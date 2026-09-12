import * as THREE from 'three';

// The map's solid geometry, rendered here and collided against in
// player.js. An OPEN arena - no perimeter/boundary walls - with a handful
// of standalone obstacles for cover; the open space beyond them is dressed
// with nature.js instead of walled off. Must stay in sync with
// server/src/map/walls.js's WALLS - same reason targets.js must stay in
// sync with hitRegistration.js's TARGETS (two separate projects, no shared
// package). See that file's layout comment for the design (a center
// complex plus an outer ring of cover near the now-much-farther-out
// SPAWN_POINTS) - the world origin (0,0) is deliberately left clear since
// every player's camera starts there (see player.js) before their first
// position update reaches the server.
export const WALLS = [
  { x: -6, z: -1, width: 4, depth: 3, height: 2.5 },
  { x: 6, z: -1, width: 4, depth: 3, height: 2.5 },

  { x: -1.5, z: -1, width: 1, depth: 1, height: 2.5 },
  { x: 1.5, z: -1, width: 1, depth: 1, height: 2.5 },

  { x: -5, z: -5, width: 1, depth: 4, height: 2.5 },
  { x: 5, z: -5, width: 1, depth: 4, height: 2.5 },

  { x: -4, z: 6, width: 3, depth: 2, height: 2 },
  { x: 4, z: 6, width: 3, depth: 2, height: 2 },

  { x: -14, z: -14, width: 4, depth: 3, height: 2.5 },
  { x: 14, z: -14, width: 4, depth: 3, height: 2.5 },
  { x: -14, z: 14, width: 4, depth: 3, height: 2.5 },
  { x: 14, z: 14, width: 4, depth: 3, height: 2.5 },

  { x: -3, z: -16, width: 2, depth: 2, height: 2 },
  { x: 3, z: -16, width: 2, depth: 2, height: 2 },
  { x: -3, z: 16, width: 2, depth: 2, height: 2 },
  { x: 3, z: 16, width: 2, depth: 2, height: 2 },
  { x: -16, z: -3, width: 2, depth: 2, height: 2 },
  { x: -16, z: 3, width: 2, depth: 2, height: 2 },
  { x: 16, z: -3, width: 2, depth: 2, height: 2 },
  { x: 16, z: 3, width: 2, depth: 2, height: 2 },
];

const COVER_COLOR = 0x555a63;
const STRIPE_COLOR = 0xff6a3d; // matches theme.css's --color-accent

// Builds a Mesh per wall and adds it to the scene - a tactical grey with a
// thin glowing accent stripe near the top, echoing the site's "premium
// dark tactical" theme. Returns the meshes in case something later wants
// to raycast against them (not required for gameplay - hit registration is
// server-authoritative - but kept for parity with targets.js).
export function createMap(scene) {
  const meshes = [];

  for (const wall of WALLS) {
    const geometry = new THREE.BoxGeometry(wall.width, wall.height, wall.depth);
    const material = new THREE.MeshStandardMaterial({
      color: COVER_COLOR,
      roughness: 0.8,
      metalness: 0.2,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(wall.x, wall.height / 2, wall.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    meshes.push(mesh);

    const stripeGeometry = new THREE.BoxGeometry(wall.width + 0.05, 0.15, wall.depth + 0.05);
    const stripeMaterial = new THREE.MeshStandardMaterial({
      color: STRIPE_COLOR,
      emissive: STRIPE_COLOR,
      emissiveIntensity: 0.5,
    });
    const stripe = new THREE.Mesh(stripeGeometry, stripeMaterial);
    stripe.position.set(wall.x, wall.height - 0.1, wall.z);
    scene.add(stripe);
    meshes.push(stripe);
  }

  return meshes;
}

// Circular obstacles contributed at runtime by nature.js once it's actually
// placed its trees/rocks (their positions are randomized per page load, so
// unlike WALLS there's no fixed list to hand-author) - each is
// { x, z, radius }. A plain mutable array, not a full module of its own,
// since map.js is already the single collision authority both WALLS and
// this get checked against together in collidesAt below.
export const dynamicObstacles = [];

function collidesAt(x, z, radius) {
  const collidesWithWall = WALLS.some((wall) => (
    Math.abs(x - wall.x) < wall.width / 2 + radius
    && Math.abs(z - wall.z) < wall.depth / 2 + radius
  ));
  if (collidesWithWall) return true;

  return dynamicObstacles.some((obstacle) => {
    const dx = x - obstacle.x;
    const dz = z - obstacle.z;
    return dx * dx + dz * dz < (obstacle.radius + radius) ** 2;
  });
}

// Applies a desired X/Z movement delta to a position, sliding along walls
// instead of passing through them: each axis is tried independently, so
// bumping into a wall at an angle still lets you slide along its face
// rather than stopping dead. Purely a local movement feel concern - the
// server never validates a player's claimed position against these walls
// (see the project's server-authority pattern doc: movement stays
// client-predicted), it only checks a shot's origin against last-known
// position.
export function moveWithCollision(position, deltaX, deltaZ, radius) {
  let { x, z } = position;

  const nextX = x + deltaX;
  if (!collidesAt(nextX, z, radius)) x = nextX;

  const nextZ = z + deltaZ;
  if (!collidesAt(x, nextZ, radius)) z = nextZ;

  return { x, z };
}
