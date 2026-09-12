import { Router } from 'express';
import { query } from '../db/client.js';
import { requireAuth } from '../auth/routes.js';

export const router = Router();

// Real stats + recent match history, computed from the matches table -
// replaces the placeholder numbers the dashboard showed before match
// recording existed. "Successful" here means anything but 'eliminated'
// (last-standing or time-limit both count - you walked away with
// something; extraction alone no longer ends a match, so 'extracted'
// never appears as a stored result - see match.js's bankCurrentPot).
router.get('/summary', requireAuth, async (req, res) => {
  const userId = req.session.userId;

  // users.balance is the REAL, spendable balance (see
  // server/src/economy/wallet.js) - deducted for Versus/Coop entry stakes
  // and Private's pooled stake, credited back on a win/refund. This is what
  // every "Balance"/wallet display should show from here on; totalEarned
  // below is a separate LIFETIME stat (gross earnings ever, unaffected by
  // stakes), kept for the dashboard's stats panel but no longer what
  // "Balance" means.
  const balanceResult = await query('SELECT balance FROM users WHERE id = $1', [userId]);
  const balance = Number(balanceResult.rows[0]?.balance ?? 0);

  const statsResult = await query(
    `SELECT
       COUNT(*) AS total_matches,
       COALESCE(SUM(kills), 0) AS total_kills,
       COUNT(*) FILTER (WHERE result != 'eliminated') AS successful_matches,
       COALESCE(SUM(final_pot), 0) AS total_earned,
       COALESCE(MAX(final_pot), 0) AS highest_extraction
     FROM matches
     WHERE user_id = $1`,
    [userId],
  );
  const stats = statsResult.rows[0];

  const recentResult = await query(
    `SELECT id, kills, result, final_pot, rank, total_players, played_at
     FROM matches
     WHERE user_id = $1
     ORDER BY played_at DESC
     LIMIT 10`,
    [userId],
  );

  const totalMatches = Number(stats.total_matches);
  const successfulMatches = Number(stats.successful_matches);

  res.status(200).json({
    balance,
    stats: {
      totalMatches,
      totalKills: Number(stats.total_kills),
      successfulMatches,
      extractionRate: totalMatches > 0 ? Math.round((successfulMatches / totalMatches) * 100) : 0,
      totalEarned: Number(stats.total_earned),
      highestExtraction: Number(stats.highest_extraction),
    },
    recentMatches: recentResult.rows.map((row) => ({
      id: row.id,
      kills: row.kills,
      result: row.result,
      finalPot: row.final_pot,
      rank: row.rank,
      totalPlayers: row.total_players,
      playedAt: row.played_at,
    })),
  });
});
