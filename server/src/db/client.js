import pg from 'pg';
import 'dotenv/config';

// A shared connection pool, not a connection-per-request - pg's Pool
// manages reuse for us. Every query in this project goes through here,
// using parameterized queries ($1, $2, ...) everywhere - never string-
// concatenated SQL - so user input can never be interpreted as SQL.
//
// SSL is forced on in production rather than relying on DATABASE_URL
// itself carrying a `?sslmode=require` query param - nearly every hosted
// Postgres (Render's own managed Postgres included) REJECTS a plaintext
// connection outright ("SSL/TLS required", pg error code 28000) rather
// than just warning, so a deployment that forgets that query param fails
// signup/login entirely with no way to tell from the client side what
// went wrong. rejectUnauthorized:false skips CA verification (most
// managed Postgres providers use a cert chain Node doesn't have bundled) -
// this still encrypts the connection, it just doesn't verify the server's
// identity against a known CA, an accepted tradeoff for this prototype's
// scale. Conditional on NODE_ENV, not unconditional: local dev's Docker
// Postgres has no SSL listener at all, so forcing this against it would
// break local dev outright instead of just being redundant.
const isProduction = process.env.NODE_ENV === 'production';
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ...(isProduction ? { ssl: { rejectUnauthorized: false } } : {}),
});

pool.on('error', (err) => {
  // A background connection failing (e.g. Postgres restarted) shouldn't
  // crash the whole server - just log it.
  console.error('Unexpected Postgres pool error:', err);
});

export function query(text, params) {
  return pool.query(text, params);
}
