import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRealUnoCall } from '../src/screens/Game.js';

/**
 * The UNO button is always clickable, so this predicate is the only thing
 * standing between an impatient player and a stream of duplicate events. The
 * export that prompted it showed twelve in four seconds.
 */
test('only the first press, on your last card, counts', () => {
  assert.equal(isRealUnoCall({ handCount: 1, saidUno: false }), true, 'the real moment');
  assert.equal(isRealUnoCall({ handCount: 1, saidUno: true }), false, 'already declared');
  assert.equal(isRealUnoCall({ handCount: 2, saidUno: false }), false, 'not down to one yet');
  assert.equal(isRealUnoCall({ handCount: 7, saidUno: false }), false, 'a full hand');
  assert.equal(isRealUnoCall({ handCount: 0, saidUno: false }), false, 'already out');
  assert.equal(isRealUnoCall(undefined), false, 'not seated');
});

test('mashing it produces exactly one event', () => {
  // Simulates the button being pressed repeatedly: the server flips saidUno on
  // the first accepted call, so every later press is filtered out here.
  let saidUno = false;
  let events = 0;
  for (let press = 0; press < 12; press++) {
    if (isRealUnoCall({ handCount: 1, saidUno })) {
      events++;
      saidUno = true; // what the server does in response
    }
  }
  assert.equal(events, 1, 'twelve presses, one event');
});
