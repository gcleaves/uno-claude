/**
 * Proves a game really survives a restart, rather than merely that a file gets
 * written: deals a hand, restarts the server underneath the players, and checks
 * everyone gets their own cards back.
 *
 *   npx tsx scripts/restart-check.ts "docker compose restart" http://localhost:3210
 *   npx tsx scripts/restart-check.ts --manual http://localhost:3001
 *
 * With --manual it pauses so you can restart the server yourself.
 * Exits 0 on success, 1 on failure.
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { io, type Socket } from 'socket.io-client';
import type { GameView } from '@uno/shared';

const [restartCmd = '--manual', url = 'http://localhost:3001'] = process.argv.slice(2);
const NAMES = ['Ada', 'Grace'];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function connect(name: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      auth: { token: `guest_${randomUUID()}`, name },
      transports: ['websocket'],
      reconnectionDelay: 500,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (e) => reject(new Error(`${name}: ${e.message}`)));
  });
}

function ask<T>(socket: Socket, event: string, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 15_000);
    socket.emit(event, payload, (res: T) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

/** Mirrors what the real client does on reconnect: re-take the seat by token. */
function autoRejoin(socket: Socket, code: string, name: string): void {
  socket.on('connect', () => {
    socket.emit('room:join', { code, name }, (res: { ok: boolean; error?: string }) => {
      if (!res.ok) console.error(`    ${name} could not re-take their seat: ${res.error}`);
    });
  });
}

const latest = new Map<Socket, GameView>();

async function main() {
  console.log(`→ ${url}`);
  const sockets = await Promise.all(NAMES.map(connect));
  const [host, other] = sockets as [Socket, Socket];
  for (const s of sockets) s.on('state', (v: GameView) => latest.set(s, v));

  const created = await ask<{ ok: boolean; code?: string; error?: string }>(host, 'room:create', {
    name: NAMES[0],
  });
  if (!created.ok || !created.code) throw new Error(created.error ?? 'room:create failed');
  const code = created.code;

  const joined = await ask<{ ok: boolean; error?: string }>(other, 'room:join', {
    code,
    name: NAMES[1],
  });
  if (!joined.ok) throw new Error(joined.error ?? 'room:join failed');

  const started = await ask<{ ok: boolean; error?: string }>(host, 'game:action', { type: 'start' });
  if (!started.ok) throw new Error(started.error ?? 'start failed');
  await wait(500);

  sockets.forEach((s, i) => autoRejoin(s, code, NAMES[i]!));

  const before = snapshotOf(sockets);
  console.log(`  room ${code} dealt`);
  for (const [name, hand] of before) console.log(`    ${name}: ${hand.length} cards`);
  const topBefore = latest.get(host)!.topCard?.id;
  const turnBefore = latest.get(host)!.turn;

  if (restartCmd === '--manual') {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question('  restart the server now, then press enter… ');
    rl.close();
  } else {
    console.log(`  restarting: ${restartCmd}`);
    execSync(restartCmd, { stdio: 'inherit' });
  }

  // Drop every cached view, so what we compare against afterwards can only be
  // state the *restarted* server sent. Without this the check passes vacuously
  // on the pre-restart snapshot even if nobody ever gets their seat back.
  latest.clear();

  console.log('  waiting for both clients to reconnect…');
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await wait(500);
    if (sockets.every((s) => s.connected && latest.has(s))) break;
  }
  if (!sockets.every((s) => s.connected)) throw new Error('clients never reconnected');
  if (!sockets.every((s) => latest.has(s))) {
    throw new Error('reconnected, but the restarted server never sent a fresh view');
  }
  await wait(500);

  const after = snapshotOf(sockets);
  for (const [name, hand] of before) {
    const now = after.get(name);
    assertDeep(hand, now ?? [], `${name}'s hand`);
    console.log(`    ${name}: ${now!.length} cards, unchanged`);
  }

  const view = latest.get(host)!;
  assertEqual(view.topCard?.id, topBefore, 'discard pile top');
  assertEqual(view.turn, turnBefore, 'whose turn it is');
  assertEqual(view.phase, 'playing', 'phase');

  // And the resumed game is still playable, not just readable.
  const mover = sockets.find((s) => latest.get(s)!.you.isYourTurn);
  if (!mover) throw new Error('nobody is on turn after the restart');
  const moverView = latest.get(mover)!;
  const cardId = moverView.you.playable[0];
  const move = await ask<{ ok: boolean; error?: string }>(mover, 'game:action', {
    cardId,
    type: cardId ? 'play' : 'draw',
    chosenColor: 'red',
  });
  if (!move.ok) throw new Error(`could not play after restart: ${move.error}`);
  console.log('    play accepted after the restart');

  for (const s of sockets) s.close();
  console.log('PASS');
}

function snapshotOf(sockets: Socket[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of sockets) {
    const view = latest.get(s);
    if (!view) continue;
    const me = view.players.find((p) => p.id === view.you.id)!;
    out.set(me.name, view.you.hand.map((c) => c.id).sort());
  }
  return out;
}

function assertDeep(a: string[], b: string[], what: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what} changed across the restart:\n    before ${a}\n    after  ${b}`);
  }
}

function assertEqual<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);
}

main().catch((err) => {
  console.error(`FAIL: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
