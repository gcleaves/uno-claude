import { COLORS, type Action, type CardColor, type HouseRules } from '@uno/shared';

/**
 * Everything arriving over a socket is attacker-controlled, including the shape.
 * Nothing reaches the engine until it has been proven to be one of the actions
 * the engine actually understands.
 */

/** Card and player ids are opaque strings; cap them so nothing unbounded is stored. */
const MAX_ID = 64;

function str(v: unknown, max = MAX_ID): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

function colour(v: unknown): CardColor | null {
  return typeof v === 'string' && (COLORS as readonly string[]).includes(v)
    ? (v as CardColor)
    : null;
}

const RULE_BOOLS = ['stacking', 'drawToMatch', 'sevenZero', 'challenges', 'scoring'] as const;
const RULE_NUMS = ['handSize', 'targetScore'] as const;

/** Returns a well-formed Action, or null if the payload is anything else. */
export function parseAction(raw: unknown): Action | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Record<string, unknown>;

  switch (a.type) {
    case 'start':
    case 'draw':
    case 'pass':
    case 'sayUno':
    case 'challenge':
    case 'nextRound':
      return { type: a.type };

    case 'play': {
      const cardId = str(a.cardId);
      if (!cardId) return null;
      const chosenColor = a.chosenColor === undefined ? undefined : colour(a.chosenColor);
      if (a.chosenColor !== undefined && !chosenColor) return null;
      const targetPlayerId = a.targetPlayerId === undefined ? undefined : str(a.targetPlayerId);
      if (a.targetPlayerId !== undefined && !targetPlayerId) return null;
      return {
        type: 'play',
        cardId,
        ...(chosenColor && { chosenColor }),
        ...(targetPlayerId && { targetPlayerId }),
      };
    }

    case 'callOut': {
      const playerId = str(a.playerId);
      return playerId ? { type: 'callOut', playerId } : null;
    }

    case 'updateRules': {
      if (typeof a.rules !== 'object' || a.rules === null) return null;
      const src = a.rules as Record<string, unknown>;
      const rules: Partial<HouseRules> = {};
      for (const key of RULE_BOOLS) {
        if (key in src) {
          if (typeof src[key] !== 'boolean') return null;
          rules[key] = src[key] as boolean;
        }
      }
      for (const key of RULE_NUMS) {
        if (key in src) {
          const n = src[key];
          // The engine clamps these; reject only what it cannot clamp.
          if (typeof n !== 'number' || !Number.isFinite(n)) return null;
          rules[key] = n;
        }
      }
      return { type: 'updateRules', rules };
    }

    default:
      return null;
  }
}

/** Room codes as typed by a person: letters and digits, of the expected length. */
export function parseRoomCode(raw: unknown, length: number): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return new RegExp(`^[A-Z0-9]{${length}}$`).test(code) ? code : null;
}
