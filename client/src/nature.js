import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { WALLS, dynamicObstacles } from './map.js';

// Environmental dressing (CC0, "Stylized Nature MegaKit" by Quaternius)
// scattered across the whole arena - now that map.js's WALLS is just a
// handful of standalone tactical obstacles (no perimeter/boundary walls),
// this is what makes it read as an open arena with a real backdrop instead
// of a bare green plane. Placement steers clear of things it would look
// wrong overlapping: the tactical obstacles themselves, the static
// targets, the extraction zone, the world origin (every player's camera
// starts there client-side, see player.js, before their first position
// update reaches the server), and the spawn points.
//
// Trees and rocks get a real (if approximate) collision radius - pushed
// into map.js's dynamicObstacles once actually placed, since (unlike
// WALLS) their positions are randomized per page load rather than fixed,
// so there's nothing to hand-author collision boxes for ahead of time. A
// tree's collider is much smaller than its visual canopy (trunk-only, so
// you can still walk near/under branches, not the whole leafy spread);
// grass and bushes stay walk-through, same as real grass.
//
// Already authored close to real-world scale for trees/rocks (a tree is
// ~6.5m tall - checked against the source .gltf's own bounding box), so no
// rescaling for those; grass is scaled down some (see GRASS_SCALE_RANGE) -
// its raw authored height reads more like reeds than lawn grass otherwise.
const PROP_URLS = {
  tree1: '/assets/nature/CommonTree_1.gltf',
  tree2: '/assets/nature/CommonTree_2.gltf',
  tree3: '/assets/nature/CommonTree_3.gltf',
  tree4: '/assets/nature/CommonTree_4.gltf',
  tree5: '/assets/nature/CommonTree_5.gltf',
  pine1: '/assets/nature/Pine_1.gltf',
  pine2: '/assets/nature/Pine_2.gltf',
  pine3: '/assets/nature/Pine_3.gltf',
  rock1: '/assets/nature/Rock_Medium_1.gltf',
  rock2: '/assets/nature/Rock_Medium_2.gltf',
  rock3: '/assets/nature/Rock_Medium_3.gltf',
  bush: '/assets/nature/Bush_Common.gltf',
  grassCommonShort: '/assets/nature/Grass_Common_Short.gltf',
  grassCommonTall: '/assets/nature/Grass_Common_Tall.gltf',
  grassWispyShort: '/assets/nature/Grass_Wispy_Short.gltf',
  grassWispyTall: '/assets/nature/Grass_Wispy_Tall.gltf',
};

const TREE_KEYS = new Set(['tree1', 'tree2', 'tree3', 'tree4', 'tree5', 'pine1', 'pine2', 'pine3']);
const ROCK_KEYS = new Set(['rock1', 'rock2', 'rock3']);
const GRASS_KEYS = new Set(['grassCommonShort', 'grassCommonTall', 'grassWispyShort', 'grassWispyTall']);

const TREE_COLLISION_RADIUS = 0.4; // trunk-only - the canopy overhead is walkable under
const ROCK_COLLISION_RADIUS = 0.8;
const NORMAL_SCALE_RANGE = [0.85, 1.2]; // a little size variety so it doesn't read as obviously copy-pasted
const GRASS_SCALE_RANGE = [0.4, 0.65]; // this pack's grass is authored tall enough to read as reeds at full scale

const PROP_KEYS = Object.keys(PROP_URLS);

const SCATTER_EXTENT = 48; // stay inside the 100x100 ground plane (see scene.js), leaving a small margin at the very edge
const PROP_COUNT = 260; // more than before - the playable area is much bigger now, and grass wants real density

// Must stay in sync with hitRegistration.js's TARGETS / server/src/match/
// extraction.js's EXTRACTION_ZONE / match.js's SPAWN_POINTS (same
// duplication pattern as WALLS) - only x/z matter here, purely to keep
// decoration from overlapping them.
const TARGET_POSITIONS = [{ x: -3, z: -6 }, { x: 0, z: -8 }, { x: 3, z: -6 }];
const EXTRACTION_ZONE = { x: 0, z: 4, radius: 2 };
const SPAWN_POINTS = [
  { x: -28, z: -28 }, { x: 28, z: -28 }, { x: -28, z: 28 }, { x: 28, z: 28 },
  { x: 0, z: -35 }, { x: 0, z: 35 }, { x: -35, z: 0 }, { x: 35, z: 0 },
];

const WALL_CLEARANCE = 1.5;
const TARGET_CLEARANCE = 2;
const EXTRACTION_CLEARANCE = 1.5;
const ORIGIN_CLEARANCE = 3;
const SPAWN_CLEARANCE = 3;

function distance2D(ax, az, bx, bz) {
  return Math.hypot(ax - bx, az - bz);
}

function isInExclusionZone(x, z) {
  for (const wall of WALLS) {
    if (Math.abs(x - wall.x) < wall.width / 2 + WALL_CLEARANCE
      && Math.abs(z - wall.z) < wall.depth / 2 + WALL_CLEARANCE) return true;
  }
  for (const target of TARGET_POSITIONS) {
    if (distance2D(x, z, target.x, target.z) < TARGET_CLEARANCE) return true;
  }
  if (distance2D(x, z, EXTRACTION_ZONE.x, EXTRACTION_ZONE.z) < EXTRACTION_ZONE.radius + EXTRACTION_CLEARANCE) return true;
  if (distance2D(x, z, 0, 0) < ORIGIN_CLEARANCE) return true;
  for (const spawn of SPAWN_POINTS) {
    if (distance2D(x, z, spawn.x, spawn.z) < SPAWN_CLEARANCE) return true;
  }
  return false;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function pickScatterPosition() {
  let x;
  let z;
  do {
    x = randomBetween(-SCATTER_EXTENT, SCATTER_EXTENT);
    z = randomBetween(-SCATTER_EXTENT, SCATTER_EXTENT);
  } while (isInExclusionZone(x, z));
  return { x, z };
}

const loader = new GLTFLoader();

// Loads each distinct prop file exactly once (not once per placement -
// PROP_COUNT scattered instances all clone from these same templates, the
// same "load once, clone many" approach as characterModel.js, just without
// needing SkeletonUtils since none of these are skinned/animated).
function loadTemplates() {
  return Promise.all(
    PROP_KEYS.map((key) => new Promise((resolve) => {
      loader.load(
        PROP_URLS[key],
        (gltf) => resolve([key, gltf.scene]),
        undefined,
        (err) => {
          console.error(`Failed to load nature prop "${key}":`, err);
          resolve([key, null]);
        },
      );
    })),
  ).then((entries) => Object.fromEntries(entries));
}

export async function createNature(scene) {
  // dynamicObstacles is a module-level singleton in map.js, so a fresh
  // match calling createNature() again must clear out the previous
  // match's tree/rock colliders first - otherwise they'd accumulate
  // forever across matches in the same tab, eventually leaving invisible
  // collision blobs from scenery that isn't there anymore.
  dynamicObstacles.length = 0;

  const templates = await loadTemplates();

  for (let i = 0; i < PROP_COUNT; i++) {
    const key = PROP_KEYS[Math.floor(Math.random() * PROP_KEYS.length)];
    const template = templates[key];
    if (!template) continue; // that one prop's load failed - skip this placement, not the whole scatter

    const { x, z } = pickScatterPosition();
    const isGrass = GRASS_KEYS.has(key);
    const [scaleMin, scaleMax] = isGrass ? GRASS_SCALE_RANGE : NORMAL_SCALE_RANGE;
    const scale = randomBetween(scaleMin, scaleMax);

    const model = template.clone(true);
    model.position.set(x, 0, z);
    model.rotation.y = randomBetween(0, Math.PI * 2);
    model.scale.setScalar(scale);
    scene.add(model);

    if (TREE_KEYS.has(key)) {
      dynamicObstacles.push({ x, z, radius: TREE_COLLISION_RADIUS * scale });
    } else if (ROCK_KEYS.has(key)) {
      dynamicObstacles.push({ x, z, radius: ROCK_COLLISION_RADIUS * scale });
    }
  }
}
