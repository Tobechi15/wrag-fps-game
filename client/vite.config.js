import { defineConfig } from 'vite';

// Force the dev server to bind on IPv4 loopback (127.0.0.1) explicitly.
// Without this, Vite can end up listening only on the IPv6 loopback (::1),
// and if your browser resolves "localhost" to the IPv4 address first, the
// connection just fails with no clear error.
export default defineConfig({
  // Every asset (dev AND production build alike) is served under /play/
  // instead of / - this is what lets site/vercel.json proxy /play/* on the
  // SITE's own domain through to this deployment (see that file's comment)
  // so the whole flow, dashboard through live match, stays on one origin.
  // That matters specifically for the PWA: a browser drops an installed
  // standalone-mode app back into normal browser chrome the instant it
  // navigates to a different origin - see site/src/dashboard.js's
  // wireDeployButton for the full story on why this client used to do
  // exactly that.
  //
  // This has to be the SAME in dev and production, not just build - an
  // earlier version of this kept dev at `/` for convenience, but that
  // meant the dev-mode HTML referenced its own JS/CSS/assets unprefixed
  // (root-relative), so site/vite.config.js's dev proxy - which only
  // intercepts paths actually STARTING WITH /play - never saw those
  // sub-resource requests at all; they went straight to the SITE's own
  // dev server instead, where they don't exist (confirmed live: every
  // sub-resource request 404/503'd even though the initial /play HTML
  // load itself succeeded). Keeping this one value consistent everywhere
  // is what makes dev and prod behave the same way.
  //
  // Practical effect for local client-only development: visit
  // 127.0.0.1:5173/play/ (not bare 127.0.0.1:5173/) - see README.
  base: '/play/',
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
});
