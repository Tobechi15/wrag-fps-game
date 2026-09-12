// Mobile touch controls: a fixed-position virtual joystick (movement),
// drag-to-look on the right half of the screen, and Fire/Jump/Crouch
// buttons - only ever constructed when isTouchDevice() is true (see
// gameScreen.js), so desktop's mouse/keyboard path is completely
// unaffected. Fixed default layout only - no drag-to-reposition editor
// this pass, per the plan.
const JOYSTICK_MAX_RADIUS = 45; // px the knob can travel from center before clamping

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
// implementation regardless of input source. `fire` is
// shootingSystem.fire() (see shooting.js) - the same raycast-and-report
// logic the mouse's click handler uses, just invoked directly instead of
// through a pointer-lock-gated mousedown (Pointer Lock is unreliable on
// mobile Safari, so touch never uses it at all).
export function createTouchControls(gameScreenElement, playerControls, fire) {
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
      <button class="touch-btn touch-btn-crouch" id="touch-btn-crouch" type="button">Crouch</button>
      <button class="touch-btn touch-btn-jump" id="touch-btn-jump" type="button">Jump</button>
      <button class="touch-btn touch-btn-fire" id="touch-btn-fire" type="button">Fire</button>
    </div>
  `;
  gameScreenElement.appendChild(root);

  const joystickZone = root.querySelector('#touch-joystick-zone');
  const joystickBase = root.querySelector('#touch-joystick-base');
  const joystickKnob = root.querySelector('#touch-joystick-knob');
  const lookZone = root.querySelector('#touch-look-zone');
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

  function resetJoystick() {
    joystickTouchId = null;
    joystickKnob.style.transform = 'translate(0px, 0px)';
    playerControls.setVirtualMoveInput(0, 0);
  }

  function onJoystickTouchStart(event) {
    if (joystickTouchId !== null) return; // already tracking a touch here - ignore a second finger
    const touch = event.changedTouches[0];
    joystickTouchId = touch.identifier;
    const rect = joystickBase.getBoundingClientRect();
    joystickOriginX = rect.left + rect.width / 2;
    joystickOriginY = rect.top + rect.height / 2;
    event.preventDefault();
  }

  function onJoystickTouchMove(event) {
    if (joystickTouchId === null) return;
    const touch = findTouchById(event.changedTouches, joystickTouchId) ?? findTouchById(event.touches, joystickTouchId);
    if (!touch) return;
    const dx = touch.clientX - joystickOriginX;
    const dy = touch.clientY - joystickOriginY;
    const distance = Math.min(Math.sqrt(dx * dx + dy * dy), JOYSTICK_MAX_RADIUS);
    const angle = Math.atan2(dy, dx);
    const clampedX = Math.cos(angle) * distance;
    const clampedY = Math.sin(angle) * distance;
    joystickKnob.style.transform = `translate(${clampedX}px, ${clampedY}px)`;
    // Normalize to -1..1 for player.js. Dragging UP (negative screen Y)
    // means forward, so that axis is inverted relative to raw screen Y.
    playerControls.setVirtualMoveInput(clampedX / JOYSTICK_MAX_RADIUS, -clampedY / JOYSTICK_MAX_RADIUS);
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
    playerControls.applyLookDelta(dx, dy);
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

  function dispose() {
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
    crouchBtn.removeEventListener('touchstart', onCrouchTouchStart);
    playerControls.setVirtualMoveInput(0, 0);
    playerControls.setVirtualCrouchHeld(false);
    root.remove();
  }

  return { dispose };
}
