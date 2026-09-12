// All fetch helpers for the admin dashboard (site/src/admin.js) - see
// server/src/api/admin.js. Every route here is gated on requireAdmin, which
// returns a plain 404 for anyone not flagged is_admin (see .env.example's
// ADMIN_EMAILS), same as a route that genuinely doesn't exist, so a
// non-admin hitting /admin.html can't tell the difference - it just
// surfaces as these functions returning null either way.

// The house's P&L (see DEV_README.md's "House ledger" section).
export async function fetchHouseLedger() {
  const response = await fetch('/api/admin/summary');
  if (!response.ok) return null;
  return response.json();
}

// Live, in-memory server state (connected sockets, queue sizes, active
// matches) - see server/src/liveStats.js.
export async function fetchLiveStats() {
  const response = await fetch('/api/admin/live');
  if (!response.ok) return null;
  return response.json();
}

// Every registered account (optionally filtered by `search`, matched
// against email or callsign) - see admin.js's /users route.
export async function fetchAdminUsers(search = '') {
  const url = search ? `/api/admin/users?search=${encodeURIComponent(search)}` : '/api/admin/users';
  const response = await fetch(url);
  if (!response.ok) return null;
  const body = await response.json();
  return body.users;
}

// The most recent matches across every real account (not just one player,
// unlike dashboard-client.js's fetchDashboardSummary).
export async function fetchAdminMatches() {
  const response = await fetch('/api/admin/matches');
  if (!response.ok) return null;
  const body = await response.json();
  return body.matches;
}

// Manual balance correction (support/testing tool, see wallet.js's
// adjustBalance) - `amount` is a signed integer, positive credits, negative
// debits. Throws with the server's own error message on a rejected amount
// so the caller can show it as-is (same pattern as depositToWallet).
export async function adjustUserBalance(userId, amount) {
  const response = await fetch(`/api/admin/users/${userId}/balance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Balance adjustment failed.');
  return body.balance;
}
