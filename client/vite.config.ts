import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.SERVER_URL ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    // Same-origin in dev too, so the client never needs to know the server's port.
    proxy: {
      '/socket.io': { target, ws: true, changeOrigin: true },
      '/api': { target, changeOrigin: true },
    },
    host: true, // reachable from phones on the LAN
  },
  build: { outDir: 'dist', sourcemap: true },
});
