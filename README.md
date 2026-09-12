# WRAG FPS

A browser-based, first-person extraction shooter with a fake-points
("PTS") economy. Kill other players and bots, loot points, and get to the
extraction zone before you die — die with points still "at risk" and you
lose them. No real money, no payment integration — `balance`/PTS is a
demo currency, and the one "Deposit" button that exists is explicitly
labeled as a dev/demo top-up, not a real transaction.

For the deeper architecture walkthrough (how a match actually runs, the
bot AI, the economy, the WebSocket message catalog, and how to add a new
mode or tunable), see **[DEV_README.md](DEV_README.md)**. This file is
the "what is this and how do I run it" doc.

## Game modes

- **Battle Royale (Versus)** — free-for-all, up to `VERSUS_MATCH_SIZE`
  participants (20 by default, real players + bot-filled). One life. Stand
  in the extraction zone ~3s to bank your current pot (you can extract
  multiple times per match); die and your unbanked pot is lost. The
  post-match screen shows your kill count alongside rank/final pot.
- **Co-op** — two even teams, up to `COOP_MATCH_SIZE` total (10 by
  default, 5 a side - real players + bots fill out both sides). Each side
  has `COOP_MAX_DEATHS` lives per member (3 by default) before that member
  is out for good; a kill pays the FULL kill-point value to every real
  player on the killer's team, not just the killer, and that per-kill
  value is derived from the entry stake and lives count (`ENTRY_STAKE /
  COOP_MAX_DEATHS`) rather than a flat number, so it always takes exactly
  as many kills to drain a stake as that player has lives. A killed BOT
  pays less than a killed real player either way (`BOT_KILL_VALUE_PERCENT`)
  so a bot-padded match can't farm full kill value for free. A team is
  defeated once every one of its members (real or bot) is out of lives —
  the match ends immediately when that happens for either side. A live
  "versus bar" across the top of the screen shows both squads' icons
  (yours left, theirs right) with a lives badge on each, plus a running
  kill-tally score for both teams in the center. Same
  "die-with-an-unbanked-pot-and-lose-it" rule as Versus, respawn included.
- **Private** — invite-only via a room code. The host sets a pooled
  stake everyone joining pays into; whoever's still standing when the
  timer runs out claims the pool. Unlimited respawns within the timer.
  Anonymous (not-logged-in) players can join and play for free, but can't
  claim pool winnings.
- **Survival** — solo against bots that respawn forever. No time limit,
  no other real players — the only goal is beating your own personal-best
  score (stored per-account, not a shared leaderboard).

## Tech stack

- **Client & Site**: [Three.js](https://threejs.org/) for 3D rendering,
  plain JavaScript (ES modules, no framework), served by
  [Vite](https://vitejs.dev/)
- **Server**: Node.js, [`ws`](https://github.com/websockets/ws) for the
  authoritative game WebSocket, [Express](https://expressjs.com/) for the
  account/dashboard/wallet HTTP API
- **Database**: PostgreSQL (accounts, sessions, match history, balance)

## Folder structure

```
wrag fps/
├── client/          # The actual game - loads at deploy time, one match at a time
│   └── src/         # Scene/player/weapon/bots-on-screen/HUD/mobile touch controls
├── server/          # Node.js authoritative backend (one process, one port)
│   └── src/
│       ├── index.js     # WebSocket game server - shares one http.Server/port with the API below
│       ├── api/          # Express HTTP API - auth, dashboard, wallet, admin
│       ├── auth/         # Signup/login/session/play-token handling
│       ├── match/        # Match state machine, mode rules, extraction, hit registration
│       ├── bots/         # Bot AI (patrol/attack state machine)
│       ├── lobby/        # Matchmaking queue + private room registry
│       ├── economy/      # Wallet: stakes, rake, deposits
│       ├── map/          # Shared server-side geometry (walls, nav graph)
│       └── db/           # Postgres pool + schema.sql
├── site/            # Marketing site + dashboard + account/login/signup pages
│   └── src/
├── audio/           # Shared sound assets
└── screenshots/
```

## Running it locally

You need Postgres running, plus **three dev processes** (server, site,
client) — four terminals total (or run Postgres detached and skip
watching it).

**1 — Postgres** (Docker, one-time setup):
```
docker run --name wrag-fps-postgres -e POSTGRES_PASSWORD=devpassword -e POSTGRES_DB=wrag_fps -p 5432:5432 -d postgres:16
docker exec -i wrag-fps-postgres psql -U postgres -d wrag_fps < server/src/db/schema.sql
```
(`schema.sql` is idempotent — safe to re-run any time the schema changes.)

**2 — Server** (WebSocket game server + Express API, one process, one port
- `:8080` by default, or `PORT` from the environment):
```
cd server
cp .env.example .env   # first time only - fill in SESSION_SECRET, adjust tuning if you want
npm install             # first time only
npm run dev
```
There is **no watch/reload** here — restart this process after every
server-side code change.

**3 — Site** (marketing + dashboard + account/login/signup):
```
cd site
npm install   # first time only
npm run dev
```
Open **`http://127.0.0.1:5175/`**.

**4 — Client** (the actual game — reached via the dashboard's Deploy
button, or directly for quick testing):
```
cd client
npm install   # first time only
npm run dev
```
Open **`http://127.0.0.1:5173/`** directly, or just click **Deploy** from
the dashboard once you're logged in on the site.

Use `127.0.0.1`, not `localhost`, for all three — see the Windows IPv6
note at the bottom.

To test multiplayer, open a second browser window (not just a tab) and
deploy into the same mode.

## Controls

**Desktop:**
- **Click** the game to lock the mouse and start playing
- **Mouse** — look around
- **WASD** — move
- **Space** — jump
- **Ctrl** (held) — crouch
- **Left click** — fire at the crosshair
- **Esc** — release the mouse

**Mobile / touch:** a virtual joystick (bottom-left) for movement,
drag-to-look anywhere on the right half of the screen, and Fire/Jump/
Crouch buttons (bottom-right) — mounted automatically on a touch-detected
device, no setup needed. Crouch is a toggle (tap to crouch, tap again to
stand) rather than held, since there's no good "held" equivalent for a
small on-screen button.

## The economy, briefly

- Versus/Co-op charge a flat entry stake (`ENTRY_STAKE`, PTS) to join;
  Private's stake is a pooled amount the host sets per room; Survival is
  free. Insufficient balance blocks entry with an error, rather than
  letting you queue and fail later.
- Kill payouts and Private's pool payout both have a house rake
  (`HOUSE_RAKE_PERCENT`) held back — never applied to your own pot moving
  from unsecured to secured (banking your own money isn't a "payout"),
  and never applied to a stake refund for leaving before a match starts.
- A "Deposit (Demo)" button (dashboard nav + account page) tops up your
  balance directly from a fixed preset list — clearly a dev/demo action,
  never a real transaction, and the exact seam a real payment gateway's
  confirmation would plug into later.
- Bot difficulty, entry stake, rake %, match sizes, Coop lives/respawns,
  the bot-kill discount, match time limit, and more are all
  environment-variable tunable — see `server/.env.example` and
  DEV_README.md.
- **Admin dashboard** (`/admin.html`, gated by `ADMIN_EMAILS` — see
  `server/.env.example`): shows the house's running P&L — fees collected
  (the actual rake withheld from payouts) and overall profit (net stakes
  collected minus winnings paid out), plus the raw numbers behind both.
  Auto-granted to any matching account on login; there's no
  admin-management UI beyond that env var.

## Known rough edges (worth revisiting later)

- **Target and extraction zone positions are duplicated** between client
  (rendering) and server (validation) — `client/src/targets.js` /
  `extraction.js` vs. `server/src/match/hitRegistration.js` /
  `extraction.js`. Moving one without the other desyncs what you see from
  what actually counts.
- **No reconnect/interpolation** — other players' positions update in
  discrete steps with no smoothing.
- **Crouch doesn't shrink your server-side hitbox** — it's a purely
  local/visual movement change; hit registration always uses the same
  capsule regardless of crouch state.
- **Remote players never visually crouch or jump** — no matching
  animation clips exist in the character pack, so a teammate crouching or
  jumping only shows up to others as a plain Y-position blip, not a pose.

## Windows dev server note (IPv6 binding)

On some Windows setups, Vite's default dev server binds to the IPv6
loopback address (`::1`) only, not `127.0.0.1`. It still prints "ready"
and looks like it started, but the browser can fail to connect with no
clear error. Every `vite.config.js` in this project forces its dev server
onto `127.0.0.1` explicitly — always open these apps at
`http://127.0.0.1:<port>/`, not `http://localhost:<port>/`, to sidestep
any remaining DNS-resolution quirk on your machine.
