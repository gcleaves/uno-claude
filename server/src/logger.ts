import { createWriteStream, mkdirSync, readdirSync, unlinkSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Structured logging as newline-delimited JSON, one event per line, so the logs
 * can be queried directly:
 *
 *   SELECT * FROM read_json_auto('data/logs/*.jsonl', union_by_name = true);
 *
 * Two things make that pleasant rather than painful, and both are deliberate:
 *
 * 1. A field means the same thing everywhere and always has the same type.
 *    DuckDB infers a column's type by sampling; a field that is a number in one
 *    line and a string in another turns the column into a union or an error, so
 *    the shared fields below are fixed and everything else is namespaced.
 * 2. Nothing here may throw or block. A logger that can take down a game server
 *    is worse than no logger, so every failure degrades to stderr and carries on.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Fields every line carries. Anything event-specific goes alongside as a flat
 * scalar — objects and arrays are avoided so columns stay directly queryable.
 */
export interface LogFields {
  /** Room code the event belongs to. */
  room?: string;
  /** Pseudonymous player id. Never a name. */
  actor?: string;
  /** Player display name, only where it is operationally useful. */
  name?: string;
  /** Client address, recorded for abuse events. */
  ip?: string;
  /** Free-form short detail, e.g. a card description or an error code. */
  detail?: string;
  /** Counts and durations. */
  count?: number;
  ms?: number;
  players?: number;
  /** Whether the thing succeeded, for events that can fail. */
  ok?: boolean;
}

interface Line extends LogFields {
  ts: string;
  level: Level;
  event: string;
}

/** UTC day stamp, so rotation is not affected by the host's timezone. */
function daystamp(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export class Logger {
  private stream: WriteStream | null = null;
  private day = '';
  private threshold: number;
  private dir: string;
  private enabled: boolean;
  private warned = false;

  constructor(dir = config.logDir, level: Level = config.logLevel) {
    this.dir = dir;
    this.threshold = LEVELS[level] ?? LEVELS.info;
    this.enabled = dir.trim().length > 0;
  }

  private open(now: Date): WriteStream | null {
    if (!this.enabled) return null;
    const day = daystamp(now);
    if (this.stream && day === this.day) return this.stream;

    try {
      this.stream?.end();
      mkdirSync(this.dir, { recursive: true });
      this.stream = createWriteStream(path.join(this.dir, `uno-${day}.jsonl`), { flags: 'a' });
      // A failing sink must not become an unhandled error event.
      this.stream.on('error', (err) => this.degrade(err));
      this.day = day;
      this.prune(now);
      return this.stream;
    } catch (err) {
      this.degrade(err);
      return null;
    }
  }

  private degrade(err: unknown): void {
    this.stream = null;
    this.enabled = false;
    if (!this.warned) {
      this.warned = true;
      console.error('logging to disk disabled after an error:', err);
    }
  }

  /** Keep the log directory bounded without needing logrotate on the host. */
  private prune(now: Date): void {
    if (config.logRetentionDays <= 0) return;
    const cutoff = now.getTime() - config.logRetentionDays * 86_400_000;
    try {
      for (const file of readdirSync(this.dir)) {
        // The day comes from the name, not the mtime: copying or restoring a
        // log directory rewrites mtimes and would make old files look current.
        const match = /^uno-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
        if (!match) continue;
        const day = Date.parse(`${match[1]}T00:00:00Z`);
        if (Number.isFinite(day) && day < cutoff) unlinkSync(path.join(this.dir, file));
      }
    } catch {
      // Housekeeping is best-effort; never let it interrupt serving a game.
    }
  }

  log(level: Level, event: string, fields: LogFields = {}): void {
    if (LEVELS[level] < this.threshold) return;
    const now = new Date();
    const line: Line = { ts: now.toISOString(), level, event, ...fields };

    // Errors and warnings also go to stdout so `docker compose logs` shows them.
    if (LEVELS[level] >= LEVELS.warn) {
      console.error(`[${level}] ${event}`, JSON.stringify(fields));
    }

    const stream = this.open(now);
    if (!stream) return;
    try {
      stream.write(`${JSON.stringify(line)}\n`);
    } catch (err) {
      this.degrade(err);
    }
  }

  debug(event: string, fields?: LogFields): void {
    this.log('debug', event, fields);
  }
  info(event: string, fields?: LogFields): void {
    this.log('info', event, fields);
  }
  warn(event: string, fields?: LogFields): void {
    this.log('warn', event, fields);
  }
  error(event: string, fields?: LogFields): void {
    this.log('error', event, fields);
  }

  /** Flush and release the file handle; called on shutdown. */
  async close(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    if (!stream) return;
    await new Promise<void>((resolve) => stream.end(resolve));
  }
}

export const log = new Logger();

/** Exposed for tests that need a logger writing somewhere disposable. */
export function createLogger(dir: string, level: Level = 'debug'): Logger {
  return new Logger(dir, level);
}
