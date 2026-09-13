import { createNetworkClient } from './network.js';
import { createLobbyScreen } from './lobbyScreen.js';
import { startGame } from './gameScreen.js';
import { createPostMatchScreen } from './postMatchScreen.js';
import { preloadCharacterModels } from './characterModel.js';
import { preloadRemoteWeaponModel } from './weapon.js';

// Kicked off immediately, in parallel with everything else below - by the
// time matchmaking actually finds a match (real network+lobby time), these
// are very likely already loaded (see remotePlayers.js's fallback for the
// rare case they aren't). Every variant is preloaded, not just this
// player's own pick, since other participants in the match may have
// chosen differently - see remotePlayers.js.
preloadCharacterModels();
// The held weapon every OTHER participant shows (see remotePlayers.js) -
// always the same one model regardless of loadout, so there's only ever
// this one to preload here, unlike the character variants above.
preloadRemoteWeaponModel();

const lobbyScreenEl = document.getElementById('lobby-screen');
const gameScreenEl = document.getElementById('game-screen');
const postMatchScreenEl = document.getElementById('post-match-screen');

// A logged-in player arrives here with a one-time token in the URL (the
// dashboard's Play Now button fetches one from the API server and appends
// it before navigating here - see site/src/dashboard.js). Passing it on to
// the WebSocket connection is what lets the game server attach match
// results to a real account instead of playing fully anonymously; no
// token just means anonymous play, same as Phase 1 always has. The
// dashboard's loadout selector appends `character`/`gun` the same way -
// both now ride along on the connection URL: character needs to reach the
// SERVER so other participants can see your pick (see match.js's roster),
// and gun does too, even though it still only ever changes YOUR OWN
// first-person view client-side (see weapon.js) - the server now also
// reads it to resolve per-weapon damage/range (see match.js's
// WEAPON_STATS: a shotgun one-shots up close but can't reach far, a sniper
// one-shots at any range), which has to be decided server-side like every
// other gameplay outcome, not left to the client's own claim.
const urlParams = new URLSearchParams(window.location.search);
const playToken = urlParams.get('token');
const characterVariant = urlParams.get('character');
const gunVariant = urlParams.get('gun');
// Which mode to enter - chosen on the dashboard's Play Mode dock (see
// site/src/dashboard.js's wirePlayModeSelector), not anything picked in
// this client itself (see lobbyScreen.js's module comment). Read once here
// and reused for every show() call below, including returning to the
// lobby after a match, so the whole tab session stays in whatever mode the
// player originally deployed into.
const playMode = urlParams.get('mode') ?? 'versus';

const wsParams = new URLSearchParams();
if (playToken) wsParams.set('token', playToken);
if (characterVariant) wsParams.set('character', characterVariant);
if (gunVariant) wsParams.set('gun', gunVariant);
const wsQuery = wsParams.toString();

// The game server's own address, not a hardcoded '127.0.0.1' - this page
// is reachable from other devices (a phone, via a forwarded port/LAN IP, or
// a real Vercel deployment entirely separate from wherever the backend
// actually runs), and '127.0.0.1' in THIS URL would mean "connect back to
// yourself" on whatever device/host the browser is actually running on,
// never this dev machine. Three ways to reach it, in order:
//   1. VITE_GAME_SERVER_URL, baked in at BUILD time (see .env.example) - a
//      full ws://or wss://host[:port] URL, for a real deployment where the
//      client (Vercel) and the backend (e.g. Render) are on two entirely
//      different domains with no shared-host relationship at all. Set this
//      as a Vercel project env var; unset for local dev.
//   2. `?wsHost=` on this page's own URL, if present - an explicit full
//      host[:port] for the WS server, no protocol (see wsProtocol below) -
//      e.g. VS Code's port-forwarding gives port 5173 and port 8080
//      completely DIFFERENT forwarded hostnames (not "same host, different
//      port"), so there's no way to derive 8080's forwarded address from
//      this page's own URL alone. Copy the forwarded address for port 8080
//      from VS Code's Ports panel and pass it here, e.g.
//      ...5173.../?wsHost=abc123-8080.usw2.devtunnels.ms.
//   3. Otherwise, this page's own hostname on port 8080 - correct for
//      desktop (127.0.0.1) and for the common "same LAN, typed the IP
//      directly" case, where both ports genuinely do share one host.
// For (2) and (3), the PROTOCOL matches this page's own (wss:// for an
// https:// page, ws:// for http://) - a forwarding tool serving this page
// over https (VS Code's tunnels always do) would have the browser block a
// plain ws:// connection outright as mixed content, even if the WS server
// itself has no TLS of its own (the tunnel terminates TLS on the way in).
// (1) is a full URL already, so it carries its own explicit protocol.
const gameServerUrlOverride = import.meta.env.VITE_GAME_SERVER_URL;
const wsHostOverride = urlParams.get('wsHost');
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const gameServerBase = gameServerUrlOverride ?? `${wsProtocol}//${wsHostOverride ?? `${window.location.hostname}:8080`}`;
const gameServerUrl = wsQuery ? `${gameServerBase}?${wsQuery}` : gameServerBase;

// One connection for the whole tab, opened as soon as the page loads so the
// server can put us in its matchmaking queue immediately - see network.js
// for why this is created once here rather than per-screen.
const network = createNetworkClient(gameServerUrl);

const postMatchScreen = createPostMatchScreen(postMatchScreenEl, {
  onReturnToLobby: () => {
    postMatchScreen.hide();
    lobbyScreen.show(playMode);
  },
});

const lobbyScreen = createLobbyScreen(lobbyScreenEl, network, {
  onMatchStart: ({ players, teamId }) => {
    lobbyScreen.hide();
    gameScreenEl.hidden = false;
    startGame(gameScreenEl, network, players, (matchEndedMessage) => {
      gameScreenEl.hidden = true;
      postMatchScreen.show(matchEndedMessage);
    }, gunVariant, teamId ?? null, playMode, () => {
      // Quit Match - never a scored outcome (see gameScreen.js's own
      // comment), so this skips the post-match results screen entirely and
      // goes straight back to matchmaking, same shape as postMatchScreen's
      // own Return to Lobby button.
      gameScreenEl.hidden = true;
      lobbyScreen.show(playMode);
    });
  },
});

lobbyScreen.show(playMode);
