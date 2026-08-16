import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import type { GameView } from '@uno/shared';

const url = process.argv[2] ?? 'http://localhost:3001';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const conn = (name: string) => new Promise<Socket>((res, rej) => {
  const s = io(url, { auth: { token: `guest_${randomUUID()}`, name }, transports: ['websocket'] });
  s.once('connect', () => res(s)); s.once('connect_error', rej);
});
const ask = <T,>(s: Socket, ev: string, p?: unknown): Promise<T> =>
  new Promise((r) => s.emit(ev, p, (x: T) => r(x)));

const me = await conn('Human');      // never calls UNO
const bot = await conn('Robo');      // plays on, and catches

const created = await ask<{ code: string }>(me, 'room:create', { name: 'Human' });
const code = created.code;
await ask(bot, 'room:join', { code, name: 'Robo' });
await ask(me, 'game:action', { type: 'updateRules', rules: { handSize: 2 } });

let caught = false, myCards = 99, sawWindow = false;
me.on('state', (v: GameView) => {
  myCards = v.you.hand.length;
  if (v.unoVulnerable.includes(v.you.id)) sawWindow = true;
});
// The bot behaves like scripts/bot.ts now does.
bot.on('state', (v: GameView) => {
  const victim = v.unoVulnerable.find((id) => id !== v.you.id);
  if (victim) { caught = true; bot.emit('game:action', { type: 'callOut', playerId: victim }); }
  if (v.phase === 'playing' && v.you.isYourTurn) {
    const id = v.you.playable[0];
    setTimeout(() => bot.emit('game:action',
      id ? { type: 'play', cardId: id, chosenColor: 'red' } : { type: v.hasDrawn ? 'pass' : 'draw' }), 250);
  }
});

await ask(me, 'game:action', { type: 'start' });
// Play one card and then deliberately stay silent.
for (let i = 0; i < 25 && !caught; i++) {
  await wait(300);
  const v = await new Promise<GameView>((r) => { me.once('state', r); me.emit('game:action', { type: 'noop' } as never); });
  if (v.phase !== 'playing' || !v.you.isYourTurn) continue;
  const id = v.you.playable[0];
  me.emit('game:action', id ? { type: 'play', cardId: id, chosenColor: 'red' } : { type: v.hasDrawn ? 'pass' : 'draw' });
}
await wait(1500);
console.log(`window opened on me: ${sawWindow}`);
console.log(`bot called me out  : ${caught}`);
console.log(`my hand ended at   : ${myCards} cards`);
process.exit(0);
