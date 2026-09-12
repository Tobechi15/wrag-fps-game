import { query } from '../db/client.js';

// The one place any real-money-shaped points ever move in or out of a real
// account's balance - entry stakes (server/src/index.js's 'join-queue'
// handler, server/src/lobby/privateRooms.js) and Private's pooled-stake
// payout (server/src/match/match.js) all go through here, never a raw
// UPDATE of their own, so the "never goes negative" guarantee only has to
// be enforced in one place.

// House margin - a flat % held back from every PAYOUT (Versus/Coop kill
// points, Private's stake-pool win), never from a player's own money moving
// around (their own extraction/banking, or a stake refund for a match they
// never actually played). Without this, every PTS collected in entry
// stakes was fully paid back out - fine for a pure prototype, not
// "profitable and sustainable for the operator." See .env.example.
const HOUSE_RAKE_PERCENT = Number(process.env.HOUSE_RAKE_PERCENT ?? 10);

// Applies the house cut to a payout amount, rounded to a whole point -
// callers pass the RAW amount a player would otherwise receive in full;
// this returns what they actually get. The only place HOUSE_RAKE_PERCENT
// is read, so retuning it (or setting it to 0 to disable the rake
// entirely) only ever needs to happen here.
export function applyRake(amount) {
  return Math.round(amount * (1 - HOUSE_RAKE_PERCENT / 100));
}

// Atomic check-and-deduct: the WHERE clause means this can never take a
// balance below zero, no separate read-then-write race to worry about.
// Returns the new balance on success, or `null` if they couldn't afford it
// (the UPDATE matched zero rows) - callers treat `null` as "reject entry,
// show an error," per the user's explicit choice for insufficient funds.
export async function deductStake(userId, amount) {
  if (amount <= 0) return 0; // a free (unstaked) mode/room never touches the balance at all
  const result = await query(
    'UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance',
    [amount, userId],
  );
  return result.rows[0]?.balance ?? null;
}

// Credits a balance - used for three things: refunding a staked player who
// leaves a queue/room before a match actually starts (so nobody is ever
// charged for a match they didn't play), Private's pooled-stake payout to a
// winner, and crediting a player's finalPot (match winnings) once their
// match ends (see match.js's recordMatchResult) - the same generic "add
// points to a real balance" operation either way, just called for a
// different reason each time.
export async function refundStake(userId, amount) {
  if (amount <= 0) return;
  await query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, userId]);
}

// The "Deposit" button's demo top-up (see server/src/api/wallet.js) - a
// plain credit with NO rake applied (a deposit isn't a payout, the house
// margin only ever applies to match winnings). This is the exact seam a
// real payment gateway integration would replace: swap this function's
// body for "credit only after the gateway confirms the charge succeeded,"
// keep every caller (the /deposit route) exactly as-is. Never call this
// from anywhere that hasn't itself verified a real charge, once one exists.
export async function creditDeposit(userId, amount) {
  const result = await query(
    'UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance',
    [amount, userId],
  );
  return result.rows[0]?.balance ?? null;
}

// Admin-only manual correction (server/src/api/admin.js) - a signed delta
// rather than an absolute "set to" value, so two admins acting around the
// same time (or an admin double-clicking) compose instead of racing/
// clobbering each other. Clamped to never go below 0, same floor every
// other balance-touching path in this file already enforces - GREATEST
// does that atomically in the UPDATE itself rather than a separate
// read-then-clamp. Deliberately NOT run through the house ledger's
// counters (recordStakeCollected/recordWinningsPaid/etc.) - this is an
// out-of-band support correction, not a real gameplay economic event, so
// it should never distort the P&L those counters exist to track. Returns
// the new balance, or null if the user id doesn't exist.
export async function adjustBalance(userId, delta) {
  const result = await query(
    'UPDATE users SET balance = GREATEST(balance + $1, 0) WHERE id = $2 RETURNING balance',
    [delta, userId],
  );
  return result.rows[0]?.balance ?? null;
}

// The house's running P&L (schema.sql's `house_ledger`, a single row,
// id=1) - four independent counters, each incremented at a specific
// economic event, never derived from `users.balance` (which only ever
// shows the CURRENT net effect, not the history behind it). Four separate
// functions with their own fixed SQL rather than one generic
// `record(column, amount)` - column names can't be safely parameterized
// as query values, and this way every call site is unambiguous about
// which economic event it's recording. All fire-and-forget from the
// caller's perspective (same pattern as recordMatchResult's own writes) -
// a ledger hiccup should never block or roll back the gameplay action
// that triggered it.
//
// - stakes_collected: every successful entry-stake deduction (Versus/Coop
//   queue-join, Private room create/join) - gross revenue from players
//   entering a staked match.
// - stakes_refunded: every stake refunded for leaving BEFORE a match
//   starts (switching modes, leaving a queue/room) - a NEUTRAL event, not
//   a loss, since that player never actually played; kept separate from
//   stakes_collected (rather than just not calling recordStakeCollected in
//   the first place) so "gross collected" and "refunded" are both
//   independently visible to an operator, not just their net.
// - rake_collected: the literal house cut withheld from a payout (kill
//   points via awardKillPoints, Private's stake-pool win via
//   endMatchForSurvivor) - see applyRake above. This is the "flat fees
//   collected" figure the admin dashboard shows.
// - winnings_paid: every real payout that actually reached a player's
//   balance - match winnings (recordMatchResult's finalPot credit) and a
//   Private pool share (endMatchForSurvivor). NOT stake refunds (neutral,
//   see stakes_refunded) and NOT Deposit top-ups (not real revenue either
//   direction - see creditDeposit above).
//
// Profit (computed by the admin route, not stored) = (stakes_collected -
// stakes_refunded) - winnings_paid - the classic "money in minus money
// out" P&L; rake_collected is already implicitly reflected in a SMALLER
// winnings_paid (a raked payout is smaller than the raw amount would have
// been), so it's not subtracted again here - it's shown separately as its
// own "fees collected" figure per the operator's explicit ask, not folded
// into profit a second time.
export async function recordStakeCollected(amount) {
  if (amount <= 0) return;
  await query('UPDATE house_ledger SET stakes_collected = stakes_collected + $1 WHERE id = 1', [amount]);
}

export async function recordStakeRefunded(amount) {
  if (amount <= 0) return;
  await query('UPDATE house_ledger SET stakes_refunded = stakes_refunded + $1 WHERE id = 1', [amount]);
}

export async function recordRakeCollected(amount) {
  if (amount <= 0) return;
  await query('UPDATE house_ledger SET rake_collected = rake_collected + $1 WHERE id = 1', [amount]);
}

export async function recordWinningsPaid(amount) {
  if (amount <= 0) return;
  await query('UPDATE house_ledger SET winnings_paid = winnings_paid + $1 WHERE id = 1', [amount]);
}

// Read-only snapshot for the admin dashboard (server/src/api/admin.js) -
// profit is derived here rather than stored, so it's always consistent
// with whatever the four raw counters currently say.
export async function getHouseLedger() {
  const result = await query('SELECT stakes_collected, stakes_refunded, rake_collected, winnings_paid FROM house_ledger WHERE id = 1');
  const row = result.rows[0] ?? { stakes_collected: 0, stakes_refunded: 0, rake_collected: 0, winnings_paid: 0 };
  const stakesCollected = Number(row.stakes_collected);
  const stakesRefunded = Number(row.stakes_refunded);
  const rakeCollected = Number(row.rake_collected);
  const winningsPaid = Number(row.winnings_paid);
  return {
    stakesCollected,
    stakesRefunded,
    rakeCollected,
    winningsPaid,
    netStakesCollected: stakesCollected - stakesRefunded,
    profit: (stakesCollected - stakesRefunded) - winningsPaid,
  };
}
