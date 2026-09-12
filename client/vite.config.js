import { defineConfig } from 'vite';

// Force the dev server to bind on IPv4 loopback (127.0.0.1) explicitly.
// Without this, Vite can end up listening only on the IPv6 loopback (::1),
// and if your browser resolves "localhost" to the IPv4 address first, the
// connection just fails with no clear error.
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
});
