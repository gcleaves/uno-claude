import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addPlayer,
  applyAction,
  canChallenge,
  createGame,
  current,
  mulberry32,
  startRound,
  viewFor,
  type Card,
  type CardColor,
  type GameState,
} from '../src/index.js';

const rng = mulberry32(11);

const card = (id: string, kind: Card['kind'], color?: CardColor, value?: number): Card => ({
  id,
  kind,
  ...(color ? { color } : {}),
  ...(value !== undefined ? { value } : {}),
});

function table(names: string[], rules = {}): GameState {
  const state = createGame('CHAL', rules);
  for (const n of names) addPlayer(state, { id: n, name: n, token: n });
  startRound(state, rng);
  return state;
}

function setBoard(
  state: GameState,
  hands: Record<string, Card[]>,
  top: Card,
  activeColor: CardColor,
) {
  state.discardPile = [top];
  state.activeColor = activeColor;
  for (const p of state.players) p.hand = hands[p.id] ?? [];
  state.turn = 0;
  state.pendingDraw = 0;
  state.pendingDrawKind = null;
  state.wild4 = null;
  state.hasDrawn = false;
  // Big draw pile so penalties always have cards behind them.
  state.drawPile = Array.from({ length: 40 }, (_, i) => card(`d${i}`, 'number', 'green', 1));
}

test('a +4 played with no card of the active colour is a legal play', () => {
  const state = table(['a', 'b']);
  setBoard(
    state,
    { a: [card('a1', 'wild4'), card('a2', 'number', 'blue', 3)], b: [card('b1', 'number', 'red', 1)] },
    card('t', 'number', 'red', 5),
    'red',
  );

  applyAction(state, 'a', { type: 'play', cardId: 'a1', chosenColor: 'green' }, rng);
  assert.deepEqual(state.wild4, { playerId: 'a', legal: true });
});

test('holding the active colour makes the +4 a bluff', () => {
  const state = table(['a', 'b']);
  setBoard(
    state,
    { a: [card('a1', 'wild4'), card('a2', 'number', 'red', 3)], b: [card('b1', 'number', 'red', 1)] },
    card('t', 'number', 'red', 5),
    'red',
  );

  applyAction(state, 'a', { type: 'play', cardId: 'a1', chosenColor: 'green' }, rng);
  assert.deepEqual(state.wild4, { playerId: 'a', legal: false }, 'they held a red card');
});

test('only the colour blocks a +4 — matching numbers and other wilds do not', () => {
  const state = table(['a', 'b']);
  setBoard(
    state,
    {
      // A matching *number* and a spare wild, but nothing red.
      a: [card('a1', 'wild4'), card('a2', 'number', 'blue', 5), card('a3', 'wild')],
      b: [card('b1', 'number', 'red', 1)],
    },
    card('t', 'number', 'red', 5),
    'red',
  );

  applyAction(state, 'a', { type: 'play', cardId: 'a1', chosenColor: 'green' }, rng);
  assert.equal(state.wild4!.legal, true);
});

test('a successful challenge makes the bluffer draw and leaves the turn with the challenger', () => {
  const state = table(['a', 'b']);
  setBoard(
    state,
    { a: [card('a1', 'wild4'), card('a2', 'number', 'red', 3)], b: [card('b1', 'number', 'green', 1)] },
    card('t', 'number', 'red', 5),
    'red',
  );

  applyAction(state, 'a', { type: 'play', cardId: 'a1', chosenColor: 'green' }, rng);
  assert.equal(current(state).id, 'b');
  assert.equal(canChallenge(state, state.players[1]!), true);

  const before = state.players[0]!.hand.length;
  const result = applyAction(state, 'b', { type: 'challenge' }, rng);
  assert.equal(result.ok, true);

  assert.equal(state.players[0]!.hand.length, before + 4, 'the bluffer takes the four');
  assert.equal(state.players[1]!.hand.length, 1, 'the challenger draws nothing');
  assert.equal(state.pendingDraw, 0);
  assert.equal(current(state).id, 'b', 'and still gets to play');
  assert.equal(state.challengeResult!.upheld, true);
  assert.equal(state.challengeResult!.drawn, 4);
});

test('a failed challenge costs the challenger the penalty plus two, and the turn', () => {
  const state = table(['a', 'b', 'c']);
  setBoard(
    state,
    {
      a: [card('a1', 'wild4'), card('a2', 'number', 'blue', 3)],
      b: [card('b1', 'number', 'green', 1)],
      c: [card('c1', 'number', 'green', 2)],
    },
    card('t', 'number', 'red', 5),
    'red',
  );

  applyAction(state, 'a', { type: 'play', cardId: 'a1', chosenColor: 'green' }, rng);
  applyAction(state, 'b', { type: 'challenge' }, rng);

  assert.equal(state.players[1]!.hand.length, 1 + 6, 'four plus two more');
  assert.equal(state.players[0]!.hand.length, 1, 'the accused draws nothing');
  assert.equal(current(state).id, 'c', 'and the challenger loses the turn');
  assert.equal(state.challengeResult!.upheld, false);
  assert.equal(state.challengeResult!.drawn, 6, 'the reported count is what was actually drawn');
});

test('the reveal shows the accused hand and goes only to the challenger', () => {
  const state = table(['a', 'b', 'c']);
  setBoard(
    state,
    {
      a: [card('a1', 'wild4'), card('a2', 'number', 'red', 3)],
      b: [card('b1', 'number', 'green', 1)],
      c: [card('c1', 'number', 'green', 2)],
    },
    card('t', 'number', 'red', 5),
    'red',
  );

  applyAction(state, 'a', { type: 'play', cardId: 'a1', chosenColor: 'green' }, rng);
  applyAction(state, 'b', { type: 'challenge' }, rng);

  const challenger = viewFor(state, 'b');
  assert.ok(challenger.challengeResult, 'the challenger sees the evidence');
  assert.deepEqual(
    challenger.challengeResult!.revealed.map((c) => c.id),
    ['a2'],
    'the hand as it was when the +4 was played, before the penalty',
  );

  assert.equal(viewFor(state, 'c').challengeResult, null, 'bystanders do not see the hand');
  assert.equal(viewFor(state, 'a').challengeResult, null, 'nor does the accused');
});

test('taking the cards instead of challenging closes the window', () => {
  const state = table(['a', 'b']);
  setBoard(
    state,
    { a: [card('a1', 'wild4'), card('a2', 'number', 'red', 3)], b: [card('b1', 'number', 'green', 1)] },
    card('t', 'number', 'red', 5),
    'red',
  );

  applyAction(state, 'a', { type: 'play', cardId: 'a1', chosenColor: 'green' }, rng);
  applyAction(state, 'b', { type: 'draw' }, rng);

  assert.equal(state.wild4, null);
  assert.equal(applyAction(state, 'b', { type: 'challenge' }, rng).ok, false);
});

test('a +2 cannot be challenged', () => {
  const state = table(['a', 'b']);
  setBoard(
    state,
    { a: [card('a1', 'draw2', 'red'), card('a2', 'number', 'red', 3)], b: [card('b1', 'number', 'green', 1)] },
    card('t', 'number', 'red', 5),
    'red',
  );

  applyAction(state, 'a', { type: 'play', cardId: 'a1' }, rng);
  assert.equal(canChallenge(state, state.players[1]!), false);
  assert.equal(applyAction(state, 'b', { type: 'challenge' }, rng).error, 'noChallenge');
});

test('challenges can be switched off', () => {
  const state = table(['a', 'b'], { challenges: false });
  setBoard(
    state,
    { a: [card('a1', 'wild4'), card('a2', 'number', 'red', 3)], b: [card('b1', 'number', 'green', 1)] },
    card('t', 'number', 'red', 5),
    'red',
  );

  applyAction(state, 'a', { type: 'play', cardId: 'a1', chosenColor: 'green' }, rng);
  assert.equal(canChallenge(state, state.players[1]!), false);
  assert.equal(applyAction(state, 'b', { type: 'challenge' }, rng).error, 'challengesDisabled');
});

test('stacking a +4 moves the challenge to the newest one', () => {
  const state = table(['a', 'b', 'c'], { stacking: true });
  setBoard(
    state,
    {
      // Ada is clean; Bo is not.
      a: [card('a1', 'wild4'), card('a2', 'number', 'blue', 3)],
      b: [card('b1', 'wild4'), card('b2', 'number', 'green', 7)],
      c: [card('c1', 'number', 'green', 2)],
    },
    card('t', 'number', 'red', 5),
    'red',
  );

  applyAction(state, 'a', { type: 'play', cardId: 'a1', chosenColor: 'green' }, rng);
  assert.equal(state.wild4!.playerId, 'a');

  applyAction(state, 'b', { type: 'play', cardId: 'b1', chosenColor: 'blue' }, rng);
  assert.equal(state.wild4!.playerId, 'b', 'the newest play is the one on trial');
  assert.equal(state.wild4!.legal, false, 'Bo held green when they stacked');
  assert.equal(state.pendingDraw, 8);

  applyAction(state, 'c', { type: 'challenge' }, rng);
  assert.equal(state.players[1]!.hand.length, 1 + 8, 'Bo eats the whole stack');
  assert.equal(current(state).id, 'c');
});

test('you cannot challenge out of turn, or after drawing', () => {
  const state = table(['a', 'b', 'c']);
  setBoard(
    state,
    {
      a: [card('a1', 'wild4'), card('a2', 'number', 'red', 3)],
      b: [card('b1', 'number', 'green', 1)],
      c: [card('c1', 'number', 'green', 2)],
    },
    card('t', 'number', 'red', 5),
    'red',
  );

  applyAction(state, 'a', { type: 'play', cardId: 'a1', chosenColor: 'green' }, rng);
  assert.equal(applyAction(state, 'c', { type: 'challenge' }, rng).error, 'notYourTurn');
  assert.equal(applyAction(state, 'a', { type: 'challenge' }, rng).error, 'notYourTurn');
});
