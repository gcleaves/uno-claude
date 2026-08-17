/// <reference types="vite/client" />

/**
 * Injected by vite.config.ts from POSTHOG_KEY / POSTHOG_HOST in the repo-root
 * .env, so the browser and the server read the same variables. Empty key means
 * analytics is off.
 */
declare const __POSTHOG_KEY__: string;
declare const __POSTHOG_HOST__: string;
