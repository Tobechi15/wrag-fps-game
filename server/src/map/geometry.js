// Low-level ray/segment-vs-box math shared by hit registration (rays with
// unbounded length, we want the hit distance) and the map/nav systems
// (bounded segments between two points, we only care whether anything is in
// the way). Both reduce to the same slab-method AABB test - separated out
// here instead of living only in hitRegistration.js since the map/nav code
// needs it too.

// Ray-AABB intersection using the slab method. Returns the distance along
// the ray to the closest intersection, or null if it misses.
export function rayIntersectsBox(origin, direction, boxMin, boxMax) {
  let tMin = -Infinity;
  let tMax = Infinity;

  for (const axis of ['x', 'y', 'z']) {
    const o = origin[axis];
    const d = direction[axis];
    const min = boxMin[axis];
    const max = boxMax[axis];

    if (Math.abs(d) < 1e-8) {
      if (o < min || o > max) return null; // ray parallel to this axis, outside the slab
      continue;
    }

    let t1 = (min - o) / d;
    let t2 = (max - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  if (tMax < 0) return null; // box is entirely behind the ray origin
  return tMin >= 0 ? tMin : tMax;
}

// Whether the straight ground-level segment between two points passes
// through a box - same slab test, but bounded to t in [0, 1] instead of a
// one-directional ray, and only checked in the X/Z plane (walls are treated
// as floor-to-ceiling blockers for this purpose, so Y never matters for line
// of sight / pathing - only rayIntersectsBox's shot-occlusion caller cares
// about Y).
export function segmentIntersectsBoxXZ(pointA, pointB, boxMin, boxMax) {
  let tMin = 0;
  let tMax = 1;

  for (const axis of ['x', 'z']) {
    const o = pointA[axis];
    const d = pointB[axis] - pointA[axis];
    const min = boxMin[axis];
    const max = boxMax[axis];

    if (Math.abs(d) < 1e-8) {
      if (o < min || o > max) return false;
      continue;
    }

    let t1 = (min - o) / d;
    let t2 = (max - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }

  return true;
}
