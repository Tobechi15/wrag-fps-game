// A brief triangle that points toward wherever an incoming hit just came
// from, in SCREEN space relative to the player's CURRENT facing - the
// classic FPS "who's shooting me" cue. Most useful exactly when the
// attacker isn't on screen at all (behind you, or off to the side) since
// there's nothing else to tell you that; still shown even when they
// happen to be in view, same as every mainstream shooter's version of this.
//
// Pooled, fixed-size set of DOM elements (see shootEffects.js for the same
// "pool, don't allocate/dispose per event" reasoning) - a handful of slots
// is already more than enough for how many distinct hit directions could
// plausibly be active in the same ~1s window; a hit arriving faster than
// that just reuses the oldest slot and restarts its fade.
const POOL_SIZE = 4;
const VISIBLE_MS = 1100;
const RING_RADIUS_PX = 140; // distance from the crosshair the triangle sits at

// Only ever mounted while a match is running (see gameScreen.js), so this
// never has to worry about outliving the game screen itself.
export function createHitDirectionIndicator(gameScreenElement) {
  const root = document.createElement('div');
  root.id = 'hit-direction-indicators';
  gameScreenElement.appendChild(root);

  const pool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const el = document.createElement('div');
    el.className = 'hit-direction-indicator';
    root.appendChild(el);
    pool.push({ el, timeoutId: null });
  }
  let nextIndex = 0;

  // playerPosition/shooterPosition are plain {x,z} (y is ignored - this is
  // a horizontal "which way do I turn" cue only, same as every other
  // bearing-ish thing in this project, e.g. player.js's own yaw-only
  // movement). playerYaw is playerControls.getYaw(). Silently no-ops if
  // shooterPosition is missing (an older/unexpected message shape) rather
  // than pointing at a meaningless default direction.
  function trigger(playerPosition, playerYaw, shooterPosition) {
    if (!shooterPosition) return;

    const dx = shooterPosition.x - playerPosition.x;
    const dz = shooterPosition.z - playerPosition.z;
    if (dx === 0 && dz === 0) return; // degenerate - nothing meaningful to point at

    // Forward basis matches player.js's own update() (forward.set(sin(yaw),
    // 0, cos(yaw)).multiplyScalar(-1)) - that really is the camera's actual
    // forward direction. Its "right" vector is NOT reused here despite the
    // name, though: player.js's `right` is negated in a way that actually
    // points toward the player's on-screen LEFT (confirmed directly by its
    // own WASD handling - KeyD, strafe right, does `moveDirection.sub(right)`,
    // so `-right` is the true rightward direction, not `right` itself). This
    // builds its own right vector WITHOUT that extra negation, so a shooter
    // at true screen-right projects to a positive bearing - verified against
    // a known world position (yaw=0 facing -Z, a shooter at world +X, which
    // is screen-right for that facing, produces bearing=+90 with this sign,
    // matching rotate(90deg)'s clockwise/rightward turn in game.css).
    const forwardX = -Math.sin(playerYaw);
    const forwardZ = -Math.cos(playerYaw);
    const rightX = Math.sin(playerYaw + Math.PI / 2);
    const rightZ = Math.cos(playerYaw + Math.PI / 2);
    const localForward = (dx * forwardX) + (dz * forwardZ);
    const localRight = (dx * rightX) + (dz * rightZ);
    const bearingDegrees = Math.atan2(localRight, localForward) * (180 / Math.PI);

    const slot = pool[nextIndex];
    nextIndex = (nextIndex + 1) % pool.length;
    clearTimeout(slot.timeoutId);

    // Centers on the crosshair, rotates to the computed bearing (the
    // triangle's own unrotated shape - see game.css - points "up", i.e. 0deg
    // = straight ahead), then pushes it out along that now-rotated axis to
    // sit in a ring around the crosshair instead of on top of it.
    slot.el.style.transform = `translate(-50%, -50%) rotate(${bearingDegrees}deg) translateY(-${RING_RADIUS_PX}px)`;
    slot.el.classList.remove('visible');
    void slot.el.offsetWidth; // force a reflow so re-triggering the same slot restarts the fade instead of the browser coalescing the class change away
    slot.el.classList.add('visible');

    slot.timeoutId = setTimeout(() => slot.el.classList.remove('visible'), VISIBLE_MS);
  }

  function dispose() {
    for (const slot of pool) clearTimeout(slot.timeoutId);
    root.remove();
  }

  return { trigger, dispose };
}
