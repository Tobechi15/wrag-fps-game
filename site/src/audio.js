// Same minimal pattern as client/src/audio.js, just for the dashboard's
// own background track - no SFX catalog needed here, this page has no
// gameplay events to react to.
const MUSIC_PLAYLIST = ['/audio/dashboard-bg-music.mp3', '/audio/bg-music-interlude.mp3', '/audio/action-bg-music1.mp3', '/audio/bg-music-interlude1.mp3', '/audio/action-bg-music2.mp3'];
const MUSIC_VOLUME = 0.2;

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

  function playCurrentTrack() {
    musicEl = new Audio(playlist[playlistIndex]);
    musicEl.volume = MUSIC_VOLUME;
    musicEl.addEventListener('ended', () => {
      playlistIndex = (playlistIndex + 1) % playlist.length;
      playCurrentTrack();
    });
    musicEl.play().catch(() => { });
  }
  // Idempotent - a second call while music is already playing is a no-op.

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

  return { playMusic, stopMusic };
}
