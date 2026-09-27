import { defaultClientConditions, defineConfig } from 'vite';

// Keep in sync with DEFAULT_PORT in orderup-shared (not imported: config runs before shared is built).
const apiPort = Number(process.env.ORDERUP_PORT ?? 7717);
const api = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  resolve: {
    // Resolve workspace packages to their TypeScript sources in dev and build.
    conditions: ['source', ...defaultClientConditions],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // changeOrigin: the server only accepts its own Host (ADR-003).
      '/health': { target: api, changeOrigin: true },
      '/ws': { target: api, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // three.js alone is ~500 kB; the page is served from localhost, not the web.
    chunkSizeWarningLimit: 800,
  },
});
