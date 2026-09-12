import { Router } from 'express';
import { requireAdmin } from '../auth/routes.js';
import { getHouseLedger, adjustBalance } from '../economy/wallet.js';
import { getLiveStats } from '../liveStats.js';
import { query } from '../db/client.js';

export const router = Router();

// Every route below is gated on requireAdmin (see .env.example's
// ADMIN_EMAILS and auth/routes.js - no admin-management UI, that env var
// is the whole mechanism for who can even reach this file).
router.use(requireAdmin);

// The house's P&L - see DEV_README.md's "House ledger" section for exactly
// what each number means and why "fees collected" (rake_collected) and
// "profit" (stakes in minus winnings out) are two separate figures.
router.get('/summary', async (req, res) => {
  const ledger = await getHouseLedger();
  res.status(200).json(ledger);
});

// Live, in-memory server state (connected sockets, queue sizes, active
// matches, private rooms) - see liveStats.js for why this is a snapshot
// function rather than anything persisted. Returns nulls for everything if
// the game server's WS process somehow never registered a provider (should
// never happen in normal operation - see index.js).
router.get('/live', (req, res) => {
  const stats = getLiveStats();
  res.status(200).json(stats ?? {
    connectedPlayers: null,
    activeMatches: null,
    versusQueueSize: null,
    coopQueueSize: null,
    roomCount: null,
    waitingPlayers: null,
  });
});

// Every registered account, newest first, with a per-user match count
// folded in via a subquery (cheap at this prototype's scale - no pagination
// needed until the users table is actually large). `search` (case-
// insensitive, matches email OR callsign) lets an operator find one account
// without scrolling a long list - empty/missing means "everyone."
router.get('/users', async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const params = [];
  let whereClause = '';
  if (search) {
    params.push(`%${search}%`);
    whereClause = 'WHERE u.email ILIKE $1 OR u.callsign ILIKE $1';
  }

  const result = await query(
    `SELECT
       u.id, u.email, u.callsign, u.balance, u.is_admin, u.survival_best_score, u.created_at,
       (SELECT COUNT(*) FROM matches m WHERE m.user_id = u.id) AS matches_played
     FROM users u
     ${whereClause}
     ORDER BY u.created_at DESC
     LIMIT 200`,
    params,
  );

  res.status(200).json({
    users: result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      callsign: row.callsign,
      balance: Number(row.balance),
      isAdmin: Boolean(row.is_admin),
      survivalBestScore: Number(row.survival_best_score),
      matchesPlayed: Number(row.matches_played),
      createdAt: row.created_at,
    })),
  });
});

// Admin-only manual balance correction (see wallet.js's adjustBalance) -
// support/testing tool for the fake-points economy, deliberately kept out
// of the house ledger's own counters (not a real gameplay economic event).
// `amount` is a signed integer - positive credits, negative debits.
router.post('/users/:id/balance', async (req, res) => {
  const { amount } = req.body ?? {};
  if (!Number.isInteger(amount) || amount === 0) {
    return res.status(400).json({ error: 'amount must be a non-zero integer.' });
  }

  const newBalance = await adjustBalance(req.params.id, amount);
  if (newBalance === null) {
    return res.status(404).json({ error: 'No user with that id.' });
  }
  res.status(200).json({ balance: newBalance });
});

// The most recent matches across EVERY player (not just one account, unlike
// server/src/api/dashboard.js's own /summary) - joined against users for
// callsign/email so an operator can see who actually played. Anonymous/bot
// participants never produce a matches row at all (see match.js's
// recordMatchResult), so this is real-account activity only, same scope as
// the users list above.
router.get('/matches', async (req, res) => {
  const result = await query(
    `SELECT m.id, m.kills, m.result, m.final_pot, m.rank, m.total_players, m.mode, m.played_at,
            u.callsign, u.email
     FROM matches m
     JOIN users u ON u.id = m.user_id
     ORDER BY m.played_at DESC
     LIMIT 50`,
  );

  res.status(200).json({
    matches: result.rows.map((row) => ({
      id: row.id,
      callsign: row.callsign,
      email: row.email,
      kills: row.kills,
      result: row.result,
      finalPot: row.final_pot,
      rank: row.rank,
      totalPlayers: row.total_players,
      mode: row.mode,
      playedAt: row.played_at,
    })),
  });
});
