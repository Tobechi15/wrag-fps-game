import * as THREE from 'three';

// Mobile touch controls: a fixed-position virtual joystick (movement),
// drag-to-look on the right half of the screen, and Fire/Jump/Crouch
// buttons - only ever constructed when isTouchDevice() is true (see
// gameScreen.js), so desktop's mouse/keyboard path is completely
// unaffected. Fixed default layout only - no drag-to-reposition editor
// this pass, per the plan.
// How long the auto-rotate tip banner stays fully visible before starting
// its fade, and how long the fade transition itself takes (must match
// touchControls.css's .touch-autorotate-tip transition duration, so the
// element is actually re-hidden right as the fade visually finishes, not
// noticeably before/after).
const AUTO_ROTATE_TIP_VISIBLE_MS = 4000;
const AUTO_ROTATE_TIP_FADE_MS = 700;

// A plain look-drag felt sluggish turning side to side, worse still while
// actively moving (running with the joystick held off-center made steering
// hard to keep up with) - both boost only the horizontal (yaw/"sideway
// turning") component of touch look-drag, stacking on top of each other
// while moving (BASE alone applies at a standstill; BASE * WHILE_MOVING
// applies while running). Vertical look and the mouse/keyboard path
// (player.js's own onMouseMove -> applyLookDelta) are completely untouched.
const TOUCH_YAW_BOOST_BASE = 1.35;
const TOUCH_YAW_BOOST_WHILE_MOVING = 1.6;

// Aim assist ("magnetism") - touch has no equivalent to a mouse's pixel-
// precise pointer, so landing exactly on a moving target through a finger
// drag is much harder than with a mouse. While actively look-dragging, if
// the nearest NEARBY enemy's projected screen position is within
// AIM_ASSIST_RADIUS_PX of the crosshair (screen center - see shooting.js,
// which always fires dead-center), a small extra nudge is added toward it
// on top of the player's own drag - the same applyLookDelta path normal
// look input already goes through, just scaled down (AIM_ASSIST_STRENGTH),
// so it never fights or overrides manual aim, only helps finish it. Mouse
// look (player.js's onMouseMove) is completely untouched - precise pointer
// aim doesn't need or want this, and unwanted "magnetism" on a mouse is
// exactly the kind of thing PC shooter players actively dislike.
//
// AIM_ASSIST_MAX_DISTANCE_METERS gates this on actual world-space distance,
// not just screen-space pixels - a distant enemy can easily project onto a
// spot right next to the crosshair (small on screen, but nowhere near the
// player), and pulling the view toward them made ordinary look-around/
// steering while just running feel like it was fighting back, per direct
// feedback after trying it. Restricting assist to CLOSE targets only means
// it can only ever kick in during an actual close-range engagement, never
// while just moving through the world with an enemy incidentally near the
// crosshair at a distance.
const AIM_ASSIST_RADIUS_PX = 60;
const AIM_ASSIST_DEADZONE_PX = 4; // already close enough - no nudge, so this never fights a final fine adjustment right at the target
const AIM_ASSIST_STRENGTH = 0.18; // fraction of the remaining pixel offset pulled in per touch-move event
const AIM_ASSIST_MAX_DISTANCE_METERS = 12;

// Reused scratch vector - projecting a target to screen space every
// touch-move event shouldn't allocate a new Vector3 each time.
const projectedPoint = new THREE.Vector3();

// Finds the on-screen-nearest NEARBY aim-assist candidate (see
// remotePlayers.js's getAimAssistTargets) and returns a small look-delta
// nudge toward it, or null if none are both close enough in the world AND
// close enough on screen to the crosshair (or none exist, or
// getAimAssistTargets wasn't provided at all - e.g. a caller that hasn't
// wired a remote-player manager up yet).
function findAimAssistDelta(camera, getAimAssistTargets) {
  if (!camera || !getAimAssistTargets) return null;
  const targets = getAimAssistTargets();
  if (!targets || targets.length === 0) return null;

  const halfWidth = window.innerWidth / 2;
  const halfHeight = window.innerHeight / 2;
  let bestDx = 0;
  let bestDy = 0;
  let bestDistSq = Infinity;

  for (const worldPoint of targets) {
    if (camera.position.distanceTo(worldPoint) > AIM_ASSIST_MAX_DISTANCE_METERS) continue; // too far away - see the module comment above
    projectedPoint.copy(worldPoint).project(camera);
    if (projectedPoint.z < -1 || projectedPoint.z > 1) continue; // behind the camera (or outside clip range) - never assist toward something not actually visible
    const screenX = (projectedPoint.x + 1) * halfWidth;
    const screenY = (1 - projectedPoint.y) * halfHeight; // NDC y is up; screen y is down
    const dx = screenX - halfWidth;
    const dy = screenY - halfHeight;
    const distSq = (dx * dx) + (dy * dy);
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestDx = dx;
      bestDy = dy;
    }
  }

  const bestDist = Math.sqrt(bestDistSq);
  if (bestDist > AIM_ASSIST_RADIUS_PX || bestDist < AIM_ASSIST_DEADZONE_PX) return null;
  return { dx: bestDx * AIM_ASSIST_STRENGTH, dy: bestDy * AIM_ASSIST_STRENGTH };
}

// Deliberately NOT `'ontouchstart' in window || navigator.maxTouchPoints > 0`
// - that flags ANY touch-capable screen, including a touchscreen laptop or
// desktop monitor that also has a mouse/trackpad, wrongly handing it the
// mobile overlay and hiding the normal desktop mouse/keyboard experience
// underneath it. `(hover: none) and (pointer: coarse)` instead asks "is
// touch the ONLY way to point at this screen" - a touchscreen laptop still
// has a hover-capable pointer (its trackpad/mouse), so it reports
// `hover: hover` and correctly stays in desktop mode; a phone/tablet with
// no other pointing device reports `hover: none` and gets the touch
// overlay. Checked fresh every time a match starts (see gameScreen.js) -
// not cached - so switching devices (or plugging a mouse into a tablet)
// between matches just works without a page reload.
export function isTouchDevice() {
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

function findTouchById(touchList, id) {
  for (let i = 0; i < touchList.length; i += 1) {
    if (touchList[i].identifier === id) return touchList[i];
  }
  return null;
}

// `playerControls` is the object createPlayerControls() returns (see
// player.js) - this feeds it the same setVirtualMoveInput/
// setVirtualCrouchHeld/requestJump/applyLookDelta hooks WASD/mouse/Space
// already drive, so player.js has one single movement/look/jump/crouch
// implementation regardless of input source. `fire`/`reload` are
// shootingSystem.fire()/reload() (see shooting.js) - the same logic the
// mouse/keyboard path uses, just invoked directly instead of through a
// pointer-lock-gated mousedown/keydown (Pointer Lock is unreliable on
// mobile Safari, so touch never uses it at all).
export function createTouchControls(gameScreenElement, playerControls, fire, reload, { camera, getAimAssistTargets } = {}) {
  // #ammo-display (see game.css) sits at the exact bottom-right corner -
  // the same corner the Fire/Jump/Crouch/Reload cluster anchors to on
  // touch. game.css uses this class to shift the ammo card clear of that
  // cluster ONLY on touch (desktop's corner is otherwise empty, see
  // ammo-display's own comment, so it stays put there).
  gameScreenElement.classList.add('touch-active');

  const root = document.createElement('div');
  root.id = 'touch-controls';
  root.innerHTML = `
    <div class="touch-joystick-zone" id="touch-joystick-zone">
      <div class="touch-joystick-base" id="touch-joystick-base">
        <div class="touch-joystick-knob" id="touch-joystick-knob"></div>
      </div>
    </div>
    <div class="touch-look-zone" id="touch-look-zone"></div>
    <div class="touch-buttons">
      <button class="touch-btn touch-btn-reload" id="touch-btn-reload" type="button">Reload</button>
      <button class="touch-btn touch-btn-crouch" id="touch-btn-crouch" type="button">Crouch</button>
      <button class="touch-btn touch-btn-jump" id="touch-btn-jump" type="button">Jump</button>
      <button class="touch-btn touch-btn-fire" id="touch-btn-fire" type="button">Fire</button>
    </div>
    <div class="touch-autorotate-tip" id="touch-autorotate-tip" hidden>
      Tip: turn on auto-rotate in your device settings for the best experience
    </div>
    <div class="touch-orientation-overlay" id="touch-orientation-overlay" hidden>
      <div class="rotate-icon"></div>
      <div class="rotate-message">Rotate your device to landscape to play</div>
    </div>
  `;
  gameScreenElement.appendChild(root);

  const joystickZone = root.querySelector('#touch-joystick-zone');
  const joystickBase = root.querySelector('#touch-joystick-base');
  const joystickKnob = root.querySelector('#touch-joystick-knob');
  const lookZone = root.querySelector('#touch-look-zone');
  const orientationOverlayEl = root.querySelector('#touch-orientation-overlay');
  const autoRotateTipEl = root.querySelector('#touch-autorotate-tip');
  const reloadBtn = root.querySelector('#touch-btn-reload');
  const fireBtn = root.querySelector('#touch-btn-fire');
  const jumpBtn = root.querySelector('#touch-btn-jump');
  const crouchBtn = root.querySelector('#touch-btn-crouch');

  // Movement joystick: fixed-position (the visible base never moves, per
  // the plan's "fixed default layout") - a touch starting anywhere in the
  // larger invisible zone still measures its drag relative to the base's
  // fixed center, so the touch target is bigger than the visible circle
  // without the joystick itself relocating.
  let joystickTouchId = null;
  let joystickOriginX = 0;
  let joystickOriginY = 0;
  // How far the knob can travel from center before clamping - MEASURED
  // fresh at every touchstart, not a fixed constant, since
  // touchControls.css now sizes the base/knob fluidly (clamp()'d to the
  // viewport, see that file's comment) rather than a fixed px size; a
  // hardcoded radius here would drift out of sync with whatever size the
  // CSS actually rendered on this particular screen.
  let joystickMaxRadius = 45;

  function resetJoystick() {
    joystickTouchId = null;
    joystickKnob.style.transform = 'translate(0px, 0px)';
    playerControls.setVirtualMoveInput(0, 0);
  }

  function onJoystickTouchStart(event) {
    if (joystickTouchId !== null) return; // already tracking a touch here - ignore a second finger
    const touch = event.changedTouches[0];
    joystickTouchId = touch.identifier;
    const baseRect = joystickBase.getBoundingClientRect();
    const knobRect = joystickKnob.getBoundingClientRect();
    joystickOriginX = baseRect.left + baseRect.width / 2;
    joystickOriginY = baseRect.top + baseRect.height / 2;
    joystickMaxRadius = baseRect.width / 2 - knobRect.width / 2;
    event.preventDefault();
  }

  function onJoystickTouchMove(event) {
    if (joystickTouchId === null) return;
    const touch = findTouchById(event.changedTouches, joystickTouchId) ?? findTouchById(event.touches, joystickTouchId);
    if (!touch) return;
    const dx = touch.clientX - joystickOriginX;
    const dy = touch.clientY - joystickOriginY;
    const distance = Math.min(Math.sqrt(dx * dx + dy * dy), joystickMaxRadius);
    const angle = Math.atan2(dy, dx);
    const clampedX = Math.cos(angle) * distance;
    const clampedY = Math.sin(angle) * distance;
    joystickKnob.style.transform = `translate(${clampedX}px, ${clampedY}px)`;
    // Normalize to -1..1 for player.js. Dragging UP (negative screen Y)
    // means forward, so that axis is inverted relative to raw screen Y.
    // X is ALSO inverted (left/right swapped), per the user's request -
    // the knob itself still visually tracks the real finger position
    // above, only the resulting strafe direction is flipped.
    playerControls.setVirtualMoveInput(-clampedX / joystickMaxRadius, -clampedY / joystickMaxRadius);
    event.preventDefault();
  }

  function onJoystickTouchEnd(event) {
    if (!findTouchById(event.changedTouches, joystickTouchId)) return;
    resetJoystick();
  }

  joystickZone.addEventListener('touchstart', onJoystickTouchStart, { passive: false });
  joystickZone.addEventListener('touchmove', onJoystickTouchMove, { passive: false });
  joystickZone.addEventListener('touchend', onJoystickTouchEnd);
  joystickZone.addEventListener('touchcancel', onJoystickTouchEnd);

  // Look-drag: reuses player.js's applyLookDelta - the exact same
  // clamp+sensitivity math the mouse's Pointer-Lock path already applies,
  // just fed raw per-move pixel deltas instead of movementX/Y.
  let lookTouchId = null;
  let lastLookX = 0;
  let lastLookY = 0;

  function onLookTouchStart(event) {
    if (lookTouchId !== null) return;
    const touch = event.changedTouches[0];
    lookTouchId = touch.identifier;
    lastLookX = touch.clientX;
    lastLookY = touch.clientY;
    event.preventDefault();
  }

  function onLookTouchMove(event) {
    if (lookTouchId === null) return;
    const touch = findTouchById(event.changedTouches, lookTouchId) ?? findTouchById(event.touches, lookTouchId);
    if (!touch) return;
    const dx = touch.clientX - lastLookX;
    const dy = touch.clientY - lastLookY;
    lastLookX = touch.clientX;
    lastLookY = touch.clientY;
    // getSway().isMoving reflects the joystick's current movement state
    // (see player.js) - cheap to read every move event, no caching needed.
    const turnBoost = playerControls.getSway().isMoving
      ? TOUCH_YAW_BOOST_BASE * TOUCH_YAW_BOOST_WHILE_MOVING
      : TOUCH_YAW_BOOST_BASE;
    playerControls.applyLookDelta(dx * turnBoost, dy);

    // Aim assist - see findAimAssistDelta above. Applied AFTER the player's
    // own drag, as a small additional nudge, never a replacement for it.
    const assist = findAimAssistDelta(camera, getAimAssistTargets);
    if (assist) playerControls.applyLookDelta(assist.dx, assist.dy);

    event.preventDefault();
  }

  function onLookTouchEnd(event) {
    if (!findTouchById(event.changedTouches, lookTouchId)) return;
    lookTouchId = null;
  }

  lookZone.addEventListener('touchstart', onLookTouchStart, { passive: false });
  lookZone.addEventListener('touchmove', onLookTouchMove, { passive: false });
  lookZone.addEventListener('touchend', onLookTouchEnd);
  lookZone.addEventListener('touchcancel', onLookTouchEnd);

  // Fire/Jump: plain taps, fired on touchstart for lower latency than
  // waiting for touchend - preventDefault also stops a synthetic 'click'
  // and iOS's press-and-hold callout/zoom from triggering on these.
  function onFireTouchStart(event) {
    event.preventDefault();
    fire();
  }
  fireBtn.addEventListener('touchstart', onFireTouchStart, { passive: false });

  function onJumpTouchStart(event) {
    event.preventDefault();
    playerControls.requestJump();
  }
  jumpBtn.addEventListener('touchstart', onJumpTouchStart, { passive: false });

  // Manual reload - same "at your own convenience" action the keyboard's R
  // key triggers (see shooting.js's reload()); a no-op if already full or
  // already reloading, so mashing this button is harmless.
  function onReloadTouchStart(event) {
    event.preventDefault();
    reload();
  }
  reloadBtn.addEventListener('touchstart', onReloadTouchStart, { passive: false });

  // Crouch: toggle style (press to crouch, press again to stand) - see
  // player.js's virtualCrouchHeld comment for why, vs. a held button.
  let crouching = false;
  function onCrouchTouchStart(event) {
    event.preventDefault();
    crouching = !crouching;
    crouchBtn.classList.toggle('active', crouching);
    playerControls.setVirtualCrouchHeld(crouching);
  }
  crouchBtn.addEventListener('touchstart', onCrouchTouchStart, { passive: false });

  // Blocking "rotate your device" prompt - this game's touch layout
  // (bottom-left joystick, bottom-right buttons, right-half look-drag)
  // only makes sense in landscape, so portrait is treated as unplayable
  // rather than letting someone try to use a cramped/overlapping layout.
  // Reactive to `orientationchange`-driven media query changes, not
  // checked once at mount - a player can physically rotate their phone
  // mid-match, and the prompt should appear/disappear live as they do.
  const portraitQuery = window.matchMedia('(orientation: portrait)');
  let autoRotateTipTimeoutIds = [];

  function clearAutoRotateTipTimers() {
    for (const id of autoRotateTipTimeoutIds) clearTimeout(id);
    autoRotateTipTimeoutIds = [];
  }

  // A phone that's rotated but has auto-rotate OFF never actually fires
  // 'orientationchange'/updates this media query at all - the OS just
  // keeps rendering the page upright regardless of physical orientation,
  // so from this code's perspective it looks identical to "still
  // portrait." There's no reliable way to detect THAT specific case (no
  // web API exposes the device's physical orientation independent of the
  // OS's own rotation-lock state) - so this tip is shown alongside every
  // portrait prompt, covering both "please physically rotate" and "please
  // also check auto-rotate is on" in one nudge, rather than trying (and
  // frequently failing) to tell the two apart. Non-blocking, fades on its
  // own - never dismissed by the user, never re-shown while already
  // visible (clearAutoRotateTipTimers + the immediate re-hide below keep
  // repeated portrait->landscape->portrait flips from stacking timers).
  function showAutoRotateTip() {
    clearAutoRotateTipTimers();
    autoRotateTipEl.hidden = false;
    autoRotateTipEl.classList.remove('fade-out');
    autoRotateTipTimeoutIds.push(setTimeout(() => {
      autoRotateTipEl.classList.add('fade-out');
    }, AUTO_ROTATE_TIP_VISIBLE_MS));
    autoRotateTipTimeoutIds.push(setTimeout(() => {
      autoRotateTipEl.hidden = true;
      autoRotateTipEl.classList.remove('fade-out');
    }, AUTO_ROTATE_TIP_VISIBLE_MS + AUTO_ROTATE_TIP_FADE_MS));
  }

  function updateOrientationOverlay() {
    const isPortrait = portraitQuery.matches;
    orientationOverlayEl.hidden = !isPortrait;
    if (isPortrait) showAutoRotateTip();
  }

  updateOrientationOverlay();
  portraitQuery.addEventListener('change', updateOrientationOverlay);

  function dispose() {
    gameScreenElement.classList.remove('touch-active');
    clearAutoRotateTipTimers();
    portraitQuery.removeEventListener('change', updateOrientationOverlay);
    joystickZone.removeEventListener('touchstart', onJoystickTouchStart);
    joystickZone.removeEventListener('touchmove', onJoystickTouchMove);
    joystickZone.removeEventListener('touchend', onJoystickTouchEnd);
    joystickZone.removeEventListener('touchcancel', onJoystickTouchEnd);
    lookZone.removeEventListener('touchstart', onLookTouchStart);
    lookZone.removeEventListener('touchmove', onLookTouchMove);
    lookZone.removeEventListener('touchend', onLookTouchEnd);
    lookZone.removeEventListener('touchcancel', onLookTouchEnd);
    fireBtn.removeEventListener('touchstart', onFireTouchStart);
    jumpBtn.removeEventListener('touchstart', onJumpTouchStart);
    reloadBtn.removeEventListener('touchstart', onReloadTouchStart);
    crouchBtn.removeEventListener('touchstart', onCrouchTouchStart);
    playerControls.setVirtualMoveInput(0, 0);
    playerControls.setVirtualCrouchHeld(false);
    root.remove();
  }

  return { dispose };
}
