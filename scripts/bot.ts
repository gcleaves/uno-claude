/**
 * A minimal auto-playing client, handy for filling a table while testing.
 *
 *   npx tsx scripts/bot.ts ABCD Robot          # join room ABCD
 *   npx tsx scripts/bot.ts ABCD Robot --start  # ...and start the round once seated
 *
 * It plays the first legal card it holds, draws otherwise, and remembers to
 * call UNO — which makes it a useful opponent for exercising the rules, not a
 * good one.
 */
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';
import { COLORS, type Card, type CardColor, type GameView } from '@uno/shared';

const [code, name = 'Bot', ...flags] = process.argv.slice(2);
if (!code) {
  console.error('usage: tsx scripts/bot.ts <ROOM CODE> [name] [--start]');
  process.exit(1);
}
const autoStart = flags.includes('--start');
const url = process.env.UNO_URL ?? 'http://localhost:3001';
const thinkMs = Number(process.env.BOT_DELAY_MS ?? 900);

const socket = io(url, {
  auth: { token: `guest_${randomUUID()}`, name },
  transports: ['websocket'],
});

let acting = false;

socket.on('connect', () => {
  socket.emit('room:join', { code: code.toUpperCase(), name }, (res: { ok: boolean; error?: string }) => {
    if (!res.ok) {
      console.error(`${name}: ${res.error}`);
      process.exit(1);
    }
    console.log(`${name} joined ${code.toUpperCase()}`);
    if (autoStart) setTimeout(() => socket.emit('game:action', { type: 'start' }), 500);
  });
});

socket.on('state', (view: GameView) => {
  if (view.phase !== 'playing' || !view.you.isYourTurn || acting) return;
  acting = true;
  setTimeout(() => {
    takeTurn(view);
    acting = false;
  }, thinkMs);
});

socket.on('connect_error', (e) => console.error(`${name}: ${e.message}`));

function takeTurn(view: GameView) {
  const hand = view.you.hand;
  // BOT_BLUFF=1 makes it lead with Wild Draw Four whenever it can, which is how
  // you get a challengeable play on demand while testing.
  const bluff = process.env.BOT_BLUFF
    ? view.you.playable.find((id) => hand.find((c) => c.id === id)?.kind === 'wild4')
    : undefined;
  const playableId = bluff ?? view.you.playable[0];

  if (!playableId) {
    socket.emit('game:action', { type: view.hasDrawn ? 'pass' : 'draw' });
    return;
  }

  const card = hand.find((c) => c.id === playableId)!;
  if (hand.length === 2) socket.emit('game:action', { type: 'sayUno' });

  socket.emit('game:action', {
    type: 'play',
    cardId: card.id,
    chosenColor: isWild(card) ? bestColor(hand) : undefined,
    targetPlayerId: view.players.find((p) => p.id !== view.you.id)?.id,
  });
}

function isWild(card: Card): boolean {
  return card.kind === 'wild' || card.kind === 'wild4';
}

/** Call whichever colour the bot holds most of. */
function bestColor(hand: Card[]): CardColor {
  const counts = new Map<CardColor, number>(COLORS.map((c) => [c, 0]));
  for (const c of hand) if (c.color) counts.set(c.color, (counts.get(c.color) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}
