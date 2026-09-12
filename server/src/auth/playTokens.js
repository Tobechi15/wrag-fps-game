import { randomBytes } from 'crypto';

// Bridges the site's HTTP session (cookie, on the API server's origin) to
// the game server's WebSocket connection (a totally different origin/
// protocol, which can't see that cookie at all). The dashboard exchanges
// its session for one of these short-lived, single-use tokens, passes it
// to the game client via a URL param, and the game client hands it to the
// WS server on connect - see server/src/index.js's 'connection' handler.
//
// In-memory only (not the database) since both the API server and the WS
// game server run in this same Node process (see index.js) and a token is
// only ever meant to live for a few seconds - there's nothing here worth
// persisting across a restart.
const TOKEN_TTL_MS = 30_000;
const tokens = new Map(); // token -> { userId, callsign, expiresAt }

export function issuePlayToken(userId, callsign) {
  const token = randomBytes(24).toString('hex');
  tokens.set(token, { userId, callsign, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

// Single-use: consuming a token deletes it immediately, whether or not it
// turned out to be valid - a token can never be replayed.
export function consumePlayToken(token) {
  const entry = tokens.get(token);
  tokens.delete(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) return null;
  return { userId: entry.userId, callsign: entry.callsign };
}

// Housekeeping so an abandoned (never-consumed) token doesn't sit in
// memory forever - unref() so this interval alone doesn't keep the process
// alive.
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tokens) {
    if (now > entry.expiresAt) tokens.delete(token);
  }
}, 60_000).unref();
