/**
 * End-to-end check against a running server: seats three clients, plays a full
 * round over real WebSockets, and asserts somebody wins. Point it at a fresh
 * deployment to confirm the socket path works, not just that /healthz answers.
 *
 *   npx tsx scripts/smoke.ts                          # localhost:3001
 *   npx tsx scripts/smoke.ts https://uno.example.com  # a deployment
 *
 * Exits 0 on success, 1 on failure.
 */
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { COLORS, type Card, type CardColor, type GameView } from '@uno/shared';

const url = process.argv[2] ?? process.env.UNO_URL ?? 'http://localhost:3001';
const NAMES = ['Ada', 'Grace', 'Alan'];
const TIMEOUT_MS = 60_000;

function connect(name: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      auth: { token: `guest_${randomUUID()}`, name },
      transports: ['websocket'],
      timeout: 10_000,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (e) => reject(new Error(`${name}: ${e.message}`)));
  });
}

function ask<T>(socket: Socket, event: string, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 10_000);
    socket.emit(event, payload, (res: T) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

function bestColor(hand: Card[]): CardColor {
  const counts = new Map<CardColor, number>(COLORS.map((c) => [c, 0]));
  for (const c of hand) if (c.color) counts.set(c.color, (counts.get(c.color) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

async function main() {
  console.log(`→ ${url}`);
  const sockets = await Promise.all(NAMES.map(connect));
  console.log(`  connected ${sockets.length} clients`);

  const [host, ...rest] = sockets as [Socket, ...Socket[]];
  const created = await ask<{ ok: boolean; code?: string; error?: string }>(host, 'room:create', {
    name: NAMES[0],
  });
  if (!created.ok || !created.code) throw new Error(created.error ?? 'room:create failed');
  const code = created.code;
  console.log(`  room ${code}`);

  for (let i = 0; i < rest.length; i++) {
    const joined = await ask<{ ok: boolean; error?: string }>(rest[i]!, 'room:join', {
      code,
      name: NAMES[i + 1],
    });
    if (!joined.ok) throw new Error(joined.error ?? 'room:join failed');
  }
  console.log(`  seated ${sockets.length} players`);

  const finished = new Promise<GameView>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('round never finished')), TIMEOUT_MS);
    let plays = 0;

    for (const socket of sockets) {
      socket.on('state', (view: GameView) => {
        if (view.phase === 'roundOver' || view.phase === 'matchOver') {
          clearTimeout(timer);
          resolve(view);
          return;
        }
        if (view.phase !== 'playing' || !view.you.isYourTurn) return;

        const cardId = view.you.playable[0];
        if (!cardId) {
          socket.emit('game:action', { type: view.hasDrawn ? 'pass' : 'draw' });
          return;
        }
        const card = view.you.hand.find((c) => c.id === cardId)!;
        if (view.you.hand.length === 2) socket.emit('game:action', { type: 'sayUno' });
        socket.emit('game:action', {
          type: 'play',
          cardId,
          chosenColor: card.kind === 'wild' || card.kind === 'wild4' ? bestColor(view.you.hand) : undefined,
          targetPlayerId: view.players.find((p) => p.id !== view.you.id)?.id,
        });
        plays++;
        if (plays > 5000) reject(new Error('game did not converge'));
      });
    }
  });

  const start = await ask<{ ok: boolean; error?: string }>(host, 'game:action', { type: 'start' });
  if (!start.ok) throw new Error(start.error ?? 'start failed');
  console.log('  dealt, playing…');

  const final = await finished;
  const winner = final.players.find((p) => p.id === final.roundWinner);
  if (!winner) throw new Error('round ended without a winner');

  console.log(`  ${winner.name} won with ${winner.score} points`);
  for (const socket of sockets) socket.close();
  console.log('PASS');
}

main().catch((err) => {
  console.error(`FAIL: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
