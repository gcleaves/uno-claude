import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from '../src/logger.js';

const scratch = () => mkdtempSync(path.join(tmpdir(), 'uno-log-'));

function readLines(dir: string): Array<Record<string, unknown>> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) =>
      readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    );
}

test('each event is one self-contained JSON object per line', async () => {
  const dir = scratch();
  const log = createLogger(dir);
  log.info('room.create', { room: 'ABC123', actor: 'p1' });
  log.warn('limit.tripped', { ip: '1.2.3.4', detail: 'game:action' });
  await log.close();

  const raw = readFileSync(path.join(dir, readdirSync(dir)[0]!), 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), 'every line parses on its own');
    assert.equal(line.includes('\n'), false);
  }
});

test('every line carries the same core fields, with stable types', async () => {
  // DuckDB infers a column type by sampling; a field that is a string in one
  // line and a number in another turns the column into a union or an error.
  const dir = scratch();
  const log = createLogger(dir);
  log.info('room.create', { room: 'ABC123', actor: 'p1', players: 2 });
  log.debug('action', { room: 'ABC123', actor: 'p1', detail: 'play', ok: true, ms: 3 });
  log.error('server.error', { detail: 'boom' });
  await log.close();

  for (const line of readLines(dir)) {
    assert.equal(typeof line.ts, 'string');
    assert.equal(typeof line.level, 'string');
    assert.equal(typeof line.event, 'string');
    assert.ok(!Number.isNaN(Date.parse(line.ts as string)), 'ts is a parseable instant');
    for (const [key, expected] of Object.entries({
      room: 'string',
      actor: 'string',
      name: 'string',
      ip: 'string',
      detail: 'string',
      count: 'number',
      ms: 'number',
      players: 'number',
      ok: 'boolean',
    })) {
      if (key in line) assert.equal(typeof line[key], expected, `${key} in ${line.event}`);
    }
  }
});

test('nothing nested is emitted, so every column is directly queryable', async () => {
  const dir = scratch();
  const log = createLogger(dir);
  log.info('room.join', { room: 'ABC123', actor: 'p1', name: 'Ada', players: 3 });
  await log.close();

  for (const line of readLines(dir)) {
    for (const [key, value] of Object.entries(line)) {
      assert.ok(
        value === null || ['string', 'number', 'boolean'].includes(typeof value),
        `${key} is ${typeof value}; nested values make SQL awkward`,
      );
    }
  }
});

test('the level threshold filters, and warnings always get through', async () => {
  const dir = scratch();
  const log = createLogger(dir, 'warn');
  log.debug('action', { detail: 'noisy' });
  log.info('room.create', {});
  log.warn('limit.tripped', {});
  log.error('server.error', {});
  await log.close();

  const events = readLines(dir).map((l) => l.event);
  assert.deepEqual(events, ['limit.tripped', 'server.error']);
});

test('logging is disabled cleanly when no directory is configured', () => {
  const log = createLogger('');
  assert.doesNotThrow(() => log.info('room.create', { room: 'X' }));
});

test('an unwritable directory degrades instead of taking the server down', () => {
  const dir = scratch();
  const blocked = path.join(dir, 'nested');
  writeFileSync(blocked, 'not a directory');
  const log = createLogger(blocked);

  // mkdir over a regular file fails; the logger must swallow it.
  assert.doesNotThrow(() => log.info('room.create', { room: 'X' }));
  assert.doesNotThrow(() => log.info('room.create', { room: 'Y' }));
  chmodSync(blocked, 0o644);
});

test('old files are pruned and current ones are kept', async () => {
  const dir = scratch();
  const stale = path.join(dir, 'uno-2000-01-01.jsonl');
  writeFileSync(stale, '{"ts":"2000-01-01T00:00:00.000Z","level":"info","event":"old"}\n');
  const unrelated = path.join(dir, 'notes.txt');
  writeFileSync(unrelated, 'leave me alone');

  const log = createLogger(dir);
  log.info('server.start', {});
  await log.close();

  assert.equal(existsSync(stale), false, 'a log older than the retention window goes');
  assert.equal(existsSync(unrelated), true, 'anything that is not a log file is left alone');
  assert.ok(readdirSync(dir).some((f) => /^uno-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)));
});

test('DuckDB can query the logs without any coaxing', async () => {
  // The whole point of the format, so it is checked against the real thing
  // rather than assumed from the shape of the JSON.
  const dir = scratch();
  const log = createLogger(dir);
  log.info('room.create', { room: 'ABC123', actor: 'p1' });
  log.info('room.join', { room: 'ABC123', actor: 'p2', name: 'Ada', players: 2 });
  log.info('game.round_end', { room: 'ABC123', actor: 'p1', players: 2, count: 42, ms: 91_000 });
  log.warn('limit.tripped', { ip: '1.2.3.4', detail: 'game:join' });
  await log.close();

  const glob = path.join(dir, '*.jsonl');
  const sql = `
    SELECT event, count(*) AS n
    FROM read_json_auto('${glob}', union_by_name = true)
    WHERE level = 'info'
    GROUP BY event ORDER BY event;
  `;
  const out = execFileSync('duckdb', ['-csv', '-c', sql], { encoding: 'utf8' });
  assert.match(out, /game\.round_end,1/);
  assert.match(out, /room\.create,1/);
  assert.match(out, /room\.join,1/);
  assert.equal(out.includes('limit.tripped'), false, 'the WHERE clause filtered it');

  // Timestamps must survive as timestamps, not strings, for time-series work.
  const tsSql = `
    SELECT typeof(CAST(ts AS TIMESTAMP)) AS t,
           round(avg(ms) / 1000) AS avg_round_sec
    FROM read_json_auto('${glob}', union_by_name = true)
    WHERE event = 'game.round_end' GROUP BY t;
  `;
  const tsOut = execFileSync('duckdb', ['-csv', '-c', tsSql], { encoding: 'utf8' });
  assert.match(tsOut, /TIMESTAMP,91/);
});
