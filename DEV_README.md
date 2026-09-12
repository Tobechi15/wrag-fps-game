# DEV_README

Architecture deep-dive for anyone (including future-you) working on this
codebase. See [README.md](README.md) first for what the project is and
how to run it. This file assumes that context and goes deeper into *why*
things are built the way they are.

## Process layout

Three dev processes talk to each other:

- **`server`** (one Node process, `server/src/index.js`) runs BOTH the
  authoritative game WebSocket server and an Express HTTP API
  (`server/src/api/server.js`'s `createApiApp()`, for auth/dashboard/
  wallet/admin) on ONE shared `http.Server`/ONE port (`process.env.PORT`,
  falling back to `8080` for local dev) — `ws`'s `WebSocketServer` attaches
  to that same server via its `server` option (hooking only the 'upgrade'
  event) rather than opening an independent listener. Used to be two
  separate listeners on two separate ports (`:8080` WS, `:8081` API) —
  fine for local dev, but broken on any host that only exposes one port
  per service (see the "No open ports detected on 0.0.0.0" class of error:
  a service with two independent listeners never has both reachable
  externally, since the platform's edge only ever forwards the one port it
  detected). Bound to `0.0.0.0`, not `127.0.0.1` — a hosting platform's
  port scanner connects from outside this container's loopback interface,
  so a service bound only to `127.0.0.1` is invisible to it even while
  genuinely running.
- **`site`** (`:5175`) is the marketing page, login/signup, dashboard, and
  account page — talks to the API over `/api/*`, proxied same-origin by
  `site/vite.config.js` so session cookies work locally without
  `SameSite=None`/https.
- **`client`** (`:5173`) is the actual game. Reached from the dashboard's
  Deploy button (which hands it a one-time play token + loadout/mode via
  URL params — see `site/src/dashboard.js`'s `wireDeployButton`) or
  directly for quick testing (falls back to anonymous play).

Postgres is the only other moving part — a plain Docker container, no
compose file, see README.md for the exact `docker run` command.

### Testing on a phone (or any device that isn't this machine)

`client/src/app.js` used to hard-code `ws://127.0.0.1:8080` for the game
server connection — harmless on desktop (where the page IS 127.0.0.1
already) but silently fatal from any other device: `127.0.0.1` in a
browser always means "this device," so a phone loading the client over a
forwarded port would try to connect to a WS server running on ITSELF, fail
with no visible error (see `network.js`'s `error`/`close` handlers, which
only `console.error` — nothing surfaces in the UI), and just sit at the
lobby forever waiting for a queue update that will never arrive. Fixed by
deriving the WS host from the page's own `window.location`, with an
optional `?wsHost=` override:

- **Same WiFi, typed the LAN IP directly** (e.g. `http://192.168.1.50:5173`)
  — works with no query param: the client connects to
  `${location.hostname}:8080`, which is the same LAN IP either way, and
  both ports being plain `http`/`ws` (no TLS) means no mixed-content issue.
- **VS Code port forwarding** (or any tool that gives EACH forwarded port
  its own distinct hostname, not "same host, different port") — you must
  forward port 8080 too, not just 5173, and pass its forwarded address
  explicitly: open the game via
  `https://<id>-5173.<region>.devtunnels.ms/?wsHost=<id>-8080.<region>.devtunnels.ms`
  (copy the exact forwarded address for port 8080 from VS Code's Ports
  panel — don't guess the hostname pattern). The client automatically uses
  `wss://` (not `ws://`) whenever the page itself loaded over `https://`,
  since a browser blocks a plain `ws://` connection from an `https://` page
  as mixed content, even though the WS server itself has no TLS of its own
  (the tunnel terminates TLS on the way in). Also make sure port 8080's
  visibility is set to the same level as 5173's in the Ports panel (VS
  Code forwards default to a mode that can require the viewer to be signed
  into the same account) — if only 5173 is Public, the phone's browser can
  load the lobby page fine but still fail to reach the WS server.
- **ngrok or a similar tunnel** — same idea as VS Code above: forward both
  ports (they'll get different hostnames), pass the WS one via `?wsHost=`.

`site/src/dashboard.js`'s `GAME_CLIENT_URL` and
`client/src/postMatchScreen.js`'s `DASHBOARD_URL` are the same
hardcoded-127.0.0.1 pattern, one level up — only relevant if you're also
testing the logged-in dashboard→deploy→post-match flow from another
device (not needed for guest/anonymous play), not fixed yet.

## The mode-config table pattern

Every rule that differs between Versus/Co-op/Private/Survival lives in
ONE place: `server/src/match/modes.js`'s `MODE_CONFIGS` object. `match.js`
never branches on a mode's name directly (`if (modeName === 'coop')`) —
it reads a property off `modeConfig` instead (`modeConfig.teams`,
`modeConfig.maxDeaths`, `modeConfig.pointsPerKill`, `modeConfig.botsRespawn`,
etc.). This is the single biggest thing to understand before touching
`match.js`: if you're tempted to special-case a mode by name somewhere in
match logic, you're almost always supposed to add a new field to
`MODE_CONFIGS` instead and read it generically.

```js
export const MODE_CONFIGS = {
  versus:   { type: 'versus',   teams: false, maxDeaths: 1,           pointsPerKill: POINTS_PER_KILL,      botPointsPerKill: ...,  entryStake: ENTRY_STAKE, botsRespawn: false, matchSize: VERSUS_MATCH_SIZE, ... },
  coop:     { type: 'coop',     teams: true,  maxDeaths: COOP_MAX_DEATHS, pointsPerKill: COOP_POINTS_PER_KILL, botPointsPerKill: ..., entryStake: ENTRY_STAKE, botsRespawn: true, maxBotRespawns: COOP_MAX_BOT_RESPAWNS, botHitChance: COOP_BOT_HIT_CHANCE, matchSize: COOP_MATCH_SIZE, ... },
  private:  { type: 'private',  teams: false, maxDeaths: Infinity,    pointsPerKill: POINTS_PER_KILL,      botPointsPerKill: ...,  entryStake: 0,           botsRespawn: false, ... },
  survival: { type: 'survival', teams: false, maxDeaths: Infinity,    pointsPerKill: POINTS_PER_KILL,      botPointsPerKill: ...,  entryStake: 0,           botsRespawn: true,  maxBotRespawns: Infinity, ... },
};
```

`createMatch(matchId, participants, onEmpty, modeName, matchOptions)`
looks up `MODE_CONFIGS[modeName]` once at the top and closes over it as
`modeConfig` for the rest of the match's lifetime. `matchOptions` carries
the one thing that's genuinely per-room rather than per-mode: Private's
`stakePool` (the host-set pooled stake, summed from whoever joined that
specific room — see `server/src/lobby/privateRooms.js`).

`botPointsPerKill` is every mode's `pointsPerKill` run through
`botKillValue()` (a % of the normal rate, `BOT_KILL_VALUE_PERCENT`) —
`awardKillPoints` (see below) picks whichever one applies based on the
KILLED entity's type, not the killer's. `matchSize` only exists on
Versus/Coop (Private never bot-fills, Survival uses its own
`bot.js`-level `MATCH_TARGET_SIZE` instead — see `index.js`'s queue
construction for exactly where each is read).

## Client-predict / server-confirm

The server is the only authority on anything that touches points. The
client is trusted for movement (position/yaw are relayed, never
validated — a real anti-cheat pass is out of scope for this project) but
NOT for hits, kills, banking, or balance. The pattern, used consistently
everywhere real value could be at stake:

1. The client does its own cheap local check immediately, purely for
   responsiveness (a target flashes the instant you click, an
   extraction progress bar fills while you're standing in the zone).
2. The client also reports the raw inputs to the server (a shot's
   origin+direction, a position update) — never a computed result like
   "I hit them" or "I banked."
3. The server independently re-derives the outcome from its own
   authoritative state and decides for itself. Its decision — via a
   message back to the client — is what actually changes the pot/balance
   shown on screen. The client-side prediction from step 1 is cosmetic
   only and gets silently overwritten by whatever the server says.

Concretely: `shooting.js`'s `fire()` runs a local raycast against visible
target meshes for the instant-flash feedback, then separately calls
`onFire(origin, direction)`, which `gameScreen.js` wires to
`network.sendShot(...)`. The server (`match.js`'s `handleShoot`)
re-raycasts against its OWN target/entity/wall lists and is the only
thing that ever touches `player.pot`. Same shape for extraction:
`extraction.js`'s client-side tracker just estimates dwell time for the
progress bar; the server (`updateExtractionState`, called from every
`handleMove`) independently tracks the same thing from the position
stream it already gets for multiplayer sync, and its own `'banked'`
message is the only thing that actually moves pot → securedPot.

## Bot AI (`server/src/bots/bot.js`)

A simple per-match state machine, one `createBotController(bots, hooks,
options)` call per match, each bot living in a `botStates` Map with
`{ position, yaw, targetNode, alive, respawnCount, canAttackAfter, ... }`.
A `setInterval` `tick()` (every `PATROL_TICK_MS`, 100ms) drives every bot
each cycle:

- **Patrol**: walk toward `bot.targetNode` along a pre-validated
  nav-graph edge (`server/src/map/navGraph.js`) — every edge is
  wall-free by construction, so a bot never needs its own collision
  check. On arrival, pick a random neighbor and keep going.
- **Attack**: once a real target (or, in Co-op, an enemy bot too — see
  `getEnemyBots`) is within `DETECTION_RANGE` AND has a clear line of
  sight (`map/walls.js`'s `isPathClear`) AND the bot's spawn grace period
  has elapsed, it stops, faces the target, and fires on a cooldown
  (`shotIntervalMs`) with a per-shot hit chance (`hitChance`). A shared
  `activeAttackers` Map caps one attacker per target at a time so a
  player caught near three bots doesn't take triple damage.
- **Death/respawn**: `killBot(id)` marks a bot dead and returns whether
  it'll respawn (`respawnDelayMs !== null && respawnCount < maxRespawns`).
  Versus/Private bots never respawn (`maxRespawns: 0` via `modes.js`);
  Co-op bots get `COOP_MAX_BOT_RESPAWNS` lives (env-driven, mirroring a
  real player's own `COOP_MAX_DEATHS`-driven lives budget);
  Survival bots respawn forever (`Infinity`). `getStatus(id)` exposes
  `{alive, respawnCount}` for Co-op's live status bar (see below).

`hitChance`/`shotIntervalMs`/`respawnDelayMs`/`maxRespawns` are all passed
in per-match via `options` from `match.js`, itself reading from
`modeConfig` — Co-op deliberately tunes its bots a little more lethal
than the baseline (see `modes.js`'s `COOP_BOT_*` constants) since a
teammate assisting should feel like a real threat multiplier, not a
freebie. `BOT_SPEED`/`BOT_HIT_CHANCE`/`BOT_SHOT_INTERVAL_MS` (and their
`COOP_*` counterparts) are all env-driven — see "Env-driven tuning" below.

### Co-op's live status bar

`match.js`'s `buildTeamStatus(teamId)` reads the FIXED `rosterSnapshot`
(who started on this team, taken once at match start — unlike the
`players` Map, which loses an entry the moment someone's eliminated) and,
for each member, computes `{callsign, isBot, alive, livesRemaining}` —
`maxDeaths - deathCount` for real players, `maxBotRespawns -
respawnCount` (via `botController.getStatus`) for bots.
`broadcastTeamStatus()` sends this as a `'team-status'` message
(`{yourTeam, otherTeam}`, one message per recipient so each player's
"your team" is actually theirs) to every real player, gated on
`modeConfig.teams` (a no-op everywhere else). It's called from every
place team composition can change: match start, a bot's `onBotRespawned`
hook, and the death/respawn/elimination/disconnect handlers
(`handleBotVictim`, `respawnPlayer`, `eliminatePlayer`,
`handleDisconnect`).

## The wallet/economy system (`server/src/economy/wallet.js`)

Four core functions (plus four ledger-recording ones, see "House ledger"
below), every balance change in the project goes through one of them:

- `deductStake(userId, amount)` — atomic conditional UPDATE
  (`balance >= $1`), returns the new balance or `null` if insufficient —
  the caller (queue-join, private-room-join) uses `null` to reject entry
  with an error rather than letting balance go negative.
- `refundStake(userId, amount)` — adds back (used both for a literal
  refund — leaving a queue/room before a match starts — and, doing double
  duty, for CREDITING MATCH WINNINGS: `recordMatchResult` calls it with
  `finalPot` at match end. Same underlying SQL, different caller intent —
  not worth a second near-identical function).
- `creditDeposit(userId, amount)` — the demo/dev top-up (see
  `server/src/api/wallet.js`'s `POST /deposit`, allow-listed amounts
  only). The seam a real payment gateway's confirmation webhook would
  call into, once one exists — never touched by anything else in this
  project.
- `applyRake(amount)` — `Math.round(amount * (1 - HOUSE_RAKE_PERCENT /
  100))`. The ONE place the house edge is taken. Applied in exactly two
  spots: `awardKillPoints` (every Versus/Co-op kill payout) and
  `endMatchForSurvivor`'s Private stake-pool payout. Deliberately NOT
  applied to a player's own pot moving from unsecured to secured
  (extracting your own money isn't a payout event) and NOT applied to an
  entry-stake refund (leaving before a match starts isn't a win).

**Balance vs. pot, don't confuse them**: `users.balance` (Postgres column)
is a player's real, spendable, persistent balance — what entry stakes
deduct from and match winnings credit to. `player.pot`/`player.securedPot`
(in-memory, per-match, in `match.js`) are that ONE match's at-risk/banked
earnings — `finalPot` (usually `securedPot` alone; the unsecured portion
is lost on death/elimination) is what eventually gets added to `balance`
via `recordMatchResult` → `refundStake` at match end. A match's pot is not
your balance; it's what you're about to add to (or fail to add to) it.

### House ledger

`schema.sql`'s `house_ledger` is a single row (`id = 1`) tracking the
operator's running P&L, independent of (and never derived from)
`users.balance` — balance only ever shows the CURRENT net effect, not the
history behind it. Four counters, each incremented by its own function in
`wallet.js` right alongside the balance mutation it corresponds to
(fire-and-forget, same as every other non-blocking write in this project):

- `recordStakeCollected(amount)` — every successful entry-stake deduction
  (`index.js`'s `'join-queue'` handler, `privateRooms.js`'s
  `tryPayStake`).
- `recordStakeRefunded(amount)` — every stake refunded for leaving BEFORE
  a match starts (`leaveAllPreMatchQueues`, `privateRooms.js`'s `leave`) —
  a NEUTRAL event, not a loss, kept as its own counter (not just "don't
  call recordStakeCollected") so gross-collected and refunded are both
  independently visible.
- `recordRakeCollected(amount)` — the literal house cut withheld from a
  payout (`awardKillPoints`'s kill payouts, `endMatchForSurvivor`'s
  Private stake-pool win). This is the admin dashboard's "Fees Collected"
  figure.
- `recordWinningsPaid(amount)` — every real payout that actually reached a
  player's balance (`recordMatchResult`'s `finalPot` credit,
  `endMatchForSurvivor`'s stake-pool share). NOT stake refunds and NOT
  Deposit top-ups (not real revenue either direction).

`getHouseLedger()` reads the four raw counters and derives the two
figures the admin dashboard (`/admin.html`, `server/src/api/admin.js`,
gated by `requireAdmin`/`ADMIN_EMAILS`) actually shows:
`netStakesCollected = stakesCollected - stakesRefunded`, and
`profit = netStakesCollected - winningsPaid` — the classic "money in
minus money out." `rakeCollected` is shown as its own separate "fees"
number, not subtracted a second time into profit (it's already implicitly
smaller `winningsPaid`, from every payout having been raked before it was
ever credited).

`is_admin` (on `users`) is never set by any UI — `auth/routes.js`'s login
route auto-grants it to any account whose email is in the `ADMIN_EMAILS`
env var, awaited so it takes effect on that very login. Revoking an email
from the list doesn't retroactively un-flag an existing admin row (no code
path does that) — flip `is_admin` back to `false` by hand in Postgres if
you need to actually revoke one.

Beyond the ledger, `/admin.html` also shows:

- **Live server state** (`GET /api/admin/live`) — connected sockets, active
  match count, both public queue sizes, and private-room/waiting-player
  counts. Pulled from `server/src/liveStats.js`, a tiny bridge between the
  WS game server (`index.js`, which owns all this in-memory state) and the
  separate Express admin route in the same process: `index.js` registers
  ONE snapshot function (`registerLiveStatsProvider`) once, after
  everything it closes over already exists, rather than push-updating on
  every individual connect/join/match-start call site. Purely in-memory,
  resets on a restart like every other piece of live match state.
- **Accounts** (`GET /api/admin/users?search=`) — every registered account
  with balance, matches played, Survival best, and join date; `search`
  matches callsign or email (case-insensitive). Each row has a manual
  balance-adjustment control (`POST /api/admin/users/:id/balance`, a signed
  integer delta via `wallet.js`'s `adjustBalance`) — a support/testing
  correction on the fake-points economy, clamped to never go below 0, and
  deliberately NOT run through the house-ledger counters above (it's not a
  real gameplay economic event, so it should never distort the P&L).
- **Recent matches** (`GET /api/admin/matches`) — the last 50 matches
  across every real account, joined against `users` for callsign/email
  (same scope as the accounts list — bots/anonymous play never produce a
  `matches` row at all).

All three routes live in `server/src/api/admin.js`, mounted under one
`router.use(requireAdmin)` so every route in that file shares the same
gate. Restart the API server (`server/src/index.js`'s process) for changes
to any of this to take effect — same as any other server-side change in
this project, no hot-reload.

## Env-driven tuning

Every operator-facing knob is read ONCE at module-top-level via
`process.env.X ?? <default>` — see `server/.env.example` for the full,
commented list: `HOUSE_RAKE_PERCENT`, `ENTRY_STAKE`,
`MATCH_TIME_LIMIT_MINUTES`, `BOT_HIT_CHANCE`/`BOT_SHOT_INTERVAL_MS`/
`BOT_SPEED` and their Co-op-specific `COOP_*` counterparts,
`BOT_KILL_VALUE_PERCENT` (a bot kill's payout as a % of a real player
kill's), `COOP_MAX_DEATHS`/`COOP_MAX_BOT_RESPAWNS` (Coop's lives budget —
`COOP_MAX_DEATHS` also drives `COOP_POINTS_PER_KILL`'s derivation, see the
mode-config section above), `VERSUS_MATCH_SIZE`/`COOP_MATCH_SIZE`
(total participants per match — an odd `COOP_MATCH_SIZE` is rounded up to
the next even number so both teams stay balanced), and
`RESPAWN_DELAY_SECONDS` (how long a Coop/Private respawn's countdown
banner runs — see `match.js`'s `beginRespawn`/`finishRespawn`). Because
these are read at module load, not per-request, **an env change requires a
server restart** (same "no watch/reload" caveat as any other server-side
edit — see below).

**Load-order gotcha, worth knowing before you add another one of these**:
`import 'dotenv/config'` MUST run before any module that reads
`process.env.X` at its own top level. This is why it's the literal first
line of `server/src/index.js` — it used to work only by accident, via
`index.js`'s import chain transitively loading `dotenv/config` (through
`privateRooms.js → wallet.js → db/client.js`) before `bot.js`/`modes.js`
happened to be evaluated. Moving imports around can silently break this;
if a newly-added env-driven constant reads as `undefined`/its fallback
even with `.env` set correctly, check import order first.

## WebSocket message catalog

Every distinct `type` either side sends over the game WebSocket
(`:8080`). Client → server messages are validated/interpreted entirely by
`server/src/index.js` and `match.js`; nothing here is trusted beyond basic
shape checks.

**Client → server:**

| type | payload | handled by |
|---|---|---|
| `join-queue` | `{ mode }` | `index.js` — deducts entry stake (if any) before joining |
| `create-room` | `{ stake }` | `index.js` → `privateRooms.create` |
| `join-room` | `{ code }` | `index.js` → `privateRooms.join` |
| `start-room` | `{ code }` | `index.js` → `privateRooms.start` (host only) |
| `start-survival` | — | `index.js` — joins a solo Survival match immediately |
| `move` | `{ position, yaw }` | `match.js`'s `handleMove` — relayed, not validated; also drives extraction-zone dwell tracking |
| `shoot` | `{ origin, direction }` | `match.js`'s `handleShoot` — the only server-authoritative hit path |

**Server → client:**

| type | payload | sent by |
|---|---|---|
| `queue-update` | `{ players, capacity, secondsRemaining }` | `lobby/queue.js`, broadcast to everyone queued |
| `queue-error` | `{ reason: 'insufficient-balance', required }` | `index.js`, join rejected |
| `joined-queue` | `{ id, callsign }` | `index.js` |
| `room-created` | `{ code, hostId, stake }` | `privateRooms.create` |
| `room-update` | `{ code, hostId, stake, pool, members }` | `privateRooms`, broadcast to the room on any membership/stake change |
| `room-error` | `{ reason: 'insufficient-balance'\|'not-found'\|'full'\|'server-error', ... }` | `privateRooms` |
| `match-start` | `{ matchId, players: roster, teamId }` | `match.js`'s `start()` — one message per recipient, roster excludes them |
| `team-status` | `{ yourTeam, otherTeam, yourScore, otherScore }` | `match.js`'s `broadcastTeamStatus` — Co-op only; `*Score` is each team's running kill tally so far (`getTeamScore`) |
| `player-moved` | `{ id, position, yaw, isBot }` | `match.js`, relayed movement (real or bot) |
| `respawn-countdown` | `{ seconds, pot, securedPot, killedBy }` | `match.js`'s `beginRespawn` — fires the INSTANT a Coop/Private death happens, to the dying player only; client shows a ticking countdown banner (`RESPAWN_DELAY_SECONDS`, see .env.example) while the player is server-side `respawning: true` (untargetable) |
| `player-respawned` / `respawn` | position/yaw/health/pot/deathsRemaining | `match.js`'s `finishRespawn`, fired `RESPAWN_DELAY_SECONDS` after `respawn-countdown` — `respawn` to the player themselves (includes their own pot/health), `player-respawned` to everyone else |
| `player-left` | `{ id }` | `match.js`, on any death/elimination/disconnect |
| `hit` | `{ health, maxHealth, hitBy }` | `match.js`'s `applyDamage`, to a real player who survived a hit |
| `shot-fired` | `{ id, origin, direction }` | `match.js`, cosmetic-only broadcast for muzzle-flash/tracer effects |
| `shoot-result` | `{ hit, killed, pot }` or `{ rejected: true }` | `match.js`, back to the shooter (and, in Co-op, their teammates on a kill — see `awardKillPoints`) |
| `banked` | `{ pot, securedPot }` | `extraction.js`'s `updateExtractionState`, fired the moment the server's own dwell-timer crosses the threshold — never client-requested |
| `match-ended` | `{ reason, finalPot, rank, kills, teamScoreboard?, fullScoreboard?, score?, personalBest? }` | `match.js`, terminal message for this player's involvement in the match — `kills` is always this player's own kill count, regardless of mode; `fullScoreboard` (Versus only, `buildFullScoreboard`) is every participant's `{callsign, isBot, kills, rank}`, `rank` null for anyone still in the match as of this moment (a free-for-all doesn't end for everyone at once) |

## Adding a new mode or tunable — worked example

**Adding a tunable** (say, a new `EXTRACTION_ZONE_SECONDS` env var):
1. Add it to `server/.env` and `.env.example` with a comment.
2. In whichever module actually uses it (`server/src/match/extraction.js`
   for this example), read it once at module-top-level:
   `const REQUIRED_SECONDS_TO_BANK = Number(process.env.EXTRACTION_ZONE_SECONDS ?? 3);`
3. Done — no other file needs to change. Restart the server to pick it up.

**Adding a new mode** (say, a hypothetical "Last Team Standing" 4-way
team mode):
1. Add an entry to `MODE_CONFIGS` in `modes.js` with whatever fields the
   existing modes already use (`teams`, `maxDeaths`, `pointsPerKill`,
   `entryStake`, `botsRespawn`, etc.) — if it needs a genuinely NEW rule
   no existing mode has, add a new field here (not a mode-name check in
   `match.js`).
2. If the new field needs new runtime logic (not just a number
   `match.js` already reads generically), add that logic in `match.js`
   gated on the new field, following the pattern `modeConfig.teams` or
   `modeConfig.botsRespawn` already use — `if (modeConfig.yourNewFlag) { ... }`.
3. Wire the client-facing entry point: the dashboard's Play Mode dock
   (`site/dashboard.html`'s `data-mode` buttons +
   `site/src/dashboard.js`'s `wirePlayModeSelector`) needs a new tab, and
   `server/src/index.js`'s `join-queue`/room-creation handling needs to
   route that mode name to the right queue/match-start path (mirroring
   how Co-op and Private each got their own path when they were added).
4. If it needs its own queue (not just a `MODE_CONFIGS` variant of an
   existing one), see `index.js`'s two `createQueue(...)` instances
   (Versus, Co-op) for the pattern — a third queue for a third mode is a
   straightforward copy of that wiring, matchSize and mode name adjusted.

## Testing methodology used while building this

No formal test suite/framework — verification during development leaned
on small throwaway Node scripts: import the real source modules directly
(via relative paths), exercise them against mocked sockets (a plain
object with `send()` pushing into an array you can assert against) or a
real throwaway Postgres row (insert, assert, delete), then discard the
script. Useful pattern for verifying `match.js`/`bot.js` changes without
standing up a full browser + two WebSocket clients by hand — e.g., to
confirm a kill payout, mock two players' sockets, call
`match.handleShoot(shooterId, origin, direction)` directly, and assert on
`shooterSocket.messages`.

## Known architectural rough edges

See README.md's "Known rough edges" section — the duplicated target/zone
positions between client and server, no reconnect/interpolation, crouch
not affecting the server-side hitbox, and remote players never visually
crouching/jumping are all there, not repeated here.
