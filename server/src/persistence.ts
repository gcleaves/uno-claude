import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import type { GameState } from '@uno/shared';

/**
 * Snapshotting rooms to disk so a restart does not end everyone's game.
 *
 * The whole file is rewritten each time: a busy server holds a few hundred KB
 * of rooms, which is far cheaper to write whole than to maintain incrementally.
 */

/** Bumped when the shape changes; an older file is discarded rather than guessed at. */
const VERSION = 1;

export interface PersistedRoom {
  state: GameState;
  seats: Array<[string, string]>;
  droppedAt: Array<[string, number]>;
  lastActivity: number;
}

export interface Snapshot {
  version: number;
  savedAt: number;
  rooms: PersistedRoom[];
}

function serialize(rooms: PersistedRoom[], now: number): string {
  return JSON.stringify({ version: VERSION, savedAt: now, rooms } satisfies Snapshot);
}

/** Background save. Writes beside the target then renames, so a crash mid-write
 * leaves the previous good snapshot intact rather than a truncated file. */
export async function saveSnapshot(
  file: string,
  rooms: PersistedRoom[],
  now = Date.now(),
): Promise<void> {
  const tmp = `${file}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  // Hands are in here, so keep it readable only by the owner.
  await writeFile(tmp, serialize(rooms, now), { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
}

/** Shutdown save. Synchronous on purpose: the process is about to exit and an
 * awaited write is not guaranteed to finish. */
export function saveSnapshotSync(file: string, rooms: PersistedRoom[], now = Date.now()): void {
  const tmp = `${file}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(tmp, serialize(rooms, now), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Read a snapshot back. Returns null for anything unusable — a missing file, a
 * truncated one, or a version this build does not understand. Losing games is
 * bad; refusing to boot because of a bad file is worse.
 */
export function loadSnapshot(file: string): Snapshot | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`could not read snapshot ${file}:`, err);
    }
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Snapshot;
    if (parsed?.version !== VERSION) {
      console.warn(`ignoring snapshot written by a different version (${parsed?.version})`);
      return null;
    }
    if (!Array.isArray(parsed.rooms)) return null;
    return { ...parsed, rooms: parsed.rooms.filter(isUsable) };
  } catch (err) {
    console.warn('snapshot is not valid JSON, starting empty:', err);
    return null;
  }
}

/** Cheap structural check, so one corrupt room cannot take the others down. */
function isUsable(room: unknown): room is PersistedRoom {
  const r = room as PersistedRoom | undefined;
  return (
    !!r &&
    !!r.state &&
    typeof r.state.code === 'string' &&
    Array.isArray(r.state.players) &&
    Array.isArray(r.state.drawPile) &&
    Array.isArray(r.state.discardPile) &&
    Array.isArray(r.seats) &&
    Array.isArray(r.droppedAt)
  );
}
