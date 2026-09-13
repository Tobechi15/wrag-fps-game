import * as THREE from 'three';

// Reused across every shot instead of allocating new ones each click.
const raycaster = new THREE.Raycaster();
const SCREEN_CENTER = new THREE.Vector2(0, 0); // NDC (0,0) = dead center = crosshair

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
//
// magazineSize/reloadDurationMs/fireCooldownMs come from the CALLER
// (gameScreen.js, reading weapon.js's resolved GUN_VARIANTS entry for
// whatever gun this player is actually holding) rather than being fixed
// constants here - a bigger gun takes longer to empty (bigger magazine)
// AND longer to physically reload, and rate of fire (fireCooldownMs, the
// minimum time between shots) is its own per-weapon "lethality" knob on
// top of that - an assault rifle and a bolt-action sniper shouldn't be
// spammable at the same speed just because the player can click/tap that
// fast.
export function createShootingSystem(camera, targets, domElement, {
  onLocalHit, onFire, onDryFire, onReloadStart, onReloadEnd, onAmmoChange, magazineSize, reloadDurationMs, fireCooldownMs,
}) {
  // Set while waiting to respawn (see gameScreen.js's 'respawn-countdown'/
  // 'respawn' handlers) - a "dead" player shouldn't be able to keep firing
  // during the delay. Checked in fire() itself so both the mouse path below
  // and touchControls.js's Fire button (which calls fire() directly) are
  // covered by one gate.
  let locked = false;

  let ammoInMag = magazineSize;
  let isReloading = false;
  let reloadTimeoutId = null;
  // Rate-of-fire gate - the mechanical cycle time real held-trigger
  // weapons enforce whether or not the player's own click/tap rate would
  // allow faster. -Infinity so the very first shot of a match is never
  // blocked waiting on a cooldown that hasn't started yet.
  let lastFireAt = -Infinity;

  // Reports the current ammo count to the HUD (see gameScreen.js's
  // #ammo-count) - called once up front so the display never shows a
  // stale/placeholder value, then again every time ammoInMag actually
  // changes (a shot, a reload finishing, or a reset - never on the
  // "reload denied, already full" no-op paths below, since nothing
  // changed there).
  function reportAmmo() {
    onAmmoChange(ammoInMag, magazineSize);
  }
  reportAmmo();

  function startReload() {
    isReloading = true;
    onReloadStart(reloadDurationMs);
    reloadTimeoutId = setTimeout(() => {
      isReloading = false;
      ammoInMag = magazineSize;
      reloadTimeoutId = null;
      onReloadEnd();
      reportAmmo();
    }, reloadDurationMs);
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
    ammoInMag = magazineSize;
    reportAmmo();
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
    // Firing faster than this gun's mechanical cycle time allows - a
    // silent no-op, not a dry-fire click (there's ammo, the trigger just
    // hasn't reset yet - a real gun doesn't make an "I'm too fast" sound
    // either, it just doesn't fire again yet).
    const now = performance.now();
    if (now - lastFireAt < fireCooldownMs) return;
    lastFireAt = now;

    raycaster.setFromCamera(SCREEN_CENTER, camera);
    onFire(raycaster.ray.origin, raycaster.ray.direction);

    const intersections = raycaster.intersectObjects(targets);
    if (intersections.length > 0) {
      onLocalHit(intersections[0].object);
    }

    ammoInMag -= 1;
    reportAmmo();
    if (ammoInMag <= 0) startReload();
  }

  // Manual reload, "at your own convenience" - unlike the automatic
  // reload above (only ever triggered by emptying the mag on a shot), this
  // can fire with any partial mag, not just an empty one. Two guards, both
  // just no-ops (no sound, no animation) rather than errors: already
  // reloading (can't double-reload), and already full (nothing to do -
  // playing the reload sound/animation over an unchanged full mag would
  // just be confusing, not a real action).
  function reload() {
    if (locked || isReloading || ammoInMag >= magazineSize) return;
    startReload();
  }

  function onMouseDown(event) {
    const isLeftClick = event.button === 0;
    const isPointerLocked = document.pointerLockElement === domElement;
    if (!isLeftClick || !isPointerLocked) return;
    fire();
  }

  // Keyboard reload (desktop) - 'R', gated on pointer lock the same way
  // the mouse's fire path is, so it only ever does anything while actually
  // in the gameplay view (not, say, while the click-to-play overlay is
  // still showing pre-lock).
  function onKeyDown(event) {
    if (event.code !== 'KeyR') return;
    if (document.pointerLockElement !== domElement) return;
    reload();
  }

  domElement.addEventListener('mousedown', onMouseDown);
  document.addEventListener('keydown', onKeyDown);

  function dispose() {
    domElement.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('keydown', onKeyDown);
    clearTimeout(reloadTimeoutId);
  }

  function setLocked(value) {
    locked = value;
    if (value) resetAmmo(); // entering the respawn-lock window - see resetAmmo's own comment
  }

  return {
    dispose, fire, reload, setLocked,
  };
}
