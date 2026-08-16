import { COLORS, type Card, type CardColor } from './types.js';

/** Deterministic PRNG so games can be replayed/tested from a seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

/**
 * A standard 108-card deck:
 *   per colour: one 0, two each of 1-9, two Skip, two Reverse, two Draw Two  (25 x 4 = 100)
 *   plus four Wild and four Wild Draw Four                                   (8)
 */
export function buildDeck(): Card[] {
  const deck: Card[] = [];
  let n = 0;
  const push = (c: Omit<Card, 'id'>) => deck.push({ ...c, id: `c${n++}` });

  for (const color of COLORS) {
    push({ kind: 'number', color, value: 0 });
    for (let v = 1; v <= 9; v++) {
      push({ kind: 'number', color, value: v });
      push({ kind: 'number', color, value: v });
    }
    for (const kind of ['skip', 'reverse', 'draw2'] as const) {
      push({ kind, color });
      push({ kind, color });
    }
  }
  for (let i = 0; i < 4; i++) push({ kind: 'wild' });
  for (let i = 0; i < 4; i++) push({ kind: 'wild4' });

  return deck;
}

/** Fisher-Yates, in place, returns the same array for convenience. */
export function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = items[i]!;
    const b = items[j]!;
    items[i] = b;
    items[j] = a;
  }
  return items;
}

export function isWild(card: Card): boolean {
  return card.kind === 'wild' || card.kind === 'wild4';
}

/** Can `card` be played on top of `top`, given the currently active colour? */
export function canPlay(
  card: Card,
  top: Card | null,
  activeColor: CardColor | null,
): boolean {
  if (isWild(card)) return true;
  if (!top) return true;
  if (card.color && card.color === activeColor) return true;
  if (card.kind === 'number' && top.kind === 'number') return card.value === top.value;
  if (card.kind !== 'number' && card.kind === top.kind) return true;
  return false;
}

/** Official scoring: numbers face value, action cards 20, wilds 50. */
export function cardPoints(card: Card): number {
  switch (card.kind) {
    case 'number':
      return card.value ?? 0;
    case 'skip':
    case 'reverse':
    case 'draw2':
      return 20;
    case 'wild':
    case 'wild4':
      return 50;
  }
}

export function handPoints(hand: Card[]): number {
  return hand.reduce((sum, c) => sum + cardPoints(c), 0);
}

export function describeCard(card: Card): string {
  const color = card.color ? card.color[0]!.toUpperCase() + card.color.slice(1) : '';
  switch (card.kind) {
    case 'number':
      return `${color} ${card.value}`;
    case 'skip':
      return `${color} Skip`;
    case 'reverse':
      return `${color} Reverse`;
    case 'draw2':
      return `${color} Draw Two`;
    case 'wild':
      return 'Wild';
    case 'wild4':
      return 'Wild Draw Four';
  }
}
