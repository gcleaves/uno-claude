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
  /**
   * A Wild Draw Four may only be played when you hold nothing of the current
   * colour. With this on, the next player may call the bluff instead of drawing.
   */
  challenges: boolean;
  /** Score is kept across rounds; first to `targetScore` wins the match. */
  scoring: boolean;
  targetScore: number;
}

export const DEFAULT_RULES: HouseRules = {
  handSize: 7,
  stacking: true,
  drawToMatch: false,
  sevenZero: false,
  challenges: true,
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

/**
 * Log messages travel as a key plus values, never as prose: the server has no
 * idea what language each player is reading in, so the words are chosen on the
 * client. Same reasoning as ErrorCode below.
 */
export type LogKey =
  | 'joined'
  | 'left'
  | 'newHost'
  | 'backToLobby'
  | 'roundStart'
  | 'skipped'
  | 'drawsAndSkipped'
  | 'reversedFirst'
  | 'played'
  | 'playedWild'
  | 'playsAgain'
  | 'reversed'
  | 'swappedHands'
  | 'rotatedHands'
  | 'drawsAndLosesTurn'
  | 'couldNotDraw'
  | 'drewCard'
  | 'drewCards'
  | 'passed'
  | 'callsUno'
  | 'caught'
  | 'winsRoundScoring'
  | 'winsRound'
  | 'winsMatch'
  | 'reshuffled'
  | 'ranOutOfTime'
  | 'ranOutOfTimeTakes'
  | 'serverRestarted'
  | 'challengeUpheld'
  | 'challengeFailed';

export interface LogEntry {
  id: number;
  at: number;
  key: LogKey;
  /** Names, counts and colours the message refers to. */
  params?: Record<string, string | number>;
  /** A card the message names, so the reader sees it in their own language. */
  card?: Card;
}

/** Rejection reasons, as codes for the same reason log messages are keys. */
export type ErrorCode =
  | 'notInGame'
  | 'roomFull'
  | 'alreadyStarted'
  | 'notHost'
  | 'gameRunning'
  | 'gameNotRunning'
  | 'roundNotOver'
  | 'finishRoundFirst'
  | 'needTwoPlayers'
  | 'notYourTurn'
  | 'cardNotInHand'
  | 'mustDrawPenalty'
  | 'onlyDrawnCard'
  | 'cardNoMatch'
  | 'pickColour'
  | 'unknownColour'
  | 'alreadyDrawn'
  | 'mustDrawFirst'
  | 'tooManyCardsForUno'
  | 'cannotCatchSelf'
  | 'nothingToCatch'
  | 'unknownPlayer'
  | 'noChallenge'
  | 'challengesDisabled'
  | 'noSuchRoom'
  | 'couldNotJoin'
  | 'badCode'
  | 'notConnected'
  | 'noResponse'
  | 'lostSeat';

export interface GameState {
  code: string;
  phase: GamePhase;
  rules: HouseRules;
  players: Player[];
  /** Index into `players` whose turn it is. */
  turn: number;
  /**
   * Increments every time the turn moves. Lets callers tell "it is your turn
   * now" apart from "it was your turn one lap ago", which the index alone
   * cannot express.
   */
  turnSeq: number;
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
  /**
   * The Wild Draw Four now facing the current player, and whether it was
   * played legally. Recorded when it is played, because by the time anyone
   * challenges, the evidence — the player's hand at that moment — has moved on.
   */
  wild4: { playerId: string; legal: boolean } | null;
  /**
   * Outcome of the last challenge, including the hand that was shown. Sent only
   * to the challenger, who under the official rule is the one entitled to see it.
   */
  challengeResult: {
    id: number;
    challengerId: string;
    accusedId: string;
    /** True when the accused was bluffing and the challenge succeeded. */
    upheld: boolean;
    /**
     * How many cards the loser actually drew. Carried explicitly because the
     * pending penalty is cleared by the time anyone reads this.
     */
    drawn: number;
    revealed: Card[];
  } | null;
  /** The current player has taken their draw this turn and may only play that card or pass. */
  hasDrawn: boolean;
  /** Card ids the current player is allowed to play after drawing (subset of hand). */
  drawnPlayable: string[];
  /**
   * Players down to one card who never said UNO, and can still be caught.
   * Under the official rule the window shuts as soon as the next player begins
   * their turn, so in practice this holds at most one player — it stays a list
   * because it describes who is catchable, not how the window is timed.
   */
  unoVulnerable: string[];
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
  /** True when this player may challenge the Wild Draw Four facing them. */
  canChallenge: boolean;
  /** Only ever populated for the challenger. */
  challengeResult: GameState['challengeResult'];
  /*
   * There is deliberately no `unoVulnerable` here. Spotting that someone went
   * quiet on their last card is the opponents' job, so the client is not told —
   * not even in a field it chooses not to draw, which devtools would happily
   * reveal. What players get is what they would have at a real table: the card
   * counts, and whether each player was heard to declare.
   */
  roundWinner: string | null;
  matchWinner: string | null;
  log: LogEntry[];
  /**
   * Milliseconds left for the current player to act before the server forces
   * the game on, or null when no clock is running. Sent as a duration rather
   * than a timestamp so it does not depend on the client's clock being right.
   */
  turnRemainingMs: number | null;
  /** How long the running clock started at, for drawing a progress bar. */
  turnTotalMs: number | null;
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
  | { type: 'challenge' }
  | { type: 'pass' }
  | { type: 'sayUno' }
  | { type: 'callOut'; playerId: string }
  | { type: 'nextRound' }
  | { type: 'updateRules'; rules: Partial<HouseRules> };

export interface ActionResult {
  ok: boolean;
  error?: ErrorCode;
  /** Values the message needs, e.g. how many cards are owed. */
  errorParams?: Record<string, string | number>;
}
