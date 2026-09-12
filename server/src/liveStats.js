// A tiny bridge between the WS game server (index.js, which owns all the
// live in-memory state: connected sockets, queues, private rooms, active
// matches) and the REST API's admin route (api/admin.js) - two separate
// Express/ws setups in the same process (see api/server.js), with no other
// shared module between them. Rather than pushing an update here on every
// connect/disconnect/queue-join/match-start (which would mean touching
// every one of those call sites in index.js), index.js registers ONE
// snapshot function once, after everything it closes over already exists;
// the admin route just calls it on demand whenever a GET /api/admin/live
// request comes in. Always in-memory/live, never persisted - a server
// restart naturally resets to "nothing connected," same as every other
// piece of live match state.
let snapshotProvider = null;

export function registerLiveStatsProvider(fn) {
  snapshotProvider = fn;
}

// Returns null if nothing has registered yet (shouldn't happen in practice -
// index.js registers this before its WebSocketServer starts accepting
// connections - but the admin route should never assume it did).
export function getLiveStats() {
  return snapshotProvider ? snapshotProvider() : null;
}
