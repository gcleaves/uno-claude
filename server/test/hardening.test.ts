import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RoomStore } from '../src/rooms.js';
import { parseAction, parseRoomCode } from '../src/validate.js';
import { ConnectionCounter, RateLimiter } from '../src/guard.js';
import { config } from '../src/config.js';

/**
 * The server is reachable from the open internet, so everything here is about
 * what a stranger can do to it — not about how the game plays.
 */

test('a malformed action is refused, not passed to the engine', () => {
  // Regression: an unrecognised action type reached the engine, which returned
  // undefined, and reading `.ok` off it threw straight out of the socket
  // handler and killed the process. One message, whole server down.
  for (const bad of [
    { type: 'not-a-real-action' },
    { type: '__proto__' },
    { type: 'play' }, // no cardId
    { type: 'play', cardId: 42 },
    { type: 'play', cardId: 'x', chosenColor: 'octarine' },
    { type: 'callOut' },
    { type: 'callOut', playerId: { evil: true } },
    { type: 'updateRules', rules: 'all of them' },
    { type: 'updateRules', rules: { handSize: 'lots' } },
    { type: 'updateRules', rules: { stacking: 1 } },
    { type: 'play', cardId: 'x'.repeat(5000) },
    null,
    undefined,
    'draw',
    42,
    [],
  ]) {
    assert.equal(parseAction(bad), null, `should have refused: ${JSON.stringify(bad)}`);
  }
});

test('well-formed actions still get through', () => {
  assert.deepEqual(parseAction({ type: 'draw' }), { type: 'draw' });
  assert.deepEqual(parseAction({ type: 'play', cardId: 'c7' }), { type: 'play', cardId: 'c7' });
  assert.deepEqual(parseAction({ type: 'play', cardId: 'c7', chosenColor: 'red' }), {
    type: 'play',
    cardId: 'c7',
    chosenColor: 'red',
  });
  assert.deepEqual(parseAction({ type: 'callOut', playerId: 'p1' }), {
    type: 'callOut',
    playerId: 'p1',
  });
  assert.deepEqual(parseAction({ type: 'updateRules', rules: { stacking: false, handSize: 5 } }), {
    type: 'updateRules',
    rules: { stacking: false, handSize: 5 },
  });
});

test('the engine itself refuses an unknown action rather than throwing', async () => {
  // Defence in depth: validation is the guard, but the engine must not be a
  // loaded gun if anything ever reaches it unchecked.
  const { addPlayer, applyAction, createGame, mulberry32 } = await import('@uno/shared');
  const state = createGame('TEST');
  addPlayer(state, { id: 'a', name: 'Ada', token: 'a' });
  const result = applyAction(state, 'a', { type: 'bogus' } as never, mulberry32(1));
  assert.equal(result.ok, false, 'returns a rejection');
  assert.ok(result.error, 'with a code, rather than throwing');
});

test('room codes are long enough that guessing an active room is impractical', () => {
  const store = new RoomStore();
  const room = store.create();
  assert.ok(room);
  assert.equal(room.state.code.length, config.roomCodeLength);
  assert.ok(config.roomCodeLength >= 6, 'four characters is only ~923k combinations');

  // 31 unambiguous characters, so six of them is ~887 million.
  const space = 31 ** config.roomCodeLength;
  assert.ok(space > 100_000_000, `code space is only ${space}`);
});

test('room codes are validated before use', () => {
  const n = config.roomCodeLength;
  assert.equal(parseRoomCode('a'.repeat(n), n), 'A'.repeat(n), 'case and padding normalised');
  assert.equal(parseRoomCode(` ${'a'.repeat(n)} `, n), 'A'.repeat(n));
  assert.equal(parseRoomCode('a'.repeat(n - 1), n), null, 'too short');
  assert.equal(parseRoomCode('a'.repeat(n + 1), n), null, 'too long');
  assert.equal(parseRoomCode('../../etc', n), null);
  assert.equal(parseRoomCode(42, n), null);
  assert.equal(parseRoomCode(null, n), null);
});

test('the server stops creating rooms once it is full', () => {
  const store = new RoomStore();
  for (let i = 0; i < config.maxRooms; i++) {
    assert.ok(store.create(), `should have created room ${i}`);
  }
  assert.equal(store.create(), null, 'refuses rather than growing without bound');
  assert.equal(store.stats().rooms, config.maxRooms);
});

test('the rate limiter allows a burst then throttles', () => {
  const limiter = new RateLimiter(5, 1000);
  const t = 1_000_000;
  for (let i = 0; i < 5; i++) {
    assert.equal(limiter.allow('client', t), true, `burst call ${i} should pass`);
  }
  assert.equal(limiter.allow('client', t), false, 'the sixth is throttled');

  // It refills over time rather than locking anyone out.
  assert.equal(limiter.allow('client', t + 200), true, 'one token back after a fifth of a window');
  assert.equal(limiter.allow('client', t + 200), false);

  // And one noisy client cannot throttle anyone else.
  assert.equal(limiter.allow('someone-else', t), true);
});

test('rate limiter state does not grow without bound', () => {
  const limiter = new RateLimiter(5, 1000);
  const t = 1_000_000;
  for (let i = 0; i < 500; i++) limiter.allow(`client-${i}`, t);
  assert.equal(limiter.size, 500);
  limiter.sweep(t + 1000 * 11);
  assert.equal(limiter.size, 0, 'idle buckets are dropped');
});

test('join attempts are limited tightly enough to stop code guessing', () => {
  // The attack is not "enumerate the space", it is "stumble onto a room that is
  // actually in use". With one game running, that is half the space on average.
  const space = 31 ** config.roomCodeLength;
  const expectedAttempts = space / 2;
  const years = expectedAttempts / config.joinsPerMinute / 60 / 24 / 365;

  assert.ok(
    years > 10,
    `a client could expect to find a live room in ${years.toFixed(1)} years — too soon`,
  );

  // Sanity-check the two inputs that drive it, so this cannot pass because
  // somebody quietly loosened the limit or shortened the code.
  assert.ok(config.roomCodeLength >= 6);
  assert.ok(config.joinsPerMinute <= 60);
});

test('connections are counted per client and released on disconnect', () => {
  const counter = new ConnectionCounter();
  assert.equal(counter.add('1.2.3.4'), 1);
  assert.equal(counter.add('1.2.3.4'), 2);
  assert.equal(counter.get('1.2.3.4'), 2);
  assert.equal(counter.get('5.6.7.8'), 0, 'counted separately');

  counter.remove('1.2.3.4');
  counter.remove('1.2.3.4');
  assert.equal(counter.get('1.2.3.4'), 0);
  assert.equal(counter.size, 0, 'the entry is dropped, not left at zero');
});
