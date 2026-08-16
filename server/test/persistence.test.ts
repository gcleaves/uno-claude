import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { current, type Card, type CardColor } from '@uno/shared';
import { RoomStore } from '../src/rooms.js';
import { loadSnapshot, saveSnapshotSync, type PersistedRoom } from '../src/persistence.js';
import { config } from '../src/config.js';

const scratch = () => mkdtempSync(path.join(tmpdir(), 'uno-snap-'));

const card = (id: string, kind: Card['kind'], color?: CardColor, value?: number): Card => ({
  id,
  kind,
  ...(color ? { color } : {}),
  ...(value !== undefined ? { value } : {}),
});

/** A game in progress with a known board. */
function liveGame() {
  const store = new RoomStore();
  const room = store.create();
  const code = room.state.code;
  store.join(code, { subject: 'tok-a', name: 'Ada' });
  store.join(code, { subject: 'tok-b', name: 'Bo' });
  store.act(code, 'tok-a', { type: 'start' });

  room.state.discardPile = [card('t', 'number', 'red', 5)];
  room.state.activeColor = 'red';
  room.state.players[0]!.hand = [card('a1', 'number', 'red', 3), card('a2', 'wild4')];
  room.state.players[1]!.hand = [card('b1', 'number', 'blue', 1)];
  room.state.players[0]!.score = 120;
  room.state.turn = 0;
  return { store, room, code };
}

test('a game survives a round trip through disk', () => {
  const { store, room, code } = liveGame();
  const file = path.join(scratch(), 'rooms.json');

  saveSnapshotSync(file, store.export());
  const snapshot = loadSnapshot(file);
  assert.ok(snapshot);
  assert.equal(snapshot.rooms.length, 1);

  const revived = new RoomStore();
  assert.equal(revived.restore(snapshot.rooms), 1);

  const before = room.state;
  const after = revived.get(code)!.state;
  assert.equal(after.code, before.code);
  assert.equal(after.phase, 'playing');
  assert.equal(after.turn, before.turn);
  assert.equal(after.activeColor, 'red');
  assert.deepEqual(
    after.players.map((p) => p.hand.map((c) => c.id)),
    [['a1', 'a2'], ['b1']],
    'hands come back exactly as they were',
  );
  assert.equal(after.players[0]!.score, 120, 'scores survive');
  assert.equal(after.drawPile.length, before.drawPile.length);
});

test('a player reclaims their seat after a restart using the same token', () => {
  const { store, room, code } = liveGame();
  const file = path.join(scratch(), 'rooms.json');
  saveSnapshotSync(file, store.export());

  const revived = new RoomStore();
  revived.restore(loadSnapshot(file)!.rooms);

  const restored = revived.get(code)!;
  assert.ok(
    restored.state.players.every((p) => !p.connected),
    'everyone starts offline — their sockets died with the old process',
  );

  const back = revived.join(code, { subject: 'tok-a', name: 'Ada' });
  assert.equal(back.ok, true);
  assert.equal(back.ok && back.playerId, 'tok-a');
  assert.equal(restored.state.players[0]!.connected, true);
  assert.deepEqual(
    revived.view(code, 'tok-a')!.you.hand.map((c) => c.id),
    ['a1', 'a2'],
    'and they get their own cards back, not a fresh deal',
  );
  void room;
});

test('nobody is forfeited while they are still reconnecting', () => {
  const { store, code } = liveGame();
  const file = path.join(scratch(), 'rooms.json');
  saveSnapshotSync(file, store.export());

  const revived = new RoomStore();
  const t0 = 8_000_000;
  revived.restore(loadSnapshot(file)!.rooms, t0);
  const room = revived.get(code)!;

  // Everyone is offline, so without the grace the AFK clock would fire fast.
  revived.sweep(t0 + 1_000);
  assert.equal(room.turnDeadline, null, 'no clock runs during the resume grace');
  assert.equal(revived.view(code, 'tok-a', t0 + 1_000)!.turnRemainingMs, null);

  revived.sweep(t0 + config.resumeGraceSec * 1000 - 1);
  assert.equal(current(room.state).id, 'tok-a', 'still their turn');

  // Once the grace passes the clock takes over again.
  revived.sweep(t0 + config.resumeGraceSec * 1000 + 1);
  assert.notEqual(room.turnDeadline, null, 'the clock resumes afterwards');
});

test('seats are held from the restart, not from when the snapshot was written', () => {
  const { store, code } = liveGame();
  const file = path.join(scratch(), 'rooms.json');
  // A snapshot written long ago must not instantly expire everyone's seat.
  saveSnapshotSync(file, store.export(), 1_000);

  const revived = new RoomStore();
  const t0 = 9_000_000;
  revived.restore(loadSnapshot(file)!.rooms, t0);

  revived.sweep(t0 + config.reconnectGraceSec * 1000 - 1_000);
  assert.equal(revived.get(code)!.state.players.length, 2, 'seats still held');

  revived.sweep(t0 + config.reconnectGraceSec * 1000 + 1);
  assert.equal(revived.get(code)!.state.players.length, 0, 'and reclaimed once the grace passes');
});

test('empty and abandoned rooms are not saved', () => {
  const store = new RoomStore();
  const empty = store.create();
  const busy = store.create();
  store.join(busy.state.code, { subject: 'tok-a', name: 'Ada' });

  const saved = store.export();
  assert.equal(saved.length, 1, 'the room with nobody in it is dropped');
  assert.equal(saved[0]!.state.code, busy.state.code);
  void empty;

  // And one that has been idle past its TTL is dropped too.
  busy.lastActivity = Date.now() - (config.emptyRoomTtlMin + 1) * 60_000;
  assert.equal(store.export().length, 0);
});

test('a corrupt or foreign snapshot is ignored rather than fatal', () => {
  const dir = scratch();

  const missing = path.join(dir, 'nope.json');
  assert.equal(loadSnapshot(missing), null);

  const truncated = path.join(dir, 'truncated.json');
  writeFileSync(truncated, '{"version":1,"rooms":[{"state":');
  assert.equal(loadSnapshot(truncated), null, 'half-written file does not throw');

  const foreign = path.join(dir, 'foreign.json');
  writeFileSync(foreign, JSON.stringify({ version: 999, savedAt: 0, rooms: [] }));
  assert.equal(loadSnapshot(foreign), null, 'a future format is refused, not guessed at');

  const partly = path.join(dir, 'partly.json');
  writeFileSync(
    partly,
    JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      rooms: [{ state: { code: 'JUNK' } }, ...[]],
    }),
  );
  assert.deepEqual(loadSnapshot(partly)!.rooms, [], 'a malformed room is dropped, not restored');
});

test('the snapshot is not world-readable', () => {
  const file = path.join(scratch(), 'rooms.json');
  const { store } = liveGame();
  saveSnapshotSync(file, store.export());
  // It contains every player's hand.
  assert.equal(statSync(file).mode & 0o077, 0, 'no group or other access');
  assert.ok(readFileSync(file, 'utf8').includes('"a1"'));
});

test('restoring twice does not duplicate a room', () => {
  const { store, code } = liveGame();
  const saved: PersistedRoom[] = store.export();

  const revived = new RoomStore();
  assert.equal(revived.restore(saved), 1);
  assert.equal(revived.restore(saved), 0, 'the second attempt is a no-op');
  assert.equal(revived.stats().rooms, 1);
  assert.ok(revived.get(code));
});

test('the store reports whether anything needs saving', () => {
  const store = new RoomStore();
  const room = store.create();
  store.join(room.state.code, { subject: 'tok-a', name: 'Ada' });
  assert.equal(store.dirty, true);

  store.export();
  assert.equal(store.dirty, false, 'clean immediately after a snapshot');

  store.join(room.state.code, { subject: 'tok-b', name: 'Bo' });
  assert.equal(store.dirty, true, 'and dirty again once someone acts');
});
