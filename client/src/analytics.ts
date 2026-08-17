// The 'slim' build drops session replay, surveys and the other features this
// game switched off anyway; 'no-external' stops the library lazy-loading extra
// chunks from PostHog's CDN at runtime, which would have reintroduced exactly
// the third-party fetch that choosing the SDK over the HTML snippet avoided.
import posthog from 'posthog-js/dist/module.slim.no-external';

/**
 * Client-side analytics, via the npm SDK rather than the HTML snippet.
 *
 * The snippet fetches PostHog from a CDN at runtime. This app is bundled and
 * served from its own container behind the user's proxy, so bundling the
 * library keeps the version pinned in the lockfile, removes a third-party
 * request from page load, and works even where that CDN is blocked.
 *
 * Capture is deliberately narrow. Children play this game, so there is no
 * autocapture of every click, no session recording, and nothing carrying a
 * name, a room code or the contents of a hand. What is sent is a handful of
 * named events with counts on them.
 */

// Inlined at build time from the repo-root .env by vite.config.ts.
const KEY = __POSTHOG_KEY__;
const HOST = __POSTHOG_HOST__;

let ready = false;

export function initAnalytics(): void {
  if (!KEY || ready) return;
  posthog.init(KEY, {
    api_host: HOST,
    // Every one of these defaults to something chattier. Turned down on purpose.
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    disable_surveys: true,
    // The identifier is a random id in this browser's storage. It is never
    // linked to a name, an email or an account.
    person_profiles: 'identified_only',
  });
  ready = true;
}

export type Props = Record<string, string | number | boolean>;

export function track(event: string, props: Props = {}): void {
  if (!ready) return;
  try {
    posthog.capture(event, props);
  } catch {
    // Analytics must never interrupt a game.
  }
}

/** True when a key is configured, so the UI can be honest about it. */
export const analyticsEnabled = (): boolean => KEY.length > 0;
