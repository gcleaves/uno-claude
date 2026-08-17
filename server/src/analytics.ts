import { PostHog } from 'posthog-node';
import { config } from './config.js';
import { log } from './logger.js';

/**
 * Server-side product analytics.
 *
 * The game's truth lives here, so the events worth trusting — who actually won,
 * how long a round took, whether a challenge succeeded — are sent from the
 * server rather than the browser, where they would be lost to a closed tab and
 * editable by anyone with devtools.
 *
 * What is deliberately never sent: player names, room codes, IP addresses, or
 * anything else that identifies a person or a household. Children play this.
 * Events carry counts and outcomes; the identifier is the same pseudonymous
 * token the browser already holds, hashed so that a PostHog record cannot be
 * matched back to a session token in the logs.
 */

let client: PostHog | null = null;

export function initAnalytics(): void {
  if (!config.posthogKey) {
    log.info('analytics.disabled', { detail: 'no key configured' });
    return;
  }
  client = new PostHog(config.posthogKey, {
    host: config.posthogHost,
    // Small batches: a family game generates a trickle of events, and waiting
    // for a default-sized batch would mean losing them on shutdown.
    flushAt: 10,
    flushInterval: 10_000,
  });
  log.info('analytics.enabled', { detail: config.posthogHost });
}

/**
 * A stable, non-reversible id for a player. The raw subject is a session token
 * that also appears in the logs; hashing keeps the two datasets from being
 * trivially joinable if either is ever exposed.
 */
export function anonId(subject: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const salt = `${config.posthogSalt}:${subject}`;
  for (let i = 0; i < salt.length; i++) {
    h1 = Math.imul(h1 ^ salt.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 + salt.charCodeAt(i), 2246822519) >>> 0;
  }
  return `p_${h1.toString(36)}${h2.toString(36)}`;
}

export type Props = Record<string, string | number | boolean | null>;

/** Fire and forget: analytics must never delay or break a game. */
export function track(subject: string, event: string, properties: Props = {}): void {
  if (!client) return;
  try {
    client.capture({ distinctId: anonId(subject), event, properties });
  } catch (err) {
    log.warn('analytics.capture_failed', { detail: String(err) });
  }
}

export async function shutdownAnalytics(): Promise<void> {
  if (!client) return;
  const c = client;
  client = null;
  try {
    await c.shutdown();
  } catch (err) {
    log.warn('analytics.shutdown_failed', { detail: String(err) });
  }
}
