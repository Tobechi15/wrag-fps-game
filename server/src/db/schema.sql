-- Run this once against a fresh database before starting the server:
--   psql "postgresql://postgres:devpassword@127.0.0.1:5432/wrag_fps" -f src/db/schema.sql
-- (connect-pg-simple creates its own "session" table automatically on
-- first run, via createTableIfMissing - it doesn't need to be defined here.)

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  callsign TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per real player's involvement in one match (bots and anonymous
-- players never get a row - see server/src/match/match.js's recordMatchResult).
-- result mirrors the reasons the client's postMatchScreen.js shows:
-- 'eliminated' | 'last-standing' | 'time-limit'. ('extracted' no longer
-- ends a match - see match.js's bankCurrentPot - so it never appears here.)
-- rank/total_players are battle-royale-style placement among the match's
-- real players only (bots aren't ranked - a killed bot stays gone for the
-- rest of the match but still never has a fixed placement).
CREATE TABLE IF NOT EXISTS matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kills INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL,
  final_pot INTEGER NOT NULL DEFAULT 0,
  rank INTEGER NOT NULL DEFAULT 1,
  total_players INTEGER NOT NULL DEFAULT 1,
  played_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS matches_user_id_played_at_idx ON matches (user_id, played_at DESC);

-- Safe to re-run: adds rank/total_players to a `matches` table that already
-- existed from before this migration (CREATE TABLE IF NOT EXISTS above is a
-- no-op once the table exists, so the new columns need adding explicitly).
ALTER TABLE matches ADD COLUMN IF NOT EXISTS rank INTEGER NOT NULL DEFAULT 1;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS total_players INTEGER NOT NULL DEFAULT 1;

-- Which match type produced this row - 'versus' (the original/default),
-- 'coop', or 'private'. Survival runs never write a matches row at all (rank/
-- total_players don't mean anything for a solo vs-infinite-bots run) - see
-- users.survival_best_score below instead.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'versus';

-- Survival mode's score: a PER-PLAYER personal best, not a global/shared
-- leaderboard - just a plain column on the user, updated in place
-- (GREATEST(survival_best_score, $1)) whenever a run beats it. See
-- server/src/match/match.js's recordSurvivalScore.
ALTER TABLE users ADD COLUMN IF NOT EXISTS survival_best_score INTEGER NOT NULL DEFAULT 0;

-- A REAL, spendable balance - replaces the dashboard's old "Balance" figure,
-- which was only ever a derived SUM(final_pot) over `matches` (see
-- server/src/api/dashboard.js) and never actually spendable. Needed once
-- Versus/Coop/Private entry stakes started actually deducting points - see
-- server/src/economy/wallet.js. 500 is a starting allowance (5 Versus/Coop
-- matches worth) for a prototype with no real money involved; existing
-- accounts get it too via the column default, which is fine for dev data.
ALTER TABLE users ADD COLUMN IF NOT EXISTS balance INTEGER NOT NULL DEFAULT 500;

-- Gates the admin dashboard (server/src/api/admin.js) - see
-- ADMIN_EMAILS in .env.example for how an account actually gets this set
-- (auto-flagged on login; no admin-management UI exists, this is an
-- operator/dev feature, not a player-facing one).
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

-- The house's running P&L, a single row (id=1) updated alongside every real
-- economic event - see server/src/economy/wallet.js's record* functions and
-- DEV_README.md's "House ledger" section for exactly what increments each
-- column and why. Never touched by Survival (unstaked) or the Deposit
-- button (a demo top-up, not real revenue - see wallet.js's creditDeposit).
CREATE TABLE IF NOT EXISTS house_ledger (
  id INTEGER PRIMARY KEY DEFAULT 1,
  stakes_collected BIGINT NOT NULL DEFAULT 0,
  stakes_refunded BIGINT NOT NULL DEFAULT 0,
  rake_collected BIGINT NOT NULL DEFAULT 0,
  winnings_paid BIGINT NOT NULL DEFAULT 0
);
INSERT INTO house_ledger (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
