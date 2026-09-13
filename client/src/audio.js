import { assetUrl } from './assetPath.js';

// Web Audio API-based sound manager - no Web Audio graph needed for a
// prototype's worth of one-shot SFX plus a single looping music track... or
// so it seemed. The original version of this file used `new Audio(url)` per
// playSfx() call - simple, but each call constructs a brand-new
// HTMLMediaElement AND re-decodes the file's audio data from scratch, every
// single time. That's cheap enough for the occasional footstep/UI blip, but
// every gunshot (the local player's own AND every bot/remote participant's,
// see gameScreen.js's 'shot-fired' handler) goes through this same path -
// during an active firefight with several bots engaging at once, that's a
// burst of fresh element+decode work several times a second, which is
// exactly when players reported the game hitching/hanging (never while bots
// were just patrolling and nothing was firing). Web Audio fixes this at the
// root: preloadAudio() below decodes every SFX file into an AudioBuffer
// ONCE, and playSfx() just spins up a lightweight AudioBufferSourceNode
// pointed at that already-decoded buffer - no re-decoding, no full media
// element, and cheap enough to fire many times a second without a hitch.
//
// Every browser requires a user gesture before audio can actually start;
// the game screen already requires a click (pointer lock) before anything
// happens, so getAudioContext()'s resume() call below always has one by the
// time it's needed. Playback failures are swallowed defensively (a blocked
// autoplay or a failed decode isn't worth crashing over, it's just silence).
const SFX_URLS = {
  gunshotPlayer: ['/audio/gunshot-1.mp3', '/audio/gunshot-2.mp3'], // picks one at random per shot, so your own gunfire doesn't sound identical every time
  gunshotRemote: ['/audio/gunshot-1.mp3', '/audio/gunshot-2.mp3'], // any OTHER participant's shot (bot or human) - distinct from your own so you can tell you didn't just fire
  footstep: '/audio/footstep.mp3',
  collectPot: '/audio/collect-pot.mp3',
  killConfirmed: '/audio/kill-confirmed.mp3', // the "character fall" sample, not a health/gain sound - reads better as a body going down on a confirmed kill
  matchStart: '/audio/match-start.mp3',
  winner: '/audio/winner.mp3',
  // No dedicated respawn recording exists yet - reuses match-start.mp3,
  // which already reads as "you're back in the fight," a reasonable stand-in
  // until a purpose-made cue is added. Coop/Private only (Versus has no
  // respawns - maxDeaths:1 - and Survival ends outright on death).
  respawn: '/audio/match-start.mp3',
  // Non-lethal damage taken - see gameScreen.js's 'hit' handler (survived a
  // hit, health drops but the match continues). Distinct from `dying`
  // below, which is specifically for this player's OWN death.
  hurt: ['/audio/hurt.mp3','/audio/male-hurt.mp3','/audio/grunt2.mp3'], // picks one at random per hit, so repeated hits don't sound identical every time
  // This player's own death - fires both when they're about to respawn
  // (Coop/Private, alongside the new respawn countdown banner - see
  // gameScreen.js's 'respawn-countdown' handler) and on a final
  // elimination (no respawn coming). Never for anyone else's death - see
  // killConfirmed above for that.
  dying: ['/audio/dying.mp3','/audio/man-death-scream.mp3'], // picks one at random per death, so repeated deaths don't sound identical every time
  // One tick of the respawn countdown banner - see gameScreen.js's
  // RESPAWN_COUNTDOWN_MS-driven ticker.
  beep: '/audio/beep.mp3',
  // The results-screen stinger - fires once, right as gameScreen.js tears
  // down and hands off to the post-match screen, for EVERY ending (win or
  // loss alike) - distinct from `winner`/`dying` above, which are the
  // immediate in-the-moment reactions to how THIS specific match ended;
  // this is just "the match is over, here are your results" either way.
  gameOver: '/audio/game-over.mp3',
  // The dry-fire click when trying to shoot with an empty magazine - see
  // shooting.js's onDryFire (fires instead of gunshotPlayer, never both,
  // whenever fire() is called while a reload is already in progress).
  emptyGunshot: '/audio/empty-gunshot.mp3',
  // The reload itself - fires once, right as shooting.js's onReloadStart
  // does (see gameScreen.js), alongside the HUD's reload-indicator ring.
  // Picks one at random per reload, same "don't sound identical every
  // time" reasoning as gunshotPlayer/hurt/dying above.
  reload: ['/audio/gun-reload.mp3', '/audio/gun-reload-2.mp3'],
};
// Prefixes every URL above with this build's actual base path (see
// assetPath.js) - applied here, after the fact, rather than wrapping each
// value individually above, so the per-sound comments stay attached to
// their original literal instead of getting buried in assetUrl() calls.
for (const key of Object.keys(SFX_URLS)) {
  const value = SFX_URLS[key];
  SFX_URLS[key] = Array.isArray(value) ? value.map(assetUrl) : assetUrl(value);
}
const SFX_VOLUMES = {
  gunshotPlayer: 0.6,
  gunshotRemote: 0.45,
  footstep: 0.12, // was 0.3 - footsteps were reported as overwhelming at that level, playing every ~0.35s while moving
  collectPot: 0.55,
  killConfirmed: 0.55,
  matchStart: 0.5,
  winner: 0.6,
  respawn: 0.5,
  hurt: 0.5,
  dying: 0.55,
  beep: 0.4,
  emptyGunshot: 0.5,
  reload: 0.55,
};
// A real playlist, not one track on repeat - cycles through every track in
// order (wrapping back to the first once the last one ends) via the
// AudioBufferSourceNode's own 'ended' event below, rather than a single
// `loop = true` source. Shuffled ONCE per playMusic() call (not per page
// load and not re-shuffled on every loop) so a given play session has a
// fixed, predictable running order instead of the same track potentially
// repeating back-to-back at the wrap-around point.
const MUSIC_PLAYLIST = [
  '/audio/action-bg-music.mp3',
].map(assetUrl);
const MUSIC_VOLUME = 0.22; // low enough to sit under SFX, not compete with it

// Fisher-Yates - an unbiased shuffle (unlike sorting on Math.random(),
// which skews the resulting order) for the once-per-session playlist
// ordering above.
function shuffle(array) {
  const result = array.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// One AudioContext for the whole page (creating more than one is wasteful
// and some browsers cap how many can exist) - created lazily since browsers
// forbid an unstarted/unresumed context before a user gesture. Every
// decodeAudioData call below works fine even while the context is still
// 'suspended' (decoding doesn't require the context to be running), so
// preloading can start immediately at page load, well before any click.
let audioContext = null;
function getAudioContext() {
  if (!audioContext) {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextCtor();
  }
  return audioContext;
}

// url -> decoded AudioBuffer, populated once by preloadAudio() and reused
// for every subsequent playSfx()/music call - the actual fix for the
// per-shot decode cost described above. Same "load once, reuse many" shape
// as characterModel.js's template cache.
const bufferCache = new Map();

// Fetches + decodes one audio file exactly once. A missing/broken file (or
// a decode failure) shouldn't block the match from starting, same
// tolerance as every other asset loader in this project - it would just
// play silently wrong later, same as it does today with no preloading at
// all - so failures resolve rather than reject, leaving that url absent
// from bufferCache (playSfx/playCurrentTrack below already no-op on a
// missing buffer).
async function loadBuffer(url) {
  if (bufferCache.has(url)) return;
  try {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await getAudioContext().decodeAudioData(arrayBuffer);
    bufferCache.set(url, audioBuffer);
  } catch (err) {
    console.error(`Failed to load/decode audio "${url}":`, err);
  }
}

// Every unique SFX/music URL, deduplicated (a few names above share the
// same file, e.g. gunshotPlayer/gunshotRemote) - see gameScreen.js's
// matchAssetsReady, which waits on this alongside every other asset type
// before revealing a match, so the match-start stinger/music (and every
// sound afterward) actually play the instant they're triggered instead of
// stuttering on a cold fetch+decode the first time each one is used.
export function preloadAudio() {
  const urls = new Set();
  for (const source of Object.values(SFX_URLS)) {
    if (Array.isArray(source)) source.forEach((url) => urls.add(url));
    else urls.add(source);
  }
  for (const url of MUSIC_PLAYLIST) urls.add(url);
  return Promise.all(Array.from(urls).map(loadBuffer));
}

export function createAudioManager() {
  let musicSource = null;

  // Plays an already-decoded buffer through its own GainNode (so this
  // instance's volume doesn't affect any other overlapping instance of the
  // same sound). The source node is fire-and-forget - the Web Audio graph
  // cleans it up on its own once playback ends, unlike the old
  // HTMLAudioElement approach which left a whole media element alive per
  // call until GC got to it.
  function playBuffer(buffer, volume) {
    const context = getAudioContext();
    if (context.state === 'suspended') context.resume().catch(() => {});

    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = context.createGain();
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(context.destination);
    source.start(0);
    return source;
  }

  function playSfx(name) {
    const urlSource = SFX_URLS[name];
    if (!urlSource) return;
    const url = Array.isArray(urlSource) ? urlSource[Math.floor(Math.random() * urlSource.length)] : urlSource;
    const buffer = bufferCache.get(url);
    if (!buffer) return; // not loaded yet (preloadAudio() still in flight, or that file failed) - silently skip, same tolerance as before
    playBuffer(buffer, SFX_VOLUMES[name] ?? 0.5);
  }

  // Plays playlist[playlistIndex], then advances (wrapping around) and
  // plays the next one the moment THIS track ends - a real "loop through
  // the whole playlist," not just one track repeating.
  let playlist = [];
  let playlistIndex = 0;
  function playCurrentTrack() {
    const url = playlist[playlistIndex];
    const buffer = bufferCache.get(url);
    if (!buffer) return; // failed to load - skip straight to silence rather than throwing
    musicSource = playBuffer(buffer, MUSIC_VOLUME);
    // Plain onended (not addEventListener) so stopMusic() below can cleanly
    // remove it by assignment before calling stop() - stop() fires 'ended'
    // too, and without clearing this first an intentional stop would
    // immediately advance to and start playing the next track.
    musicSource.onended = () => {
      playlistIndex = (playlistIndex + 1) % playlist.length;
      playCurrentTrack();
    };
  }

  // Idempotent - a second call while music is already playing is a no-op,
  // so callers don't need to track whether they've already started it.
  function playMusic() {
    if (musicSource) return;
    playlist = shuffle(MUSIC_PLAYLIST);
    playlistIndex = 0;
    playCurrentTrack();
  }

  function stopMusic() {
    if (!musicSource) return;
    musicSource.onended = null;
    musicSource.stop();
    musicSource = null;
  }

  return {
    playSfx, playMusic, stopMusic,
  };
}
