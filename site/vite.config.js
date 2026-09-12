import { defineConfig } from 'vite';

// Bind to 127.0.0.1 explicitly - see client/vite.config.js for why (the
// default can end up IPv6-only and unreachable from a browser). Runs on a
// different port than client/ (5173) so both can run side by side.
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5175,
    // Forwards /api/* to the Express server so the browser sees it as
    // same-origin (127.0.0.1:5175/api/...) instead of a cross-origin
    // request to :8081. This matters for session cookies: a real
    // cross-origin request would need SameSite=None, which browsers only
    // allow over https - proxying sidesteps that entirely for local dev.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8081',
        changeOrigin: true,
      },
    },
  },
});
