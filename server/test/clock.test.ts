import assert from 'node:assert/strict';
import { test } from 'node:test';
import { current, legalPlays, type Card, type CardColor } from '@uno/shared';
import { RoomStore, turnBudgetMs } from '../src/rooms.js';
import { config } from '../src/config.js';

const FORCED = config.forcedActionSec * 1000;
const CHOICE = config.turnTimeoutSec * 1000;
const AFK = config.afkTurnSec * 1000;

const card = (id: string, kind: Card['kind'], color?: CardColor, value?: number): Card => ({
  id,
  kind,
  ...(color ? { color } : {}),
  ...(value !== undefined ? { value } : {}),
});

/** A started two-player game with a known board. */
function table() {
  const store = new RoomStore();
  const room = store.create();
  const code = room.state.code;
  store.join(code, { subject: 'a', name: 'Ada' });
  store.join(code, { subject: 'b', name: 'Bo' });
  store.act(code, 'a', { type: 'start' });

  const setBoard = (hands: Record<string, Card[]>, top: Card, activeColor: CardColor) => {
    room.state.discardPile = [top];
    room.state.activeColor = activeColor;
    for (const p of room.state.players) p.hand = hands[p.id] ?? [];
    room.state.turn = 0;
    room.state.pendingDraw = 0;
    room.state.pendingDrawKind = null;
    room.state.hasDrawn = false;
  };
  /**
   * Start the clock at a synthetic time. Needed because the setup above runs on
   * the real clock, and these tests then reason in small made-up timestamps.
   */
  const arm = (now: number) => {
    room.turnKey = '';
    room.turnDeadline = null;
    store.sweep(now);
  };

  return { store, room, code, setBoard, arm };
}

test('no clock runs in the lobby', () => {
  const store = new RoomStore();
  const room = store.create();
  store.join(room.state.code, { subject: 'a', name: 'Ada' });
  assert.equal(turnBudgetMs(room.state), 0);
  store.sweep();
  assert.equal(room.turnDeadline, null);
});

test('a player with a real choice gets the long clock', () => {
  const { room, code, store, setBoard, arm } = table();
  setBoard(
    { a: [card('a1', 'number', 'red', 3)], b: [card('b1', 'number', 'blue', 1)] },
    card('t', 'number', 'red', 5),
    'red',
  );
  assert.ok(legalPlays(room.state, current(room.state)).length > 0);
  assert.equal(turnBudgetMs(room.state), CHOICE);

  const now = 1_000_000;
  arm(now);
  assert.equal(room.turnDeadline, now + CHOICE);
  assert.equal(store.view(code, 'a', now)!.turnRemainingMs, CHOICE);
});

test('a player with no legal play gets the short forced clock', () => {
  const { room, store, setBoard, arm } = table();
  setBoard(
    { a: [card('a1', 'number', 'blue', 3)], b: [card('b1', 'number', 'blue', 1)] },
    card('t', 'number', 'red', 5),
    'red',
  );
  assert.deepEqual(legalPlays(room.state, current(room.state)), []);
  assert.equal(turnBudgetMs(room.state), FORCED);
  arm(1_000_000);
  assert.equal(room.turnDeadline, 1_000_000 + FORCED);
});

test('being made to draw a penalty uses the short clock', () => {
  const { room, store, setBoard, arm } = table();
  setBoard(
    { a: [card('a1', 'number', 'red', 3)], b: [card('b1', 'number', 'blue', 1)] },
    card('t', 'number', 'red', 5),
    'red',
  );
  room.state.pendingDraw = 4;
  room.state.pendingDrawKind = 'wild4';
  // No wild4 on record, so there is nothing to challenge and drawing is the
  // only move left.
  room.state.wild4 = null;
  assert.deepEqual(legalPlays(room.state, current(room.state)), []);
  assert.equal(turnBudgetMs(room.state), FORCED);
  arm(500);
  assert.equal(room.turnDeadline, 500 + FORCED);
});

test('facing a challengeable +4 earns the long clock, not the forced one', () => {
  // Regression: deciding whether to call a bluff is a real choice. Treating it
  // as a formality gave five seconds and the server drew before you could act.
  const { room, store, setBoard, arm } = table();
  setBoard(
    { a: [card('a1', 'number', 'red', 3)], b: [card('b1', 'number', 'blue', 1)] },
    card('t', 'number', 'red', 5),
    'red',
  );
  room.state.pendingDraw = 4;
  room.state.pendingDrawKind = 'wild4';
  room.state.wild4 = { playerId: 'b', legal: false };

  assert.deepEqual(legalPlays(room.state, current(room.state)), [], 'nothing to stack');
  assert.equal(turnBudgetMs(room.state), CHOICE);

  const t0 = 6_000_000;
  arm(t0);
  store.sweep(t0 + FORCED + 1);
  assert.equal(current(room.state).id, 'a', 'still their turn — they can still challenge');
  assert.equal(room.state.pendingDraw, 4, 'and have not been made to draw');
});

test('the clock expiring takes the penalty and forfeits the turn', () => {
  const { room, code, store, setBoard, arm } = table();
  setBoard(
    { a: [card('a1', 'number', 'red', 3)], b: [card('b1', 'number', 'blue', 1)] },
    card('t', 'number', 'red', 5),
    'red',
  );
  room.state.pendingDraw = 2;
  room.state.pendingDrawKind = 'draw2';

  const t0 = 5_000_000;
  arm(t0);
  store.sweep(t0 + FORCED - 1);
  assert.equal(current(room.state).id, 'a', 'still their turn just before the deadline');
  assert.equal(room.state.players[0]!.hand.length, 1);

  store.sweep(t0 + FORCED);
  assert.equal(room.state.players[0]!.hand.length, 3, 'took the two penalty cards');
  assert.equal(room.state.pendingDraw, 0);
  assert.equal(current(room.state).id, 'b', 'turn moved on');
  assert.ok(
    room.state.log.some((l) => l.key === 'ranOutOfTimeTakes' && l.params?.count === 2),
  );
  void code;
});

test('timing out never plays a card from the hand', () => {
  const { room, store, setBoard, arm } = table();
  const keeper = card('a1', 'wild4');
  setBoard({ a: [keeper], b: [card('b1', 'number', 'blue', 1)] }, card('t', 'number', 'red', 5), 'red');

  const t0 = 9_000_000;
  arm(t0);
  store.sweep(t0 + CHOICE);

  assert.ok(
    room.state.players[0]!.hand.some((c) => c.id === 'a1'),
    'the wild is still theirs — the server does not choose for them',
  );
  assert.equal(current(room.state).id, 'b');
});

test('drawing buys a fresh window to decide', () => {
  const { room, code, store, setBoard, arm } = table();
  setBoard({ a: [card('a1', 'number', 'blue', 3)], b: [] }, card('t', 'number', 'red', 5), 'red');
  room.state.drawPile = [card('d1', 'number', 'red', 2)];

  const t0 = 2_000_000;
  arm(t0);
  assert.equal(room.turnDeadline, t0 + FORCED, 'short clock: nothing playable');

  // They draw with two seconds to spare, and it turns out to be playable.
  store.act(code, 'a', { type: 'draw' });
  assert.equal(room.state.hasDrawn, true);
  assert.ok(room.turnDeadline! > Date.now() + CHOICE - 1000, 'clock restarted at the long budget');
  assert.equal(current(room.state).id, 'a');
});

test('playing twice in a row gets a fresh clock each time', () => {
  // Regression: the clock was keyed on whose turn it is. Head-to-head, a skip
  // (or reverse) means the same player goes again, so the key repeated and the
  // second turn silently inherited the first turn's already-spent deadline.
  const { room, code, store, setBoard, arm } = table();
  setBoard(
    {
      a: [card('a1', 'skip', 'red'), card('a2', 'number', 'red', 4)],
      b: [card('b1', 'number', 'red', 1)],
    },
    card('t', 'number', 'red', 5),
    'red',
  );

  const t0 = 4_000_000;
  arm(t0);
  assert.equal(room.turnDeadline, t0 + CHOICE);

  // Ada skips Bo, so it is Ada's turn again.
  store.act(code, 'a', { type: 'play', cardId: 'a1' }, t0 + 30_000);
  assert.equal(current(room.state).id, 'a', 'a skip is a repeat turn head-to-head');

  assert.equal(
    room.turnDeadline,
    t0 + 30_000 + CHOICE,
    'the repeat turn gets a full clock, not the leftovers of the first',
  );

  // The decisive check: the first turn's deadline has now passed, and Ada must
  // not be punished for it.
  store.sweep(t0 + 30_500);
  assert.equal(current(room.state).id, 'a', 'still their turn, not forfeited');
  assert.ok(store.view(code, 'a', t0 + 30_500)!.turnRemainingMs! > CHOICE - 1_000);
});

test('an unrelated update does not extend the clock', () => {
  const { room, code, store, setBoard, arm } = table();
  setBoard(
    {
      a: [card('a1', 'number', 'red', 3)],
      b: [card('b1', 'number', 'blue', 1), card('b2', 'number', 'blue', 2)],
    },
    card('t', 'number', 'red', 5),
    'red',
  );
  const t0 = 3_000_000;
  arm(t0);
  const deadline = room.turnDeadline;

  // Bo calls UNO out of turn; Ada's clock must not restart.
  store.act(code, 'b', { type: 'sayUno' });
  assert.equal(room.turnDeadline, deadline);
});

test('a disconnected player is hurried along on the AFK clock', () => {
  const { room, code, store, setBoard, arm } = table();
  setBoard(
    { a: [card('a1', 'number', 'red', 3)], b: [card('b1', 'number', 'blue', 1)] },
    card('t', 'number', 'red', 5),
    'red',
  );
  assert.equal(turnBudgetMs(room.state), CHOICE);

  store.markDisconnected(code, 'a');
  assert.equal(turnBudgetMs(room.state), AFK);
  assert.notEqual(AFK, CHOICE, 'the two clocks should differ, or this proves nothing');

  const t0 = 7_000_000;
  arm(t0);
  store.sweep(t0 + AFK);
  assert.equal(current(room.state).id, 'b');
});

test('the clock stops when the round ends', () => {
  const { room, code, store, setBoard, arm } = table();
  setBoard({ a: [card('a1', 'number', 'red', 3)], b: [card('b1', 'number', 'blue', 1)] }, card('t', 'number', 'red', 5), 'red');
  arm(1_000);
  assert.notEqual(room.turnDeadline, null);

  store.act(code, 'a', { type: 'play', cardId: 'a1' });
  assert.equal(room.state.phase, 'roundOver');
  assert.equal(room.turnDeadline, null);
  assert.equal(store.view(code, 'a')!.turnRemainingMs, null);
});

test('the clock keeps firing until somebody can actually move', () => {
  // Both players offline: the table must still resolve rather than wedge.
  const { room, code, store, setBoard, arm } = table();
  setBoard(
    { a: [card('a1', 'number', 'blue', 3)], b: [card('b1', 'number', 'blue', 1)] },
    card('t', 'number', 'red', 5),
    'red',
  );
  store.markDisconnected(code, 'a');
  store.markDisconnected(code, 'b');

  let now = 100_000;
  arm(now);
  for (let i = 0; i < 40; i++) {
    now += AFK;
    store.sweep(now);
  }
  assert.ok(
    room.state.phase !== 'playing' || room.state.players.every((p) => p.hand.length > 1),
    'the game advanced instead of sitting on one player',
  );
  assert.ok(
    room.state.log.filter((l) => l.key === 'ranOutOfTime' || l.key === 'ranOutOfTimeTakes')
      .length > 1,
  );
});
