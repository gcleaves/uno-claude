import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addPlayer,
  applyAction,
  canChallenge,
  createGame,
  current,
  handPoints,
  legalPlays,
  mulberry32,
  startRound,
  type Action,
  type CardColor,
  type GameState,
  type HouseRules,
} from '../src/index.js';

const COLORS: CardColor[] = ['red', 'yellow', 'green', 'blue'];

/** Every card must be somewhere: a hand, the draw pile, or the discard pile. */
function totalCards(state: GameState): number {
  return (
    state.drawPile.length +
    state.discardPile.length +
    state.players.reduce((n, p) => n + p.hand.length, 0)
  );
}

/**
 * Plays a full round with players choosing uniformly at random among legal moves.
 * Returns the number of actions it took, or throws if the game wedged.
 */
function playRound(seed: number, playerCount: number, rules: Partial<HouseRules>): number {
  const rng = mulberry32(seed);
  const state = createGame('SOAK', rules);
  for (let i = 0; i < playerCount; i++) {
    addPlayer(state, { id: `p${i}`, name: `p${i}`, token: `p${i}` });
  }
  assert.equal(startRound(state, rng).ok, true);

  let steps = 0;
  const limit = 20_000;

  while (state.phase === 'playing') {
    if (++steps > limit) {
      throw new Error(`round did not finish in ${limit} actions (seed ${seed})`);
    }
    assert.equal(totalCards(state), 108, `cards leaked at step ${steps} (seed ${seed})`);

    const player = current(state);
    const legal = legalPlays(state, player);
    let action: Action;

    if (legal.length > 0 && rng() < 0.9) {
      const cardId = legal[Math.floor(rng() * legal.length)]!;
      const card = player.hand.find((c) => c.id === cardId)!;
      action = {
        type: 'play',
        cardId,
        chosenColor: COLORS[Math.floor(rng() * 4)]!,
        // Harmless when the rule is off; exercises the swap when it is on.
        targetPlayerId: state.players.find((p) => p.id !== player.id)!.id,
      };
      // Declare UNO about half the time, so both branches get exercised.
      if (player.hand.length === 2 && rng() < 0.5) {
        applyAction(state, player.id, { type: 'sayUno' }, rng);
      }
    } else if (state.hasDrawn) {
      action = { type: 'pass' };
    } else {
      action = { type: 'draw' };
    }

    const result = applyAction(state, player.id, action, rng);
    assert.equal(
      result.ok,
      true,
      `legal action rejected (seed ${seed}, step ${steps}): ${result.error}`,
    );

    // Sometimes call the bluff on a +4 rather than taking the cards.
    if (state.phase === 'playing' && rng() < 0.35) {
      const challenger = current(state);
      if (canChallenge(state, challenger)) {
        const result = applyAction(state, challenger.id, { type: 'challenge' }, rng);
        assert.equal(result.ok, true, `challenge rejected (seed ${seed}): ${result.error}`);
      }
    }

    // Someone who forgot to call gets caught by a neighbour.
    if (state.unoVulnerable && rng() < 0.3) {
      const catcher = state.players.find((p) => p.id !== state.unoVulnerable);
      if (catcher) applyAction(state, catcher.id, { type: 'callOut', playerId: state.unoVulnerable }, rng);
    }
  }

  assert.ok(state.roundWinner, `round ended with no winner (seed ${seed})`);
  const winner = state.players.find((p) => p.id === state.roundWinner)!;
  assert.equal(winner.hand.length, 0);
  assert.equal(totalCards(state), 108);
  if (state.rules.scoring) {
    const expected = state.players
      .filter((p) => p.id !== winner.id)
      .reduce((n, p) => n + handPoints(p.hand), 0);
    assert.equal(winner.score, expected);
  }
  return steps;
}

const VARIANTS: Array<{ name: string; rules: Partial<HouseRules> }> = [
  { name: 'default rules', rules: {} },
  { name: 'no stacking', rules: { stacking: false } },
  { name: 'draw until playable', rules: { drawToMatch: true } },
  { name: 'sevens and zeros', rules: { sevenZero: true } },
  { name: 'everything on', rules: { stacking: true, drawToMatch: true, sevenZero: true } },
  { name: 'no challenges', rules: { challenges: false } },
];

for (const variant of VARIANTS) {
  test(`500 random rounds finish cleanly: ${variant.name}`, () => {
    let steps = 0;
    for (let seed = 1; seed <= 500; seed++) {
      const players = 2 + (seed % 5); // 2 through 6 players
      steps += playRound(seed, players, variant.rules);
    }
    assert.ok(steps > 0);
  });
}

test('a two-player round still terminates when both players stall', () => {
  // Worst case for progress: few legal plays, constant drawing and reshuffling.
  for (let seed = 1; seed <= 200; seed++) {
    playRound(seed * 7919, 2, { handSize: 15, stacking: true });
  }
});
