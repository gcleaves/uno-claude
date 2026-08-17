import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite normally reads .env from its own root, which here is `client/`. It is
 * pointed at the repo root instead so the whole stack — server and browser —
 * is configured from a single .env, and so there is one variable name rather
 * than a POSTHOG_KEY for the server and a VITE_POSTHOG_KEY for the client that
 * can silently disagree.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig(({ mode }) => {
  // An empty prefix loads every variable, from .env files and the real
  // environment alike — which is how the Docker build arg arrives. Only the
  // values named in `define` below are ever put into the bundle.
  const env = loadEnv(mode, repoRoot, '');
  const target = env.SERVER_URL ?? 'http://localhost:3001';

  return {
    plugins: [react()],
    envDir: repoRoot,
    define: {
      // Inlined at build time. The project key is publishable by design.
      __POSTHOG_KEY__: JSON.stringify(env.POSTHOG_KEY ?? ''),
      __POSTHOG_HOST__: JSON.stringify(env.POSTHOG_HOST ?? 'https://eu.i.posthog.com'),
    },
    server: {
      // Same-origin in dev too, so the client never needs to know the server's port.
      proxy: {
        '/socket.io': { target, ws: true, changeOrigin: true },
        '/api': { target, changeOrigin: true },
      },
      host: true, // reachable from phones on the LAN
    },
    build: { outDir: 'dist', sourcemap: true },
  };
});
