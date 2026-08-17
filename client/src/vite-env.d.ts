/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** PostHog project API key. Publishable by design; empty disables analytics. */
  readonly VITE_POSTHOG_KEY?: string;
  readonly VITE_POSTHOG_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
