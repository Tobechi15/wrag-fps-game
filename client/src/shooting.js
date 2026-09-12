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
export function createShootingSystem(camera, targets, domElement, { onLocalHit, onFire }) {
  // Set while waiting to respawn (see gameScreen.js's 'respawn-countdown'/
  // 'respawn' handlers) - a "dead" player shouldn't be able to keep firing
  // during the delay. Checked in fire() itself so both the mouse path below
  // and touchControls.js's Fire button (which calls fire() directly) are
  // covered by one gate.
  let locked = false;

  // The actual raycast-and-report logic, shared by the mouse path below
  // (gated on pointer lock) and touchControls.js's Fire button (which calls
  // this directly - Pointer Lock is unreliable on mobile Safari, so mobile
  // has no lock to gate on in the first place).
  function fire() {
    if (locked) return;
    raycaster.setFromCamera(SCREEN_CENTER, camera);
    onFire(raycaster.ray.origin, raycaster.ray.direction);

    const intersections = raycaster.intersectObjects(targets);
    if (intersections.length > 0) {
      onLocalHit(intersections[0].object);
    }
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
  }

  function setLocked(value) {
    locked = value;
  }

  return { dispose, fire, setLocked };
}
