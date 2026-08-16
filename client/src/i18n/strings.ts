import type { Card, CardColor, ErrorCode, LogKey } from '@uno/shared';

/**
 * Every piece of text the interface can show.
 *
 * Because the type spells out each key, a locale that forgets one fails to
 * compile rather than quietly falling back to English at runtime.
 */

export type Params = Record<string, string | number>;

/** `card` arrives already named in this locale. */
export type Fmt = (p: Params, card: string) => string;

export interface Strings {
  /** Shown in the language picker, in the language itself. */
  languageName: string;
  /** BCP 47 tag, used for `lang` and for number formatting. */
  locale: string;

  ui: {
    tagline: string;
    yourName: string;
    namePlaceholder: string;
    startNewGame: string;
    orJoinOne: string;
    codePlaceholder: string;
    codeLabel: string;
    join: string;

    leave: string;
    share: string;
    copied: string;
    gameCode: string;
    players: string;
    host: string;
    you: string;
    houseRules: string;
    hostOnly: string;
    cardsDealt: string;
    dealTheCards: string;
    waitingForPlayers: string;
    waitingForHost: string;

    ruleStacking: string;
    ruleStackingHint: string;
    ruleDrawToMatch: string;
    ruleDrawToMatchHint: string;
    ruleSevenZero: string;
    ruleSevenZeroHint: string;
    ruleChallenges: string;
    ruleChallengesHint: string;
    ruleScoring: string;
    ruleScoringHint: (target: number) => string;

    yourTurn: string;
    waitingFor: (name: string) => string;
    drawN: (n: number) => string;
    drawNOrStack: (n: number) => string;
    playDrawnOrPass: string;
    draw: string;
    pass: string;
    uno: string;
    catchThem: string;
    catchBanner: string;
    noCards: string;
    roundOver: string;
    matchOver: string;
    youWin: string;
    playerWins: (name: string) => string;
    nextRound: string;
    playAgain: string;
    leaveGame: string;
    gameLog: string;
    pickColour: string;
    swapWith: string;
    cancel: string;
    dismiss: string;
    connecting: string;
    reconnecting: string;
    clockLeftYours: string;
    clockLeftTheirs: string;
    language: string;
    clockwise: string;
    counterClockwise: string;
    drawPileLabel: (n: number) => string;
    faceDownCard: string;

    challenge: string;
    challengeHint: string;
    challengeWonTitle: string;
    challengeLostTitle: string;
    challengeWonBody: (name: string, n: number) => string;
    challengeLostBody: (name: string, n: number) => string;
    theirHandWas: string;
  };

  colour: Record<CardColor, string>;

  card: {
    skip: string;
    reverse: string;
    drawTwo: string;
    wild: string;
    wildFour: string;
  };

  log: Record<LogKey, Fmt>;
  error: Record<ErrorCode, Fmt>;
}

/** Name a card in the reader's language. */
export function cardName(card: Card, s: Strings): string {
  const colour = card.color ? s.colour[card.color] : '';
  switch (card.kind) {
    case 'number':
      return `${colour} ${card.value}`.trim();
    case 'skip':
      return `${colour} ${s.card.skip}`.trim();
    case 'reverse':
      return `${colour} ${s.card.reverse}`.trim();
    case 'draw2':
      return `${colour} ${s.card.drawTwo}`.trim();
    case 'wild':
      return s.card.wild;
    case 'wild4':
      return s.card.wildFour;
  }
}
