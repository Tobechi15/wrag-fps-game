import { rayIntersectsBox } from '../map/geometry.js';

// Must stay in sync with client/src/targets.js (see the comment there and
// in README.md about this known duplication).
export const TARGETS = [
  { center: { x: -3, y: 1, z: -6 }, halfExtents: { x: 0.5, y: 1, z: 0.5 } },
  { center: { x: 0, y: 1, z: -8 }, halfExtents: { x: 0.5, y: 1, z: 0.5 } },
  { center: { x: 3, y: 1, z: -6 }, halfExtents: { x: 0.5, y: 1, z: 0.5 } },
];

// A player/bot hitbox must match the capsule rendered client-side (see
// client/src/remotePlayers.js's CAPSULE_RADIUS/CAPSULE_CENTER_Y) - centered
// on the ground, not at the tracked eye-height position. Real players and
// bots use the same capsule shape, so the same hitbox applies to both.
const ENTITY_HITBOX_HALF_EXTENTS = { x: 0.3, y: 0.85, z: 0.3 };
const ENTITY_HITBOX_CENTER_Y = 0.85;

// Finds the closest STATIC target dummy a given ray hits, if any. Returns
// { target, distance } or null. This is what makes hit registration
// server-authoritative: the client tells us where it fired from and in
// what direction, but WE decide whether that counts as a hit - never the
// client's own raycast result.
export function findClosestHitTarget(origin, direction) {
  let closestDistance = Infinity;
  let closestTarget = null;

  for (const target of TARGETS) {
    const boxMin = {
      x: target.center.x - target.halfExtents.x,
      y: target.center.y - target.halfExtents.y,
      z: target.center.z - target.halfExtents.z,
    };
    const boxMax = {
      x: target.center.x + target.halfExtents.x,
      y: target.center.y + target.halfExtents.y,
      z: target.center.z + target.halfExtents.z,
    };

    const distance = rayIntersectsBox(origin, direction, boxMin, boxMax);
    if (distance !== null && distance < closestDistance) {
      closestDistance = distance;
      closestTarget = target;
    }
  }

  return closestTarget ? { target: closestTarget, distance: closestDistance } : null;
}

// Finds the closest PLAYER OR BOT a given ray hits, if any, out of the
// provided list of currently-alive entities (`entities`: array of
// { id, position }) - real players and bots share the same hitbox, so the
// caller doesn't need to distinguish them here (match.js decides what a hit
// on a given id means). Returns { id, distance } or null.
export function findClosestHitEntity(origin, direction, entities) {
  let closestDistance = Infinity;
  let closestId = null;

  for (const entity of entities) {
    const boxMin = {
      x: entity.position.x - ENTITY_HITBOX_HALF_EXTENTS.x,
      y: ENTITY_HITBOX_CENTER_Y - ENTITY_HITBOX_HALF_EXTENTS.y,
      z: entity.position.z - ENTITY_HITBOX_HALF_EXTENTS.z,
    };
    const boxMax = {
      x: entity.position.x + ENTITY_HITBOX_HALF_EXTENTS.x,
      y: ENTITY_HITBOX_CENTER_Y + ENTITY_HITBOX_HALF_EXTENTS.y,
      z: entity.position.z + ENTITY_HITBOX_HALF_EXTENTS.z,
    };

    const distance = rayIntersectsBox(origin, direction, boxMin, boxMax);
    if (distance !== null && distance < closestDistance) {
      closestDistance = distance;
      closestId = entity.id;
    }
  }

  return closestId ? { id: closestId, distance: closestDistance } : null;
}
