import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultClientConditions, defineConfig, type Plugin } from 'vite';

// Keep in sync with DEFAULT_PORT in orderup-shared (not imported: config runs before shared is built).
const apiPort = Number(process.env.ORDERUP_PORT ?? 7717);
const api = `http://127.0.0.1:${apiPort}`;

/**
 * `npm run dev` only: the page comes from Vite, not the server, so read the command token the
 * server wrote with `--crew` and add the same `<meta>` it injects (COMMAND_TOKEN_META).
 */
function commandToken(): Plugin {
  return {
    name: 'orderup-command-token',
    apply: 'serve',
    transformIndexHtml() {
      let token: string;
      try {
        token = readFileSync(path.join(os.homedir(), '.orderup', 'command-token'), 'utf8').trim();
      } catch {
        return [];
      }
      if (!/^[0-9a-f]+$/.test(token)) return [];
      return [{ tag: 'meta', attrs: { name: 'orderup-command-token', content: token } }];
    },
  };
}

export default defineConfig({
  plugins: [commandToken()],
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
