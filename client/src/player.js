import * as THREE from 'three';
import { moveWithCollision } from './map.js';

const MOVE_SPEED = 5; // meters per second
const PLAYER_HEIGHT = 1.7; // camera height off the ground, roughly eye level
const LOOK_SENSITIVITY = 0.0022; // radians per pixel of mouse movement
const PLAYER_RADIUS = 0.4; // for wall collision only - roughly matches the server's entity hitbox (see hitRegistration.js's ENTITY_HITBOX_HALF_EXTENTS)

// Jump/crouch: purely local/client-predicted, same as horizontal movement -
// the server only ever relays whatever position it's told (see match.js's
// handleMove), it never validates height. LOCAL PLAYER ONLY - remote
// players won't visually crouch/jump since no Crouch/Jump animation clips
// exist in the character pack (see characterModel.js's clip list), so
// teammates only ever see a plain Y-position blip from these.
const GRAVITY = -22; // meters/second^2 - tuned for a snappy, arcade-ish arc rather than a realistic float
const JUMP_VELOCITY = 7.5; // initial upward speed on takeoff, meters/second
const CROUCH_HEIGHT = 1.0; // camera height while crouched, vs PLAYER_HEIGHT standing
const CROUCH_MOVE_SPEED_MULTIPLIER = 0.5;
const CROUCH_TRANSITION_SPEED = 10; // how fast the camera lerps between standing/crouched height

// Chromium on Windows has a long-standing Pointer Lock bug: when the mouse
// moves fast enough (high-DPI/high-polling-rate mice especially), the raw
// input driver occasionally fails to deliver a clean relative delta and
// Chromium falls back to a miscalculated movementX/Y that can be an order
// of magnitude too large for that one event - reported as the camera
// "snapping to a point" on a fast/far turn. A single real mouse event
// between frames essentially never legitimately moves this many pixels, so
// clamping each event's delta to this cap absorbs the bad-driver-data
// spikes while staying well above anything a real flick produces.
const MAX_MOUSE_DELTA_PER_EVENT = 120; // pixels

// View bob / sway - purely a rendering-layer effect (see the truePosition
// split below). First pass (amplitude ~0.035/0.02) was imperceptible;
// second pass (frequency 8, amplitude 0.09/0.05) was too fast/jarring;
// third pass (frequency 5.5) over-corrected into "sluggish". The
// jarring/"jumpy" quality was mostly the sin^2 fix below (a smooth curve
// instead of abs(sin(2x)), which has a sharp direction-reversal at every
// zero crossing) - with that actually fixed, frequency can sit closer to
// the original without bringing the jumpiness back. weapon.js applies its
// OWN sway on top of this (see getSway() below and gameScreen.js) - the
// held weapon bends/sways more visibly than the camera itself, which stays
// fairly restrained to avoid motion sickness.
const BOB_FREQUENCY_MOVING = 7; // was 8, then 5.5 (too slow) - settling between the two
const BOB_AMPLITUDE_X_MOVING = 0.06;
const BOB_AMPLITUDE_Y_MOVING = 0.035; // see sin^2 note above for why this looks smoother even at a similar amplitude to the too-fast pass
const BOB_FREQUENCY_IDLE = 1.2; // a slow "breathing" sway while standing still
const BOB_AMPLITUDE_X_IDLE = 0.015;
const BOB_AMPLITUDE_Y_IDLE = 0.008;

// Wires up first-person mouse look + WASD movement for the given camera.
// Uses the browser's Pointer Lock API: once the player clicks the canvas,
// the mouse cursor is hidden and captured, and every mouse move gives us a
// raw delta (movementX/Y) instead of an absolute screen position.
//
// `camera.position` is NOT the authoritative gameplay position - it's the
// true position (see getPosition()) plus a small cosmetic sway offset
// recomputed every frame, so the weapon (a child of camera, see weapon.js)
// sways along with the view "for free". The network/server only ever sees
// getPosition()'s unswayed value (see gameScreen.js) - the sway must never
// leak into the position we report, or the server would read a stationary,
// gently-oscillating player as constantly drifting sideways.
export function createPlayerControls(camera, domElement, overlayElement) {
  const truePosition = new THREE.Vector3(0, PLAYER_HEIGHT, 0);
  camera.position.copy(truePosition);

  // Yaw = turning left/right (rotate around world Y axis).
  // Pitch = looking up/down (rotate around local X axis).
  // Kept as separate numbers instead of letting three.js accumulate rotation
  // directly, so we can clamp pitch and avoid the camera flipping upside down.
  let yaw = 0;
  let pitch = 0;
  let bobTime = 0;
  let currentSwayX = 0;
  let currentSwayY = 0;
  let currentlyMoving = false;

  // Jump: a vertical offset ON TOP OF whatever height crouch currently
  // wants (see crouchAmount below) - integrated independently so a jump
  // arc looks the same whether standing or mid-crouch-transition.
  let verticalVelocity = 0;
  let jumpOffset = 0;
  let jumpRequested = false; // edge-triggered on keydown, not held - see onKeyDown
  // 0 = fully standing, 1 = fully crouched - lerped toward whichever the
  // held key wants (see update()) so the transition isn't an instant snap.
  let crouchAmount = 0;

  // Touch joystick's current analog output (-1..1 each), see
  // setVirtualMoveInput - touchControls.js feeds this every touchmove, and
  // it just resets to 0/0 on touchend. Merged with WASD in update() below
  // rather than replacing it, so a touch-capable laptop with a keyboard
  // still works normally.
  let virtualMoveX = 0;
  let virtualMoveY = 0;
  // Touch's Crouch button is toggle-style (press to crouch, press again to
  // stand) rather than held, since there's no "held" equivalent for a
  // small on-screen button without it feeling fiddly - see setVirtualCrouchHeld.
  let virtualCrouchHeld = false;

  // Frozen while waiting to respawn (see gameScreen.js's 'respawn-countdown'/
  // 'respawn' handlers and setMovementLocked below) - looking around still
  // works (nothing gates yaw/pitch), only WASD/touch-joystick movement,
  // jump, and crouch stop responding, so a "dead" player can't keep
  // wandering/jumping around during the delay.
  let movementLocked = false;

  const keysDown = new Set();

  // Shared by the mouse's pointer-lock-gated onMouseMove below AND
  // touchControls.js's look-drag (which has no pointer lock to gate on -
  // unreliable on mobile Safari, see the plan). Same clamp/sensitivity
  // either way so look feel is consistent across input methods.
  function applyLookDelta(movementX, movementY) {
    // See MAX_MOUSE_DELTA_PER_EVENT above - clamp BEFORE applying sensitivity
    // so a single bad-driver spike can't jump yaw/pitch by an outsized
    // amount in one frame, without changing how normal-speed turning feels.
    const clampedX = Math.max(-MAX_MOUSE_DELTA_PER_EVENT, Math.min(MAX_MOUSE_DELTA_PER_EVENT, movementX));
    const clampedY = Math.max(-MAX_MOUSE_DELTA_PER_EVENT, Math.min(MAX_MOUSE_DELTA_PER_EVENT, movementY));
    yaw -= clampedX * LOOK_SENSITIVITY;
    pitch -= clampedY * LOOK_SENSITIVITY;
    // Clamp pitch just short of straight up/down so the camera never flips.
    const maxPitch = Math.PI / 2 - 0.01;
    pitch = Math.max(-maxPitch, Math.min(maxPitch, pitch));
  }

  function onMouseMove(event) {
    if (document.pointerLockElement !== domElement) return;
    applyLookDelta(event.movementX, event.movementY);
  }

  function onKeyDown(event) {
    // event.repeat fires continuously while a key is held (OS key-repeat) -
    // only the very first keydown should request a jump, otherwise holding
    // Space would queue up extra jumps that fire back-to-back once grounded.
    if (event.code === 'Space' && !event.repeat) jumpRequested = true;
    keysDown.add(event.code);
  }

  function onKeyUp(event) {
    keysDown.delete(event.code);
  }

  function onClick() {
    domElement.requestPointerLock();
  }

  function onPointerLockChange() {
    const locked = document.pointerLockElement === domElement;
    overlayElement.classList.toggle('hidden', locked);
  }

  // The overlay div sits visually on top of the canvas until pointer lock is
  // active, so it's the element that actually receives the click — listening
  // on domElement here would never fire.
  overlayElement.addEventListener('click', onClick);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('pointerlockchange', onPointerLockChange);

  // Reusable vectors so update() doesn't allocate garbage every frame.
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const moveDirection = new THREE.Vector3();

  function update(deltaSeconds) {
    camera.rotation.set(pitch, yaw, 0, 'YXZ');

    // Forward/right vectors flattened onto the ground plane (ignore pitch)
    // so looking up/down doesn't change movement speed or fly the player.
    forward.set(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(-1);
    right.set(Math.sin(yaw + Math.PI / 2), 0, Math.cos(yaw + Math.PI / 2)).multiplyScalar(-1);

    moveDirection.set(0, 0, 0);
    if (!movementLocked) {
      if (keysDown.has('KeyW')) moveDirection.add(forward);
      if (keysDown.has('KeyS')) moveDirection.sub(forward);
      if (keysDown.has('KeyD')) moveDirection.sub(right);
      if (keysDown.has('KeyA')) moveDirection.add(right);

      // Touch joystick input (see setVirtualMoveInput) - a small deadzone so
      // a knob that's barely off-center (or hasn't fully re-centered on
      // release yet) doesn't register as a drift command. Added on top of
      // WASD, not exclusive with it.
      const VIRTUAL_MOVE_DEADZONE = 0.15;
      if (Math.abs(virtualMoveX) > VIRTUAL_MOVE_DEADZONE || Math.abs(virtualMoveY) > VIRTUAL_MOVE_DEADZONE) {
        moveDirection.x += forward.x * virtualMoveY + right.x * virtualMoveX;
        moveDirection.z += forward.z * virtualMoveY + right.z * virtualMoveX;
      }
    }

    // Crouch (held Ctrl) lerps toward CROUCH_HEIGHT and slows movement while
    // held - both instantly reversible the moment it's released, no separate
    // "stand up" key. Jump is only allowed while fully standing (crouchAmount
    // effectively 0), matching real FPS convention and keeping this pass
    // simple (no crouch-jump interaction to tune). Forced toward standing
    // while movementLocked, same as the movement freeze above.
    const crouchHeld = !movementLocked
      && (keysDown.has('ControlLeft') || keysDown.has('ControlRight') || virtualCrouchHeld);
    const crouchTarget = crouchHeld ? 1 : 0;
    crouchAmount += Math.sign(crouchTarget - crouchAmount)
      * Math.min(Math.abs(crouchTarget - crouchAmount), CROUCH_TRANSITION_SPEED * deltaSeconds);

    const isMoving = moveDirection.lengthSq() > 0;
    if (isMoving) {
      const speed = MOVE_SPEED * (1 - crouchAmount * (1 - CROUCH_MOVE_SPEED_MULTIPLIER));
      moveDirection.normalize().multiplyScalar(speed * deltaSeconds);
      const resolved = moveWithCollision(truePosition, moveDirection.x, moveDirection.z, PLAYER_RADIUS);
      truePosition.x = resolved.x;
      truePosition.z = resolved.z;
    }

    // Grounded = no jump arc currently in progress. Only takes off from a
    // full standing height (crouchAmount ~0) - crouch-jumping is out of
    // scope this pass (see the comment above).
    const isGrounded = jumpOffset <= 0 && verticalVelocity <= 0;
    if (jumpRequested && isGrounded && crouchAmount < 0.05 && !movementLocked) {
      verticalVelocity = JUMP_VELOCITY;
    }
    jumpRequested = false; // always consumed - a jump attempt while airborne must not queue up and fire on landing

    verticalVelocity += GRAVITY * deltaSeconds;
    jumpOffset += verticalVelocity * deltaSeconds;
    if (jumpOffset <= 0) {
      jumpOffset = 0;
      verticalVelocity = 0;
    }

    const standHeight = PLAYER_HEIGHT - crouchAmount * (PLAYER_HEIGHT - CROUCH_HEIGHT);
    truePosition.y = standHeight + jumpOffset;

    // Sway is purely a function of time (so it keeps flowing smoothly
    // through a step change in speed) - just at a slower frequency/smaller
    // amplitude while idle than while moving.
    const frequency = isMoving ? BOB_FREQUENCY_MOVING : BOB_FREQUENCY_IDLE;
    const amplitudeX = isMoving ? BOB_AMPLITUDE_X_MOVING : BOB_AMPLITUDE_X_IDLE;
    const amplitudeY = isMoving ? BOB_AMPLITUDE_Y_MOVING : BOB_AMPLITUDE_Y_IDLE;
    bobTime += deltaSeconds * frequency;
    currentSwayX = Math.sin(bobTime) * amplitudeX;
    // sin(bobTime)^2 instead of abs(sin(bobTime*2)) - same shape and period
    // (down-up-down-up once per full side-to-side cycle) but smooth at the
    // zero crossings instead of reversing direction instantly there.
    currentSwayY = (Math.sin(bobTime) ** 2) * amplitudeY;
    currentlyMoving = isMoving;

    camera.position.set(truePosition.x + currentSwayX, truePosition.y + currentSwayY, truePosition.z);
  }

  function dispose() {
    overlayElement.removeEventListener('click', onClick);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('pointerlockchange', onPointerLockChange);
  }

  function getYaw() {
    return yaw;
  }

  // The true, unswayed position - what movement/collision actually track
  // and what gets reported to the server (see gameScreen.js). Never
  // camera.position directly, which also carries the cosmetic sway offset.
  function getPosition() {
    return truePosition;
  }

  // This frame's sway offset (same values just applied to camera.position)
  // plus whether the player is currently moving - weapon.js uses both to
  // apply its own larger, independent sway to the held weapon (see
  // gameScreen.js's animate loop).
  function getSway() {
    return { x: currentSwayX, y: currentSwayY, isMoving: currentlyMoving };
  }

  // Snaps the player to a new position/facing without any of update()'s
  // normal movement/collision handling - used for a mid-match respawn (see
  // gameScreen.js's 'respawn' handler; Coop/Private only, see match.js).
  // Also resets the view bob's own clock/offsets so a respawn never
  // inherits a stale mid-cycle sway from wherever the camera was sitting
  // right before it died.
  function respawnTo(position, yawValue) {
    truePosition.set(position.x, position.y, position.z);
    yaw = yawValue;
    pitch = 0;
    bobTime = 0;
    currentSwayX = 0;
    currentSwayY = 0;
    verticalVelocity = 0;
    jumpOffset = 0;
    jumpRequested = false;
    crouchAmount = 0;
    camera.position.copy(truePosition);
  }

  // touchControls.js's virtual joystick output - x = strafe, y = forward,
  // each -1..1. See the deadzone merge in update() above.
  function setVirtualMoveInput(x, y) {
    virtualMoveX = x;
    virtualMoveY = y;
  }

  // touchControls.js's toggle-style Crouch button.
  function setVirtualCrouchHeld(held) {
    virtualCrouchHeld = held;
  }

  // touchControls.js's Jump button - same edge-triggered request the
  // keyboard's Space key uses (see onKeyDown), so a tap never double-queues.
  function requestJump() {
    jumpRequested = true;
  }

  // gameScreen.js's 'respawn-countdown'/'respawn' handlers - see
  // movementLocked above.
  function setMovementLocked(locked) {
    movementLocked = locked;
  }

  return {
    update, dispose, getYaw, getPosition, getSway, respawnTo, applyLookDelta,
    setVirtualMoveInput, setVirtualCrouchHeld, requestJump, setMovementLocked,
  };
}
