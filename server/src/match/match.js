import { findClosestHitTarget, findClosestHitEntity } from './hitRegistration.js';
import { updateExtractionState } from './extraction.js';
import { createBotController } from '../bots/bot.js';
import { findClosestWallHit } from '../map/walls.js';
import { query } from '../db/client.js';
import { MODE_CONFIGS } from './modes.js';
import {
  refundStake, applyRake, recordRakeCollected, recordWinningsPaid,
} from '../economy/wallet.js';

const POINTS_PER_HIT = 10; // for hitting a static target dummy - same for every mode, only kill points vary (see modes.js)
const SHOT_POSITION_TOLERANCE = 3; // meters a claimed shot origin may differ from last known server position
// Env-driven (MATCH_TIME_LIMIT_MINUTES, see .env.example) - falls back to
// the original 3 minutes if unset. Survival mode skips this entirely - see
// the timeLimitTimeoutId setup below.
const MATCH_TIME_LIMIT_MS = Number(process.env.MATCH_TIME_LIMIT_MINUTES ?? 3) * 60 * 1000;

// How long a Coop/Private respawn takes - was instant, now a real delay
// with a countdown banner client-side (see gameScreen.js's
// 'respawn-countdown' handler). Lives directly here rather than in
// modes.js's MODE_CONFIGS since it's not a rule that varies BY mode (both
// respawn-capable modes share it) - same reasoning MATCH_TIME_LIMIT_MS
// above already follows.
const RESPAWN_DELAY_MS = Number(process.env.RESPAWN_DELAY_SECONDS ?? 5) * 1000;

const MAX_HEALTH = 100;
const DAMAGE_PER_HIT = 25; // 4 hits to kill - no instant one-shot elimination

// Where each participant starts. Spread far apart across the whole
// (now-big) map - well beyond bots' 10m detection range from each other so
// nobody spawns already under fire, and far enough from the center that
// there's real ground to cross before reaching it - assigned round-robin
// to whoever's in the match (bots included), NOT tied to the map's
// targets/extraction zone, which sit near the origin. See map/walls.js's
// WALLS for the outposts and lane cover placed near these.
// 16 points now (was 8) - Versus can hold up to VERSUS_MATCH_SIZE
// participants (20 by default, see modes.js) and Coop up to
// COOP_MATCH_SIZE (10), so 8 points meant 2-3 participants sharing the
// exact same spawn in a full lobby. Still assigned round-robin
// (index % SPAWN_POINTS.length in createMatch below), so a large enough
// match still doubles up eventually - this just raises how big a match
// has to get before that happens, without adding new terrain/cover for
// each one (out of scope here, same "known duplication" tradeoff as the
// target/extraction-zone positions - see README.md).
const SPAWN_POINTS = [
  { x: -28, z: -28 },
  { x: 28, z: -28 },
  { x: -28, z: 28 },
  { x: 28, z: 28 },
  { x: 0, z: -35 },
  { x: 0, z: 35 },
  { x: -35, z: 0 },
  { x: 35, z: 0 },
  { x: -45, z: -15 },
  { x: 45, z: -15 },
  { x: -45, z: 15 },
  { x: 45, z: 15 },
  { x: -15, z: -45 },
  { x: 15, z: -45 },
  { x: -15, z: 45 },
  { x: 15, z: 45 },
];

// One live match's authoritative state: every participant's position,
// health, pot, and extraction progress - both real players AND bots, which
// are stored the same way but with `socket: null` (see bots/bot.js).
// Movement stays client-predicted for real players (per the project brief)
// - the server just relays it - but hits, kills, and pot/banking changes
// are entirely decided here, never by the client. See hitRegistration.js
// and extraction.js for the validation logic itself.
//
// Versus match rules: free-for-all, battle-royale style. Each player has an
// UNSECURED pot (current earnings, still at risk) and a SECURED pot
// (locked in by extracting). Extraction does NOT end your match anymore -
// it just moves your current unsecured pot into secured and you keep
// playing, so you can extract multiple times in one match. Getting killed
// only costs your currently-unsecured pot; whatever you'd already secured
// stays yours, but your match ends. The match keeps going until only one
// real player remains AND every bot has also been killed (last standing -
// their combined secured+unsecured pot banks and the match ends for them
// too) or the time limit elapses.
//
// `onEmpty(matchId)` is called once no real players remain, for any reason
// (disconnect, elimination, or the match resolving to its final
// survivor) - the caller (see index.js) uses it to remove the match from
// its registry.
//
// `modeName` selects a rule set from modes.js's MODE_CONFIGS ('versus' by
// default, matching every match this project had before Coop/Private/
// Survival existed) - see that file for what each mode actually changes
// (teams/friendly-fire, respawns, kill points, and how the time limit
// pays out). `matchOptions.stakePool` (Private only, from
// server/src/lobby/privateRooms.js's room.pool) is the winner-take-all
// pot everyone who joined that room paid into - see endMatchForSurvivor's
// payout below. Every other mode's caller omits matchOptions entirely.
export function createMatch(matchId, participants, onEmpty, modeName = 'versus', matchOptions = {}) {
  const modeConfig = MODE_CONFIGS[modeName] ?? MODE_CONFIGS.versus;
  const stakePool = matchOptions.stakePool ?? 0;
  const players = new Map(); // id -> { socket, callsign, isBot, userId, characterVariant, teamId, position, yaw, health, pot, securedPot, kills, deathCount, secondsInZone, lastMoveAt }

  participants.forEach(({
    id, socket, callsign, isBot, userId, characterVariant,
  }, index) => {
    if (socket) socket.matchId = matchId;
    const spawnPoint = SPAWN_POINTS[index % SPAWN_POINTS.length];
    players.set(id, {
      socket: socket ?? null,
      callsign,
      isBot: Boolean(isBot),
      userId: userId ?? null, // set only for a real, logged-in player - see server/src/index.js
      characterVariant: characterVariant ?? null, // the dashboard loadout selector's pick - see index.js's ?character= query param
      // Alternating 0/1 by join order when this mode has teams (Coop) -
      // null everywhere else. Bots get a teamId too, so they fill out both
      // sides same as they fill empty slots elsewhere.
      teamId: modeConfig.teams ? index % 2 : null,
      position: { x: spawnPoint.x, y: 1.7, z: spawnPoint.z },
      yaw: 0,
      health: MAX_HEALTH,
      pot: 0, // unsecured - currently at risk
      securedPot: 0, // locked in by a previous extraction this match - safe even if killed later
      kills: 0,
      deathCount: 0, // real players only - how many times they've died this match, see handlePlayerDeath
      secondsInZone: 0,
      lastMoveAt: Date.now(),
    });
  });

  // A fixed snapshot of who was in this match and which team they started
  // on - taken once here and never touched again, unlike `players` (which
  // loses an entry the moment someone's eliminated). Paired with
  // killCountsById (also never cleaned up) so buildTeamScoreboard() below
  // can still show an eliminated teammate's final kill count at match end.
  const rosterSnapshot = participants.map(({ id, callsign, isBot }, index) => ({
    id,
    callsign,
    isBot: Boolean(isBot),
    teamId: modeConfig.teams ? index % 2 : null,
  }));
  const killCountsById = new Map(rosterSnapshot.map((entry) => [entry.id, 0]));
  // Final placement, by id - populated progressively as each participant
  // finishes (see captureRankAndAdvance below), NOT all at once - in a
  // free-for-all mode, participants finish at genuinely different times
  // (one player's elimination doesn't end the match for whoever's still
  // fighting), so at the moment any ONE player's own match ends, some
  // roster entries may still have no rank recorded yet - see
  // buildFullScoreboard, which reads that as "still in the match."
  const ranksById = new Map();

  // Every teammate's kill count, by callsign - what the post-match "member
  // kill scores" breakdown (client/src/postMatchScreen.js) actually shows.
  // Only meaningful (and only ever attached to a match-ended message) when
  // modeConfig.teams is true (Coop).
  function buildTeamScoreboard(teamId) {
    return rosterSnapshot
      .filter((entry) => entry.teamId === teamId)
      .map((entry) => ({ callsign: entry.callsign, isBot: entry.isBot, kills: killCountsById.get(entry.id) ?? 0 }));
  }

  // The WHOLE match's leaderboard - every participant (real or bot), not
  // just a team - what the post-match screen's "battle royale" scoreboard
  // shows (see postMatchScreen.js). Only meaningful (and only ever
  // attached to a match-ended message) when modeConfig.showFullScoreboard
  // is true (Versus). `rank` is null for anyone not yet finished as of
  // the moment THIS player's own match ended (see ranksById's comment) -
  // the client sorts finished entries by rank and shows everyone else as
  // still in progress.
  function buildFullScoreboard() {
    return rosterSnapshot.map((entry) => ({
      callsign: entry.callsign,
      isBot: entry.isBot,
      kills: killCountsById.get(entry.id) ?? 0,
      rank: ranksById.get(entry.id) ?? null,
    }));
  }

  // The Coop live opposition status bar's data: every roster member's
  // CURRENT alive/lives-remaining state (unlike buildTeamScoreboard above,
  // this is read continuously through the match, not just once at the end).
  // A real player who's been PERMANENTLY eliminated has no entry left in
  // `players` at all (see eliminatePlayer) - absence there is exactly
  // "not alive, 0 lives left," so that's read directly rather than needing
  // its own tracked flag. Bots stay in `players` forever (dead or not), so
  // their alive/respawn state comes from botController.getStatus instead.
  // References `botController` before its own `const` finishes below -
  // safe, since this is only ever CALLED later (from respawnPlayer/
  // eliminatePlayer/handleBotVictim/handleDisconnect, well after the
  // assignment completes), same pattern already used elsewhere in this file.
  function buildTeamStatus(teamId) {
    return rosterSnapshot
      .filter((entry) => entry.teamId === teamId)
      .map((entry) => {
        if (entry.isBot) {
          const status = botController.getStatus(entry.id);
          const livesRemaining = modeConfig.maxBotRespawns === Infinity
            ? null
            : Math.max(0, modeConfig.maxBotRespawns - (status?.respawnCount ?? modeConfig.maxBotRespawns));
          return {
            callsign: entry.callsign, isBot: true, alive: status?.alive ?? false, livesRemaining,
          };
        }
        const player = players.get(entry.id);
        const deathCount = player?.deathCount ?? modeConfig.maxDeaths; // gone from `players` = used up every life
        const livesRemaining = modeConfig.maxDeaths === Infinity ? null : Math.max(0, modeConfig.maxDeaths - deathCount);
        // Still IN `players` during a respawn delay (see beginRespawn's
        // `respawning` flag) - not gone for good, but not really "alive"
        // on screen either for the next few seconds, so the status bar
        // should read them as down until finishRespawn clears the flag.
        return {
          callsign: entry.callsign, isBot: false, alive: Boolean(player) && !player.respawning, livesRemaining,
        };
      });
  }

  // The live "versus bar" score (see client/src/gameScreen.js) - total
  // kills by everyone on this team so far, real players AND bots alike
  // (kill COUNT attribution is always individual via killCountsById
  // regardless of mode - see awardKillPoints' own comment on why that's
  // separate from who gets PAID for a kill). Reuses the same
  // rosterSnapshot + killCountsById pair buildTeamScoreboard already reads
  // at match end - this is just that same sum, read continuously instead
  // of once.
  function getTeamScore(teamId) {
    return rosterSnapshot
      .filter((entry) => entry.teamId === teamId)
      .reduce((total, entry) => total + (killCountsById.get(entry.id) ?? 0), 0);
  }

  // Sends every real player currently in this Coop match their own team's
  // status plus the opposing team's, right now - called whenever team
  // composition changes (respawn, elimination, a bot dying/coming back,
  // disconnect) so the client's live status bar never goes stale. A kill
  // itself always triggers one of those same call sites too (a kill IS a
  // death, handled by handleBotVictim/handlePlayerDeath - see
  // handleShotOnEntity/onBotShoot), so the score below is never stale by
  // more than that one broadcast. A no-op outside Coop (modeConfig.teams
  // false) - never sent for other modes.
  function broadcastTeamStatus() {
    if (!modeConfig.teams) return;
    const teamIds = Array.from(new Set(rosterSnapshot.map((entry) => entry.teamId)));
    for (const player of players.values()) {
      if (!player.socket || player.isBot) continue;
      const otherTeamId = teamIds.find((teamId) => teamId !== player.teamId);
      player.socket.send(JSON.stringify({
        type: 'team-status',
        yourTeam: buildTeamStatus(player.teamId),
        otherTeam: otherTeamId !== undefined ? buildTeamStatus(otherTeamId) : [],
        yourScore: getTeamScore(player.teamId),
        otherScore: otherTeamId !== undefined ? getTeamScore(otherTeamId) : 0,
      }));
    }
  }

  // Battle-royale style placement among ALL starting competitors - real
  // players AND bots, now that a killed bot is gone for the rest of the
  // match (see bots/bot.js's killBot) rather than respawning. Only real
  // players ever get a rank NUMBER recorded (bots have no account to
  // attach a result to - see recordMatchResult), but a bot kill still
  // advances the counter, so a player who dies having outlasted 0 bots
  // correctly reads as last place (e.g. "4th" in a 1-player-vs-3-bots
  // match), not tied with whoever dies after clearing some bots first.
  const totalCompetitors = participants.length;
  let remainingCompetitors = totalCompetitors;

  function captureRankAndAdvance(id) {
    const rank = remainingCompetitors;
    remainingCompetitors -= 1;
    ranksById.set(id, rank); // see buildFullScoreboard above
    broadcastMatchStatus();
    return rank;
  }

  // The classic battle-royale "X remaining" HUD counter (see
  // client/src/gameScreen.js's 'match-status' handler) - real players AND
  // bots both count, same as the rank/placement numbers above, since
  // that's what actually determines when the match ends (checkForLastStanding
  // needs every bot dead too, not just every real player). Gated on
  // modeConfig.showRemainingCount (Versus/Private - see modes.js) rather
  // than sent for every mode: Coop already has its own richer per-member
  // versus bar (buildTeamStatus/broadcastTeamStatus) that would make this
  // redundant clutter, and Survival's bots respawn forever
  // (maxBotRespawns: Infinity) so remainingCompetitors never actually
  // moves there - a "remaining" count that's permanently stuck at the
  // starting total isn't a useful thing to show.
  function broadcastMatchStatus() {
    if (!modeConfig.showRemainingCount) return;
    const message = JSON.stringify({
      type: 'match-status', alive: Math.max(0, remainingCompetitors), total: totalCompetitors,
    });
    for (const player of players.values()) {
      if (player.socket && !player.isBot) player.socket.send(message);
    }
  }

  // Writes one row to the matches table for a real, logged-in player whose
  // match just ended (win or loss), AND credits their `finalPot` to their
  // REAL spendable balance - anonymous players and bots get neither (no
  // account to attach either to). Fire-and-forget from the caller's
  // perspective: a DB hiccup here shouldn't block telling the player their
  // match ended, so failures are just logged.
  //
  // BUG FIX: before users.balance existed, "balance" was just the derived
  // SUM(final_pot) over this same matches table, so recording a match
  // result WAS the only thing that ever needed to happen for a win to grow
  // a player's balance. Once balance became its own real column (for the
  // entry-stake system), match winnings stopped reaching it entirely -
  // recordMatchResult only ever wrote the matches-table row, nothing ever
  // credited the new real balance. That's why a Coop/Versus win banked
  // zero points: the stake was being deducted at entry (real balance) but
  // winnings were only ever landing in the (now-separate) derived stat.
  // finalPot can legitimately be 0 (eliminated with nothing secured) -
  // refundStake(amount<=0) is already a safe no-op, so no extra guard
  // needed here for that case.
  function recordMatchResult(player, result, finalPot, rank) {
    if (!player.userId) return;
    query(
      `INSERT INTO matches (user_id, kills, result, final_pot, rank, total_players, mode) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [player.userId, player.kills, result, finalPot, rank, totalCompetitors, modeConfig.type],
    ).catch((err) => {
      console.error(`Failed to record match result for user ${player.userId}:`, err);
    });
    refundStake(player.userId, finalPot).catch((err) => {
      console.error(`Failed to credit match winnings for user ${player.userId}:`, err);
    });
    recordWinningsPaid(finalPot).catch((err) => {
      console.error('Failed to record match winnings in house ledger:', err);
    });
  }

  // Survival's score: a per-PLAYER best (not a global leaderboard) - a
  // plain GREATEST() update on the user's own row, see schema.sql. The
  // query's own returned value IS the post-write best, so the caller never
  // has to separately re-read anything to know whether this run set a new
  // record. `onDone(personalBest)` fires either way (even for an anonymous
  // player, where it just echoes `score` back) so endSurvivalRun below can
  // stay in one continuation regardless of whether a write happened.
  function recordSurvivalScore(player, score, onDone) {
    if (!player.userId) { onDone(score); return; }
    query(
      `UPDATE users SET survival_best_score = GREATEST(survival_best_score, $1) WHERE id = $2 RETURNING survival_best_score`,
      [score, player.userId],
    ).then((result) => onDone(result.rows[0]?.survival_best_score ?? score))
      .catch((err) => {
        console.error(`Failed to record survival score for user ${player.userId}:`, err);
        onDone(score);
      });
  }

  function broadcastToOthers(message, exceptId) {
    const data = JSON.stringify(message);
    for (const [id, player] of players) {
      if (id !== exceptId && player.socket && player.socket.readyState === player.socket.OPEN) {
        player.socket.send(data);
      }
    }
  }

  function countRealPlayers() {
    return Array.from(players.values()).filter((p) => !p.isBot).length;
  }

  // A unit vector from `from` to `to` - used only for the cosmetic
  // 'shot-fired' broadcast (see onBotShoot below and handleShoot), never
  // for hit registration.
  function directionBetween(from, to) {
    const dx = to.x - from.x;
    const dy = (to.y ?? 0) - (from.y ?? 0);
    const dz = to.z - from.z;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    return { x: dx / length, y: dy / length, z: dz / length };
  }

  // Tells every REAL participant the match has begun and who their initial
  // matchmates are (bots included, flagged with isBot so the client can
  // label them). Bots have no socket, so there's nothing to send them.
  function start() {
    for (const [id, player] of players) {
      if (!player.socket) continue;
      const roster = Array.from(players.entries())
        .filter(([otherId]) => otherId !== id)
        .map(([otherId, otherPlayer]) => ({
          id: otherId,
          position: otherPlayer.position,
          yaw: otherPlayer.yaw,
          isBot: otherPlayer.isBot,
          characterVariant: otherPlayer.characterVariant,
          teamId: otherPlayer.teamId,
          // Wasn't sent before - the client only ever learned OTHER
          // participants' callsigns via Coop's team-status message,
          // nothing outside that mode. Needed now so a bot's overhead tag
          // can show its actual name instead of a generic "BOT" label
          // (see remotePlayers.js's createCharacterEntry) - fixed for the
          // whole match, so this one-time roster snapshot is enough; no
          // need to repeat it on every 'player-moved' update.
          callsign: otherPlayer.callsign,
        }));
      // teamId here is THIS recipient's own team (Coop only, null
      // otherwise) - each roster entry above carries every OTHER
      // participant's teamId, so the client can compare the two to know
      // who's an ally without needing a per-recipient-customized roster.
      player.socket.send(JSON.stringify({
        type: 'match-start', matchId, players: roster, teamId: player.teamId,
      }));
    }
    broadcastTeamStatus(); // Coop only (no-op otherwise) - so the status bar shows correctly from the very first frame, not just after the first death
    broadcastMatchStatus(); // Versus/Private only (no-op otherwise) - same reasoning, for the "X remaining" counter
  }

  const botEntries = Array.from(players.entries())
    .filter(([, p]) => p.isBot)
    .map(([id, p]) => ({ id, position: p.position }));
  const botController = createBotController(botEntries, {
    // Only REAL players are things a bot can detect/attack - and, in Coop,
    // only OPPOSING real players: `botId` identifies which bot is asking,
    // so its own team's real players can be excluded from what IT can see.
    // Without this, a bot had no team awareness at all and would attack any
    // real player in range regardless of side - "my ally is shooting me".
    // `!p.respawning` (see beginRespawn/finishRespawn) excludes a real
    // player currently mid-respawn-delay - they're still in `players` (not
    // eliminated) but shouldn't be a valid target: they have no real
    // on-screen position right now, and a bot/player "killing" them again
    // before their delay finishes would double-count the death (extra
    // deathCount increment, a second respawn timer stacked on the first).
    getRealPlayers: (botId) => {
      const bot = players.get(botId);
      return Array.from(players.entries())
        .filter(([, p]) => !p.isBot && !p.respawning && (!modeConfig.teams || p.teamId !== bot?.teamId))
        .map(([id, p]) => ({ id, position: p.position }));
    },

    // Gated on modeConfig.botsFightEachOther (undefined/false - not even
    // passed - for modes that don't want it, so bot.js's findNearestTarget
    // skips bot-vs-bot entirely there): other bots this bot should treat as
    // targets, still alive right now. In a TEAM mode (Coop), that's the
    // opposing team only - this is what makes Coop real team-vs-team combat
    // instead of bots just patrolling until a real player wanders by, "my
    // ally isn't assisting me" was this exact gap. In a non-team, free-for-
    // all mode (Versus), there's no team to filter by - EVERY other living
    // bot is fair game, matching a real battle royale where nothing is
    // allied with anything else. References `botController` before its own
    // `const` finishes - safe because this is only ever CALLED from
    // tick(), on a setInterval that fires well after createBotController
    // has returned and the assignment below has completed (same pattern
    // handleShoot's botController.isAlive check already relies on).
    getEnemyBots: modeConfig.botsFightEachOther ? (botId) => {
      const bot = players.get(botId);
      return Array.from(players.entries())
        .filter(([id, p]) => id !== botId && p.isBot && botController.isAlive(id) && (!modeConfig.teams || p.teamId !== bot?.teamId))
        .map(([id, p]) => ({ id, position: p.position }));
    } : undefined,

    // Bot patrol/attack movement, broadcast the same way a real player's
    // 'move' message would be - the client doesn't need to know or care
    // that this update was generated locally instead of arriving over the
    // network.
    onBotMoved: (id, position, yaw) => {
      const bot = players.get(id);
      if (!bot) return;
      bot.position = position;
      bot.yaw = yaw;
      broadcastToOthers({ type: 'player-moved', id, position, yaw, isBot: true }, id);
    },

    // A bot's shot connecting with a real player OR (Coop only, see
    // getEnemyBots above) an enemy bot - same damage rules either way (see
    // applyDamage). Bots don't do a real raycast (see bots/bot.js's
    // hitChance probability check) so there's no genuine origin/direction
    // to relay - approximated as a straight line from the bot to its
    // target purely for the shot-fired broadcast below (cosmetic only, see
    // shootEffects.js), not used for hit registration.
    onBotShoot: (botId, targetId) => {
      const bot = players.get(botId);
      if (!bot) return;

      const target = players.get(targetId);
      if (target) {
        const direction = directionBetween(bot.position, target.position);
        broadcastToOthers({
          type: 'shot-fired', id: botId, origin: bot.position, direction,
        }, botId);
      }

      const died = applyDamage(targetId, bot.callsign);
      if (!died) return;

      bot.kills += 1;
      killCountsById.set(botId, bot.kills);
      awardKillPoints(bot, Boolean(target?.isBot));
      console.log(`${bot.callsign} killed ${target?.callsign ?? targetId} in match ${matchId}`);

      if (target?.isBot) {
        handleBotVictim(targetId);
      } else {
        handlePlayerDeath(targetId, bot.callsign);
      }
    },

    // Coop's live status bar needs to refresh the instant a bot respawns
    // (its lives-remaining count just changed) - no-op everywhere else
    // since onBotRespawned is only ever read by bot.js's tick(), never
    // required.
    onBotRespawned: () => broadcastTeamStatus(),
  }, {
    ...(modeConfig.botsRespawn ? {
      respawnDelayMs: modeConfig.botRespawnDelayMs,
      getSpawnPoint: () => SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)],
      maxRespawns: modeConfig.maxBotRespawns,
    } : {}),
    hitChance: modeConfig.botHitChance,
    shotIntervalMs: modeConfig.botShotIntervalMs,
  });

  function handleMove(id, position, yaw) {
    const player = players.get(id);
    if (!player) return;
    // Waiting to respawn (see beginRespawn/finishRespawn's `respawning` flag)
    // - the client's own controls lock during this window (see
    // gameScreen.js's 'respawn-countdown'/'respawn' handlers), but that's
    // only ever a courtesy; the server must never trust a client not to send
    // move updates anyway, so this stays authoritative here too. Silently
    // dropped, not broadcast - a stray update from this window shouldn't
    // resurrect a corpse for other clients (they already got 'player-left').
    if (player.respawning) return;

    const now = Date.now();
    const deltaSeconds = (now - player.lastMoveAt) / 1000;
    const { secondsInZone, didBank } = updateExtractionState(position, player.secondsInZone, deltaSeconds, modeConfig);

    player.position = position;
    player.yaw = yaw;
    player.secondsInZone = secondsInZone;
    player.lastMoveAt = now;

    if (didBank) bankCurrentPot(id);

    broadcastToOthers({ type: 'player-moved', id, position, yaw, isBot: false }, id);
  }

  // Locks in the player's current unsecured pot as secured - unlike the old
  // behavior, this does NOT end their match or remove them from it. They
  // keep playing and can bank again later; only what's still unsecured is
  // at risk if they're killed afterward.
  function bankCurrentPot(id) {
    const player = players.get(id);
    if (!player || player.isBot) return;

    const bankedAmount = player.pot;
    player.securedPot += bankedAmount;
    player.pot = 0;

    console.log(`${player.callsign} banked ${bankedAmount} (secured total ${player.securedPot}) in match ${matchId}`);
    if (player.socket) {
      player.socket.send(JSON.stringify({
        type: 'banked',
        bankedAmount,
        securedPot: player.securedPot,
        pot: player.pot,
      }));
    }
  }

  function handleShoot(id, origin, direction) {
    const player = players.get(id);
    if (!player) return;
    // Waiting to respawn - see handleMove's matching guard above for why
    // this stays server-side authoritative too, not just a client-side lock.
    // Silently dropped, same as a rejected shot, but with no message back -
    // a legitimate client never sends one of these in the first place once
    // its own controls are locked.
    if (player.respawning) return;

    // Basic anti-cheat: the claimed shot origin must be near where the
    // server last knew this player to be. Generous tolerance since
    // position updates arrive at ~20Hz, not every frame.
    const dx = origin.x - player.position.x;
    const dy = origin.y - player.position.y;
    const dz = origin.z - player.position.z;
    const distanceFromKnownPosition = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (distanceFromKnownPosition > SHOT_POSITION_TOLERANCE) {
      console.log(`Rejected shot from ${id} in match ${matchId}: origin too far from known position`);
      player.socket.send(JSON.stringify({ type: 'shoot-result', hit: false, rejected: true }));
      return;
    }

    // Cosmetic only (see shootEffects.js) - every legitimate shot flashes
    // for bystanders, hit or miss, same as a real gun. Rejected shots
    // (above) don't broadcast anything - they're not a real shot.
    broadcastToOthers({
      type: 'shot-fired', id, origin, direction,
    }, id);

    const targetHit = findClosestHitTarget(origin, direction);

    // Free-for-all (or, when this mode has teams, anyone NOT on the
    // shooter's own team - friendly fire is off in Coop): any other living
    // entity is a valid target. A bot already killed this match isn't
    // hittable (unless it's since respawned - botController.isAlive()
    // reflects that either way, see bot.js) - a real player mid-respawn-
    // delay isn't hittable either, same reasoning as getRealPlayers above
    // (see beginRespawn/finishRespawn's p.respawning flag).
    const otherEntities = Array.from(players.entries())
      .filter(([otherId, p]) => otherId !== id
        && (!p.isBot || botController.isAlive(otherId))
        && !p.respawning
        && (!modeConfig.teams || p.teamId !== player.teamId))
      .map(([otherId, p]) => ({ id: otherId, position: p.position }));
    const entityHit = findClosestHitEntity(origin, direction, otherEntities);

    // The map's walls block shots too - a target/entity only counts as hit
    // if nothing solid stood between the shooter and it. Whichever of
    // {wall, target, entity} is closest wins - a real raycast only ever
    // registers the nearest surface along the ray.
    const wallHit = findClosestWallHit(origin, direction);
    const isBlockedByWall = (candidateDistance) => wallHit !== null && wallHit.distance < candidateDistance;

    const entityIsCloser = entityHit !== null
      && (targetHit === null || entityHit.distance < targetHit.distance)
      && !isBlockedByWall(entityHit.distance);
    const targetIsHit = !entityIsCloser && targetHit !== null && !isBlockedByWall(targetHit.distance);

    if (entityIsCloser) {
      handleShotOnEntity(entityHit.id, id, player);
    } else if (targetIsHit) {
      player.pot += POINTS_PER_HIT;
      player.socket.send(JSON.stringify({ type: 'shoot-result', hit: true, killed: false, pot: player.pot }));
    } else {
      player.socket.send(JSON.stringify({ type: 'shoot-result', hit: false }));
    }
  }

  // Applies one hit's damage to a victim (bot or real player). Returns
  // true if they died. A REAL player who survives gets a 'hit' message so
  // their health bar updates - bots don't need one, nobody's watching a
  // bot's health bar.
  function applyDamage(victimId, attackerCallsign) {
    const victim = players.get(victimId);
    if (!victim) return false;

    victim.health -= DAMAGE_PER_HIT;
    if (victim.health <= 0) return true;

    if (victim.socket) {
      victim.socket.send(JSON.stringify({
        type: 'hit',
        health: victim.health,
        maxHealth: MAX_HEALTH,
        hitBy: attackerCallsign,
      }));
    }
    return false;
  }

  // Pays out a kill AND sends every recipient their own 'shoot-result' -
  // the only place either happens, so the direct killer's own message
  // (when they're a real player) and their teammates' messages can never
  // both fire for the same kill. In Coop, the FULL kill-point value goes
  // to every real player on the killer's team, including the killer
  // themselves if they're one (confirmed with the user - not a reduced
  // "assist" amount for teammates), so an ally scoring still pays you.
  // Everywhere else (no teams), it's just the direct killer (and only if
  // they're a real player - a bot has no wallet/UI of its own to notify).
  // Kill COUNT attribution (killer.kills, killCountsById, both updated by
  // the caller before this runs) is always individual regardless of mode -
  // that's what the post-match scoreboard needs to show who actually got
  // each kill, separate from who got paid for it.
  //
  // `victimIsBot` picks which of the mode's two per-kill values applies -
  // a bot kill pays modeConfig.botPointsPerKill (a % of the normal value,
  // see modes.js's BOT_KILL_VALUE_PERCENT), never the full amount. This is
  // about the VICTIM, not the killer - an ally bot in Coop scoring a real
  // kill still pays the team its full normal rate; only the recipients of a
  // BOT'S death get the discounted number, whoever did the killing.
  // Without this, a mostly-bot-filled match (bots fill any queue that's
  // short on real players, see index.js) would let a team farm the exact
  // same kill-point value from a bot as from an actual opposing player,
  // draining the raked economy for free.
  function awardKillPoints(killer, victimIsBot) {
    const recipients = modeConfig.teams
      ? Array.from(players.values()).filter((p) => !p.isBot && p.teamId === killer.teamId)
      : (killer.isBot ? [] : [killer]);

    // House rake applied HERE, per recipient - this is a payout (see
    // wallet.js's applyRake), unlike a player extracting/banking their own
    // already-earned pot, which never gets raked.
    const rawValue = victimIsBot ? modeConfig.botPointsPerKill : modeConfig.pointsPerKill;
    const payout = applyRake(rawValue);
    if (recipients.length > 0) {
      recordRakeCollected((rawValue - payout) * recipients.length).catch((err) => {
        console.error('Failed to record kill-payout rake in house ledger:', err);
      });
    }
    for (const p of recipients) {
      p.pot += payout;
      if (p.socket) {
        p.socket.send(JSON.stringify({ type: 'shoot-result', hit: true, killed: true, pot: p.pot }));
      }
    }
  }

  // A bot's death, however it happened (a real player's shot - see
  // handleShotOnEntity below - or another bot's, see onBotShoot above).
  // Normally advances the placement counter and checks for a match-ending
  // condition; skipped when the bot is coming back (botsRespawn mode) -
  // see bot.js's killBot for what decides that (limited in Coop, unlimited
  // in Survival).
  function handleBotVictim(victimId) {
    const victim = players.get(victimId);
    if (!victim) return;

    victim.health = MAX_HEALTH; // reset now - it's untargetable until/unless it respawns anyway
    broadcastToOthers({ type: 'player-left', id: victimId });
    const willRespawn = botController.killBot(victimId);
    broadcastTeamStatus(); // reflect the immediate "down" state even if it comes back later - the eventual respawn itself refreshes again via onBotRespawned
    if (willRespawn) return; // it's coming back - see bot.js's tick(), no placement/end-of-match bookkeeping yet

    captureRankAndAdvance(victimId); // a permanently-killed bot occupies a placement slot too - see the comment above totalCompetitors
    // Clearing the last bot on a side can itself be the thing that ends the
    // match (Coop: that bot's team just lost its last fighter; non-team
    // modes: a lone remaining real player just cleared every bot) - check
    // here too, not just after a real player is eliminated/disconnects.
    checkForMatchEndCondition();
  }

  // A player's shot connecting with a bot OR another real player.
  function handleShotOnEntity(victimId, shooterId, shooterPlayer) {
    const victim = players.get(victimId);
    if (!victim) return;

    const died = applyDamage(victimId, shooterPlayer.callsign);

    if (!died) {
      // Registered as a hit, but they're still alive - no kill reward yet.
      shooterPlayer.socket.send(JSON.stringify({ type: 'shoot-result', hit: true, killed: false, pot: shooterPlayer.pot }));
      return;
    }

    shooterPlayer.kills += 1;
    killCountsById.set(shooterId, shooterPlayer.kills);
    console.log(`${shooterPlayer.callsign} killed ${victim.callsign} in match ${matchId}`);
    awardKillPoints(shooterPlayer, victim.isBot); // sends shooterPlayer (and, in Coop, their teammates) their own 'shoot-result' - see its own comment

    if (victim.isBot) {
      handleBotVictim(victimId);
    } else {
      handlePlayerDeath(victimId, shooterPlayer.callsign);
    }
  }

  // Routes a real player's death to whatever this mode does about it:
  // Survival ends their run outright (they have exactly one life, handled
  // entirely separately). Everyone else gets one more death counted against
  // modeConfig.maxDeaths (see modes.js - "deathCount at which they're
  // eliminated", not "how many times they may die") and either respawns
  // (still under the limit) or is eliminated for good (reached it) -
  // Versus's maxDeaths: 1 means every death still ends the match
  // immediately, exactly like before Coop/Private existed.
  function handlePlayerDeath(id, killedByCallsign) {
    const player = players.get(id);
    if (!player || player.isBot) return;

    if (modeConfig.type === 'survival') {
      endSurvivalRun(id, killedByCallsign);
      return;
    }

    player.deathCount += 1;
    if (player.deathCount < modeConfig.maxDeaths) {
      beginRespawn(id, killedByCallsign);
    } else {
      eliminatePlayer(id, killedByCallsign);
    }
  }

  // Starts a Coop/Private respawn - the FIRST of two phases (see
  // finishRespawn below), fired the instant death happens rather than
  // resetting the player immediately. Loses whatever pot was still at risk
  // right away (dying loses it, exactly like a permanent elimination does -
  // see eliminatePlayer's finalPot = securedPot, unsecured lost - without
  // this, respawning made death consequence-free for points), marks the
  // player `respawning` (see getRealPlayers/otherEntities above - makes
  // them untargetable for the rest of the delay, so a second "kill" can't
  // land on someone already dead and stack a second respawn on top of the
  // first), tells the player themselves how long the countdown is (client
  // shows a banner - see gameScreen.js's 'respawn-countdown' handler), and
  // tells everyone else this id just went down (the normal death-fall
  // animation - client/src/remotePlayers.js's remove() - safely gets
  // cancelled and replaced once finishRespawn's 'player-respawned' arrives,
  // same as it already does for a permanent elimination).
  function beginRespawn(id, killedByCallsign) {
    const player = players.get(id);
    if (!player || player.isBot) return;

    const lostPot = player.pot;
    player.pot = 0;
    player.respawning = true;

    console.log(`${player.callsign} died (death ${player.deathCount}/${modeConfig.maxDeaths === Infinity ? '∞' : modeConfig.maxDeaths}, lost ${lostPot} unsecured pot) - respawning in ${RESPAWN_DELAY_MS / 1000}s in match ${matchId}`);

    if (player.socket) {
      player.socket.send(JSON.stringify({
        type: 'respawn-countdown',
        seconds: RESPAWN_DELAY_MS / 1000,
        pot: player.pot,
        securedPot: player.securedPot,
        killedBy: killedByCallsign,
      }));
    }
    broadcastToOthers({ type: 'player-left', id });
    broadcastTeamStatus(); // reflect the "down, respawning" state immediately - see buildTeamStatus's respawning check above

    setTimeout(() => finishRespawn(id, killedByCallsign), RESPAWN_DELAY_MS);
  }

  // Second phase - actually brings the player back: resets health/
  // position/zone-progress (kills/deathCount stay as-is; pot was already
  // zeroed in beginRespawn above) and clears `respawning` so they're a
  // valid target again. Guarded the same way every other player-scoped
  // function here is - if they disconnected during the delay, `players`
  // no longer has them and this is a safe no-op. The player themselves
  // gets a 'respawn' message (their own match keeps running, including the
  // now-zeroed pot so their HUD updates) - everyone else gets
  // 'player-respawned' so their view of this id reappears.
  function finishRespawn(id, killedByCallsign) {
    const player = players.get(id);
    if (!player || player.isBot) return;

    const spawnPoint = SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)];
    player.health = MAX_HEALTH;
    player.position = { x: spawnPoint.x, y: 1.7, z: spawnPoint.z };
    player.yaw = 0;
    player.secondsInZone = 0;
    player.respawning = false;

    console.log(`${player.callsign} respawned in match ${matchId}`);

    if (player.socket) {
      player.socket.send(JSON.stringify({
        type: 'respawn',
        position: player.position,
        yaw: player.yaw,
        health: player.health,
        maxHealth: MAX_HEALTH,
        pot: player.pot,
        securedPot: player.securedPot,
        deathsRemaining: modeConfig.maxDeaths === Infinity ? null : modeConfig.maxDeaths - player.deathCount,
        killedBy: killedByCallsign,
      }));
    }
    broadcastToOthers({
      type: 'player-respawned',
      id,
      position: player.position,
      yaw: player.yaw,
      isBot: false,
      characterVariant: player.characterVariant,
      teamId: player.teamId,
    }, id);
    broadcastTeamStatus();
  }

  // Survival's ending: the human player has exactly one life, so any death
  // ends their run outright - no rank/placement (solo vs. bots, nothing to
  // rank against), just a score (their pot at the moment of death) and
  // whether it beat their stored personal best. See recordSurvivalScore
  // above for how that best is stored (per-player, not a shared leaderboard).
  function endSurvivalRun(id, killedByCallsign) {
    const player = players.get(id);
    if (!player || player.isBot) return;

    const score = player.securedPot + player.pot;
    players.delete(id);

    recordSurvivalScore(player, score, (personalBest) => {
      if (player.socket) {
        player.socket.matchId = null;
        player.socket.send(JSON.stringify({
          type: 'match-ended',
          reason: 'survival-ended',
          score,
          personalBest,
          isNewRecord: personalBest === score,
          killedBy: killedByCallsign,
          kills: player.kills,
        }));
      }
      console.log(`${player.callsign} survival run ended with score ${score} (personal best ${personalBest}) in match ${matchId}`);
      checkForEmptyMatch();
    });
  }

  // Removes a REAL player from the match after being killed: only their
  // currently-UNSECURED pot is lost - anything already locked in by a
  // previous extraction this match stays theirs. Bots are never passed
  // here - see handleShotOnEntity above.
  function eliminatePlayer(id, killedByCallsign) {
    const player = players.get(id);
    if (!player || player.isBot) return;

    const rank = captureRankAndAdvance(id);
    const finalPot = player.securedPot; // the unsecured portion is lost; secured survives

    const teamId = player.teamId; // captured before players.delete() below
    players.delete(id);
    if (player.socket) {
      player.socket.matchId = null;
      player.socket.send(JSON.stringify({
        type: 'match-ended',
        reason: 'eliminated',
        killedBy: killedByCallsign,
        finalPot,
        rank,
        totalPlayers: totalCompetitors,
        kills: player.kills,
        teamScoreboard: modeConfig.teams ? buildTeamScoreboard(teamId) : undefined,
        fullScoreboard: modeConfig.showFullScoreboard ? buildFullScoreboard() : undefined,
      }));
    }
    broadcastToOthers({ type: 'player-left', id });
    console.log(`${player.callsign} was eliminated by ${killedByCallsign} (rank ${rank}/${totalCompetitors}) in match ${matchId}`);
    recordMatchResult(player, 'eliminated', finalPot, rank);
    broadcastTeamStatus(); // player already removed from `players` above, so buildTeamStatus correctly reads them as down

    checkForMatchEndCondition();
    checkForEmptyMatch();
  }

  // Ends the match for one remaining real player without them dying - used
  // for both "last player standing" and the match time limit. Normally
  // their full total (secured + whatever was still unsecured) banks;
  // Private is the exception specifically for the TIMER-elapsed reason -
  // "points gotten from timer dont count as pot" means running out the
  // clock only banks what was already secured, same as if they'd been
  // eliminated. A genuine last-standing win (everyone else eliminated
  // before the timer) still banks the full total even in Private - only
  // "you just ran out the clock" is reduced.
  // `winnerCount` is how many real players are winning in this SAME batch
  // (last-standing is always exactly 1; a team-victory or the time-limit
  // timeout can end the match for several people at once) - needed to
  // split Private's stake pool evenly between simultaneous winners. It has
  // to be computed by the CALLER before any of them are processed (see
  // checkForTeamVictory/the time-limit handler below), not re-derived
  // in here, since `players` shrinks (via players.delete below) after each
  // individual winner in the same batch is handled.
  function endMatchForSurvivor(id, reason, winnerCount = 1) {
    const player = players.get(id);
    if (!player || player.isBot) return;

    const rank = captureRankAndAdvance(id);
    const reducedPayout = reason === 'time-limit' && !modeConfig.bankUnsecuredOnTimeLimit;
    const finalPot = reducedPayout ? player.securedPot : player.securedPot + player.pot;

    // Private's pooled stake: "whoever wins claims stake" - every call to
    // endMatchForSurvivor (never eliminatePlayer) IS a win, so no reason
    // filtering is needed here. Split evenly across simultaneous winners
    // (Math.floor - any remainder from an uneven split is simply not paid
    // out, an acceptable prototype-scale rounding loss). An anonymous
    // winner's share is silently forfeited, never credited anywhere else -
    // confirmed with the user ("they can't claim it").
    if (modeConfig.type === 'private' && stakePool > 0 && player.userId) {
      // House rake applied to the RAW share, before rounding it across
      // winners - a stake-pool win is a payout same as a kill reward, see
      // wallet.js's applyRake. This function runs once PER winner (see its
      // own comment on winnerCount), so the total rake on the pool is
      // likewise split into a per-winner slice here (same floor-rounding
      // tradeoff already accepted for `share` below) rather than recorded
      // in full on every call, which would over-count it for a multi-
      // winner batch (team-victory, or several players hitting the time
      // limit at once).
      const totalRake = stakePool - applyRake(stakePool);
      const rakeShare = Math.floor(totalRake / winnerCount);
      recordRakeCollected(rakeShare).catch((err) => {
        console.error('Failed to record stake-pool rake in house ledger:', err);
      });
      const share = Math.floor(applyRake(stakePool) / winnerCount);
      if (share > 0) {
        refundStake(player.userId, share).catch((err) => {
          console.error(`Failed to pay stake-pool share to user ${player.userId}:`, err);
        });
        recordWinningsPaid(share).catch((err) => {
          console.error('Failed to record stake-pool payout in house ledger:', err);
        });
      }
    }

    const teamId = player.teamId; // captured before players.delete() below
    players.delete(id);
    if (player.socket) {
      player.socket.matchId = null;
      player.socket.send(JSON.stringify({
        type: 'match-ended',
        reason,
        finalPot,
        rank,
        totalPlayers: totalCompetitors,
        kills: player.kills,
        teamScoreboard: modeConfig.teams ? buildTeamScoreboard(teamId) : undefined,
        fullScoreboard: modeConfig.showFullScoreboard ? buildFullScoreboard() : undefined,
      }));
    }
    broadcastToOthers({ type: 'player-left', id });
    console.log(`${player.callsign} match ended (${reason}) with ${finalPot} points (rank ${rank}/${totalCompetitors}) in match ${matchId}`);
    recordMatchResult(player, reason, finalPot, rank);

    checkForEmptyMatch();
  }

  // "Match ends... as last man standing": once exactly one real player
  // remains AND every bot in the match has also been killed, that lone
  // survivor has genuinely eliminated everyone else - their match ends too
  // (auto-win) rather than sitting them alone until the time limit. Used by
  // every non-team mode (Versus/Private/Survival) - see
  // checkForMatchEndCondition below for Coop's team-based equivalent.
  function checkForLastStanding() {
    const realPlayerIds = Array.from(players.entries()).filter(([, p]) => !p.isBot).map(([id]) => id);
    if (realPlayerIds.length === 1 && botController.allBotsDead()) {
      endMatchForSurvivor(realPlayerIds[0], 'last-standing');
    }
  }

  // Coop's real win condition: once one team has ZERO LIVING MEMBERS AT ALL
  // (real players AND bots - a bot that's permanently dead, i.e. exhausted
  // its respawns, no longer counts), every surviving real player on every
  // OTHER team has won outright - their match ends and their full total
  // banks, same treatment endMatchForSurvivor already gives a last-standing
  // survivor.
  //
  // A first version of this only counted REAL players toward "defeated",
  // which silently broke the common case of a solo player queuing into
  // Coop with bots filling BOTH teams: the enemy team (all bots, zero real
  // players from the start) never appeared in its team-id set at all, so
  // wiping out every enemy bot never registered as a win - "game didn't end
  // after eliminating the other group." Fixed by tracking which team ids
  // still have ANY living member (real player present in `players`, or a
  // bot with botController.isAlive(id) true) instead of real-player counts,
  // and reading rosterSnapshot (not `players`) for the full set of team ids
  // that existed at match start - a fully-wiped team has no entries left in
  // `players` to discover a real player's id from, but bots stay in
  // `players` forever (just not alive), so they're checked directly.
  function checkForTeamVictory() {
    const allTeamIds = new Set(rosterSnapshot.map((entry) => entry.teamId));
    const teamsWithLivingMembers = new Set();
    for (const [id, p] of players) {
      if (!p.isBot || botController.isAlive(id)) teamsWithLivingMembers.add(p.teamId);
    }
    const defeatedTeamIds = Array.from(allTeamIds).filter((teamId) => !teamsWithLivingMembers.has(teamId));
    if (defeatedTeamIds.length === 0) return; // every team still has at least one living member

    const winnerIds = Array.from(players.entries())
      .filter(([, p]) => !p.isBot && !defeatedTeamIds.includes(p.teamId))
      .map(([id]) => id);
    for (const id of winnerIds) endMatchForSurvivor(id, 'team-victory', winnerIds.length);
  }

  // Picks the right match-ending check for this mode - Coop's is team-
  // based (checkForTeamVictory), everything else keeps the original
  // single-survivor condition (checkForLastStanding) unchanged.
  function checkForMatchEndCondition() {
    if (modeConfig.teams) {
      checkForTeamVictory();
    } else {
      checkForLastStanding();
    }
  }

  function checkForEmptyMatch() {
    if (countRealPlayers() === 0) {
      destroy();
      onEmpty(matchId);
    }
  }

  function handleDisconnect(id) {
    const player = players.get(id);
    if (!player) return;
    players.delete(id);
    broadcastToOthers({ type: 'player-left', id });
    // A disconnect isn't a ranked result (no clean outcome to record), but
    // it still occupies a placement slot - advance the rank counter so
    // whoever finishes after them gets the correct number instead of one
    // that's off-by-one (e.g. the sole remaining player reading as 2nd).
    if (!player.isBot) captureRankAndAdvance(id);
    broadcastTeamStatus(); // player already removed from `players` above, so buildTeamStatus correctly reads them as down
    // It can also leave exactly one real player behind (or, in Coop, wipe
    // out their whole team) - that shouldn't require waiting out the full
    // time limit to resolve.
    checkForMatchEndCondition();
    checkForEmptyMatch();
  }

  // Survival has no forced ending - "the bots can infinitely respawn, the
  // aim is to set a high score" only makes sense as an open-ended run that
  // lasts until the player actually dies, not one silently cut off at the
  // same 3-minute cap every other mode uses. Every other mode keeps the
  // existing global time limit unchanged.
  const timeLimitTimeoutId = modeConfig.type === 'survival' ? null : setTimeout(() => {
    const realPlayerIds = Array.from(players.entries()).filter(([, p]) => !p.isBot).map(([id]) => id);
    for (const id of realPlayerIds) {
      endMatchForSurvivor(id, 'time-limit', realPlayerIds.length);
    }
  }, MATCH_TIME_LIMIT_MS);

  // Stops the bot behavior loop and the match timer. Called once no real
  // players remain, from whatever path got it there - otherwise an
  // abandoned match's bots (and its timers) keep running forever.
  function destroy() {
    botController.stop();
    if (timeLimitTimeoutId) clearTimeout(timeLimitTimeoutId);
  }

  return { start, handleMove, handleShoot, handleDisconnect };
}
