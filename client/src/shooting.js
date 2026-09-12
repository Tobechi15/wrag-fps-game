import * as THREE from 'three';

// Reused across every shot instead of allocating new ones each click.
const raycaster = new THREE.Raycaster();
const SCREEN_CENTER = new THREE.Vector2(0, 0); // NDC (0,0) = dead center = crosshair

// One universal magazine size/reload time regardless of gun variant - this
// project has no per-weapon ammo tuning yet (weapon.js's GUN_VARIANTS only
// differ in visual model/scale), so a single shared value is the whole
// scope here rather than inventing a per-gun system nothing else needs yet.
const MAGAZINE_SIZE = 8;
const RELOAD_DURATION_MS = 1800;

// Wires up "click to fire". On every left-click while the mouse is locked,
// two things happen:
//   1. A LOCAL raycast against the visible target meshes runs immediately,
//      purely so the target can flash the instant you click - this is
//      client-side prediction for responsiveness, nothing more.
//   2. The same ray (origin + direction) is reported via onFire on EVERY
//      shot, hit or miss. The server independently re-runs this raycast
//      against its own authoritative target list and decides for itself
//      whether it was a hit and whether the pot changes - see
//      server/src/index.js. The local flash in step (1) is only ever a
//      prediction; the real outcome comes back over the network.
//
// Magazine/reload is entirely CLIENT-SIDE and cosmetic-ish (like the local
// hit-flash prediction above) - the server has no concept of ammo at all
// and will happily process a 'shoot' message any time this client sends
// one. This only gates whether fire() ever SENDS that message in the first
// place; it's a fairness/feel feature (no infinite full-auto with no
// downside), not a server-enforced rule, matching this project's existing
// split between client-predicted feel and server-authoritative outcomes.
export function createShootingSystem(camera, targets, domElement, {
  onLocalHit, onFire, onDryFire, onReloadStart, onReloadEnd,
}) {
  // Set while waiting to respawn (see gameScreen.js's 'respawn-countdown'/
  // 'respawn' handlers) - a "dead" player shouldn't be able to keep firing
  // during the delay. Checked in fire() itself so both the mouse path below
  // and touchControls.js's Fire button (which calls fire() directly) are
  // covered by one gate.
  let locked = false;

  let ammoInMag = MAGAZINE_SIZE;
  let isReloading = false;
  let reloadTimeoutId = null;

  function startReload() {
    isReloading = true;
    onReloadStart(RELOAD_DURATION_MS);
    reloadTimeoutId = setTimeout(() => {
      isReloading = false;
      ammoInMag = MAGAZINE_SIZE;
      reloadTimeoutId = null;
      onReloadEnd();
    }, RELOAD_DURATION_MS);
  }

  // Cancels any in-progress reload and resets to a full magazine - called
  // whenever this player's own life ends (see setLocked below), so a fresh
  // respawn/new match always starts with a full mag instead of picking up
  // wherever the last life's reload cycle happened to be.
  function resetAmmo() {
    clearTimeout(reloadTimeoutId);
    reloadTimeoutId = null;
    if (isReloading) {
      isReloading = false;
      onReloadEnd();
    }
    ammoInMag = MAGAZINE_SIZE;
  }

  // The actual raycast-and-report logic, shared by the mouse path below
  // (gated on pointer lock) and touchControls.js's Fire button (which calls
  // this directly - Pointer Lock is unreliable on mobile Safari, so mobile
  // has no lock to gate on in the first place).
  function fire() {
    if (locked) return;
    if (isReloading) {
      onDryFire(); // the empty-mag click sound - no shot, no ammo change, nothing sent to the server
      return;
    }

    raycaster.setFromCamera(SCREEN_CENTER, camera);
    onFire(raycaster.ray.origin, raycaster.ray.direction);

    const intersections = raycaster.intersectObjects(targets);
    if (intersections.length > 0) {
      onLocalHit(intersections[0].object);
    }

    ammoInMag -= 1;
    if (ammoInMag <= 0) startReload();
  }

  function onMouseDown(event) {
    const isLeftClick = event.button === 0;
    const isPointerLocked = document.pointerLockElement === domElement;
    if (!isLeftClick || !isPointerLocked) return;
    fire();
  }

  domElement.addEventListener('mousedown', onMouseDown);

  function dispose() {
    domElement.removeEventListener('mousedown', onMouseDown);
    clearTimeout(reloadTimeoutId);
  }

  function setLocked(value) {
    locked = value;
    if (value) resetAmmo(); // entering the respawn-lock window - see resetAmmo's own comment
  }

  return {
    dispose, fire, setLocked,
  };
}
