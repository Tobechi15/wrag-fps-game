// Per-mode rule tables for createMatch() (see match.js). Kept as pure data
// in its own file since match.js is already the biggest module in the
// server and about to grow further with respawn/survival logic - this way
// "what's different about each mode" stays scannable in one place instead
// of scattered through match.js's runtime code.
//
// Every operator-tunable number below reads from .env first (see
// .env.example/DEV_README.md), falling back to the exact values this
// project already shipped with if unset - so an untouched .env changes
// nothing, and an operator can retune difficulty/economy without touching
// code or redeploying anything but the env file + a server restart.
const POINTS_PER_KILL = 50; // Versus/Private/Survival - unchanged from before these modes existed

// The flat entry stake (PTS) for Versus/Coop - Private has no fixed stake,
// see modeConfigs.private.entryStake below.
const ENTRY_STAKE = Number(process.env.ENTRY_STAKE ?? 100);

// How many lives a real player gets in Coop before elimination (maxDeaths
// below is "deathCount at which they're eliminated" - 3 lives means 2
// respawns granted, eliminated on the 3rd death) and how many times a Coop
// bot can respawn - both operator-tunable now rather than hardcoded, so
// "increase/decrease lives" never needs a code change. Kept as two
// separate env vars (not tied together) since a real player and a bot
// dying at different rates is a legitimate difficulty knob on its own.
const COOP_MAX_DEATHS = Number(process.env.COOP_MAX_DEATHS ?? 3);
const COOP_MAX_BOT_RESPAWNS = Number(process.env.COOP_MAX_BOT_RESPAWNS ?? 2);

// Coop's kill reward: it takes COOP_MAX_DEATHS kills to eliminate a real
// player who staked ENTRY_STAKE to enter, so a single kill is worth
// 1/COOP_MAX_DEATHS of that stake - e.g. a 100-PTS stake with 3 lives pays
// ~33 PTS/kill, not the FULL 100 (that would let one team recover its
// entire opposing stake off a single kill, however many lives that player
// actually had). This is a genuine derivation from the lives count, not a
// hardcoded "/3" that happened to match the old fixed 3-lives default -
// retuning COOP_MAX_DEATHS above automatically retunes this too.
const COOP_POINTS_PER_KILL = Math.round(ENTRY_STAKE / COOP_MAX_DEATHS);

// A bot kill is worth less than a real player's - a match padded with bots
// shouldn't let a team farm the same kill-point value they'd get from
// actually eliminating a real opponent, which would otherwise let a mostly-
// bot-filled match drain the rake/economy for free. Expressed as a % of
// whatever the mode's normal (real-player) pointsPerKill is - applied in
// match.js's awardKillPoints based on the VICTIM's type, not the killer's
// (an ally bot scoring a kill still pays the mode's normal recipient rules,
// see awardKillPoints' own comment - this only discounts kills where the
// dead entity was itself a bot).
const BOT_KILL_VALUE_PERCENT = Number(process.env.BOT_KILL_VALUE_PERCENT ?? 50);
function botKillValue(pointsPerKill) {
  return Math.round(pointsPerKill * (BOT_KILL_VALUE_PERCENT / 100));
}

// How many total participants (real players + bots) a match should have -
// bots fill whatever's left once the queue's countdown elapses (see
// index.js's queue onMatchStart callbacks). Versus is a single free-for-all
// pool; Coop must stay EVEN (teamId alternates 0/1 by join order - see
// match.js's createMatch) for a balanced 2-team split, so an odd env value
// here is rounded up to the next even number rather than silently
// producing a 1-player-short side.
const VERSUS_MATCH_SIZE = Number(process.env.VERSUS_MATCH_SIZE ?? 20);
const COOP_MATCH_SIZE_RAW = Number(process.env.COOP_MATCH_SIZE ?? 10);
const COOP_MATCH_SIZE = COOP_MATCH_SIZE_RAW % 2 === 0 ? COOP_MATCH_SIZE_RAW : COOP_MATCH_SIZE_RAW + 1;

// Comfortably above client/src/remotePlayers.js's DEATH_DISPLAY_SECONDS
// (3s, the death-fall animation's runtime) so a respawned bot's new
// 'player-moved' broadcast never arrives while the client is still mid-way
// through disposing the old instance of the same id - see bot.js's tick().
// Shared by Coop and Survival - Coop's real players get COOP_MAX_DEATHS-1
// respawns each, so a bot on their team permanently vanishing after one
// death left teams eroding unevenly while players kept coming back; bots
// now respawn the same way, just not with Survival's true "forever".
const BOT_RESPAWN_DELAY_MS = 5000;

// Coop bots fight autonomously across team lines now (see match.js's
// getEnemyBots/bot.js's findNearestTarget) instead of just patrolling until
// a real player wanders by - "make ally a bit more lethal than the average
// bot" bumps their hit chance/fire rate a bit over the DEFAULT_HIT_CHANCE/
// DEFAULT_SHOT_INTERVAL_MS baseline every other mode's bots still use
// (bot.js's own module defaults apply whenever a mode's config omits these -
// also env-driven now, see bot.js).
const COOP_BOT_HIT_CHANCE = Number(process.env.COOP_BOT_HIT_CHANCE ?? 0.72);
const COOP_BOT_SHOT_INTERVAL_MS = Number(process.env.COOP_BOT_SHOT_INTERVAL_MS ?? 1800);

export const MODE_CONFIGS = {
  versus: {
    type: 'versus',
    teams: false,
    // maxDeaths is "deathCount at which a player is eliminated", not "how
    // many times they may die" - 1 means eliminated on their very first
    // death, i.e. no respawns at all, exactly the original single-life
    // behavior every match had before Coop/Private introduced respawning.
    maxDeaths: 1,
    pointsPerKill: POINTS_PER_KILL,
    botPointsPerKill: botKillValue(POINTS_PER_KILL), // a bot kill pays less - see BOT_KILL_VALUE_PERCENT above
    entryStake: ENTRY_STAKE, // see server/src/index.js's 'join-queue' handler for where this is actually deducted
    bankUnsecuredOnTimeLimit: true, // surviving to the time limit banks everything, same as always
    botsRespawn: false,
    botRespawnDelayMs: null,
    maxBotRespawns: 0,
    matchSize: VERSUS_MATCH_SIZE, // total participants (real + bot-filled) - see index.js's versusQueue
    // Free-for-all: bots treat every OTHER bot as a valid target too, not
    // just real players - a real battle royale shouldn't have bots calmly
    // ignoring each other while only hunting real players. No team concept
    // here (teams: false above), so match.js's getEnemyBots skips the
    // team filter entirely for this mode - see its own comment.
    botsFightEachOther: true,
    // The classic battle-royale "X remaining" HUD counter (see match.js's
    // broadcastMatchStatus) - real battle royale, real counter.
    showRemainingCount: true,
    // The full-match leaderboard (every participant's kills + final rank -
    // see match.js's buildFullScoreboard) attached to the post-match
    // screen. Versus only - Coop already has its own per-team
    // buildTeamScoreboard, and Private/Survival never asked for this.
    showFullScoreboard: true,
  },
  coop: {
    type: 'coop',
    teams: true, // alternating teamId 0/1 - see match.js's createMatch
    maxDeaths: COOP_MAX_DEATHS,
    pointsPerKill: COOP_POINTS_PER_KILL,
    botPointsPerKill: botKillValue(COOP_POINTS_PER_KILL), // a bot kill pays less - see BOT_KILL_VALUE_PERCENT above
    entryStake: ENTRY_STAKE,
    bankUnsecuredOnTimeLimit: true,
    botsRespawn: true, // bots respawn too, same as real players do (see BOT_RESPAWN_DELAY_MS above)
    botRespawnDelayMs: BOT_RESPAWN_DELAY_MS,
    // Mirrors maxDeaths for real players - a team's bots don't come back
    // forever, same lives budget a human teammate gets (unlike Survival).
    maxBotRespawns: COOP_MAX_BOT_RESPAWNS,
    botHitChance: COOP_BOT_HIT_CHANCE,
    botShotIntervalMs: COOP_BOT_SHOT_INTERVAL_MS,
    matchSize: COOP_MATCH_SIZE, // total across BOTH teams - see index.js's coopQueue; always even, see COOP_MATCH_SIZE above
    botsFightEachOther: true, // team-filtered this time (teams: true above) - see match.js's getEnemyBots
    // Coop's whole side shares one goal (extract together) rather than
    // battle-royale's spread-out pool needing multiple zones to avoid a
    // single chokepoint - see extraction.js's EXTRACTION_ZONES comment for
    // why Versus/Private get all three.
    singleExtractionZone: true,
  },
  private: {
    type: 'private',
    teams: false,
    maxDeaths: Infinity, // unlimited respawns within the timer
    pointsPerKill: POINTS_PER_KILL,
    botPointsPerKill: botKillValue(POINTS_PER_KILL),
    entryStake: 0, // no FIXED stake - the host sets a per-room amount instead, see privateRooms.js/match.js's stakePool handling
    bankUnsecuredOnTimeLimit: false, // "points gotten from timer dont count as pot" - only already-secured pot banks when the timer ends the match
    botsRespawn: false,
    botRespawnDelayMs: null,
    maxBotRespawns: 0,
    // Private never bot-fills (invite-only, see privateRooms.js) - no
    // matchSize/botsFightEachOther field needed here, nothing ever reads
    // either for this mode.
    // Same free-for-all elimination structure as Versus - the "X
    // remaining" counter is just as meaningful here.
    showRemainingCount: true,
  },
  survival: {
    type: 'survival',
    teams: false,
    maxDeaths: Infinity, // irrelevant - the human player has exactly one life, handled separately (see match.js's endSurvivalRun)
    pointsPerKill: POINTS_PER_KILL,
    botPointsPerKill: botKillValue(POINTS_PER_KILL),
    entryStake: 0, // personal-best runs, not a pot match - never staked
    bankUnsecuredOnTimeLimit: true, // irrelevant - survival has no forced time-limit ending, see match.js's timeLimitTimeoutId guard
    botsRespawn: true,
    botRespawnDelayMs: BOT_RESPAWN_DELAY_MS,
    maxBotRespawns: Infinity, // the true "forever" - the whole point of Survival
    // Deliberately left false (the default/falsy - see the omitted field):
    // Survival's whole point is a swarm of bots ganging up on the one real
    // player, not thinning themselves out by fighting each other.
    botsFightEachOther: false,
  },
};
