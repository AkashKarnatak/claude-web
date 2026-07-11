import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: Vite serves the UI and proxies the WebSocket to the backend, so the
// client always talks to same-origin /ws. Prod: the backend serves web/dist.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  build: { outDir: 'dist' },
});
