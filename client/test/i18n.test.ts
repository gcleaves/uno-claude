import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Card, ErrorCode, LogKey } from '@uno/shared';
import { en } from '../src/i18n/en.js';
import { es } from '../src/i18n/es.js';
import { it } from '../src/i18n/it.js';
import { cardName, type Strings } from '../src/i18n/strings.js';

/**
 * The Strings type already makes a missing key a compile error. These tests
 * cover what types cannot: a translation that dropped a placeholder, so the
 * player's name or the number of cards silently vanishes from the sentence.
 */

const LOCALES: Array<[string, Strings]> = [
  ['en', en],
  ['es', es],
  ['it', it],
];

const SAMPLE = { name: 'Ada', target: 'Bo', count: 7, gained: 42, total: 99, colour: 'red' };
const SAMPLE_CARD = 'Red 5';

function logKeys(s: Strings): LogKey[] {
  return Object.keys(s.log) as LogKey[];
}
function errorKeys(s: Strings): ErrorCode[] {
  return Object.keys(s.error) as ErrorCode[];
}

test('every locale defines exactly the same keys', () => {
  const reference = { log: logKeys(en).sort(), error: errorKeys(en).sort() };
  for (const [code, s] of LOCALES) {
    assert.deepEqual(logKeys(s).sort(), reference.log, `${code} log keys`);
    assert.deepEqual(errorKeys(s).sort(), reference.error, `${code} error keys`);
  }
});

test('every message renders to something non-empty', () => {
  for (const [code, s] of LOCALES) {
    for (const key of logKeys(s)) {
      const out = s.log[key](SAMPLE, SAMPLE_CARD);
      assert.ok(out.trim().length > 0, `${code} log.${key} is empty`);
      assert.ok(!out.includes('undefined'), `${code} log.${key} leaked undefined: ${out}`);
    }
    for (const key of errorKeys(s)) {
      const out = s.error[key](SAMPLE, '');
      assert.ok(out.trim().length > 0, `${code} error.${key} is empty`);
      assert.ok(!out.includes('undefined'), `${code} error.${key} leaked undefined: ${out}`);
    }
  }
});

test('translations keep the placeholders the English version uses', () => {
  // If English mentions the player, so must every other language — otherwise a
  // Spanish reader sees "jugó Rosso 5" with no idea who did it.
  for (const key of logKeys(en)) {
    const reference = en.log[key](SAMPLE, SAMPLE_CARD);
    for (const [code, s] of LOCALES) {
      const out = s.log[key](SAMPLE, SAMPLE_CARD);
      for (const [param, value] of Object.entries(SAMPLE)) {
        if (!reference.includes(String(value))) continue;
        assert.ok(
          out.includes(String(value)),
          `${code} log.${key} dropped "${param}": ${out}`,
        );
      }
      if (reference.includes(SAMPLE_CARD)) {
        assert.ok(out.includes(SAMPLE_CARD), `${code} log.${key} dropped the card: ${out}`);
      }
    }
  }

  for (const key of errorKeys(en)) {
    const reference = en.error[key](SAMPLE, '');
    if (!reference.includes(String(SAMPLE.count))) continue;
    for (const [code, s] of LOCALES) {
      const out = s.error[key](SAMPLE, '');
      assert.ok(out.includes(String(SAMPLE.count)), `${code} error.${key} dropped the count: ${out}`);
    }
  }
});

test('cards are named in the reader language', () => {
  const red5: Card = { id: 'x', kind: 'number', color: 'red', value: 5 };
  const wild4: Card = { id: 'y', kind: 'wild4' };
  const skip: Card = { id: 'z', kind: 'skip', color: 'blue' };

  assert.equal(cardName(red5, en), 'Red 5');
  assert.equal(cardName(red5, es), 'Rojo 5');
  assert.equal(cardName(red5, it), 'Rosso 5');

  assert.equal(cardName(wild4, en), 'Wild Draw Four');
  assert.equal(cardName(wild4, es), 'Comodín Roba Cuatro');
  assert.equal(cardName(wild4, it), 'Jolly Pesca Quattro');

  // A wild has no colour, so its name must not start with a stray space.
  for (const [, s] of LOCALES) {
    assert.equal(cardName(wild4, s), cardName(wild4, s).trim());
    assert.ok(cardName(skip, s).includes(s.colour.blue));
  }
});

test('no locale silently falls back to the English text', () => {
  // A copy-paste that forgot to translate is easy to miss by eye.
  for (const [code, s] of LOCALES) {
    if (code === 'en') continue;
    const identical = logKeys(s).filter(
      (key) => s.log[key](SAMPLE, SAMPLE_CARD) === en.log[key](SAMPLE, SAMPLE_CARD),
    );
    assert.deepEqual(identical, [], `${code} has untranslated log messages`);

    assert.notEqual(s.ui.draw, en.ui.draw, `${code} ui.draw is untranslated`);
    assert.notEqual(s.ui.yourTurn, en.ui.yourTurn, `${code} ui.yourTurn is untranslated`);
  }
});
