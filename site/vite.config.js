import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Bind to 127.0.0.1 explicitly - see client/vite.config.js for why (the
// default can end up IPv6-only and unreachable from a browser). Runs on a
// different port than client/ (5173) so both can run side by side.
export default defineConfig({
  // This is a multi-page app (six separate top-level HTML files, not one
  // SPA) - `vite dev` serves any file in the project root directly
  // regardless of this config, which is why every page worked fine in
  // local dev without it. `vite build`, however, only ever bundles
  // index.html by default - every other page (login/signup/dashboard/
  // account/admin) was SILENTLY MISSING from dist/ entirely, which is
  // exactly why they 404 once deployed as a static site (a static host
  // only ever serves what's actually in the build output - there's no
  // dev-server fallback to paper over it there). Every page needs its own
  // named entry here so the build actually includes it.
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        login: resolve(__dirname, 'login.html'),
        signup: resolve(__dirname, 'signup.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
        account: resolve(__dirname, 'account.html'),
        admin: resolve(__dirname, 'admin.html'),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5175,
    // Forwards /api/* to the Express server so the browser sees it as
    // same-origin (127.0.0.1:5175/api/...) instead of a cross-origin
    // request to :8080. This matters for session cookies: a real
    // cross-origin request would need SameSite=None, which browsers only
    // allow over https - proxying sidesteps that entirely for local dev.
    // Port 8080, not a separate 8081 - the API and the WebSocket game
    // server now share one http.Server/one port (see server/src/index.js -
    // a hosting platform only ever exposes one port per service, so they
    // can't be two independent listeners anymore).
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
      // Local-dev mirror of production's site/vercel.json + client/vercel.json
      // /play rewrite chain (see both files' own comments for the full
      // reasoning - keeping the game client same-origin with this dashboard
      // so an installed PWA stays in standalone mode through an actual
      // match, not just on the dashboard). No path rewrite needed - the
      // client's own dev server ALSO serves everything under /play/ (see
      // client/vite.config.js's `base`, unconditional in dev and
      // production alike specifically so this proxy and the client agree
      // on the same prefix without needing to translate between them).
      '/play': {
        target: 'http://127.0.0.1:5173',
        changeOrigin: true,
      },
    },
  },
});
