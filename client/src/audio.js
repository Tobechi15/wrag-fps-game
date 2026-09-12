// Simple HTMLAudioElement-based sound manager - no Web Audio graph needed
// for a prototype's worth of one-shot SFX plus a single looping music
// track. Every browser requires a user gesture before audio can actually
// play; the game screen already requires a click (pointer lock) before
// anything happens, so that gesture is always satisfied by the time any of
// this fires - .play() promise rejections are still swallowed defensively
// in case that ever isn't true (a blocked autoplay is not worth crashing
// over, it's just silence).
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
};
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
};
// A real playlist, not one track on repeat - cycles through every track in
// order (wrapping back to the first once the last one ends) via the
// 'ended' event below, rather than a single `.loop = true` track. Shuffled
// ONCE per playMusic() call (not per page load and not re-shuffled on
// every loop) so a given play session has a fixed, predictable running
// order instead of the same track potentially repeating back-to-back at
// the wrap-around point.
const MUSIC_PLAYLIST = [
  '/audio/action-bg-music.mp3',
];
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

export function createAudioManager() {
  let musicEl = null;
  let playlist = [];
  let playlistIndex = 0;

  function playSfx(name) {
    const source = SFX_URLS[name];
    if (!source) return;
    const url = Array.isArray(source) ? source[Math.floor(Math.random() * source.length)] : source;
    const audio = new Audio(url);
    audio.volume = SFX_VOLUMES[name] ?? 0.5;
    audio.play().catch(() => {});
  }

  // Plays playlist[playlistIndex], then advances (wrapping around) and
  // plays the next one the moment THIS track's 'ended' event fires - a
  // real "loop through the whole playlist," not just one track repeating.
  function playCurrentTrack() {
    musicEl = new Audio(playlist[playlistIndex]);
    musicEl.volume = MUSIC_VOLUME;
    musicEl.addEventListener('ended', () => {
      playlistIndex = (playlistIndex + 1) % playlist.length;
      playCurrentTrack();
    });
    musicEl.play().catch(() => {});
  }

  // Idempotent - a second call while music is already playing is a no-op,
  // so callers don't need to track whether they've already started it.
  function playMusic() {
    if (musicEl) return;
    playlist = shuffle(MUSIC_PLAYLIST);
    playlistIndex = 0;
    playCurrentTrack();
  }

  function stopMusic() {
    if (!musicEl) return;
    musicEl.pause();
    musicEl = null;
  }

  return {
    playSfx, playMusic, stopMusic,
  };
}
