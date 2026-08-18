import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addPlayer,
  applyAction,
  buildDeck,
  canPlay,
  cardPoints,
  createGame,
  current,
  handPoints,
  legalPlays,
  mulberry32,
  startRound,
  topCard,
  viewFor,
  type Card,
  type CardColor,
  type GameState,
} from '../src/index.js';

const rng = mulberry32(42);

function gameWith(names: string[], rules = {}): GameState {
  const state = createGame('TEST', rules);
  for (const name of names) {
    addPlayer(state, { id: name, name, token: name });
  }
  return state;
}

/** Force a specific board position so tests aren't at the mercy of the shuffle. */
function setBoard(
  state: GameState,
  opts: { top: Card; activeColor: CardColor | null; hands: Record<string, Card[]> },
) {
  state.discardPile = [opts.top];
  state.activeColor = opts.activeColor;
  for (const p of state.players) p.hand = opts.hands[p.id] ?? [];
}

const card = (id: string, kind: Card['kind'], color?: CardColor, value?: number): Card => ({
  id,
  kind,
  ...(color ? { color } : {}),
  ...(value !== undefined ? { value } : {}),
});

test('deck has the standard 108 cards', () => {
  const deck = buildDeck();
  assert.equal(deck.length, 108);
  assert.equal(deck.filter((c) => c.kind === 'wild').length, 4);
  assert.equal(deck.filter((c) => c.kind === 'wild4').length, 4);
  assert.equal(deck.filter((c) => c.kind === 'number' && c.value === 0).length, 4);
  assert.equal(deck.filter((c) => c.kind === 'number' && c.value === 5).length, 8);
  assert.equal(deck.filter((c) => c.kind === 'draw2').length, 8);
  assert.equal(new Set(deck.map((c) => c.id)).size, 108);
});

test('scoring uses official card values', () => {
  assert.equal(cardPoints(card('a', 'number', 'red', 7)), 7);
  assert.equal(cardPoints(card('b', 'skip', 'red')), 20);
  assert.equal(cardPoints(card('c', 'wild4')), 50);
  assert.equal(handPoints([card('a', 'number', 'red', 9), card('b', 'wild')]), 59);
});

test('matching rules: colour, value, symbol, wild', () => {
  const top = card('t', 'number', 'red', 5);
  assert.ok(canPlay(card('a', 'number', 'red', 9), top, 'red'), 'same colour');
  assert.ok(canPlay(card('b', 'number', 'blue', 5), top, 'red'), 'same value');
  assert.ok(canPlay(card('c', 'wild'), top, 'red'), 'wild is always legal');
  assert.ok(!canPlay(card('d', 'number', 'blue', 9), top, 'red'), 'no match');

  const skip = card('t2', 'skip', 'green');
  assert.ok(canPlay(card('e', 'skip', 'blue'), skip, 'green'), 'symbol match across colours');
  assert.ok(!canPlay(card('f', 'reverse', 'blue'), skip, 'green'), 'different symbol');

  // After a wild, only the chosen colour matters.
  const wild = card('t3', 'wild');
  assert.ok(canPlay(card('g', 'number', 'blue', 3), wild, 'blue'));
  assert.ok(!canPlay(card('h', 'number', 'red', 3), wild, 'blue'));
});

test('dealing gives every player a hand and leaves a non-wild face up', () => {
  const state = gameWith(['a', 'b', 'c']);
  startRound(state, rng);
  assert.equal(state.phase, 'playing');
  for (const p of state.players) assert.equal(p.hand.length, 7);
  const top = topCard(state)!;
  assert.ok(top.kind !== 'wild' && top.kind !== 'wild4');
  assert.equal(state.drawPile.length + state.discardPile.length + 3 * 7, 108);
});

test('turn passes in play order and reverse flips it', () => {
  const state = gameWith(['a', 'b', 'c']);
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: {
      a: [card('a1', 'reverse', 'red'), card('a2', 'number', 'red', 3)],
      b: [card('b1', 'number', 'red', 1)],
      c: [card('c1', 'number', 'red', 2)],
    },
  });
  state.turn = 0;
  state.direction = 1;
  // 'a' has one card left after playing, so mark them safe to keep the test focused.
  state.players[0]!.saidUno = true;

  applyAction(state, 'a', { type: 'play', cardId: 'a1' }, rng);
  assert.equal(state.direction, -1);
  assert.equal(current(state).id, 'c', 'reverse hands play to the previous seat');
});

test('reverse acts as a skip in a two-player game', () => {
  const state = gameWith(['a', 'b']);
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: {
      a: [card('a1', 'reverse', 'red'), card('a2', 'number', 'red', 3)],
      b: [card('b1', 'number', 'red', 1)],
    },
  });
  state.turn = 0;

  applyAction(state, 'a', { type: 'play', cardId: 'a1' }, rng);
  assert.equal(current(state).id, 'a', 'the same player goes again');
});

test('draw two forces the next player to draw and lose their turn', () => {
  const state = gameWith(['a', 'b', 'c']);
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: {
      a: [card('a1', 'draw2', 'red'), card('a2', 'number', 'red', 3)],
      b: [card('b1', 'number', 'blue', 1)],
      c: [],
    },
  });
  state.turn = 0;

  applyAction(state, 'a', { type: 'play', cardId: 'a1' }, rng);
  assert.equal(state.pendingDraw, 2);
  assert.equal(current(state).id, 'b');

  applyAction(state, 'b', { type: 'draw' }, rng);
  assert.equal(state.players[1]!.hand.length, 3, 'one held card plus two penalties');
  assert.equal(state.pendingDraw, 0);
  assert.equal(current(state).id, 'c', 'b forfeits the turn');
});

test('stacking accumulates penalties and can be escalated to a +4', () => {
  const state = gameWith(['a', 'b', 'c'], { stacking: true });
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: {
      a: [card('a1', 'draw2', 'red'), card('a2', 'number', 'red', 3)],
      b: [card('b1', 'draw2', 'blue'), card('b2', 'number', 'blue', 1)],
      c: [card('c1', 'wild4'), card('c2', 'number', 'green', 2)],
    },
  });
  state.turn = 0;

  applyAction(state, 'a', { type: 'play', cardId: 'a1' }, rng);
  // b may only answer with a penalty card, not with a plain number.
  assert.deepEqual(legalPlays(state, state.players[1]!), ['b1']);

  applyAction(state, 'b', { type: 'play', cardId: 'b1' }, rng);
  assert.equal(state.pendingDraw, 4);

  applyAction(state, 'c', { type: 'play', cardId: 'c1', chosenColor: 'green' }, rng);
  assert.equal(state.pendingDraw, 8);
  assert.equal(state.pendingDrawKind, 'wild4');
  assert.equal(current(state).id, 'a');

  // A +4 stack can no longer be answered with a +2.
  state.players[0]!.hand = [card('a3', 'draw2', 'green')];
  assert.deepEqual(legalPlays(state, state.players[0]!), []);
});

test('stacking off means the penalty must be taken', () => {
  const state = gameWith(['a', 'b'], { stacking: false });
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: {
      a: [card('a1', 'draw2', 'red'), card('a2', 'number', 'red', 3)],
      b: [card('b1', 'draw2', 'blue')],
    },
  });
  state.turn = 0;

  applyAction(state, 'a', { type: 'play', cardId: 'a1' }, rng);
  assert.deepEqual(legalPlays(state, state.players[1]!), []);
  const rejected = applyAction(state, 'b', { type: 'play', cardId: 'b1' }, rng);
  assert.equal(rejected.ok, false);
});

test('a wild sets the active colour', () => {
  const state = gameWith(['a', 'b']);
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: { a: [card('a1', 'wild'), card('a2', 'number', 'red', 1)], b: [] },
  });
  state.turn = 0;

  const noColor = applyAction(state, 'a', { type: 'play', cardId: 'a1' }, rng);
  assert.equal(noColor.ok, false, 'a colour must be chosen');

  applyAction(state, 'a', { type: 'play', cardId: 'a1', chosenColor: 'green' }, rng);
  assert.equal(state.activeColor, 'green');
});

test('drawing a playable card lets you play only that card', () => {
  const state = gameWith(['a', 'b']);
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: { a: [card('a1', 'number', 'blue', 9)], b: [] },
  });
  state.turn = 0;
  state.drawPile = [card('d1', 'number', 'red', 2)];

  applyAction(state, 'a', { type: 'draw' }, rng);
  assert.equal(state.hasDrawn, true);
  assert.deepEqual(legalPlays(state, state.players[0]!), ['d1']);

  applyAction(state, 'a', { type: 'pass' }, rng);
  assert.equal(current(state).id, 'b');
});

test('drawing an unplayable card ends the turn automatically', () => {
  const state = gameWith(['a', 'b']);
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: { a: [card('a1', 'number', 'blue', 9)], b: [] },
  });
  state.turn = 0;
  state.drawPile = [card('d1', 'number', 'blue', 2)];

  applyAction(state, 'a', { type: 'draw' }, rng);
  assert.equal(state.hasDrawn, false);
  assert.equal(current(state).id, 'b');
});

test('drawToMatch keeps drawing until something is playable', () => {
  const state = gameWith(['a', 'b'], { drawToMatch: true });
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: { a: [], b: [] },
  });
  state.turn = 0;
  // Popped from the end, so this is drawn blue, blue, then red.
  state.drawPile = [
    card('d3', 'number', 'red', 8),
    card('d2', 'number', 'blue', 4),
    card('d1', 'number', 'blue', 2),
  ];

  applyAction(state, 'a', { type: 'draw' }, rng);
  assert.equal(state.players[0]!.hand.length, 3);
  assert.deepEqual(legalPlays(state, state.players[0]!), ['d3']);
});

test('the draw pile is recycled from the discards when it runs out', () => {
  const state = gameWith(['a', 'b']);
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: { a: [card('a1', 'number', 'blue', 9)], b: [] },
  });
  state.turn = 0;
  state.drawPile = [];
  state.discardPile = [
    card('x1', 'number', 'green', 1),
    card('x2', 'number', 'green', 2),
    card('t', 'number', 'red', 5),
  ];

  applyAction(state, 'a', { type: 'draw' }, rng);
  assert.equal(state.players[0]!.hand.length, 2);
  assert.equal(topCard(state)!.id, 't', 'the face-up card stays put');
});

test('UNO can be called, and a silent player can be caught for two cards', () => {
  const state = gameWith(['a', 'b']);
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: {
      a: [card('a1', 'number', 'red', 1), card('a2', 'number', 'red', 2)],
      b: [card('b1', 'number', 'blue', 1)],
    },
  });
  state.turn = 0;

  applyAction(state, 'a', { type: 'play', cardId: 'a1' }, rng);
  assert.deepEqual(state.unoVulnerable, ['a']);

  applyAction(state, 'b', { type: 'callOut', playerId: 'a' }, rng);
  assert.equal(state.players[0]!.hand.length, 3, 'one card plus two penalties');
  assert.deepEqual(state.unoVulnerable, []);

  const again = applyAction(state, 'b', { type: 'callOut', playerId: 'a' }, rng);
  assert.equal(again.ok, false, 'no double dipping');
});

test('the window shuts the moment the next player begins their turn', () => {
  // The official rule: caught "before the next player begins their turn".
  const state = gameWith(['a', 'b', 'c']);
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: {
      a: [card('a1', 'number', 'red', 1), card('a2', 'number', 'blue', 9)],
      b: [card('b1', 'number', 'red', 3), card('b2', 'number', 'red', 4)],
      c: [card('c1', 'number', 'red', 6), card('c2', 'number', 'red', 7)],
    },
  });
  state.turn = 0;

  applyAction(state, 'a', { type: 'play', cardId: 'a1' }, rng);
  assert.deepEqual(state.unoVulnerable, ['a'], 'catchable as soon as they go quiet');
  assert.equal(current(state).id, 'b', 'and b has not started yet');

  // b starting their turn is exactly the deadline.
  applyAction(state, 'b', { type: 'play', cardId: 'b1' }, rng);
  assert.deepEqual(state.unoVulnerable, ['b'], 'a is safe; b is now the one exposed');
  assert.equal(applyAction(state, 'c', { type: 'callOut', playerId: 'a' }, rng).ok, false);
});

test('drawing also counts as beginning a turn', () => {
  const state = gameWith(['a', 'b']);
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: {
      a: [card('a1', 'number', 'red', 1), card('a2', 'number', 'red', 2)],
      b: [card('b1', 'number', 'blue', 9)],
    },
  });
  state.turn = 0;
  state.drawPile = [card('d1', 'number', 'blue', 4)];

  applyAction(state, 'a', { type: 'play', cardId: 'a1' }, rng);
  assert.deepEqual(state.unoVulnerable, ['a']);

  // b has nothing playable and draws — that is them beginning their turn.
  applyAction(state, 'b', { type: 'draw' }, rng);
  assert.deepEqual(state.unoVulnerable, [], 'a got away with it');
});

test('head-to-head, a repeat turn still leaves a window to catch', () => {
  // A skip hands the same player another turn, so "the next player begins their
  // turn" means that player acting again. Regression: the window used to be
  // closed by the turn pointer coming back round, before the opponent saw it.
  const state = gameWith(['a', 'b']);
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: {
      a: [card('a1', 'skip', 'red'), card('a2', 'number', 'red', 4)],
      b: [card('b1', 'number', 'red', 1)],
    },
  });
  state.turn = 0;

  applyAction(state, 'a', { type: 'play', cardId: 'a1' }, rng);
  assert.equal(current(state).id, 'a', 'the skip gives them another turn');
  assert.deepEqual(state.unoVulnerable, ['a'], 'but they are still catchable');
  assert.equal(applyAction(state, 'b', { type: 'callOut', playerId: 'a' }, rng).ok, true);
  assert.equal(state.players[0]!.hand.length, 3);
});

test('drawing closes the window, because they are no longer down to one', () => {
  const state = gameWith(['a', 'b']);
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: {
      a: [card('a1', 'skip', 'red'), card('a2', 'number', 'blue', 4)],
      b: [card('b1', 'number', 'red', 1)],
    },
  });
  state.turn = 0;
  state.drawPile = [card('d1', 'number', 'green', 9)];

  applyAction(state, 'a', { type: 'play', cardId: 'a1' }, rng);
  assert.deepEqual(state.unoVulnerable, ['a']);

  // Their repeat turn has nothing playable, so they draw and hold two again.
  applyAction(state, 'a', { type: 'draw' }, rng);
  assert.deepEqual(state.unoVulnerable, []);
  assert.equal(applyAction(state, 'b', { type: 'callOut', playerId: 'a' }, rng).ok, false);
});

test('calling UNO first makes you safe', () => {
  const state = gameWith(['a', 'b']);
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: {
      a: [card('a1', 'number', 'red', 1), card('a2', 'number', 'red', 2)],
      b: [card('b1', 'number', 'blue', 1)],
    },
  });
  state.turn = 0;

  applyAction(state, 'a', { type: 'sayUno' }, rng);
  applyAction(state, 'a', { type: 'play', cardId: 'a1' }, rng);
  assert.deepEqual(state.unoVulnerable, []);
  assert.equal(applyAction(state, 'b', { type: 'callOut', playerId: 'a' }, rng).ok, false);
});

test('calling UNO with two cards and a play available counts', () => {
  // The proper technique: you say it as you put your second-to-last card down.
  const state = gameWith(['a', 'b']);
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: {
      a: [card('a1', 'number', 'red', 1), card('a2', 'number', 'red', 2)],
      b: [card('b1', 'number', 'blue', 9)],
    },
  });
  state.turn = 0;

  assert.equal(applyAction(state, 'a', { type: 'sayUno' }, rng).ok, true);
  assert.equal(state.players[0]!.saidUno, true);

  // Having declared, going down to one card leaves them safe.
  applyAction(state, 'a', { type: 'play', cardId: 'a1' }, rng);
  assert.deepEqual(state.unoVulnerable, [], 'not catchable — they called it');
  assert.equal(applyAction(state, 'b', { type: 'callOut', playerId: 'a' }, rng).ok, false);
});

test('two cards with nothing playable is too early to call', () => {
  const state = gameWith(['a', 'b']);
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    // Nothing red, no wild: they must draw, so they are not about to go out.
    hands: {
      a: [card('a1', 'number', 'blue', 1), card('a2', 'number', 'green', 2)],
      b: [card('b1', 'number', 'blue', 9)],
    },
  });
  state.turn = 0;

  const result = applyAction(state, 'a', { type: 'sayUno' }, rng);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'cannotCallUnoNow');
  assert.equal(state.players[0]!.saidUno, false);
});

test('two cards on somebody else\'s turn is too early to call', () => {
  const state = gameWith(['a', 'b']);
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: {
      a: [card('a1', 'number', 'red', 1), card('a2', 'number', 'red', 2)],
      b: [card('b1', 'number', 'red', 9)],
    },
  });
  state.turn = 1; // b's turn

  assert.equal(applyAction(state, 'a', { type: 'sayUno' }, rng).error, 'cannotCallUnoNow');
});

test('calling UNO after playing still counts, until somebody else acts', () => {
  const state = gameWith(['a', 'b', 'c']);
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: {
      a: [card('a1', 'number', 'red', 1), card('a2', 'number', 'red', 2)],
      b: [card('b1', 'number', 'red', 3)],
      c: [card('c1', 'number', 'red', 4)],
    },
  });
  state.turn = 0;

  // Play first, say it after — still in time, because nobody has acted yet.
  applyAction(state, 'a', { type: 'play', cardId: 'a1' }, rng);
  assert.deepEqual(state.unoVulnerable, ['a'], 'briefly catchable');
  assert.equal(applyAction(state, 'a', { type: 'sayUno' }, rng).ok, true);
  assert.deepEqual(state.unoVulnerable, [], 'saved themselves');
  assert.equal(applyAction(state, 'b', { type: 'callOut', playerId: 'a' }, rng).ok, false);
});

test('once the next player acts, it is too late to call', () => {
  const state = gameWith(['a', 'b', 'c']);
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: {
      a: [card('a1', 'number', 'red', 1), card('a2', 'number', 'red', 2)],
      b: [card('b1', 'number', 'red', 3), card('b2', 'number', 'red', 6)],
      c: [card('c1', 'number', 'red', 4)],
    },
  });
  state.turn = 0;

  applyAction(state, 'a', { type: 'play', cardId: 'a1' }, rng);
  applyAction(state, 'b', { type: 'play', cardId: 'b1' }, rng); // the window shuts
  const result = applyAction(state, 'a', { type: 'sayUno' }, rng);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'cannotCallUnoNow');
});

test('pressing UNO repeatedly declares once and narrates once', () => {
  // The button is always live, so an impatient player will press it several
  // times. That must not fill everyone's game log with the same line.
  const state = gameWith(['a', 'b']);
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: {
      a: [card('a1', 'number', 'red', 1), card('a2', 'number', 'red', 2)],
      b: [card('b1', 'number', 'blue', 9)],
    },
  });
  state.turn = 0;

  const results = Array.from({ length: 5 }, () =>
    applyAction(state, 'a', { type: 'sayUno' }, rng),
  );
  assert.ok(results.every((r) => r.ok), 'every press is accepted');
  assert.equal(results.filter((r) => !r.noop).length, 1, 'but only one declared anything');
  assert.equal(
    state.log.filter((l) => l.key === 'callsUno').length,
    1,
    'five presses, one announcement',
  );
});

test('calling UNO with a full hand is refused, not silently accepted', () => {
  const state = gameWith(['a', 'b']);
  startRound(state, rng);
  assert.equal(state.players[0]!.hand.length, 7);
  const result = applyAction(state, 'a', { type: 'sayUno' }, rng);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'tooManyCardsForUno');
  assert.equal(state.players[0]!.saidUno, false);
});

test('emptying your hand ends the round and scores the other hands', () => {
  const state = gameWith(['a', 'b', 'c'], { scoring: true, targetScore: 500 });
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: {
      a: [card('a1', 'number', 'red', 1)],
      b: [card('b1', 'number', 'blue', 9), card('b2', 'skip', 'green')],
      c: [card('c1', 'wild4')],
    },
  });
  state.turn = 0;

  applyAction(state, 'a', { type: 'play', cardId: 'a1' }, rng);
  assert.equal(state.phase, 'roundOver');
  assert.equal(state.roundWinner, 'a');
  assert.equal(state.players[0]!.score, 9 + 20 + 50);
});

test('reaching the target score ends the match', () => {
  const state = gameWith(['a', 'b'], { scoring: true, targetScore: 50 });
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: { a: [card('a1', 'number', 'red', 1)], b: [card('b1', 'wild4')] },
  });
  state.turn = 0;

  applyAction(state, 'a', { type: 'play', cardId: 'a1' }, rng);
  assert.equal(state.phase, 'matchOver');
  assert.equal(state.matchWinner, 'a');
});

test('players cannot act out of turn or play cards they do not hold', () => {
  const state = gameWith(['a', 'b']);
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: { a: [card('a1', 'number', 'red', 1)], b: [card('b1', 'number', 'red', 2)] },
  });
  state.turn = 0;

  assert.equal(applyAction(state, 'b', { type: 'play', cardId: 'b1' }, rng).ok, false);
  assert.equal(applyAction(state, 'a', { type: 'play', cardId: 'b1' }, rng).ok, false);
  assert.equal(applyAction(state, 'a', { type: 'pass' }, rng).ok, false, 'must draw before passing');
});

test('a view never leaks another player\'s cards', () => {
  const state = gameWith(['a', 'b']);
  startRound(state, rng);
  const view = viewFor(state, 'a');
  assert.equal(view.you.hand.length, 7);
  assert.deepEqual(
    view.players.map((p) => p.handCount),
    [7, 7],
  );
  assert.equal(JSON.stringify(view).includes(state.players[1]!.hand[0]!.id), false);
});

test('the view never reveals who is catchable', () => {
  // Noticing that someone went quiet on their last card is the opponents' job.
  // Shipping it in the payload would hand it to anyone with devtools open.
  const state = gameWith(['a', 'b']);
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: {
      a: [card('a1', 'number', 'red', 1), card('a2', 'number', 'red', 2)],
      b: [card('b1', 'number', 'blue', 9)],
    },
  });
  state.turn = 0;

  applyAction(state, 'a', { type: 'play', cardId: 'a1' }, rng);
  assert.deepEqual(state.unoVulnerable, ['a'], 'the server still tracks it');

  const view = viewFor(state, 'b');
  assert.equal('unoVulnerable' in view, false, 'but never sends it');
  assert.equal(JSON.stringify(view).includes('unoVulnerable'), false);

  // What b legitimately has is the same as at a real table: the card count, and
  // whether a was heard to declare.
  const opponent = view.players.find((p) => p.id === 'a')!;
  assert.equal(opponent.handCount, 1);
  assert.equal(opponent.saidUno, false);
});

test('sevens and zeros move hands around when enabled', () => {
  const state = gameWith(['a', 'b', 'c'], { sevenZero: true });
  startRound(state, rng);
  setBoard(state, {
    top: card('t', 'number', 'red', 5),
    activeColor: 'red',
    hands: {
      a: [card('a1', 'number', 'red', 7), card('a2', 'number', 'red', 3)],
      b: [card('b1', 'number', 'blue', 1), card('b2', 'number', 'blue', 2)],
      c: [card('c1', 'number', 'green', 4)],
    },
  });
  state.turn = 0;

  applyAction(state, 'a', { type: 'play', cardId: 'a1', targetPlayerId: 'c' }, rng);
  assert.deepEqual(state.players[0]!.hand.map((h) => h.id), ['c1']);
  assert.deepEqual(state.players[2]!.hand.map((h) => h.id), ['a2']);
});
