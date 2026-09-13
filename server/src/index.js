// Loaded FIRST, explicitly, before anything else - several modules below
// (bot.js, modes.js, wallet.js) read process.env values at module-evaluation
// time (not inside a function called later), so .env must already be parsed
// before ANY of them are imported. db/client.js also does `import
// 'dotenv/config'`, which happened to make this work by accident via
// index.js's own transitive import order (privateRooms.js -> wallet.js ->
// db/client.js, evaluated before bot.js/modes.js) - real but fragile,
// since reordering imports anywhere in that chain would silently break it
// with no error, just env vars quietly not taking effect. This entry-point
// import removes that fragility entirely.
import 'dotenv/config';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import { createQueue } from './lobby/queue.js';
import { createPrivateRoomRegistry } from './lobby/privateRooms.js';
import { createMatch } from './match/match.js';
import { createBotEntries, MATCH_TARGET_SIZE } from './bots/bot.js';
import { createApiApp } from './api/server.js';
import { consumePlayToken } from './auth/playTokens.js';
import { MODE_CONFIGS } from './match/modes.js';
import {
  deductStake, refundStake, recordStakeCollected, recordStakeRefunded,
} from './economy/wallet.js';
import { generateCallsign } from './util/callsign.js';
import { registerLiveStatsProvider } from './liveStats.js';

// A hosting platform (Render, Railway, etc.) assigns this and expects the
// app to bind exactly that port - never hardcode it. Falls back to 8080
// for local dev, where nothing sets PORT.
const PORT = Number(process.env.PORT ?? 8080);
const SURVIVAL_BOT_COUNT = MATCH_TARGET_SIZE - 1; // 1 real player + this many bots, same populated feel as a filled Versus/Coop match

// The REST API (accounts/login/dashboard, api/server.js's Express app) and
// the WebSocket game server below share ONE http.Server/ONE port now -
// used to be two independent listeners (Express's own app.listen() on
// :8081, this file's WebSocketServer on :8080), which worked fine for
// local dev but can't work on a host that only exposes a single port per
// service (see the "No open ports detected on 0.0.0.0" class of error -
// a service with two separate listeners never has both reachable
// externally, since the platform's edge only ever forwards the one port
// it detected/was told about). `ws`'s WebSocketServer, given a `server`
// instead of its own host/port, hooks the shared server's 'upgrade' event
// only - Express's own request handling (the 'request' event) is
// completely unaffected, so both coexist on one listener with no route
// conflict.
const apiApp = createApiApp();
const httpServer = createServer(apiApp);

// In-memory only: resets on restart, matching the prototype scope. No
// database yet (that's Part B / accounts).
const matches = new Map(); // matchId -> match instance

// Shared by every mode's match-start path (the two public queues, private
// rooms, and Survival's direct solo start below) - builds the match and
// registers it the same way regardless of who/what triggered the start.
// `matchOptions` is the same options bag createMatch takes (currently just
// Private's `stakePool` - see privateRooms.js/match.js) - undefined for
// every other mode's call sites below, which is fine, createMatch defaults
// it to {}.
function launchMatch(participants, modeName, matchOptions) {
  const matchId = randomUUID();
  const match = createMatch(matchId, participants, (finishedMatchId) => {
    matches.delete(finishedMatchId);
    console.log(`Match ${finishedMatchId} ended (no real players left)`);
  }, modeName, matchOptions);
  matches.set(matchId, match);
  match.start();
  console.log(`Match ${matchId} (${modeName}) started with ${participants.length} participant(s)`);
  return matchId;
}

// Attaches to httpServer's 'upgrade' event rather than opening its own
// socket (see the module comment above on why this and the API app now
// share one server/port).
const wss = new WebSocketServer({ server: httpServer });

// Versus (the original/default mode) and Coop each get their own public
// queue instance - same factory, parameterized (see queue.js) - so a
// player choosing Coop never gets matched into a Versus room or vice versa.
// Match size is now per-mode (modes.js's VERSUS_MATCH_SIZE/COOP_MATCH_SIZE,
// both env-driven) rather than one shared MATCH_TARGET_SIZE - Versus can
// run up to a full battle-royale-sized lobby while Coop stays a smaller,
// evenly-split team size.
const versusQueue = createQueue({
  matchSize: MODE_CONFIGS.versus.matchSize,
  onMatchStart: (queuedPlayers) => {
    // Fill remaining slots with bots if too few real players queued, so
    // the match doesn't feel empty. If enough real players showed up on
    // their own, botsNeeded is 0/negative and no bots are added.
    const botsNeeded = Math.max(0, MODE_CONFIGS.versus.matchSize - queuedPlayers.length);
    const bots = createBotEntries(botsNeeded);
    launchMatch([...queuedPlayers, ...bots], 'versus');
  },
});

const coopQueue = createQueue({
  matchSize: MODE_CONFIGS.coop.matchSize,
  onMatchStart: (queuedPlayers) => {
    const botsNeeded = Math.max(0, MODE_CONFIGS.coop.matchSize - queuedPlayers.length);
    const bots = createBotEntries(botsNeeded);
    launchMatch([...queuedPlayers, ...bots], 'coop');
  },
});

// Private rooms never get bot-filled - it's an invite-only room for
// specific people, not a populated match (see privateRooms.js).
const privateRooms = createPrivateRoomRegistry({
  onMatchStart: (roomPlayers, stakePool) => launchMatch(roomPlayers, 'private', { stakePool }),
});

// A connection can only ever be in ONE of {a queue, a private room, a
// match} at a time - called before joining any of the first two so
// switching modes (or creating/joining a room) can never leave a stale
// membership behind. Each leave() is a harmless no-op if the id isn't
// actually there. Also refunds a Versus/Coop stake if one was deducted for
// whatever queue they're leaving (see the 'join-queue' handler below) -
// nobody should ever be charged for a match they didn't actually enter,
// whether that's switching modes mid-queue or disconnecting before a match
// forms. Private room stakes are refunded separately, inside
// privateRooms.js's own leave() - that pool is per-room, not this flat
// per-queue amount, so it's tracked independently (socket.stakedAmount is
// only ever set below, for the two public queues).
function leaveAllPreMatchQueues(id, socket) {
  versusQueue.leave(id);
  coopQueue.leave(id);
  privateRooms.leave(id);
  if (socket.stakedAmount > 0) {
    refundStake(socket.userId, socket.stakedAmount).catch((err) => {
      console.error(`Failed to refund stake for user ${socket.userId}:`, err);
    });
    recordStakeRefunded(socket.stakedAmount).catch((err) => {
      console.error('Failed to record stake refund in house ledger:', err);
    });
    socket.stakedAmount = 0;
  }
}

// Registered once, after every piece of state it reads (wss, the two public
// queues, privateRooms, matches) already exists - see liveStats.js's own
// comment for why this is a single on-demand snapshot function rather than
// push-updated from every individual connect/join/start call site above.
registerLiveStatsProvider(() => ({
  connectedPlayers: wss.clients.size,
  activeMatches: matches.size,
  versusQueueSize: versusQueue.getSize(),
  coopQueueSize: coopQueue.getSize(),
  ...privateRooms.getStats(),
}));

wss.on('connection', (socket, request) => {
  const id = randomUUID();

  // A logged-in player arrives with a one-time token in the connection URL
  // (client/src/app.js reads it from its own page URL and appends it here)
  // - see auth/playTokens.js for why this hop exists at all. No token, or
  // an invalid/expired one, just means anonymous play, same as Phase 1.
  const requestUrl = new URL(request.url, 'http://localhost');
  const token = requestUrl.searchParams.get('token');
  const identity = token ? consumePlayToken(token) : null;

  const userId = identity?.userId ?? null;
  const callsign = identity?.callsign ?? generateCallsign();
  socket.playerId = id;
  socket.userId = userId;

  // The dashboard's loadout selector appends this the same way the play
  // token gets appended (see site/src/dashboard.js's wireDeployButton) -
  // purely cosmetic, so an unrecognized/missing value just means the
  // client falls back to its own default (see characterModel.js), nothing
  // to validate strictly here.
  const characterVariant = requestUrl.searchParams.get('character');
  // Unlike characterVariant, this ISN'T purely cosmetic - match.js reads it
  // to decide per-shot damage/range (a shotgun one-shots up close but can't
  // reach far; a sniper one-shots at any range - see match.js's WEAPON_STATS),
  // so it has to be known server-side rather than staying client-only. An
  // unrecognized/missing value just falls back to match.js's own default
  // (the flat, unchanged damage every other weapon already had).
  const gunVariant = requestUrl.searchParams.get('gun');

  // Deliberately NOT auto-joined into the Versus queue here anymore (it
  // used to be, "same as before Coop/Private/Survival existed") - that
  // auto-join ran regardless of which mode the player actually wanted,
  // so a player sitting on the Private lobby screen deciding whether to
  // create/join a room (which sends nothing until they click a button -
  // see lobbyScreen.js) was STILL quietly sitting in the Versus queue the
  // whole time. If its 15s countdown (queue.js's COUNTDOWN_SECONDS)
  // elapsed first, they'd get swept into a Battle Royale match they never
  // asked for - and since that path bypassed the 'join-queue' handler
  // entirely, it also skipped entry-stake deduction. Every mode (Versus
  // included) now joins its queue/room/solo-match only via an explicit
  // client message (lobbyScreen.js's show() already sends 'join-queue'
  // for Versus/Coop on entry - network.js's sendWhenReady means this
  // reliably lands even before the socket finishes opening).
  socket.send(JSON.stringify({ type: 'joined-queue', id, callsign }));

  console.log(`Player connected: ${id} (${callsign})${userId ? ` [account ${userId}]` : ' [anonymous]'}`);

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return; // ignore anything that isn't valid JSON
    }

    // Everything below is only valid when NOT already in a match - each
    // handler is a way to (re-)enter matchmaking, not something a live
    // match interprets.
    if (!socket.matchId) {
      if (message.type === 'join-queue') {
        const mode = message.mode === 'coop' ? 'coop' : 'versus';
        const targetQueue = mode === 'coop' ? coopQueue : versusQueue;
        const stake = MODE_CONFIGS[mode].entryStake;

        // Anonymous players play free (per the user) - only a real,
        // logged-in account has a balance to stake in the first place.
        if (!userId || stake <= 0) {
          leaveAllPreMatchQueues(id, socket);
          targetQueue.join(id, socket, callsign, userId, characterVariant, gunVariant);
          return;
        }

        deductStake(userId, stake).then((newBalance) => {
          if (newBalance === null) {
            socket.send(JSON.stringify({
              type: 'queue-error', reason: 'insufficient-balance', required: stake,
            }));
            return;
          }
          // Only recorded AFTER a successful deduction - leaveAllPreMatchQueues
          // refunds whatever's currently staked when switching modes or
          // leaving before a match starts, so this must never be set before
          // the deduction has actually succeeded.
          leaveAllPreMatchQueues(id, socket);
          socket.stakedAmount = stake;
          recordStakeCollected(stake).catch((err) => {
            console.error('Failed to record stake collection in house ledger:', err);
          });
          targetQueue.join(id, socket, callsign, userId, characterVariant, gunVariant);
        }).catch((err) => {
          console.error(`Failed to deduct stake for user ${userId}:`, err);
        });
        return;
      }
      if (message.type === 'create-room') {
        leaveAllPreMatchQueues(id, socket);
        privateRooms.create(id, socket, callsign, userId, characterVariant, message.stake, gunVariant);
        return;
      }
      if (message.type === 'join-room' && typeof message.code === 'string') {
        leaveAllPreMatchQueues(id, socket);
        privateRooms.join(message.code.toUpperCase(), id, socket, callsign, userId, characterVariant, gunVariant);
        return;
      }
      if (message.type === 'start-room' && typeof message.code === 'string') {
        privateRooms.start(message.code.toUpperCase(), id);
        return;
      }
      if (message.type === 'start-survival') {
        leaveAllPreMatchQueues(id, socket);
        const bots = createBotEntries(SURVIVAL_BOT_COUNT);
        launchMatch([{
          id, socket, callsign, userId, characterVariant, gunVariant,
        }, ...bots], 'survival');
        return;
      }
      return; // queued/room-pending but nothing else to do with move/shoot messages yet
    }

    const match = matches.get(socket.matchId);
    if (!match) return;

    if (message.type === 'move' && message.position && typeof message.yaw === 'number') {
      match.handleMove(id, message.position, message.yaw);
    } else if (message.type === 'shoot' && message.origin && message.direction) {
      match.handleShoot(id, message.origin, message.direction);
    } else if (message.type === 'quit-match') {
      // Voluntary early exit (see client/src/gameScreen.js's hamburger-menu
      // Quit Match button) - handled exactly like this socket had actually
      // disconnected (same forfeit-and-clean-up behavior a real disconnect
      // already gets, see match.js's handleDisconnect - no stake refund,
      // no match-history row, just removed from the match), except the
      // socket itself stays open, since the player is expected to keep
      // using this same tab/connection afterward (back to this client's own
      // lobby screen, not a full page reload). Clearing socket.matchId is
      // what actually makes that possible - without it, every message this
      // connection sends afterward would keep routing here (`const match =
      // matches.get(socket.matchId)` above) to a match that no longer has
      // this player in it, instead of being treated as pre-match again.
      match.handleDisconnect(id);
      socket.matchId = null;
    }
  });

  socket.on('close', () => {
    console.log(`Player disconnected: ${id} (${callsign})`);
    if (socket.matchId) {
      const match = matches.get(socket.matchId);
      if (match) match.handleDisconnect(id);
    } else {
      leaveAllPreMatchQueues(id, socket);
    }
  });
});

// Started last, after every handler above is already registered - nothing
// arriving the instant this starts accepting connections can hit a
// not-yet-wired-up path. Bound to 0.0.0.0 (every interface), not
// 127.0.0.1 - a hosting platform's port scanner/edge proxy connects from
// OUTSIDE this container's loopback, so a service bound only to 127.0.0.1
// is invisible to it even while genuinely running (see the "No open ports
// detected on 0.0.0.0... Detected open ports on localhost" error this
// exact mistake produces). Harmless locally - 0.0.0.0 still accepts
// connections via 127.0.0.1 same as before.
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Server (WebSocket + API) listening on 0.0.0.0:${PORT}`);
});
