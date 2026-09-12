import { randomUUID } from 'crypto';
import { NAV_GRAPH, findNearestNode } from '../map/navGraph.js';
import { isPathClear } from '../map/walls.js';
import { generateCallsign } from '../util/callsign.js';

// Survival's total participant count (1 real player + this many bots) -
// Versus/Coop get their own match sizes from modes.js's
// VERSUS_MATCH_SIZE/COOP_MATCH_SIZE instead (env-driven, see .env.example),
// since those two needed to grow independently of each other and of this
// solo mode. Kept here, unexported from modes.js, since Survival's bot
// count was never really a "mode rule" the way lives/points-per-kill
// are - it's just "how populated does a solo run feel."
export const MATCH_TARGET_SIZE = 4;

// Was 2 (a plain walking pace, well under a player's 5 m/s) - bumped to
// read as an actual RUN (see remotePlayers.js's matching Walk->Run
// animation swap) and to make bots harder to break line of sight with/
// outrun, per the user's "more of a challenge" ask. Still under a player's
// own speed so a determined player can still outrun one 1-on-1. Env-driven
// (BOT_SPEED, see .env.example) so an operator can retune difficulty
// without a code change - falls back to this same value if unset.
const BOT_SPEED = Number(process.env.BOT_SPEED ?? 4); // meters/second
const WAYPOINT_ARRIVAL_DISTANCE = 0.3;
const PATROL_TICK_MS = 100;
const DETECTION_RANGE = 10; // meters, still subject to the wall line-of-sight check below
// Defaults for every mode except where overridden - see createBotController's
// options.hitChance/shotIntervalMs (Coop passes even higher numbers, see
// modes.js's "make ally a bit more lethal" comment - these two were bumped
// from 2200/0.6 for a general difficulty increase across every OTHER mode).
// Also env-driven (BOT_SHOT_INTERVAL_MS/BOT_HIT_CHANCE) for the same reason
// as BOT_SPEED above.
const DEFAULT_SHOT_INTERVAL_MS = Number(process.env.BOT_SHOT_INTERVAL_MS ?? 1900); // time between a bot's shots once it's found a target
const DEFAULT_HIT_CHANCE = Number(process.env.BOT_HIT_CHANCE ?? 0.68); // chance a fired shot actually connects - still gives the player a real chance to survive an engagement
const SPAWN_GRACE_MS = 3000; // no attacking for a few seconds after match start, however close a player is

// Creates the participant entries for `count` bots, in the same shape
// match.js expects for real queued players (id, socket, callsign) plus
// isBot - `socket: null` is how the rest of the server code tells a bot
// apart from a real connection (see match.js's socket-guarded sends). Bots
// draw from the same generateCallsign() pool as anonymous real players (see
// index.js) rather than a templated "Sentinel-1"/"Drone-2" label, so a bot
// reads as just another combatant - re-rolled on collision so two bots in
// the same match never end up with the same name tag.
export function createBotEntries(count) {
  const entries = [];
  const usedCallsigns = new Set();
  for (let i = 0; i < count; i += 1) {
    let callsign = generateCallsign();
    while (usedCallsigns.has(callsign)) callsign = generateCallsign();
    usedCallsigns.add(callsign);
    entries.push({
      id: `bot-${randomUUID()}`,
      socket: null,
      callsign,
      isBot: true,
    });
  }
  return entries;
}

// Picks a random node connected to `nodeIndex` in the nav graph to wander
// toward next. Every node has at least one neighbor (verified when
// NAV_GRAPH is built), so this always returns something walkable.
function pickRandomNeighbor(nodeIndex) {
  const neighbors = NAV_GRAPH.adjacency[nodeIndex];
  return neighbors[Math.floor(Math.random() * neighbors.length)];
}

function distance2D(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

// Matches player.js's yaw convention (forward = (-sin(yaw), -cos(yaw))) so
// a bot visually faces the direction it's walking or aiming.
function yawTowards(from, to) {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

// Drives every bot's behavior for one match: a simple idle/patrol/attack
// state machine. Each bot either walks toward its next nav-graph node
// (patrol) or, once a real player is within range, in line of sight, AND
// its spawn grace period has passed, stops and fires at them on a cooldown
// (attack). Patrol movement always follows a pre-validated nav-graph edge
// (see map/navGraph.js), so a bot never walks through a wall; detection is
// gated by map/walls.js's isPathClear, so a bot can't see (or shoot)
// through one either. By default a killed bot is removed for the rest of
// the match - it does NOT respawn, so the pool of opponents only shrinks,
// matching the battle-royale "last man standing" feel Versus/Coop/Private
// use. Survival mode is the one exception - see `respawnDelayMs` below.
//
// `bots`: array of { id, position } - initial spawn positions, assigned by
// match.js (see its SPAWN_POINTS) so bots don't start on top of players.
// `options.respawnDelayMs` (Coop/Survival): when set, a killed bot comes
// back to life this many ms later instead of staying dead - deliberately
// kept comfortably above remotePlayers.js's client-side
// DEATH_DISPLAY_SECONDS (3s) by whoever passes this in, so the death-fall
// animation always finishes before the same id could plausibly reappear.
// `options.getSpawnPoint` supplies a fresh spawn position for a respawn
// (required whenever respawnDelayMs is set). `options.maxRespawns` caps how
// many times any one bot can come back (default Infinity, i.e. Survival's
// true "forever") - Coop passes a finite number so a bot's lives mirror a
// real player's (see modes.js's maxBotRespawns). `options.hitChance`/
// `shotIntervalMs` override the module defaults above per-mode.
export function createBotController(bots, {
  getRealPlayers, getEnemyBots, onBotMoved, onBotShoot, onBotRespawned,
}, options = {}) {
  const {
    respawnDelayMs = null,
    getSpawnPoint = null,
    maxRespawns = Infinity,
    hitChance = DEFAULT_HIT_CHANCE,
    shotIntervalMs = DEFAULT_SHOT_INTERVAL_MS,
  } = options;
  const now = Date.now();
  const botStates = new Map(bots.map(({ id, position }) => [id, {
    position: { ...position },
    yaw: 0,
    // First leg heads for the nearest nav node - match.js's SPAWN_POINTS
    // don't sit exactly on one. Every leg after that is a graph edge
    // (runPatrol re-targets a random neighbor of whatever node it just
    // reached), each pre-verified clear of walls when NAV_GRAPH was built.
    targetNode: findNearestNode(position),
    lastShotAt: now,
    alive: true,
    canAttackAfter: now + SPAWN_GRACE_MS,
    respawnCount: 0, // how many times this specific bot has already come back - gated against maxRespawns in killBot()
  }]));

  // Which bot (if any) currently "has" each real player: targetPlayerId ->
  // botId. Without this, every bot within range fires independently, so a
  // player caught near 3 bots takes triple the intended damage per cooldown
  // window - this caps it to one attacker per player at a time. Others
  // just keep patrolling instead of piling on.
  const activeAttackers = new Map();

  // Only a target within range AND with a clear (wall-free) line to the bot
  // counts as detectable - a bot can no longer "see" or shoot someone hiding
  // on the other side of a wall just because they're close. `botId` is
  // passed through to getRealPlayers/getEnemyBots so match.js can exclude
  // this bot's OWN teammates in Coop - each bot needs its own filtered list
  // (a bot on team 0 must not target team 0's real players OR bots), not
  // one shared "everyone" list. This is what "my ally is shooting me" was:
  // bots had no team awareness at all before this and attacked any real
  // player in range regardless of side.
  //
  // Searches REAL PLAYERS and, when the mode wants bot-vs-bot combat
  // (modeConfig.botsFightEachOther - getEnemyBots is undefined everywhere
  // else, see match.js), OTHER BOTS too, as one combined pool - team-
  // filtered in Coop (only the opposing side), unfiltered in a free-for-
  // all mode like Versus (every other bot is fair game) - either way this
  // bot fights autonomously across the whole field, not just whichever
  // real player is nearby. Whichever candidate (of either kind) is closest
  // wins; same detection range/line-of-sight rule for both, no separate
  // treatment for a bot target vs. a player one.
  function findNearestTarget(botPosition, botId) {
    let nearest = null;
    let nearestDistance = DETECTION_RANGE;
    const candidates = getEnemyBots ? [...getRealPlayers(botId), ...getEnemyBots(botId)] : getRealPlayers(botId);
    for (const candidate of candidates) {
      const distance = distance2D(candidate.position, botPosition);
      if (distance < nearestDistance && isPathClear(botPosition, candidate.position)) {
        nearestDistance = distance;
        nearest = candidate;
      }
    }
    return nearest;
  }

  function releaseAnyClaimHeldBy(botId) {
    for (const [targetId, attackerId] of activeAttackers) {
      if (attackerId === botId) activeAttackers.delete(targetId);
    }
  }

  // Walks straight toward bot.targetNode's position - always safe, since
  // every nav-graph edge (and the initial spawn-to-nearest-node leg) is
  // pre-verified clear of walls. On arrival, picks a random neighbor of the
  // node just reached as the next target, so the bot keeps wandering the
  // graph indefinitely.
  function runPatrol(bot, deltaSeconds) {
    const targetPosition = NAV_GRAPH.nodes[bot.targetNode];
    const distance = distance2D(targetPosition, bot.position);
    if (distance < WAYPOINT_ARRIVAL_DISTANCE) {
      bot.targetNode = pickRandomNeighbor(bot.targetNode);
      return;
    }
    const stepDistance = BOT_SPEED * deltaSeconds;
    const dx = targetPosition.x - bot.position.x;
    const dz = targetPosition.z - bot.position.z;
    bot.position.x += (dx / distance) * stepDistance;
    bot.position.z += (dz / distance) * stepDistance;
    bot.yaw = yawTowards(bot.position, targetPosition);
  }

  function tick() {
    const tickNow = Date.now();
    const deltaSeconds = PATROL_TICK_MS / 1000;

    for (const [id, bot] of botStates) {
      if (!bot.alive) {
        // bot.respawnAt is only ever set by killBot() when it already
        // decided (respawnCount < maxRespawns) this bot gets to come back -
        // a bot that just used its last life has no respawnAt at all, so
        // this comparison naturally never fires for it (undefined >=
        // comparison is always false).
        if (respawnDelayMs !== null && tickNow >= bot.respawnAt) {
          const spawnPosition = getSpawnPoint();
          bot.position = { ...spawnPosition };
          bot.targetNode = findNearestNode(spawnPosition);
          bot.alive = true;
          bot.respawnCount += 1;
          bot.canAttackAfter = tickNow + SPAWN_GRACE_MS;
          onBotMoved(id, { ...bot.position }, bot.yaw); // tell clients it's back immediately, same message a normal patrol step uses
          onBotRespawned?.(id); // Coop's live status bar - see match.js's broadcastTeamStatus (a no-op callback everywhere else)
        }
        continue; // skip attack/patrol logic this tick either way - a fresh respawn just starts patrolling next tick
      }

      const canAttack = tickNow >= bot.canAttackAfter;
      const nearestTarget = canAttack ? findNearestTarget(bot.position, id) : null;

      if (nearestTarget) {
        const currentAttacker = activeAttackers.get(nearestTarget.id);
        const isThisBotsTarget = !currentAttacker || currentAttacker === id;

        if (isThisBotsTarget) {
          activeAttackers.set(nearestTarget.id, id);
          // ATTACK: hold position, face the target, fire on a cooldown.
          bot.yaw = yawTowards(bot.position, nearestTarget.position);
          if (tickNow - bot.lastShotAt >= shotIntervalMs) {
            bot.lastShotAt = tickNow; // cooldown resets whether the shot hits or misses
            if (Math.random() < hitChance) {
              onBotShoot(id, nearestTarget.id);
            }
          }
        } else {
          // Someone else is already on this player - don't gang up, just patrol.
          runPatrol(bot, deltaSeconds);
        }
      } else {
        releaseAnyClaimHeldBy(id); // no target in range - give up any claim so another bot could take over later
        runPatrol(bot, deltaSeconds);
      }

      onBotMoved(id, { ...bot.position }, bot.yaw);
    }
  }

  const intervalId = botStates.size > 0 ? setInterval(tick, PATROL_TICK_MS) : null;

  // Called when this bot is killed (by a player's shot OR another bot's -
  // see match.js's onBotShoot). Returns `willRespawn` so the caller (match.js)
  // knows whether this was a FINAL death (no more lives - do rank/team-
  // victory bookkeeping) or one it'll come back from (skip that bookkeeping,
  // same as before). Respawn is only granted while under maxRespawns (default
  // Infinity - Survival's true "forever"; Coop passes a finite number so a
  // bot's lives mirror a real player's, see modes.js) - once exhausted, it's
  // marked permanently dead exactly like the original single-mode behavior.
  function killBot(id) {
    const bot = botStates.get(id);
    let willRespawn = false;
    if (bot) {
      bot.alive = false;
      willRespawn = respawnDelayMs !== null && bot.respawnCount < maxRespawns;
      if (willRespawn) {
        bot.respawnAt = Date.now() + respawnDelayMs;
      } else {
        bot.respawnAt = undefined; // no stray timestamp from a previous respawn cycle could accidentally satisfy tick()'s check
      }
    }
    releaseAnyClaimHeldBy(id);
    return willRespawn;
  }

  function isAlive(id) {
    const bot = botStates.get(id);
    return bot ? bot.alive : false;
  }

  // A thin read accessor for the Coop live status bar (see match.js's
  // buildTeamStatus) - {alive, respawnCount} lets the caller compute
  // "lives remaining" the same way it already does for real players
  // (maxBotRespawns - respawnCount, mirroring maxDeaths - deathCount).
  function getStatus(id) {
    const bot = botStates.get(id);
    return bot ? { alive: bot.alive, respawnCount: bot.respawnCount } : null;
  }

  // Now that a killed bot never comes back, "every bot in this match is
  // dead" is a real, permanent state match.js can check - used to let a
  // lone remaining real player auto-win once they've cleared every bot too,
  // not just every other real player (see match.js's checkForLastStanding).
  function allBotsDead() {
    return Array.from(botStates.values()).every((bot) => !bot.alive);
  }

  function stop() {
    if (intervalId) clearInterval(intervalId);
  }

  return {
    stop, killBot, isAlive, allBotsDead, getStatus,
  };
}
