import * as THREE from 'three';

const ZONE_RADIUS = 2;
// Must stay in sync with server/src/match/extraction.js's EXTRACTION_ZONES -
// see that file's own comment for why there are three now (was one) and how
// these were placed relative to the map's walls/spawn points.
const ZONE_POSITIONS = [
  new THREE.Vector3(0, 0, 4),
  new THREE.Vector3(20, 0, 20),
  new THREE.Vector3(-20, 0, -20),
];
// Coop's whole team shares one goal rather than needing several chokepoints
// spread across a battle-royale-sized lobby - must stay in sync with
// server/src/match/extraction.js's getZonesForMode (modes.js's
// singleExtractionZone), which restricts Coop to this same first zone.
function getZonePositions(playMode) {
  return playMode === 'coop' ? [ZONE_POSITIONS[0]] : ZONE_POSITIONS;
}
const ZONE_COLOR = 0x3399ff;
const ZONE_BANKED_FLASH_COLOR = 0x33ff66;
const ZONE_FLASH_DURATION_MS = 400;
// Mirrors server/src/match/extraction.js's REQUIRED_SECONDS_TO_BANK - purely
// cosmetic here (see createExtractionTracker below), never authoritative.
// The server independently derives its own dwell time from the position
// stream it already receives and is the only thing that actually decides
// when a bank happens (see flashZoneBanked's comment) - if this ever drifts
// out of sync with the server's real value, the progress indicator would
// just look slightly early/late, nothing more (it never gates anything).
const REQUIRED_SECONDS_TO_BANK = 3;

// Flat, semi-transparent circles on the ground marking where the player can
// "cash out" - one mesh per ZONE_POSITIONS entry. Purely visual - the
// server (not this client code) is what actually decides when a player has
// stood in one long enough to bank; see server/src/match/extraction.js and
// the comment on flashZoneBanked below. Returns the array of meshes (not
// just one) - callers that need "the" zone (flashZoneBanked) work out which
// one from a position, same as the server does.
export function createExtractionZone(scene, playMode) {
  return getZonePositions(playMode).map((zonePosition) => {
    const geometry = new THREE.CircleGeometry(ZONE_RADIUS, 32);
    const material = new THREE.MeshBasicMaterial({
      color: ZONE_COLOR,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2; // lay flat on the ground, like the ground plane
    mesh.position.copy(zonePosition).setY(0.02); // tiny offset avoids z-fighting with the ground
    scene.add(mesh);
    return mesh;
  });
}

// Called when the server tells us (via a 'banked' message) that this
// player's pot was just banked - never based on any local timer. Banking
// doesn't end the match (see server/src/match/match.js's bankCurrentPot),
// so this can fire multiple times per match. The server independently
// tracks zone dwell time from the position updates it already receives, so
// it can't be tricked by a client claiming "I banked." `zoneMeshes` is the
// array createExtractionZone returned; `position` (the player's true
// position at the moment of banking) picks out WHICH zone to flash - falls
// back to flashing all of them if none match closely enough (shouldn't
// happen in practice, since banking only ever fires while genuinely inside
// one, but a fallback beats silently flashing nothing).
export function flashZoneBanked(zoneMeshes, position) {
  const nearby = zoneMeshes.filter((mesh) => {
    const dx = position.x - mesh.position.x;
    const dz = position.z - mesh.position.z;
    return dx * dx + dz * dz <= ZONE_RADIUS ** 2;
  });
  const targets = nearby.length > 0 ? nearby : zoneMeshes;

  for (const mesh of targets) {
    mesh.material.color.setHex(ZONE_BANKED_FLASH_COLOR);
    setTimeout(() => {
      mesh.material.color.setHex(ZONE_COLOR);
    }, ZONE_FLASH_DURATION_MS);
  }
}

// True if the given (x,z) ground position is inside ANY extraction zone -
// same circle test server/src/match/extraction.js runs, just duplicated
// client-side for the status indicator below (see this project's
// already-documented "target/zone positions are duplicated" rough edge).
function isInZone(position, playMode) {
  return getZonePositions(playMode).some((zonePosition) => {
    const dx = position.x - zonePosition.x;
    const dz = position.z - zonePosition.z;
    return dx * dx + dz * dz <= ZONE_RADIUS ** 2;
  });
}

// A local, PURELY COSMETIC estimate of extraction progress, for the HUD
// indicator (see gameScreen.js) - never gates anything and is never trusted
// for the actual bank decision, which stays entirely server-side (see the
// module comment on flashZoneBanked). Deliberately simple: no lag
// compensation, no clamping to match the server's own MAX_DELTA_SECONDS -
// worst case this drifts a little from the server's real timer, which only
// ever shows up as the indicator filling slightly early/late, not as an
// actual gameplay effect.
export function createExtractionTracker(playMode) {
  let secondsInZone = 0;

  // Called every frame with the player's current TRUE (unswayed) position -
  // returns whether they're currently inside the zone and how far toward
  // banking they are (0-1), for the HUD to show/hide and fill accordingly.
  function update(position, deltaSeconds) {
    const inZone = isInZone(position, playMode);
    secondsInZone = inZone ? secondsInZone + deltaSeconds : 0;
    return { inZone, progress: Math.min(secondsInZone / REQUIRED_SECONDS_TO_BANK, 1) };
  }

  // Called when the server confirms an actual bank ('banked' message) - so
  // a rapid re-entry into the zone right after banking starts its progress
  // fresh from 0 instead of visually appearing to instantly refill.
  function reset() {
    secondsInZone = 0;
  }

  return { update, reset };
}
