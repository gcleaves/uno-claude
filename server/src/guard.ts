import type { Socket } from 'socket.io';
import { config } from './config.js';

/**
 * Cheap abuse controls for a server that is reachable from the open internet.
 *
 * None of this is a substitute for authentication; it is what keeps a stranger
 * from exhausting the box or brute-forcing their way into a family's game, and
 * it still matters once sign-in is switched on.
 */

/**
 * Who to attribute a connection to. Behind a reverse proxy every socket appears
 * to come from the proxy, so per-client limits are meaningless unless the
 * forwarded address is used — but that header is trivially forged when the
 * server is exposed directly, which would let one attacker look like thousands.
 * Hence the explicit opt-in.
 */
export function clientIp(socket: Socket): string {
  if (config.trustProxy) {
    const fwd = socket.handshake.headers['x-forwarded-for'];
    const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
    if (first?.trim()) return first.trim();
  }
  return socket.handshake.address || 'unknown';
}

/**
 * Token bucket: `capacity` actions available, refilling over `windowMs`.
 * Allows a natural burst — a flurry of taps mid-game — while capping the
 * sustained rate well below what it takes to hurt anything.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; last: number }>();

  constructor(
    private capacity: number,
    private windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const rate = this.capacity / this.windowMs;
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, last: now };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.last) * rate);
    bucket.last = now;

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }

  /** Drop idle buckets so the map cannot grow without bound. */
  sweep(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.last > this.windowMs * 10) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** Counts live connections per client so one source cannot hog the server. */
export class ConnectionCounter {
  private counts = new Map<string, number>();

  add(key: string): number {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }

  remove(key: string): void {
    const next = (this.counts.get(key) ?? 1) - 1;
    if (next <= 0) this.counts.delete(key);
    else this.counts.set(key, next);
  }

  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  get size(): number {
    return this.counts.size;
  }
}
