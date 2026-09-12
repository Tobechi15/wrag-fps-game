import { rayIntersectsBox, segmentIntersectsBoxXZ } from './geometry.js';

// The map's solid geometry: an OPEN arena (no perimeter/boundary walls -
// see nature.js on the client for how the open space beyond the tactical
// obstacles is dressed instead) with a handful of standalone obstacles for
// cover. Every wall is an axis-aligned box, given as its center (x, z) plus
// full width (X), depth (Z), and height (Y) - walls sit on the ground, so
// their Y range is always [0, height]. Must stay in sync with
// client/src/map.js's WALLS (same reason hitRegistration.js's TARGETS must
// stay in sync with client/src/targets.js - two separate projects, no
// shared package).
//
// Layout: a contested CENTER (open "target range" to the north - targets
// already live at z -6..-8 - and open "extraction point" to the south,
// extraction zone centered at z=4) made of two side bunkers, a pair of
// chokepoint walls, and two small center pillars, deliberately leaving the
// exact world origin (0,0) clear since a real player's camera always
// starts there client-side (see player.js) before their first position
// update reaches the server - PLUS, now that match.js's SPAWN_POINTS are
// spread much farther out (a "big map"), an outer ring of cover so the
// long approach from spawn to center isn't empty: one small outpost near
// each corner spawn, and a pair of cover pieces on each cardinal approach
// lane (north/south/east/west) roughly a third of the way in.
export const WALLS = [
  // Side bunkers flanking the center.
  { x: -6, z: -1, width: 4, depth: 3, height: 2.5 },
  { x: 6, z: -1, width: 4, depth: 3, height: 2.5 },

  // Small center pillars either side of the origin - cover for the
  // mid-map lane without blocking it outright.
  { x: -1.5, z: -1, width: 1, depth: 1, height: 2.5 },
  { x: 1.5, z: -1, width: 1, depth: 1, height: 2.5 },

  // Chokepoint walls between the center and the target range - the lane
  // straight through the middle (x near 0) stays open between them.
  { x: -5, z: -5, width: 1, depth: 4, height: 2.5 },
  { x: 5, z: -5, width: 1, depth: 4, height: 2.5 },

  // Cover flanking the extraction zone (center 0,4 radius 2) on the
  // approach from the south.
  { x: -4, z: 6, width: 3, depth: 2, height: 2 },
  { x: 4, z: 6, width: 3, depth: 2, height: 2 },

  // Outposts near each corner spawn (see match.js's SPAWN_POINTS at
  // (+-28,+-28)) - somewhere to take cover the moment a fight starts near
  // spawn, well clear of the center complex.
  { x: -14, z: -14, width: 4, depth: 3, height: 2.5 },
  { x: 14, z: -14, width: 4, depth: 3, height: 2.5 },
  { x: -14, z: 14, width: 4, depth: 3, height: 2.5 },
  { x: 14, z: 14, width: 4, depth: 3, height: 2.5 },

  // Cover pairs along each cardinal approach lane (north/south/east/west
  // edge spawns are at +-35 - see match.js), roughly midway between an
  // edge spawn and the center, flanking the lane rather than blocking it.
  { x: -3, z: -16, width: 2, depth: 2, height: 2 },
  { x: 3, z: -16, width: 2, depth: 2, height: 2 },
  { x: -3, z: 16, width: 2, depth: 2, height: 2 },
  { x: 3, z: 16, width: 2, depth: 2, height: 2 },
  { x: -16, z: -3, width: 2, depth: 2, height: 2 },
  { x: -16, z: 3, width: 2, depth: 2, height: 2 },
  { x: 16, z: -3, width: 2, depth: 2, height: 2 },
  { x: 16, z: 3, width: 2, depth: 2, height: 2 },
];

function wallBoundsXZ(wall) {
  return {
    min: { x: wall.x - wall.width / 2, z: wall.z - wall.depth / 2 },
    max: { x: wall.x + wall.width / 2, z: wall.z + wall.depth / 2 },
  };
}

function wallBounds3D(wall) {
  return {
    min: { x: wall.x - wall.width / 2, y: 0, z: wall.z - wall.depth / 2 },
    max: { x: wall.x + wall.width / 2, y: wall.height, z: wall.z + wall.depth / 2 },
  };
}

// Closest wall a ray hits, if any - used to make shots stop at walls
// instead of passing through them (see match.js's handleShoot: a target or
// entity only counts as hit if it's closer than this).
export function findClosestWallHit(origin, direction) {
  let closestDistance = Infinity;
  let hit = false;
  for (const wall of WALLS) {
    const { min, max } = wallBounds3D(wall);
    const distance = rayIntersectsBox(origin, direction, min, max);
    if (distance !== null && distance < closestDistance) {
      closestDistance = distance;
      hit = true;
    }
  }
  return hit ? { distance: closestDistance } : null;
}

// Whether a straight ground-level line between two points is unobstructed -
// used both for a bot's line of sight to a player (bots/bot.js) and to
// decide which nav-graph edges are actually walkable (map/navGraph.js).
export function isPathClear(pointA, pointB) {
  for (const wall of WALLS) {
    const { min, max } = wallBoundsXZ(wall);
    if (segmentIntersectsBoxXZ(pointA, pointB, min, max)) return false;
  }
  return true;
}
