/**
 * Core domain types shared by the server (authoritative) and the client (views).
 */

export const COLORS = ['red', 'yellow', 'green', 'blue'] as const;
export type CardColor = (typeof COLORS)[number];

export type CardKind =
  | 'number'
  | 'skip'
  | 'reverse'
  | 'draw2'
  | 'wild'
  | 'wild4';

/** A wild card has no intrinsic colour; `color` is undefined until it is played. */
export interface Card {
  id: string;
  kind: CardKind;
  /** Undefined for wild / wild4. */
  color?: CardColor;
  /** 0-9, only for kind === 'number'. */
  value?: number;
}

export interface HouseRules {
  /** Number of cards dealt to each player. */
  handSize: number;
  /** Allow answering a +2 with another +2 (and +4 with +4), passing the stack on. */
  stacking: boolean;
  /** Keep drawing until a playable card turns up, instead of drawing exactly one. */
  drawToMatch: boolean;
  /** Playing a 7 swaps hands with a chosen player; a 0 rotates all hands. */
  sevenZero: boolean;
  /** Score is kept across rounds; first to `targetScore` wins the match. */
  scoring: boolean;
  targetScore: number;
}

export const DEFAULT_RULES: HouseRules = {
  handSize: 7,
  stacking: true,
  drawToMatch: false,
  sevenZero: false,
  scoring: true,
  targetScore: 500,
};

export interface Player {
  id: string;
  name: string;
  /** Stable identity across reconnects. Never leaves the server. */
  token: string;
  hand: Card[];
  connected: boolean;
  /** True once the player has declared UNO for their current 1-card hand. */
  saidUno: boolean;
  /** Cumulative score across rounds. */
  score: number;
  isHost: boolean;
}

export type GamePhase = 'lobby' | 'playing' | 'roundOver' | 'matchOver';

export interface LogEntry {
  id: number;
  text: string;
  at: number;
}

export interface GameState {
  code: string;
  phase: GamePhase;
  rules: HouseRules;
  players: Player[];
  /** Index into `players` whose turn it is. */
  turn: number;
  /** 1 = clockwise (ascending index), -1 = counter-clockwise. */
  direction: 1 | -1;
  drawPile: Card[];
  discardPile: Card[];
  /** Active colour — differs from the top card's colour after a wild. */
  activeColor: CardColor | null;
  /** Cards the current player must draw unless they stack onto them. */
  pendingDraw: number;
  /** Which kind of penalty is stacked, so +2 can't be answered with +4. */
  pendingDrawKind: 'draw2' | 'wild4' | null;
  /** The current player has taken their draw this turn and may only play that card or pass. */
  hasDrawn: boolean;
  /** Card ids the current player is allowed to play after drawing (subset of hand). */
  drawnPlayable: string[];
  /**
   * Player who just went down to one card and has not yet been safe.
   * Anyone may catch them until they declare or the turn moves on twice.
   */
  unoVulnerable: string | null;
  roundWinner: string | null;
  matchWinner: string | null;
  log: LogEntry[];
  nextLogId: number;
  createdAt: number;
}

/* ------------------------------------------------------------------ *
 * Client-facing views: other players' hands are reduced to a count.
 * ------------------------------------------------------------------ */

export interface PublicPlayer {
  id: string;
  name: string;
  handCount: number;
  connected: boolean;
  saidUno: boolean;
  score: number;
  isHost: boolean;
}

export interface GameView {
  code: string;
  phase: GamePhase;
  rules: HouseRules;
  players: PublicPlayer[];
  turn: number;
  direction: 1 | -1;
  drawPileCount: number;
  discardCount: number;
  topCard: Card | null;
  activeColor: CardColor | null;
  pendingDraw: number;
  pendingDrawKind: 'draw2' | 'wild4' | null;
  hasDrawn: boolean;
  unoVulnerable: string | null;
  roundWinner: string | null;
  matchWinner: string | null;
  log: LogEntry[];
  /** The receiving player. */
  you: {
    id: string;
    hand: Card[];
    isHost: boolean;
    /** Card ids that are legal to play right now. */
    playable: string[];
    isYourTurn: boolean;
  };
}

/* ------------------------------------------------------------------ *
 * Actions (client -> server)
 * ------------------------------------------------------------------ */

export type Action =
  | { type: 'start' }
  | { type: 'play'; cardId: string; chosenColor?: CardColor; targetPlayerId?: string }
  | { type: 'draw' }
  | { type: 'pass' }
  | { type: 'sayUno' }
  | { type: 'callOut'; playerId: string }
  | { type: 'nextRound' }
  | { type: 'updateRules'; rules: Partial<HouseRules> };

export interface ActionResult {
  ok: boolean;
  error?: string;
}
