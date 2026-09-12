import pg from 'pg';
import 'dotenv/config';

// A shared connection pool, not a connection-per-request - pg's Pool
// manages reuse for us. Every query in this project goes through here,
// using parameterized queries ($1, $2, ...) everywhere - never string-
// concatenated SQL - so user input can never be interpreted as SQL.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  // A background connection failing (e.g. Postgres restarted) shouldn't
  // crash the whole server - just log it.
  console.error('Unexpected Postgres pool error:', err);
});

export function query(text, params) {
  return pool.query(text, params);
}
