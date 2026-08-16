import {
  buildDeck,
  canPlay,
  describeCard,
  handPoints,
  isWild,
  shuffle,
  type Rng,
} from './cards.js';
import {
  COLORS,
  DEFAULT_RULES,
  type Action,
  type ActionResult,
  type Card,
  type CardColor,
  type GameState,
  type GameView,
  type HouseRules,
  type Player,
  type PublicPlayer,
} from './types.js';

const MAX_LOG = 60;
export const MAX_PLAYERS = 10;
export const MIN_PLAYERS = 2;

const ok: ActionResult = { ok: true };
const fail = (error: string): ActionResult => ({ ok: false, error });

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
    direction: 1,
    drawPile: [],
    discardPile: [],
    activeColor: null,
    pendingDraw: 0,
    pendingDrawKind: null,
    hasDrawn: false,
    drawnPlayable: [],
    unoVulnerable: null,
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
  if (state.players.length >= MAX_PLAYERS) return fail('This room is full.');
  if (state.phase !== 'lobby') return fail('That game has already started.');
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
  log(state, `${player.name} joined.`);
  return ok;
}

export function removePlayer(state: GameState, playerId: string, rng?: Rng): void {
  const idx = state.players.findIndex((p) => p.id === playerId);
  if (idx === -1) return;
  const [gone] = state.players.splice(idx, 1);
  if (!gone) return;
  log(state, `${gone.name} left.`);

  // Their cards go back into circulation so the deck doesn't quietly shrink.
  if (rng && gone.hand.length > 0) {
    state.drawPile = shuffle([...state.drawPile, ...gone.hand], rng);
    gone.hand = [];
  }

  if (state.players.length === 0) return;
  if (gone.isHost) {
    state.players[0]!.isHost = true;
    log(state, `${state.players[0]!.name} is now the host.`);
  }
  // Keep the turn pointer aimed at the same player where possible.
  if (idx < state.turn) state.turn--;
  if (state.turn >= state.players.length) state.turn = 0;
  if (state.unoVulnerable === gone.id) state.unoVulnerable = null;
  // Whoever inherits the turn must not inherit the leaver's half-finished draw.
  if (idx === state.turn) {
    state.hasDrawn = false;
    state.drawnPlayable = [];
  }

  if (state.phase === 'playing' && state.players.length < MIN_PLAYERS) {
    state.phase = 'lobby';
    log(state, 'Not enough players — back to the lobby.');
  }
}

/* ------------------------------------------------------------------ *
 * Round setup
 * ------------------------------------------------------------------ */

export function startRound(state: GameState, rng: Rng, startIndex = 0): ActionResult {
  if (state.players.length < MIN_PLAYERS) return fail('Need at least 2 players.');

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
  state.pendingDraw = 0;
  state.pendingDrawKind = null;
  state.hasDrawn = false;
  state.drawnPlayable = [];
  state.unoVulnerable = null;
  state.roundWinner = null;
  state.phase = 'playing';
  log(state, `New round. Starting card: ${describeCard(first)}.`);

  // The flipped card takes effect on the first player.
  switch (first.kind) {
    case 'skip':
      log(state, `${current(state).name} is skipped.`);
      advance(state, 1);
      break;
    case 'reverse':
      state.direction = -1;
      state.turn = mod(startIndex - 1, state.players.length);
      log(state, 'Direction reversed before the first turn.');
      break;
    case 'draw2': {
      const victim = current(state);
      drawCards(state, victim, 2, rng);
      log(state, `${victim.name} draws 2 and is skipped.`);
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
  if (!player) return fail('You are not in this game.');

  switch (action.type) {
    case 'start': {
      if (!player.isHost) return fail('Only the host can start the game.');
      if (state.phase === 'playing') return fail('The game is already running.');
      // "Play again" after a finished match starts a fresh scoreboard.
      if (state.phase === 'matchOver') {
        for (const p of state.players) p.score = 0;
        state.matchWinner = null;
      }
      return startRound(state, rng, 0);
    }

    case 'updateRules': {
      if (!player.isHost) return fail('Only the host can change the rules.');
      if (state.phase === 'playing') return fail('Finish the round first.');
      const next = { ...state.rules, ...action.rules };
      next.handSize = clamp(Math.round(next.handSize), 1, 15);
      next.targetScore = clamp(Math.round(next.targetScore), 50, 2000);
      state.rules = next;
      return ok;
    }

    case 'nextRound': {
      if (!player.isHost) return fail('Only the host can deal the next round.');
      if (state.phase !== 'roundOver') return fail('The round is not over.');
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

    case 'pass':
      return passTurn(state, player);
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
  if (state.phase !== 'playing') return fail('The game is not running.');
  if (current(state).id !== player.id) return fail('It is not your turn.');

  const idx = player.hand.findIndex((c) => c.id === cardId);
  if (idx === -1) return fail('That card is not in your hand.');
  const card = player.hand[idx]!;

  if (!legalPlays(state, player).includes(cardId)) {
    if (state.pendingDraw > 0) {
      return fail(`You must draw ${state.pendingDraw} or stack another penalty card.`);
    }
    if (state.hasDrawn) return fail('You may only play the card you just drew.');
    return fail(`${describeCard(card)} does not match.`);
  }

  if (isWild(card) && !chosenColor) return fail('Pick a colour for your wild.');
  if (chosenColor && !COLORS.includes(chosenColor)) return fail('Unknown colour.');

  player.hand.splice(idx, 1);
  state.discardPile.push(card);
  state.activeColor = isWild(card) ? chosenColor! : card.color!;
  state.hasDrawn = false;
  state.drawnPlayable = [];

  const colorNote = isWild(card) ? ` and calls ${chosenColor}` : '';
  log(state, `${player.name} played ${describeCard(card)}${colorNote}.`);

  // Someone who was vulnerable and got away with it is safe once play moves on.
  if (state.unoVulnerable && state.unoVulnerable !== player.id) state.unoVulnerable = null;

  if (player.hand.length === 0) {
    finishRound(state, player);
    return ok;
  }

  if (player.hand.length === 1 && !player.saidUno) {
    state.unoVulnerable = player.id;
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
      log(state, `${victim.name} is skipped.`);
      advance(state, 2);
      return;
    }
    case 'reverse': {
      state.direction = state.direction === 1 ? -1 : 1;
      if (n === 2) {
        // Head-to-head, a reverse behaves like a skip: the same player goes again.
        log(state, `${player.name} plays again.`);
        advance(state, 2);
      } else {
        log(state, 'Direction reversed.');
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
  if (state.unoVulnerable === player.id || state.unoVulnerable === target.id) {
    state.unoVulnerable = null;
  }
  log(state, `${player.name} swapped hands with ${target.name}.`);
}

function rotateHands(state: GameState): void {
  const hands = state.players.map((p) => p.hand);
  const n = state.players.length;
  for (let i = 0; i < n; i++) {
    // Hands move in the direction of play.
    state.players[i]!.hand = hands[mod(i - state.direction, n)]!;
    state.players[i]!.saidUno = false;
  }
  state.unoVulnerable = null;
  log(state, 'Everyone passes their hand around.');
}

function drawTurn(state: GameState, player: Player, rng: Rng): ActionResult {
  if (state.phase !== 'playing') return fail('The game is not running.');
  if (current(state).id !== player.id) return fail('It is not your turn.');

  if (state.pendingDraw > 0) {
    const count = state.pendingDraw;
    drawCards(state, player, count, rng);
    state.pendingDraw = 0;
    state.pendingDrawKind = null;
    log(state, `${player.name} draws ${count} and loses their turn.`);
    player.saidUno = false;
    advance(state, 1);
    return ok;
  }

  if (state.hasDrawn) return fail('You have already drawn — play that card or pass.');

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
    log(state, `${player.name} could not draw — no cards left.`);
    advance(state, 1);
    return ok;
  }

  player.saidUno = false;
  log(
    state,
    drawn.length === 1
      ? `${player.name} drew a card.`
      : `${player.name} drew ${drawn.length} cards.`,
  );

  const playable = drawn.filter((c) => canPlay(c, top, state.activeColor)).map((c) => c.id);
  if (playable.length === 0) {
    advance(state, 1);
    return ok;
  }
  state.hasDrawn = true;
  state.drawnPlayable = playable;
  return ok;
}

function passTurn(state: GameState, player: Player): ActionResult {
  if (state.phase !== 'playing') return fail('The game is not running.');
  if (current(state).id !== player.id) return fail('It is not your turn.');
  if (!state.hasDrawn) return fail('You must draw before passing.');
  state.hasDrawn = false;
  state.drawnPlayable = [];
  log(state, `${player.name} passed.`);
  advance(state, 1);
  return ok;
}

function sayUno(state: GameState, player: Player): ActionResult {
  if (state.phase !== 'playing') return fail('The game is not running.');
  if (player.hand.length > 2) return fail('You have too many cards to call UNO.');
  player.saidUno = true;
  if (state.unoVulnerable === player.id) state.unoVulnerable = null;
  log(state, `${player.name} calls UNO!`);
  return ok;
}

function callOut(
  state: GameState,
  caller: Player,
  targetId: string,
  rng: Rng,
): ActionResult {
  if (state.phase !== 'playing') return fail('The game is not running.');
  if (targetId === caller.id) return fail('You cannot catch yourself.');
  if (state.unoVulnerable !== targetId) return fail('Nothing to catch right now.');
  const target = state.players.find((p) => p.id === targetId);
  if (!target) return fail('Unknown player.');

  state.unoVulnerable = null;
  drawCards(state, target, 2, rng);
  log(state, `${caller.name} caught ${target.name} — 2 penalty cards.`);
  return ok;
}

function finishRound(state: GameState, winner: Player): void {
  state.roundWinner = winner.id;
  state.unoVulnerable = null;
  state.pendingDraw = 0;
  state.pendingDrawKind = null;

  const gained = state.players
    .filter((p) => p.id !== winner.id)
    .reduce((sum, p) => sum + handPoints(p.hand), 0);

  if (state.rules.scoring) {
    winner.score += gained;
    log(state, `${winner.name} wins the round and scores ${gained} (total ${winner.score}).`);
  } else {
    log(state, `${winner.name} wins the round!`);
  }

  if (state.rules.scoring && winner.score >= state.rules.targetScore) {
    state.phase = 'matchOver';
    state.matchWinner = winner.id;
    log(state, `${winner.name} wins the match!`);
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
  log(state, 'Draw pile reshuffled.');
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
  state.hasDrawn = false;
  state.drawnPlayable = [];
  // If play comes back around to the player who never called UNO, they got away with it.
  if (state.unoVulnerable && current(state).id === state.unoVulnerable) {
    state.unoVulnerable = null;
  }
}

export function topCard(state: GameState): Card | null {
  return state.discardPile[state.discardPile.length - 1] ?? null;
}

function log(state: GameState, text: string): void {
  state.log.push({ id: state.nextLogId++, text, at: Date.now() });
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
}

/* ------------------------------------------------------------------ *
 * Legality + views
 * ------------------------------------------------------------------ */

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
    unoVulnerable: state.unoVulnerable,
    roundWinner: state.roundWinner,
    matchWinner: state.matchWinner,
    log: state.log,
    you: {
      id: playerId,
      hand: me ? me.hand : [],
      isHost: me?.isHost ?? false,
      playable: me ? legalPlays(state, me) : [],
      isYourTurn,
    },
  };
}
