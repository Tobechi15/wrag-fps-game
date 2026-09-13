import * as THREE from 'three';
import { createScene } from './scene.js';
import { createPlayerControls } from './player.js';
import { createWeapon, preloadRemoteWeaponModel } from './weapon.js';
import { preloadCharacterModels } from './characterModel.js';
import { createTargets, flashTargetHit } from './targets.js';
import { createShootingSystem } from './shooting.js';
import { createPotTracker } from './pot.js';
import { createExtractionZone, flashZoneBanked, createExtractionTracker } from './extraction.js';
import { createRemotePlayerManager } from './remotePlayers.js';
import { createHealthTracker } from './health.js';
import { createMap } from './map.js';
import { createProps } from './props.js';
import { createNature } from './nature.js';
import { createShootEffects } from './shootEffects.js';
import { createArms } from './arms.js';
import { createAudioManager, preloadAudio } from './audio.js';
import { isTouchDevice, createTouchControls } from './touchControls.js';

const WIN_END_DELAY_MS = 2000; // lets the win banner actually be read before cutting to the post-match screen - just under WIN_BANNER_MS's own fade-out
const FAILURE_END_DELAY_MS = 2000; // same idea, for the losing banner - see FAILURE_BANNER_MS above

// Runs one match. `network` is the SAME connection that was already open
// while the player sat in the lobby (see app.js/network.js), and
// `initialRoster` is the list of matchmates the server already told us
// about in its 'match-start' message. `onMatchEnded(message)` fires once
// the server ends this player's involvement in the match (extracted,
// eliminated, last player standing, or time limit) - by the time it's
// called, this function has already fully torn itself down (stopped the
// render loop, released the WebGL context, removed listeners), since a
// player can go through many matches in one browser tab and leaking a
// WebGL context per match would eventually break the page.
// How many lives the vitals card's pip row should show, per mode - a
// client-side mirror of modes.js's maxDeaths (the same "known duplication"
// tradeoff as the target/extraction-zone positions - see README.md).
// Versus (1) and Private/Survival (Infinity) have no meaningful "lives
// remaining" display, so they're just absent here - see health.js's
// setLives for what an absent/<=1 total means (the row stays hidden).
const MAX_LIVES_BY_MODE = { coop: 3 };

export function startGame(gameScreenElement, network, initialRoster, onMatchEnded, gunVariant, localTeamId = null, playMode = 'versus') {
  const canvas = document.createElement('canvas');
  gameScreenElement.appendChild(canvas);

  // Shadows and antialiasing both off: shadow mapping means an extra
  // depth-render pass every frame for every shadow-casting object (trees,
  // props, every character) - the single most expensive thing this
  // renderer could be doing - and antialiasing has a real per-frame GPU
  // cost too. Neither is essential on this low-poly flat-shaded art style,
  // so both are cut for a lighter/faster game rather than kept "because
  // available". ground/sunLight still carry receiveShadow/castShadow flags
  // (scene.js) but those are harmless no-ops with shadowMap disabled here.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = false;

  const scene = createScene();

  const camera = new THREE.PerspectiveCamera(
    75, // field of view in degrees
    window.innerWidth / window.innerHeight,
    0.1, // near clip plane
    1000 // far clip plane
  );

  const overlay = gameScreenElement.querySelector('#click-to-play');
  // The overlay is a persistent DOM element reused across matches, not
  // recreated per match - if the previous match ended while the pointer
  // was still locked, it could be left with its 'hidden' class stuck on
  // (pointer lock silently releases when the old canvas is removed, but
  // that happens AFTER player.js's listeners are already disposed). Reset
  // it explicitly so every new match starts with "click to play" visible.
  overlay.classList.remove('hidden');
  const playerControls = createPlayerControls(camera, canvas, overlay);

  // Shown from the moment a match starts until every loader-based asset
  // below has actually resolved (see matchAssetsReady) - also a persistent
  // element reused across matches, so it's explicitly shown again here
  // rather than assumed hidden from a previous match's own completion.
  const matchLoadingScreenEl = gameScreenElement.querySelector('#match-loading-screen');
  matchLoadingScreenEl.hidden = false;

  // Pointer Lock (what the "click to play" overlay normally waits for) is
  // unreliable/unsupported on mobile browsers, and touch look-drag (see
  // touchControls.js) never needs it anyway - so on a touch device, skip
  // the overlay outright rather than leaving it stuck on-screen waiting
  // for a lock that will never engage.
  if (isTouchDevice()) overlay.classList.add('hidden');

  const hitFlashEl = gameScreenElement.querySelector('#hit-flash');
  function flashHitDamage() {
    hitFlashEl.classList.add('active');
    setTimeout(() => hitFlashEl.classList.remove('active'), 300);
  }

  const respawnToastEl = gameScreenElement.querySelector('#respawn-toast');
  const RESPAWN_TOAST_MS = 1200;
  let respawnToastTimeoutId = null;
  function flashRespawnToast(deathsRemaining) {
    respawnToastEl.textContent = typeof deathsRemaining === 'number'
      ? `Respawning... ${deathsRemaining} ${deathsRemaining === 1 ? 'life' : 'lives'} left`
      : 'Respawning...';
    respawnToastEl.classList.add('active');
    clearTimeout(respawnToastTimeoutId); // a fast back-to-back respawn shouldn't cut the new toast's display time short
    respawnToastTimeoutId = setTimeout(() => respawnToastEl.classList.remove('active'), RESPAWN_TOAST_MS);
  }

  // A clear single-winner ending ('last-standing'/'team-victory' - see the
  // 'match-ended' handler below) gets a brief on-screen banner BEFORE
  // cutting to the post-match screen, instead of jumping there instantly -
  // same "let the moment actually register" reasoning as flashHitDamage's
  // delay on an elimination. The world is still rendering (and still
  // technically interactive - nothing here disables input) for the
  // duration of that delay, so a small text banner alone read as "nothing
  // happened" - matchEndDimEl darkens the whole screen behind it too, so
  // the pause itself is unmistakable, not just the text.
  const winBannerEl = gameScreenElement.querySelector('#win-banner');
  const failureBannerEl = gameScreenElement.querySelector('#failure-banner');
  const matchEndDimEl = gameScreenElement.querySelector('#match-end-dim');
  // These three are persistent DOM elements reused across matches, same as
  // #click-to-play above - NOT recreated per match, so a leftover 'active'
  // class from a match that ended (or was interrupted) would otherwise
  // stay stuck through however many matches follow, e.g. matchEndDimEl
  // being added here but never removed anywhere was exactly this bug: the
  // dim stayed on forever after the very first win/loss. Reset explicitly
  // so every new match starts clean, same reasoning as the overlay reset.
  winBannerEl.classList.remove('active');
  failureBannerEl.classList.remove('active');
  matchEndDimEl.classList.remove('active');
  const WIN_BANNER_MS = 2400;
  function flashWinBanner(text) {
    winBannerEl.textContent = text;
    winBannerEl.classList.add('active');
    matchEndDimEl.classList.add('active');
    setTimeout(() => {
      winBannerEl.classList.remove('active');
      matchEndDimEl.classList.remove('active');
    }, WIN_BANNER_MS);
  }

  // Same shape as flashWinBanner, for the losing ending ('eliminated') -
  // see the 'match-ended' handler below.
  const FAILURE_BANNER_MS = 2400;
  function flashFailureBanner(text) {
    failureBannerEl.textContent = text;
    failureBannerEl.classList.add('active');
    matchEndDimEl.classList.add('active');
    setTimeout(() => {
      failureBannerEl.classList.remove('active');
      matchEndDimEl.classList.remove('active');
    }, FAILURE_BANNER_MS);
  }

  // The respawn countdown banner (Coop/Private only - see match.js's
  // beginRespawn/finishRespawn) - shown the instant this player's own
  // 'respawn-countdown' arrives, ticks down locally (purely cosmetic, same
  // as extraction.js's local dwell estimate - the server's own 'respawn'
  // message is still what actually brings the player back, on its own
  // timer; this local tick is just for the display, so a little client/
  // server drift here only ever shows up as the number looking slightly
  // early/late, never as a real gameplay effect), and hides the moment the
  // real 'respawn' message arrives.
  const respawnCountdownBannerEl = gameScreenElement.querySelector('#respawn-countdown-banner');
  const respawnCountdownLabelEl = gameScreenElement.querySelector('#respawn-countdown-label');
  const respawnCountdownValueEl = gameScreenElement.querySelector('#respawn-countdown-value');
  respawnCountdownBannerEl.hidden = true; // persistent element reused across matches - see the win/failure/dim reset above for why this matters
  let respawnCountdownIntervalId = null;
  function startRespawnCountdown(seconds, killedBy) {
    clearInterval(respawnCountdownIntervalId); // defensive - a stray double-death message shouldn't stack two tickers
    let remaining = Math.round(seconds);
    respawnCountdownLabelEl.textContent = killedBy ? `Eliminated by ${killedBy}` : 'Eliminated';
    respawnCountdownValueEl.textContent = remaining;
    respawnCountdownBannerEl.hidden = false;
    respawnCountdownIntervalId = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(respawnCountdownIntervalId);
        respawnCountdownIntervalId = null;
        respawnCountdownValueEl.textContent = 0;
        return;
      }
      respawnCountdownValueEl.textContent = remaining;
      audio.playSfx('beep');
    }, 1000);
  }
  function stopRespawnCountdown() {
    clearInterval(respawnCountdownIntervalId);
    respawnCountdownIntervalId = null;
    respawnCountdownBannerEl.hidden = true;
  }

  // The camera must be part of the scene graph for its children (the weapon)
  // to be included when the renderer traverses the scene.
  scene.add(camera);
  const weapon = createWeapon(camera, gunVariant ?? undefined);
  const armsReady = createArms(weapon); // parents itself under the weapon's own group - see arms.js/weapon.js's attachToWeapon
  const shootEffects = createShootEffects(scene);
  const audio = createAudioManager();
  const audioReady = preloadAudio();
  // matchStart/playMusic now fire once matchAssetsReady resolves below
  // (right as the loading screen actually reveals the map), not here -
  // starting them immediately used to mean the stinger/music played
  // UNDER the loading screen, disconnected from what the player could
  // actually see.

  createMap(scene); // procedural geometry, no loader - always instant, nothing to await here
  const propsReady = createProps(scene);
  const natureReady = createNature(scene);
  const targets = createTargets(scene);

  // Resolves once every loader-based asset for THIS match screen has
  // actually finished (or failed, tolerantly - see each function's own
  // comment) - the player's own weapon/arms, decorative props/nature,
  // every SFX/music file, and (in case a very fast match, e.g. a Private
  // room the host starts solo, beat app.js's page-load preload) every
  // character variant + the remote-player weapon template. Everything
  // here already runs the instant startGame() is called, same as before
  // this existed - this promise doesn't delay any of that, it only delays
  // REVEALING it (see matchLoadingScreenEl below), so nothing about
  // network/animate timing changes; a player just never sees a
  // placeholder gun or props popping in after the fact.
  // matchLoadingScreenEl is a PERSISTENT element, reused by whichever match
  // is running next - if this match ends (or this player leaves it) before
  // its own assets finish loading, the stale .then() below must not fire
  // and hide a LATER match's freshly-shown loading screen. stop() (below)
  // flips this so the check right before hiding it can tell the two apart.
  let stopped = false;
  const matchAssetsReady = Promise.all([
    weapon.ready, armsReady, propsReady, natureReady, audioReady, preloadCharacterModels(), preloadRemoteWeaponModel(),
  ]);
  matchAssetsReady.then(() => {
    if (stopped) return;
    matchLoadingScreenEl.hidden = true;
    audio.playSfx('matchStart');
    audio.playMusic();
  });
  const potTracker = createPotTracker(
    gameScreenElement.querySelector('#pot-secured'),
    gameScreenElement.querySelector('#pot-at-risk'),
    gameScreenElement.querySelector('#pot-popup'),
  );
  const healthTracker = createHealthTracker(
    gameScreenElement.querySelector('#health-bar-fill'),
    gameScreenElement.querySelector('#health-label'),
    gameScreenElement.querySelector('#lives-row'),
    gameScreenElement.querySelector('#lives-pips'),
  );
  healthTracker.reset(); // full health at the start of every match, regardless of how the last one ended
  const maxLives = MAX_LIVES_BY_MODE[playMode] ?? null;
  if (maxLives) healthTracker.setLives(maxLives, maxLives); // full lives shown from the very first frame, not just after the first death
  const extractionZoneMeshes = createExtractionZone(scene, playMode);
  const extractionTracker = createExtractionTracker(playMode);
  const extractionStatusEl = gameScreenElement.querySelector('#extraction-status');
  const extractionProgressFillEl = gameScreenElement.querySelector('#extraction-progress-fill');
  const remotePlayers = createRemotePlayerManager(scene);

  // Coop's live "versus bar" - see match.js's 'team-status' broadcast
  // below. Hidden entirely outside Coop (localTeamId is null for every
  // other mode, and the server never sends this message for them).
  const coopStatusBarEl = gameScreenElement.querySelector('#coop-status-bar');
  const coopStatusAllyListEl = gameScreenElement.querySelector('#coop-status-ally-list');
  const coopStatusEnemyListEl = gameScreenElement.querySelector('#coop-status-enemy-list');
  const coopScoreAllyEl = gameScreenElement.querySelector('#coop-score-ally');
  const coopScoreEnemyEl = gameScreenElement.querySelector('#coop-score-enemy');
  // One small circular "chip" per squad member (initials + a lives-
  // remaining badge) rather than a name row - no real avatar art exists in
  // this project (see remotePlayers.js's capsule-only rendering), and a
  // compact icon row is what actually fits lined up across the top of the
  // screen. `livesRemaining` is only ever null for a non-Coop team (never
  // actually sent here, since this whole bar is Coop-only) - kept null-safe
  // regardless, same as the server side.
  function renderTeamChips(containerEl, members) {
    containerEl.innerHTML = '';
    for (const member of members) {
      const chip = document.createElement('div');
      chip.className = `player-chip${member.isBot ? ' bot' : ''}${member.alive ? '' : ' down'}`;
      const initials = member.callsign.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '??';
      const livesBadge = member.livesRemaining === null ? '' : `<span class="player-chip-lives">${member.livesRemaining}</span>`;
      chip.innerHTML = `<span class="player-chip-avatar" title="${member.callsign}${member.isBot ? ' (Bot)' : ''}">${initials}</span>${livesBadge}`;
      containerEl.appendChild(chip);
    }
  }

  // The classic battle-royale "X remaining" + kill count readout -
  // Versus/Private only (mirrors match.js's showRemainingCount; mutually
  // exclusive with the Coop bar above, which already shows its own richer
  // per-member status). Kills are tracked purely client-side, incremented
  // the same moment the HUD already reacts to one of THIS player's own
  // kills (the 'shoot-result' handler below) - safe as a display-only
  // mirror since it only ever increments on the exact same server-
  // confirmed event the authoritative post-match kill count is built
  // from, never predicted ahead of it. "Remaining" is server-authoritative
  // (see the 'match-status' handler below) - the client has no way to
  // know when OTHER participants are eliminated on its own.
  const SHOW_MATCH_STATUS_BAR = playMode === 'versus' || playMode === 'private';
  const matchStatusBarEl = gameScreenElement.querySelector('#match-status-bar');
  const matchStatusKillsEl = gameScreenElement.querySelector('#match-status-kills');
  const matchStatusRemainingEl = gameScreenElement.querySelector('#match-status-remaining');
  let killCount = 0;
  // Explicit either way (not just when true) - this is a persistent DOM
  // element reused across matches, same reasoning as the win/failure/dim
  // reset above: a match that showed it (Versus/Private) followed by one
  // that shouldn't (Coop/Survival) must not leave it stuck visible.
  matchStatusBarEl.hidden = !SHOW_MATCH_STATUS_BAR;
  if (SHOW_MATCH_STATUS_BAR) {
    matchStatusKillsEl.textContent = '0';
    matchStatusRemainingEl.textContent = '-- / --';
  }

  // teamId is only meaningful in Coop (see match.js's modeConfig.teams) -
  // localTeamId is null everywhere else, so isAllyOf() below is always
  // false outside Coop regardless of what's in this map. Built once from
  // the initial roster since 'player-moved' broadcasts don't repeat a
  // participant's teamId (it never changes mid-match - see match.js's
  // start()) - 'player-respawned' is the one message that does carry its
  // own teamId directly, used as-is where that handler appears below.
  const teamIdById = new Map(initialRoster.map((player) => [player.id, player.teamId ?? null]));
  // 'player-moved'/'player-respawned' don't carry callsign directly (see
  // match.js) - the initial roster is the only place it's sent, so it's
  // captured here once and looked up by id for those handlers below.
  const callsignById = new Map(initialRoster.map((player) => [player.id, player.callsign]));
  function isAllyOf(id) {
    return localTeamId !== null && teamIdById.get(id) === localTeamId;
  }

  for (const player of initialRoster) {
    remotePlayers.upsert(player.id, player.position, player.yaw, player.isBot, player.characterVariant, isAllyOf(player.id), player.callsign);
  }

  function endMatch(message) {
    audio.playSfx('gameOver'); // the results-screen stinger - every ending, win or loss alike (see audio.js)
    stop();
    onMatchEnded(message);
  }

  // Pot changes only ever happen here, in response to server messages -
  // never as a direct result of a local raycast or a local timer. See the
  // comments in shooting.js, extraction.js, and server/src/match/match.js.
  //
  // Note: there's no 'player-joined' handler - under the matchmaking model
  // a match's full roster (real players + bots) is fixed at 'match-start',
  // so the server never sends that message type anymore.
  network.setHandlers({
    'player-moved': ({
      id, position, yaw, isBot,
    }) => remotePlayers.upsert(id, position, yaw, isBot, undefined, isAllyOf(id), callsignById.get(id)),
    'player-left': ({ id }) => remotePlayers.remove(id),
    // A Coop/Private teammate/opponent (or, in principle, this player
    // themself via a different route - see the self-directed 'respawn'
    // handler below) came back mid-match instead of their match ending -
    // see match.js's respawnPlayer. Uses respawn() (not upsert()) so it
    // never risks rendering alongside this id's still-falling corpse - see
    // remotePlayers.js's comment on why that matters.
    'player-respawned': ({
      id, position, yaw, isBot, characterVariant, teamId,
    }) => remotePlayers.respawn(id, position, yaw, isBot, characterVariant, localTeamId !== null && teamId === localTeamId, callsignById.get(id)),
    'shoot-result': ({ hit, killed, pot, rejected }) => {
      if (rejected) {
        console.warn('Server rejected this shot (position mismatch)');
      } else if (hit) {
        console.log(killed ? 'Kill confirmed! Pot:' : 'Hit confirmed (target survived). Pot:', pot);
        potTracker.setAtRisk(pot);
        if (killed) {
          audio.playSfx('killConfirmed');
          // Versus/Private only send this to the direct killer themselves
          // (no team to share credit with - see match.js's awardKillPoints),
          // so this is always genuinely THIS player's own kill in the only
          // modes the bar is shown for.
          if (SHOW_MATCH_STATUS_BAR) {
            killCount += 1;
            matchStatusKillsEl.textContent = killCount;
          }
        }
      }
    },
    // A bot or player's shot connected with US, but didn't kill us -
    // health drops but the match continues. See match.js's applyDamage.
    'hit': ({ health, maxHealth, hitBy }) => {
      console.log(`Hit by ${hitBy} - health now ${health}/${maxHealth}`);
      healthTracker.setHealth(health, maxHealth);
      flashHitDamage();
      audio.playSfx('hurt');
    },
    // The battle-royale "X remaining" counter - Versus/Private only (see
    // match.js's broadcastMatchStatus/showRemainingCount); never sent for
    // Coop/Survival, so this handler is simply never invoked there.
    'match-status': ({ alive, total }) => {
      matchStatusRemainingEl.textContent = `${alive} / ${total}`;
    },
    // The player reached the extraction zone and banked their current pot -
    // it moves into securedPot (safe even if killed now) and the match
    // KEEPS GOING (see match.js's bankCurrentPot). Not a match-ended event.
    'banked': ({ securedPot, pot }) => {
      console.log(`Banked! Secured total now ${securedPot}`);
      potTracker.setSecured(securedPot, pot);
      flashZoneBanked(extractionZoneMeshes, playerControls.getPosition());
      audio.playSfx('collectPot');
      extractionTracker.reset(); // so a rapid re-entry doesn't visually inherit stale progress
    },
    // Coop only - the live versus bar (see match.js's buildTeamStatus/
    // getTeamScore). `yourTeam`/`otherTeam` are both
    // [{callsign, isBot, alive, livesRemaining}], `yourScore`/`otherScore`
    // each team's running kill tally so far this match.
    'team-status': ({ yourTeam, otherTeam, yourScore, otherScore }) => {
      coopStatusBarEl.hidden = false;
      renderTeamChips(coopStatusAllyListEl, yourTeam);
      renderTeamChips(coopStatusEnemyListEl, otherTeam);
      coopScoreAllyEl.textContent = yourScore ?? 0;
      coopScoreEnemyEl.textContent = otherScore ?? 0;
    },
    // THIS player just died but their match keeps going - Coop (until
    // their 3rd death) or Private (unlimited within the timer). Fires
    // immediately on death, well before the actual respawn (see match.js's
    // beginRespawn/finishRespawn) - shows the countdown banner and loses
    // whatever unsecured pot was still at risk right away (pot is already
    // 0 by the time this arrives; securedPot is unaffected and just
    // re-sent for consistency). The player is untargetable server-side for
    // this whole window (see match.js's `respawning` flag).
    'respawn-countdown': ({ seconds, pot, securedPot, killedBy }) => {
      startRespawnCountdown(seconds, killedBy);
      potTracker.setSecured(securedPot, pot);
      audio.playSfx('dying');
      playerControls.setMovementLocked(true);
      shootingSystem.setLocked(true);
    },
    // The delay from 'respawn-countdown' above has elapsed and this player
    // is actually back - hides the countdown banner, resets health/
    // position, and shows a brief "back in the fight" toast.
    'respawn': ({
      position, yaw, health, maxHealth, deathsRemaining,
    }) => {
      stopRespawnCountdown();
      healthTracker.setHealth(health, maxHealth);
      if (maxLives && typeof deathsRemaining === 'number') healthTracker.setLives(deathsRemaining, maxLives);
      playerControls.respawnTo(position, yaw);
      playerControls.setMovementLocked(false);
      shootingSystem.setLocked(false);
      flashRespawnToast(deathsRemaining);
      audio.playSfx('respawn');
    },
    // Another participant (real player or bot) just fired - cosmetic only
    // (see shootEffects.js and match.js's handleShoot/onBotShoot, which
    // broadcast this to everyone except the shooter). origin/direction are
    // plain {x,y,z} objects over the wire, not THREE.Vector3s. Bot ids are
    // always prefixed 'bot-' (see server/src/bots/bot.js's
    // createBotEntries) - reused here to pick a distinct gunshot sound for
    // "not me", no extra field needed over the wire for it.
    //
    // The flash/tracer now spawns from that participant's actual held gun
    // (see remotePlayers.js's getMuzzleWorldPosition, reading the real
    // weapon model parented to their wrist bone) rather than the server-
    // reported `origin` - which is only ever an approximate eye-level
    // point (a real player's own raycast origin, or a bot's tracked body
    // position - see match.js). Falls back to that same `origin` if this
    // participant has no gun mesh yet (template still preloading, or the
    // capsule fallback with no bones at all).
    'shot-fired': ({ id, origin, direction }) => {
      const remoteMuzzle = remotePlayers.getMuzzleWorldPosition(id, new THREE.Vector3());
      shootEffects.triggerShot(
        remoteMuzzle ?? new THREE.Vector3(origin.x, origin.y, origin.z),
        new THREE.Vector3(direction.x, direction.y, direction.z),
      );
      audio.playSfx(id.startsWith('bot-') ? 'gunshotRemote' : 'gunshotPlayer');
    },
    // The server has ended THIS player's involvement in the match. reason
    // is one of: 'eliminated' (killed by a bot or player - unsecured pot
    // lost, securedPot survives), 'last-standing'/'team-victory' (a clear
    // single-winner ending - gets its own banner+delay below, same
    // "let the moment register" reasoning as the elimination flash) or
    // 'time-limit' (match ended around them - remaining at-risk pot
    // auto-banks, but not necessarily a solo win - several players can
    // all hit the time limit at once, so no banner for this one).
    'match-ended': (message) => {
      console.log('Match ended:', message);
      if (message.reason === 'eliminated') {
        flashHitDamage();
        audio.playSfx('dying');
        flashFailureBanner(message.killedBy ? `Eliminated by ${message.killedBy}` : 'Eliminated');
        setTimeout(() => endMatch(message), FAILURE_END_DELAY_MS);
      } else if (message.reason === 'last-standing' || message.reason === 'team-victory') {
        audio.playSfx('winner');
        flashWinBanner(message.reason === 'team-victory' ? 'Team Victory' : 'Victory');
        setTimeout(() => endMatch(message), WIN_END_DELAY_MS);
      } else {
        endMatch(message);
      }
    },
  });

  // Magazine/reload indicator - a small radial progress ring just below the
  // crosshair (see game.css's #reload-indicator), driven by shooting.js's
  // onReloadStart/onReloadEnd. The fill animation is a plain CSS
  // transition on stroke-dashoffset: reset it instantly (transition-
  // duration: 0ms) back to fully-empty, force a reflow so that reset
  // actually applies as its own frame instead of being coalesced away by
  // the browser, then re-enable the transition and set the fill target -
  // the standard trick for restarting a CSS transition from the same
  // element on repeated triggers (every subsequent reload), not just the
  // first one.
  const reloadIndicatorEl = gameScreenElement.querySelector('#reload-indicator');
  const reloadRingFillEl = gameScreenElement.querySelector('#reload-ring-fill');
  const RELOAD_RING_CIRCUMFERENCE = 113.097; // 2 * PI * 18 - must match index.html's <circle r="18">
  reloadIndicatorEl.hidden = true; // persistent element reused across matches - see the win/failure/dim reset elsewhere for why this matters
  function startReloadAnimation(durationMs) {
    reloadIndicatorEl.hidden = false;
    reloadRingFillEl.style.transitionDuration = '0ms';
    reloadRingFillEl.style.strokeDashoffset = String(RELOAD_RING_CIRCUMFERENCE);
    void reloadRingFillEl.getBoundingClientRect(); // force the reflow described above
    reloadRingFillEl.style.transitionDuration = `${durationMs}ms`;
    reloadRingFillEl.style.strokeDashoffset = '0';
  }
  function endReloadAnimation() {
    reloadIndicatorEl.hidden = true;
  }

  const muzzleWorldPosition = new THREE.Vector3(); // reused each shot so onFire doesn't allocate
  const shootingSystem = createShootingSystem(camera, targets, canvas, {
    onLocalHit: (hitTarget) => flashTargetHit(hitTarget),
    onFire: (origin, direction) => {
      network.sendShot(origin, direction);
      // Cosmetic only (see shootEffects.js) - fires from the WEAPON's
      // muzzle, not the camera-center raycast origin, so it visibly comes
      // from the gun rather than from between the player's eyes.
      shootEffects.triggerShot(weapon.getMuzzleWorldPosition(muzzleWorldPosition), direction);
      audio.playSfx('gunshotPlayer');
    },
    // Tried to fire with an empty magazine (mid-reload) - the classic dry-
    // fire click instead of a real gunshot, no shot sent to the server at
    // all (see shooting.js's fire()).
    onDryFire: () => audio.playSfx('emptyGunshot'),
    onReloadStart: (durationMs) => {
      startReloadAnimation(durationMs);
      audio.playSfx('reload');
    },
    onReloadEnd: () => endReloadAnimation(),
  });

  // Mobile touch controls - only ever constructed when isTouchDevice()
  // fires, so desktop's mouse/keyboard path is completely untouched.
  // fire() is the exact same raycast-and-report logic the mouse's
  // pointer-lock-gated click already uses (see shooting.js).
  const touchControls = isTouchDevice()
    ? createTouchControls(gameScreenElement, playerControls, shootingSystem.fire)
    : null;

  // Keep the render resolution and camera aspect ratio in sync with the window.
  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', onResize);

  const clock = new THREE.Clock();
  let animationFrameId = null;
  const FOOTSTEP_INTERVAL_SECONDS = 0.5; // was 0.35 - reported as too frequent/loud together
  let footstepTimer = 0;

  function animate() {
    animationFrameId = requestAnimationFrame(animate);
    const deltaSeconds = clock.getDelta();
    playerControls.update(deltaSeconds);
    const sway = playerControls.getSway();
    weapon.setSway(sway); // arms are a child of the weapon's own group (see arms.js) - they inherit this automatically
    remotePlayers.tick(deltaSeconds);
    shootEffects.tick(deltaSeconds);
    network.sendPosition(playerControls.getPosition(), playerControls.getYaw());

    const extractionState = extractionTracker.update(playerControls.getPosition(), deltaSeconds);
    extractionStatusEl.hidden = !extractionState.inZone;
    if (extractionState.inZone) {
      extractionProgressFillEl.style.width = `${extractionState.progress * 100}%`;
    }

    if (sway.isMoving) {
      footstepTimer += deltaSeconds;
      if (footstepTimer >= FOOTSTEP_INTERVAL_SECONDS) {
        footstepTimer = 0;
        audio.playSfx('footstep');
      }
    } else {
      footstepTimer = FOOTSTEP_INTERVAL_SECONDS; // next step plays immediately on starting to move again, not after a fresh half-interval wait
    }

    renderer.render(scene, camera);
  }

  animate();

  // Tears down everything this match created. Doesn't bother disposing
  // every individual geometry/material (a handful of boxes/capsules per
  // match is negligible GPU memory for a prototype) - releasing the
  // WebGL context itself is the part that actually matters, since browsers
  // cap how many a page can hold at once.
  function stop() {
    stopped = true;
    cancelAnimationFrame(animationFrameId);
    clearTimeout(respawnToastTimeoutId);
    clearInterval(respawnCountdownIntervalId);
    window.removeEventListener('resize', onResize);
    playerControls.dispose();
    shootingSystem.dispose();
    touchControls?.dispose();
    shootEffects.dispose();
    audio.stopMusic();
    renderer.dispose();
    canvas.remove();
  }
}
