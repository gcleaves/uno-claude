import { randomInt } from 'node:crypto';
import {
  addPlayer,
  applyAction,
  canChallenge,
  createGame,
  current,
  legalPlays,
  logEvent,
  removePlayer,
  viewFor,
  type Action,
  type ActionResult,
  type ErrorCode,
  type GameState,
  type GameView,
  type Rng,
} from '@uno/shared';
import { config } from './config.js';
import type { PersistedRoom } from './persistence.js';

/** Unambiguous alphabet: no O/0, I/1, etc. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface Room {
  state: GameState;
  /** subject -> playerId (they are the same value; kept explicit for clarity). */
  seats: Map<string, string>;
  /** playerId -> epoch ms when they dropped, or null while connected. */
  droppedAt: Map<string, number>;
  /** When the current player runs out of time, or null when no clock is running. */
  turnDeadline: number | null;
  /** What the running clock started at, so the client can draw a progress bar. */
  turnTotalMs: number | null;
  /**
   * Identifies the situation the clock was started for. When this changes the
   * clock restarts, which is what makes "one deadline per required action" work
   * without the engine needing to know a clock exists.
   */
  turnKey: string;
  lastActivity: number;
  /**
   * After a restore, no turn clock runs until this passes. Sockets do not
   * survive a restart, so everyone looks "away" for a moment and would
   * otherwise be forfeited while their phone is still reconnecting.
   */
  resumeUntil: number | null;
}

const rng: Rng = () => randomInt(0, 2 ** 31) / 2 ** 31;

export class RoomStore {
  private rooms = new Map<string, Room>();
  private changedSinceSnapshot = false;
  /** Called whenever a room's state changes so the gateway can broadcast. */
  onChange: (code: string) => void = () => {};

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  /** Null when the server is already holding as many rooms as it will allow. */
  create(): Room | null {
    if (this.rooms.size >= config.maxRooms) return null;
    let code = this.newCode();
    while (this.rooms.has(code)) code = this.newCode();
    const room: Room = {
      state: createGame(code),
      seats: new Map(),
      droppedAt: new Map(),
      turnDeadline: null,
      turnTotalMs: null,
      turnKey: '',
      lastActivity: Date.now(),
      resumeUntil: null,
    };
    this.rooms.set(code, room);
    return room;
  }

  private newCode(): string {
    let out = '';
    for (let i = 0; i < config.roomCodeLength; i++) {
      out += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
    }
    return out;
  }

  /**
   * Seat a player, or reattach them to the seat their identity already holds.
   * Returns the playerId, or an error when the room is full / already started.
   */
  join(
    code: string,
    identity: { subject: string; name: string },
  ): { ok: true; room: Room; playerId: string } | { ok: false; error: ErrorCode } {
    const room = this.get(code);
    if (!room) return { ok: false, error: 'noSuchRoom' };

    const existing = room.state.players.find((p) => p.token === identity.subject);
    if (existing) {
      existing.connected = true;
      existing.name = identity.name || existing.name;
      room.droppedAt.delete(existing.id);
      room.seats.set(identity.subject, existing.id);
      room.lastActivity = Date.now();
      syncClock(room, room.lastActivity);
      this.touch(room);
      return { ok: true, room, playerId: existing.id };
    }

    const playerId = identity.subject;
    const result = addPlayer(room.state, {
      id: playerId,
      name: identity.name,
      token: identity.subject,
    });
    if (!result.ok) return { ok: false, error: result.error ?? 'couldNotJoin' };

    room.seats.set(identity.subject, playerId);
    room.lastActivity = Date.now();
    this.touch(room);
    return { ok: true, room, playerId };
  }

  markDisconnected(code: string, playerId: string): void {
    const room = this.get(code);
    if (!room) return;
    const player = room.state.players.find((p) => p.id === playerId);
    if (!player) return;

    const now = Date.now();
    if (room.state.phase === 'lobby') {
      removePlayer(room.state, playerId, rng);
      room.seats.delete(player.token);
    } else {
      player.connected = false;
      room.droppedAt.set(playerId, now);
    }
    // Going offline shortens the clock; coming back lengthens it again.
    syncClock(room, now);
    this.touch(room);
  }

  /** `now` is injectable so tests can drive the turn clock deterministically. */
  act(code: string, playerId: string, action: Action, now = Date.now()): ActionResult {
    const room = this.get(code);
    if (!room) return { ok: false, error: 'noSuchRoom' };
    const result = applyAction(room.state, playerId, action, rng);
    if (result.ok) {
      room.lastActivity = now;
      syncClock(room, now);
      this.touch(room);
    }
    return result;
  }

  view(code: string, playerId: string, now = Date.now()): GameView | null {
    const room = this.get(code);
    if (!room) return null;
    return {
      ...viewFor(room.state, playerId),
      turnRemainingMs: room.turnDeadline === null ? null : Math.max(0, room.turnDeadline - now),
      turnTotalMs: room.turnTotalMs,
    };
  }

  private touch(room: Room): void {
    this.changedSinceSnapshot = true;
    this.onChange(room.state.code);
  }

  /**
   * Housekeeping: auto-play stalled turns, reclaim abandoned seats, drop dead rooms.
   * Called on a timer by the gateway.
   */
  sweep(now = Date.now()): void {
    for (const [code, room] of this.rooms) {
      let changed = false;

      // Reclaim seats held by long-gone players.
      for (const [playerId, at] of room.droppedAt) {
        if (now - at < config.reconnectGraceSec * 1000) continue;
        removePlayer(room.state, playerId, rng);
        room.droppedAt.delete(playerId);
        for (const [subject, id] of room.seats) {
          if (id === playerId) room.seats.delete(subject);
        }
        changed = true;
      }

      // Nobody gets to stall the table, online or off.
      if (syncClock(room, now)) changed = true;
      if (room.turnDeadline !== null && now >= room.turnDeadline) {
        forceTurn(room);
        syncClock(room, now);
        changed = true;
      }

      if (
        room.state.players.length === 0 &&
        now - room.lastActivity > config.emptyRoomTtlMin * 60_000
      ) {
        this.rooms.delete(code);
        continue;
      }

      if (changed) this.touch(room);
    }
  }

  stats() {
    return {
      rooms: this.rooms.size,
      players: [...this.rooms.values()].reduce((n, r) => n + r.state.players.length, 0),
    };
  }

  /* ---------------------------------------------------------------- *
   * Surviving a restart
   * ---------------------------------------------------------------- */

  /** True when something has changed since the last snapshot. */
  get dirty(): boolean {
    return this.changedSinceSnapshot;
  }

  /** Rooms worth saving: occupied, and not already abandoned. */
  export(now = Date.now()): PersistedRoom[] {
    const out: PersistedRoom[] = [];
    for (const room of this.rooms.values()) {
      if (room.state.players.length === 0) continue;
      if (now - room.lastActivity > config.emptyRoomTtlMin * 60_000) continue;
      out.push({
        state: room.state,
        seats: [...room.seats],
        droppedAt: [...room.droppedAt],
        lastActivity: room.lastActivity,
      });
    }
    this.changedSinceSnapshot = false;
    return out;
  }

  /**
   * Rebuild rooms from a snapshot. Everyone comes back marked offline — their
   * sockets died with the old process — and holding their seat from now, so the
   * reconnect grace is measured from the restart rather than from whenever the
   * snapshot happened to be written.
   */
  restore(saved: PersistedRoom[], now = Date.now()): number {
    let count = 0;
    for (const entry of saved) {
      const code = entry.state.code?.toUpperCase();
      if (!code || this.rooms.has(code)) continue;

      const state = entry.state;
      const droppedAt = new Map<string, number>();
      for (const player of state.players) {
        player.connected = false;
        droppedAt.set(player.id, now);
      }

      this.rooms.set(code, {
        state,
        seats: new Map(entry.seats),
        droppedAt,
        // A stale deadline from before the restart must not carry over.
        turnDeadline: null,
        turnTotalMs: null,
        turnKey: '',
        lastActivity: now,
        resumeUntil: config.resumeGraceSec > 0 ? now + config.resumeGraceSec * 1000 : null,
      });
      logEvent(state, 'serverRestarted');
      count++;
    }
    this.changedSinceSnapshot = true;
    return count;
  }
}

/**
 * How long the current player gets. The three cases are deliberately different
 * lengths: waiting on a formality should not feel as slow as waiting on someone
 * who is genuinely deciding. Returns 0 when no clock should run.
 */
export function turnBudgetMs(state: GameState): number {
  if (state.phase !== 'playing' || state.players.length === 0) return 0;

  const player = current(state);
  // Being able to challenge makes this a real decision, not a formality, even
  // though there is no card to play — so it earns the longer clock.
  const formality = legalPlays(state, player).length === 0 && !canChallenge(state, player);

  const seconds = !player.connected
    ? config.afkTurnSec
    : formality
      ? config.forcedActionSec
      : config.turnTimeoutSec;

  return seconds > 0 ? seconds * 1000 : 0;
}

/**
 * Restart the clock whenever the situation the player is facing changes, and
 * leave it alone otherwise — so drawing a card buys a fresh window to decide,
 * but an unrelated update (someone calling UNO) does not.
 */
function syncClock(room: Room, now: number): boolean {
  const state = room.state;

  // Just restarted: give everyone a chance to reconnect before any clock runs.
  if (room.resumeUntil !== null) {
    if (now < room.resumeUntil) {
      const wasRunning = room.turnDeadline !== null;
      room.turnDeadline = null;
      room.turnTotalMs = null;
      room.turnKey = '';
      return wasRunning;
    }
    room.resumeUntil = null;
  }

  const budget = turnBudgetMs(state);

  if (budget === 0) {
    const wasRunning = room.turnDeadline !== null;
    room.turnDeadline = null;
    room.turnTotalMs = null;
    room.turnKey = '';
    return wasRunning;
  }

  const player = current(state);
  // turnSeq rather than the player id: play coming back round to the same person
  // is a new turn and must get a new clock.
  const key = [
    state.phase,
    state.turnSeq,
    state.hasDrawn,
    state.pendingDraw,
    player.connected,
    budget,
  ].join('|');

  if (key === room.turnKey) return false;

  room.turnKey = key;
  room.turnTotalMs = budget;
  room.turnDeadline = now + budget;
  return true;
}

/**
 * Play the current player's turn for them: take whatever they were required to
 * take, then give up the turn. Deliberately never plays a card from their hand —
 * running out of time costs you the turn, it does not let the server choose for
 * you.
 */
function forceTurn(room: Room): void {
  const state = room.state;
  const player = current(state);
  const owed = state.pendingDraw;

  if (owed > 0) logEvent(state, 'ranOutOfTimeTakes', { name: player.name, count: owed });
  else logEvent(state, 'ranOutOfTime', { name: player.name });

  applyAction(state, player.id, { type: 'draw' }, rng);

  // Drawing can leave them holding a playable card and still on turn; they
  // forfeited it, so pass on their behalf too.
  if (state.phase === 'playing' && current(state).id === player.id && state.hasDrawn) {
    applyAction(state, player.id, { type: 'pass' }, rng);
  }
}
