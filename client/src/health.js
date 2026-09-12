const DEFAULT_MAX_HEALTH = 100;

// Displays current health as a bar + numeric label, plus (mode-dependent)
// a row of "lives" pips - purely a display either way. The server
// (server/src/match/match.js) is the only thing that ever decides how much
// health or how many lives a player has; this just renders whatever 'hit'/
// 'respawn' messages report (see gameScreen.js's MAX_LIVES_BY_MODE for how
// the pip count itself is chosen).
export function createHealthTracker(barFillElement, labelElement, livesRowElement, livesPipsElement) {
  function setHealth(current, max = DEFAULT_MAX_HEALTH) {
    const percent = Math.max(0, Math.min(100, (current / max) * 100));
    barFillElement.style.width = `${percent}%`;
    labelElement.textContent = `${Math.max(current, 0)}/${max}`;

    // Color shifts as a warning cue - green/healthy, amber/hurt, red/critical.
    if (percent > 50) {
      barFillElement.style.background = 'var(--color-success)';
    } else if (percent > 20) {
      barFillElement.style.background = 'var(--color-accent)';
    } else {
      barFillElement.style.background = 'var(--color-danger)';
    }
  }

  // `total` null/omitted (or <= 1, i.e. Versus's single life) means this
  // mode has no meaningful "lives remaining" concept - keeps the row
  // hidden rather than showing a single, always-full pip. `remaining` out
  // of `total` pips light up (a life still held); the rest render dim/
  // "lost" - see game.css's .life-pip.
  function setLives(remaining, total) {
    if (!livesRowElement || !livesPipsElement) return;
    if (!total || total <= 1) {
      livesRowElement.hidden = true;
      return;
    }
    livesRowElement.hidden = false;
    livesPipsElement.innerHTML = '';
    for (let i = 0; i < total; i += 1) {
      const pip = document.createElement('span');
      pip.className = `life-pip ${i < remaining ? 'active' : 'lost'}`;
      livesPipsElement.appendChild(pip);
    }
  }

  function reset() {
    setHealth(DEFAULT_MAX_HEALTH, DEFAULT_MAX_HEALTH);
  }

  reset();
  return { setHealth, reset, setLives };
}
