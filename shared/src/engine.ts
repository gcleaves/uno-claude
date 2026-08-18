import { buildDeck, canPlay, handPoints, isWild, shuffle, type Rng } from './cards.js';
import {
  COLORS,
  DEFAULT_RULES,
  type Action,
  type ActionResult,
  type Card,
  type CardColor,
  type ErrorCode,
  type GameState,
  type GameView,
  type HouseRules,
  type LogKey,
  type Player,
  type PublicPlayer,
} from './types.js';

const MAX_LOG = 60;
export const MAX_PLAYERS = 10;
export const MIN_PLAYERS = 2;

const ok: ActionResult = { ok: true };
const fail = (
  error: ErrorCode,
  errorParams?: Record<string, string | number>,
): ActionResult => ({ ok: false, error, ...(errorParams && { errorParams }) });

/* ------------------------------------------------------------------ *
 * Construction
 * ------------------------------------------------------------------ */

export function createGame(code: string, rules: Partial<HouseRules> = {}): GameState {
  return {
    code,
    phase: 'lobby',
    rules: { ...DEFAULT_RULES, ...rules },
    players: [],
    turn: 0,
    turnSeq: 0,
    direction: 1,
    drawPile: [],
    discardPile: [],
    activeColor: null,
    pendingDraw: 0,
    pendingDrawKind: null,
    wild4: null,
    challengeResult: null,
    hasDrawn: false,
    drawnPlayable: [],
    unoVulnerable: [],
    roundWinner: null,
    matchWinner: null,
    log: [],
    nextLogId: 1,
    createdAt: Date.now(),
  };
}

export function addPlayer(
  state: GameState,
  player: { id: string; name: string; token: string },
): ActionResult {
  if (state.players.length >= MAX_PLAYERS) return fail('roomFull');
  if (state.phase !== 'lobby') return fail('alreadyStarted');
  const isHost = state.players.length === 0;
  state.players.push({
    id: player.id,
    name: player.name,
    token: player.token,
    hand: [],
    connected: true,
    saidUno: false,
    score: 0,
    isHost,
  });
  log(state, 'joined', { name: player.name });
  return ok;
}

export function removePlayer(state: GameState, playerId: string, rng?: Rng): void {
  const idx = state.players.findIndex((p) => p.id === playerId);
  if (idx === -1) return;
  const [gone] = state.players.splice(idx, 1);
  if (!gone) return;
  log(state, 'left', { name: gone.name });

  // Their cards go back into circulation so the deck doesn't quietly shrink.
  if (rng && gone.hand.length > 0) {
    state.drawPile = shuffle([...state.drawPile, ...gone.hand], rng);
    gone.hand = [];
  }

  if (state.players.length === 0) return;
  if (gone.isHost) {
    state.players[0]!.isHost = true;
    log(state, 'newHost', { name: state.players[0]!.name });
  }
  // Keep the turn pointer aimed at the same player where possible.
  if (idx < state.turn) state.turn--;
  if (state.turn >= state.players.length) state.turn = 0;
  state.unoVulnerable = state.unoVulnerable.filter((id) => id !== gone.id);
  // Whoever inherits the turn must not inherit the leaver's half-finished draw.
  if (idx === state.turn) {
    state.hasDrawn = false;
    state.drawnPlayable = [];
  }

  if (state.phase === 'playing' && state.players.length < MIN_PLAYERS) {
    state.phase = 'lobby';
    log(state, 'backToLobby');
  }
}

/* ------------------------------------------------------------------ *
 * Round setup
 * ------------------------------------------------------------------ */

export function startRound(state: GameState, rng: Rng, startIndex = 0): ActionResult {
  if (state.players.length < MIN_PLAYERS) return fail('needTwoPlayers');

  const deck = shuffle(buildDeck(), rng);
  for (const p of state.players) {
    p.hand = deck.splice(0, state.rules.handSize);
    p.saidUno = false;
  }

  // Flip the starting card. Wilds as the first card would need a colour choice
  // before anyone has played, so we bury them and flip again.
  let first = deck.pop()!;
  while (isWild(first)) {
    deck.unshift(first);
    first = deck.pop()!;
  }

  state.drawPile = deck;
  state.discardPile = [first];
  state.activeColor = first.color ?? null;
  state.direction = 1;
  state.turn = startIndex % state.players.length;
  state.turnSeq++;
  state.pendingDraw = 0;
  state.pendingDrawKind = null;
  state.wild4 = null;
  state.challengeResult = null;
  state.hasDrawn = false;
  state.drawnPlayable = [];
  state.unoVulnerable = [];
  state.roundWinner = null;
  state.phase = 'playing';
  log(state, 'roundStart', undefined, first);

  // The flipped card takes effect on the first player.
  switch (first.kind) {
    case 'skip':
      log(state, 'skipped', { name: current(state).name });
      advance(state, 1);
      break;
    case 'reverse':
      state.direction = -1;
      state.turn = mod(startIndex - 1, state.players.length);
      log(state, 'reversedFirst');
      break;
    case 'draw2': {
      const victim = current(state);
      drawCards(state, victim, 2, rng);
      log(state, 'drawsAndSkipped', { name: victim.name });
      advance(state, 1);
      break;
    }
    default:
      break;
  }
  return ok;
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

export function applyAction(
  state: GameState,
  playerId: string,
  action: Action,
  rng: Rng,
): ActionResult {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return fail('notInGame');

  switch (action.type) {
    case 'start': {
      if (!player.isHost) return fail('notHost');
      if (state.phase === 'playing') return fail('gameRunning');
      // "Play again" after a finished match starts a fresh scoreboard.
      if (state.phase === 'matchOver') {
        for (const p of state.players) p.score = 0;
        state.matchWinner = null;
      }
      return startRound(state, rng, 0);
    }

    case 'updateRules': {
      if (!player.isHost) return fail('notHost');
      if (state.phase === 'playing') return fail('finishRoundFirst');
      const next = { ...state.rules, ...action.rules };
      next.handSize = clamp(Math.round(next.handSize), 1, 15);
      next.targetScore = clamp(Math.round(next.targetScore), 50, 2000);
      state.rules = next;
      return ok;
    }

    case 'nextRound': {
      if (!player.isHost) return fail('notHost');
      if (state.phase !== 'roundOver') return fail('roundNotOver');
      // Rotate who leads so the deal moves around the table.
      const startIndex = mod(state.turn + 1, state.players.length);
      return startRound(state, rng, startIndex);
    }

    case 'sayUno':
      return sayUno(state, player);

    case 'callOut':
      return callOut(state, player, action.playerId, rng);

    case 'play':
      return playCard(state, player, action.cardId, action.chosenColor, action.targetPlayerId, rng);

    case 'draw':
      return drawTurn(state, player, rng);

    case 'challenge':
      return challengeWild4(state, player, rng);

    case 'pass':
      return passTurn(state, player);

    default:
      // Unreachable for a well-typed caller, but the server is fed by the
      // network: returning a rejection beats throwing out of a socket handler.
      return fail('notInGame');
  }
}

function playCard(
  state: GameState,
  player: Player,
  cardId: string,
  chosenColor: CardColor | undefined,
  targetPlayerId: string | undefined,
  rng: Rng,
): ActionResult {
  if (state.phase !== 'playing') return fail('gameNotRunning');
  if (current(state).id !== player.id) return fail('notYourTurn');

  const idx = player.hand.findIndex((c) => c.id === cardId);
  if (idx === -1) return fail('cardNotInHand');
  const card = player.hand[idx]!;
  // Judged now, against the colour in play and the hand as it stands: once the
  // card is down and the colour has changed, the evidence is gone.
  const heldActiveColor = player.hand.some((c) => c.color === state.activeColor);

  if (!legalPlays(state, player).includes(cardId)) {
    if (state.pendingDraw > 0) {
      return fail('mustDrawPenalty', { count: state.pendingDraw });
    }
    if (state.hasDrawn) return fail('onlyDrawnCard');
    return fail('cardNoMatch');
  }

  if (isWild(card) && !chosenColor) return fail('pickColour');
  if (chosenColor && !COLORS.includes(chosenColor)) return fail('unknownColour');

  // This is the next turn beginning, so any outstanding call-out expires now —
  // before this play can make the player themselves catchable.
  closeUnoWindow(state);

  player.hand.splice(idx, 1);
  state.discardPile.push(card);
  state.activeColor = isWild(card) ? chosenColor! : card.color!;
  state.hasDrawn = false;
  state.drawnPlayable = [];

  // A Wild Draw Four is only legal with nothing of the current colour in hand.
  // Bluffing is allowed — the challenge is what enforces the rule.
  state.wild4 = card.kind === 'wild4' ? { playerId: player.id, legal: !heldActiveColor } : null;

  if (isWild(card)) {
    log(state, 'playedWild', { name: player.name, colour: chosenColor! }, card);
  } else {
    log(state, 'played', { name: player.name }, card);
  }

  if (player.hand.length === 0) {
    finishRound(state, player);
    return ok;
  }

  if (player.hand.length === 1 && !player.saidUno) {
    state.unoVulnerable = [...state.unoVulnerable, player.id];
  } else if (player.hand.length > 1) {
    player.saidUno = false;
  }

  applyCardEffect(state, player, card, targetPlayerId, rng);
  return ok;
}

function applyCardEffect(
  state: GameState,
  player: Player,
  card: Card,
  targetPlayerId: string | undefined,
  rng: Rng,
): void {
  const n = state.players.length;

  switch (card.kind) {
    case 'skip': {
      const victim = peek(state, 1);
      log(state, 'skipped', { name: victim.name });
      advance(state, 2);
      return;
    }
    case 'reverse': {
      state.direction = state.direction === 1 ? -1 : 1;
      if (n === 2) {
        // Head-to-head, a reverse behaves like a skip: the same player goes again.
        log(state, 'playsAgain', { name: player.name });
        advance(state, 2);
      } else {
        log(state, 'reversed');
        advance(state, 1);
      }
      return;
    }
    case 'draw2':
      state.pendingDraw += 2;
      state.pendingDrawKind = 'draw2';
      advance(state, 1);
      return;
    case 'wild4':
      state.pendingDraw += 4;
      state.pendingDrawKind = 'wild4';
      advance(state, 1);
      return;
    case 'number':
      if (state.rules.sevenZero && card.value === 7) {
        swapHands(state, player, targetPlayerId);
      } else if (state.rules.sevenZero && card.value === 0) {
        rotateHands(state);
      }
      advance(state, 1);
      return;
    default:
      advance(state, 1);
  }
  void rng;
}

function swapHands(state: GameState, player: Player, targetPlayerId: string | undefined): void {
  const target = state.players.find((p) => p.id === targetPlayerId && p.id !== player.id);
  if (!target) return;
  const tmp = player.hand;
  player.hand = target.hand;
  target.hand = tmp;
  player.saidUno = false;
  target.saidUno = false;
  state.unoVulnerable = state.unoVulnerable.filter(
    (id) => id !== player.id && id !== target.id,
  );
  log(state, 'swappedHands', { name: player.name, target: target.name });
}

function rotateHands(state: GameState): void {
  const hands = state.players.map((p) => p.hand);
  const n = state.players.length;
  for (let i = 0; i < n; i++) {
    // Hands move in the direction of play.
    state.players[i]!.hand = hands[mod(i - state.direction, n)]!;
    state.players[i]!.saidUno = false;
  }
  state.unoVulnerable = [];
  log(state, 'rotatedHands');
}

function drawTurn(state: GameState, player: Player, rng: Rng): ActionResult {
  if (state.phase !== 'playing') return fail('gameNotRunning');
  if (current(state).id !== player.id) return fail('notYourTurn');

  // Drawing is beginning a turn, so it closes the window too.
  closeUnoWindow(state);

  if (state.pendingDraw > 0) {
    const count = state.pendingDraw;
    drawCards(state, player, count, rng);
    state.pendingDraw = 0;
    state.pendingDrawKind = null;
    // Taking the cards ends any chance to question the play.
    state.wild4 = null;
    log(state, 'drawsAndLosesTurn', { name: player.name, count });
    player.saidUno = false;
    advance(state, 1);
    return ok;
  }

  if (state.hasDrawn) return fail('alreadyDrawn');

  const drawn: Card[] = [];
  const top = topCard(state);
  if (state.rules.drawToMatch) {
    // Keep drawing until something matches (or the deck genuinely runs dry).
    for (let guard = 0; guard < 200; guard++) {
      const card = drawOne(state, rng);
      if (!card) break;
      player.hand.push(card);
      drawn.push(card);
      if (canPlay(card, top, state.activeColor)) break;
    }
  } else {
    const card = drawOne(state, rng);
    if (card) {
      player.hand.push(card);
      drawn.push(card);
    }
  }

  if (drawn.length === 0) {
    log(state, 'couldNotDraw', { name: player.name });
    advance(state, 1);
    return ok;
  }

  player.saidUno = false;
  if (drawn.length === 1) log(state, 'drewCard', { name: player.name });
  else log(state, 'drewCards', { name: player.name, count: drawn.length });

  const playable = drawn.filter((c) => canPlay(c, top, state.activeColor)).map((c) => c.id);
  if (playable.length === 0) {
    advance(state, 1);
    return ok;
  }
  state.hasDrawn = true;
  state.drawnPlayable = playable;
  return ok;
}

/**
 * Call the bluff on a Wild Draw Four.
 *
 * Official rule: the accused shows their hand. If they had a card of the colour
 * that was in play, the challenge holds and *they* take the penalty while the
 * challenger plays on. If they were clean, the challenger takes the penalty plus
 * two more and loses the turn. Either way it is a gamble, which is the point.
 */
function challengeWild4(state: GameState, player: Player, rng: Rng): ActionResult {
  if (state.phase !== 'playing') return fail('gameNotRunning');
  if (!state.rules.challenges) return fail('challengesDisabled');
  if (current(state).id !== player.id) return fail('notYourTurn');
  if (state.hasDrawn) return fail('alreadyDrawn');
  if (!state.wild4 || state.pendingDrawKind !== 'wild4' || state.pendingDraw <= 0) {
    return fail('noChallenge');
  }

  // Challenging is how this player begins their turn.
  closeUnoWindow(state);

  const accused = state.players.find((p) => p.id === state.wild4!.playerId);
  if (!accused) return fail('unknownPlayer');
  if (accused.id === player.id) return fail('cannotCatchSelf');

  const upheld = !state.wild4.legal;
  const owed = state.pendingDraw;
  // Snapshot before anyone draws, so the reveal is the hand being judged.
  const revealed = accused.hand.map((c) => ({ ...c }));

  state.pendingDraw = 0;
  state.pendingDrawKind = null;
  state.wild4 = null;

  if (upheld) {
    // They were bluffing: they take the cards and the challenger plays on.
    drawCards(state, accused, owed, rng);
    accused.saidUno = false;
    log(state, 'challengeUpheld', { name: player.name, target: accused.name, count: owed });
  } else {
    drawCards(state, player, owed + 2, rng);
    player.saidUno = false;
    log(state, 'challengeFailed', { name: player.name, target: accused.name, count: owed + 2 });
    advance(state, 1);
  }

  state.challengeResult = {
    id: state.nextLogId,
    challengerId: player.id,
    accusedId: accused.id,
    upheld,
    drawn: upheld ? owed : owed + 2,
    revealed,
  };
  return ok;
}

function passTurn(state: GameState, player: Player): ActionResult {
  if (state.phase !== 'playing') return fail('gameNotRunning');
  if (current(state).id !== player.id) return fail('notYourTurn');
  if (!state.hasDrawn) return fail('mustDrawFirst');
  state.hasDrawn = false;
  state.drawnPlayable = [];
  log(state, 'passed', { name: player.name });
  advance(state, 1);
  return ok;
}

function sayUno(state: GameState, player: Player): ActionResult {
  if (state.phase !== 'playing') return fail('gameNotRunning');
  if (player.hand.length > 2) return fail('tooManyCardsForUno');
  // Pressing it again is not a second declaration. Succeed, but change nothing
  // and say nothing: otherwise an impatient player fills everyone's game log
  // with the same line.
  if (player.saidUno) return ok;
  player.saidUno = true;
  state.unoVulnerable = state.unoVulnerable.filter((id) => id !== player.id);
  log(state, 'callsUno', { name: player.name });
  return ok;
}

function callOut(
  state: GameState,
  caller: Player,
  targetId: string,
  rng: Rng,
): ActionResult {
  if (state.phase !== 'playing') return fail('gameNotRunning');
  if (targetId === caller.id) return fail('cannotCatchSelf');
  if (!state.unoVulnerable.includes(targetId)) return fail('nothingToCatch');
  const target = state.players.find((p) => p.id === targetId);
  if (!target) return fail('unknownPlayer');

  state.unoVulnerable = state.unoVulnerable.filter((id) => id !== targetId);
  drawCards(state, target, 2, rng);
  log(state, 'caught', { name: caller.name, target: target.name });
  return ok;
}

function finishRound(state: GameState, winner: Player): void {
  state.roundWinner = winner.id;
  state.unoVulnerable = [];
  state.pendingDraw = 0;
  state.pendingDrawKind = null;
  state.wild4 = null;

  const gained = state.players
    .filter((p) => p.id !== winner.id)
    .reduce((sum, p) => sum + handPoints(p.hand), 0);

  if (state.rules.scoring) {
    winner.score += gained;
    log(state, 'winsRoundScoring', { name: winner.name, gained, total: winner.score });
  } else {
    log(state, 'winsRound', { name: winner.name });
  }

  if (state.rules.scoring && winner.score >= state.rules.targetScore) {
    state.phase = 'matchOver';
    state.matchWinner = winner.id;
    log(state, 'winsMatch', { name: winner.name });
  } else {
    state.phase = 'roundOver';
  }
}

/* ------------------------------------------------------------------ *
 * Deck / turn helpers
 * ------------------------------------------------------------------ */

function drawOne(state: GameState, rng: Rng): Card | null {
  if (state.drawPile.length === 0) refillDrawPile(state, rng);
  return state.drawPile.pop() ?? null;
}

function drawCards(state: GameState, player: Player, count: number, rng: Rng): void {
  for (let i = 0; i < count; i++) {
    const card = drawOne(state, rng);
    if (!card) break;
    player.hand.push(card);
  }
}

/** Recycle everything under the top discard back into the draw pile. */
function refillDrawPile(state: GameState, rng: Rng): void {
  if (state.discardPile.length <= 1) return;
  const top = state.discardPile.pop()!;
  state.drawPile = shuffle(state.discardPile, rng);
  state.discardPile = [top];
  log(state, 'reshuffled');
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function current(state: GameState): Player {
  return state.players[state.turn]!;
}

function peek(state: GameState, steps: number): Player {
  return state.players[mod(state.turn + state.direction * steps, state.players.length)]!;
}

function advance(state: GameState, steps: number): void {
  state.turn = mod(state.turn + state.direction * steps, state.players.length);
  state.turnSeq++;
  state.hasDrawn = false;
  state.drawnPlayable = [];
}

export function topCard(state: GameState): Card | null {
  return state.discardPile[state.discardPile.length - 1] ?? null;
}

function log(
  state: GameState,
  key: LogKey,
  params?: Record<string, string | number>,
  card?: Card,
): void {
  state.log.push({ id: state.nextLogId++, at: Date.now(), key, ...(params && { params }), ...(card && { card }) });
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
}

/** Lets the server narrate things the engine has no concept of, like a turn clock. */
export function logEvent(
  state: GameState,
  key: LogKey,
  params?: Record<string, string | number>,
): void {
  log(state, key, params);
}

/* ------------------------------------------------------------------ *
 * Legality + views
 * ------------------------------------------------------------------ */

/**
 * Official rule: a player who forgot to call UNO can be caught only "before the
 * next player begins their turn" — that is, before anyone draws or plays again.
 * So every turn action shuts the window, whoever takes it. Head-to-head, where a
 * skip hands the same player another turn, that player's own next action is the
 * one that closes it.
 */
function closeUnoWindow(state: GameState): void {
  state.unoVulnerable = [];
}

/** Whether this player may question the Wild Draw Four in front of them. */
export function canChallenge(state: GameState, player: Player): boolean {
  return (
    state.phase === 'playing' &&
    state.rules.challenges &&
    current(state).id === player.id &&
    !state.hasDrawn &&
    state.pendingDrawKind === 'wild4' &&
    state.pendingDraw > 0 &&
    !!state.wild4 &&
    state.wild4.playerId !== player.id
  );
}

export function legalPlays(state: GameState, player: Player): string[] {
  if (state.phase !== 'playing') return [];
  if (current(state).id !== player.id) return [];

  const top = topCard(state);

  if (state.pendingDraw > 0) {
    if (!state.rules.stacking) return [];
    // A +2 stack may be escalated with a +4; a +4 stack can only take another +4.
    return player.hand
      .filter((c) =>
        state.pendingDrawKind === 'wild4' ? c.kind === 'wild4' : c.kind === 'draw2' || c.kind === 'wild4',
      )
      .map((c) => c.id);
  }

  if (state.hasDrawn) return [...state.drawnPlayable];

  return player.hand.filter((c) => canPlay(c, top, state.activeColor)).map((c) => c.id);
}

function toPublic(p: Player): PublicPlayer {
  return {
    id: p.id,
    name: p.name,
    handCount: p.hand.length,
    connected: p.connected,
    saidUno: p.saidUno,
    score: p.score,
    isHost: p.isHost,
  };
}

export function viewFor(state: GameState, playerId: string): GameView {
  const me = state.players.find((p) => p.id === playerId);
  const isYourTurn = state.phase === 'playing' && !!me && current(state).id === me.id;

  return {
    code: state.code,
    phase: state.phase,
    rules: state.rules,
    players: state.players.map(toPublic),
    turn: state.turn,
    direction: state.direction,
    drawPileCount: state.drawPile.length,
    discardCount: state.discardPile.length,
    topCard: topCard(state),
    activeColor: state.activeColor,
    pendingDraw: state.pendingDraw,
    pendingDrawKind: state.pendingDrawKind,
    hasDrawn: state.hasDrawn,
    canChallenge: !!me && canChallenge(state, me),
    // The official rule shows the hand to the challenger alone.
    challengeResult:
      state.challengeResult?.challengerId === playerId ? state.challengeResult : null,
    roundWinner: state.roundWinner,
    matchWinner: state.matchWinner,
    log: state.log,
    // The engine has no clock; the server fills these in when it sends the view.
    turnRemainingMs: null,
    turnTotalMs: null,
    you: {
      id: playerId,
      hand: me ? me.hand : [],
      isHost: me?.isHost ?? false,
      playable: me ? legalPlays(state, me) : [],
      isYourTurn,
    },
  };
}
