import { randomInt } from 'node:crypto';
import {
  addPlayer,
  applyAction,
  createGame,
  current,
  removePlayer,
  viewFor,
  type Action,
  type ActionResult,
  type GameState,
  type GameView,
  type Rng,
} from '@uno/shared';
import { config } from './config.js';

/** Unambiguous alphabet: no O/0, I/1, etc. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface Room {
  state: GameState;
  /** subject -> playerId (they are the same value; kept explicit for clarity). */
  seats: Map<string, string>;
  /** playerId -> epoch ms when they dropped, or null while connected. */
  droppedAt: Map<string, number>;
  /** Set when the current player is offline, used to auto-play their turn. */
  turnStalledSince: number | null;
  lastActivity: number;
}

const rng: Rng = () => randomInt(0, 2 ** 31) / 2 ** 31;

export class RoomStore {
  private rooms = new Map<string, Room>();
  /** Called whenever a room's state changes so the gateway can broadcast. */
  onChange: (code: string) => void = () => {};

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  create(): Room {
    let code = this.newCode();
    while (this.rooms.has(code)) code = this.newCode();
    const room: Room = {
      state: createGame(code),
      seats: new Map(),
      droppedAt: new Map(),
      turnStalledSince: null,
      lastActivity: Date.now(),
    };
    this.rooms.set(code, room);
    return room;
  }

  private newCode(): string {
    let out = '';
    for (let i = 0; i < 4; i++) out += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
    return out;
  }

  /**
   * Seat a player, or reattach them to the seat their identity already holds.
   * Returns the playerId, or an error when the room is full / already started.
   */
  join(
    code: string,
    identity: { subject: string; name: string },
  ): { ok: true; room: Room; playerId: string } | { ok: false; error: string } {
    const room = this.get(code);
    if (!room) return { ok: false, error: 'No game with that code.' };

    const existing = room.state.players.find((p) => p.token === identity.subject);
    if (existing) {
      existing.connected = true;
      existing.name = identity.name || existing.name;
      room.droppedAt.delete(existing.id);
      room.seats.set(identity.subject, existing.id);
      room.lastActivity = Date.now();
      this.touch(room);
      return { ok: true, room, playerId: existing.id };
    }

    const playerId = identity.subject;
    const result = addPlayer(room.state, {
      id: playerId,
      name: identity.name,
      token: identity.subject,
    });
    if (!result.ok) return { ok: false, error: result.error ?? 'Could not join.' };

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

    if (room.state.phase === 'lobby') {
      removePlayer(room.state, playerId, rng);
      room.seats.delete(player.token);
    } else {
      player.connected = false;
      room.droppedAt.set(playerId, Date.now());
    }
    this.touch(room);
  }

  act(code: string, playerId: string, action: Action): ActionResult {
    const room = this.get(code);
    if (!room) return { ok: false, error: 'No game with that code.' };
    const result = applyAction(room.state, playerId, action, rng);
    if (result.ok) {
      room.lastActivity = Date.now();
      room.turnStalledSince = null;
      this.touch(room);
    }
    return result;
  }

  view(code: string, playerId: string): GameView | null {
    const room = this.get(code);
    return room ? viewFor(room.state, playerId) : null;
  }

  private touch(room: Room): void {
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

      // Don't let one offline player freeze the table.
      if (room.state.phase === 'playing' && room.state.players.length > 0) {
        const player = current(room.state);
        if (!player.connected) {
          room.turnStalledSince ??= now;
          if (now - room.turnStalledSince >= config.afkTurnSec * 1000) {
            applyAction(room.state, player.id, { type: 'draw' }, rng);
            applyAction(room.state, player.id, { type: 'pass' }, rng);
            room.turnStalledSince = null;
            changed = true;
          }
        } else {
          room.turnStalledSince = null;
        }
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
}
