import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { assetUrl } from './assetPath.js';

// Decorative set-dressing (CC0, Kenney's Platformer Kit) scattered near the
// map's existing cover (see map.js's WALLS) - purely visual. Already
// authored close to real-world scale (a crate is ~0.5m per side - checked
// against the source .glb's own bounding box), so no rescaling here.
// Deliberately NOT part of the wall collision system: these are small
// enough relative to the walls that clipping through one is a minor
// cosmetic gap for now, not a gameplay-affecting one - a real per-prop
// collider is a reasonable follow-up if that turns out to bother anyone in
// practice, but wasn't worth the added complexity for a first pass.
const PROP_URLS = Object.fromEntries(Object.entries({
  crate: '/assets/props/crate.glb',
  crateStrong: '/assets/props/crate-strong.glb',
  barrel: '/assets/props/barrel.glb',
  fenceStraight: '/assets/props/fence-straight.glb',
  fenceCorner: '/assets/props/fence-corner.glb',
  chest: '/assets/props/chest.glb',
}).map(([key, path]) => [key, assetUrl(path)]));

// Hand-placed next to (not inside) the cover pieces from map.js's WALLS,
// e.g. the west bunker at x:-8..-4,z:-2.5..0.5 gets a crate/barrel just
// outside its footprint - so movement/collision there is exactly the
// wall's AABB, unaffected by whatever a prop visually overlaps.
const PLACEMENTS = [
  { prop: 'crate', x: -9, z: -2, rotationY: 0.3 },
  { prop: 'barrel', x: -8.5, z: -0.5, rotationY: 1.1 },
  { prop: 'crateStrong', x: 8.5, z: -1.5, rotationY: -0.4 },
  { prop: 'barrel', x: 9, z: 0, rotationY: 2 },
  { prop: 'crate', x: -4.5, z: 5.5, rotationY: 0.8 },
  { prop: 'crate', x: 4.5, z: 5.5, rotationY: -0.8 },
  { prop: 'chest', x: 0, z: -10.5, rotationY: 0 },
  { prop: 'fenceStraight', x: -2.5, z: -9, rotationY: 0 },
  { prop: 'fenceCorner', x: 2.5, z: -9, rotationY: Math.PI / 2 },
];

const loader = new GLTFLoader();
const templatesByUrl = new Map();

function loadTemplate(url) {
  if (!templatesByUrl.has(url)) {
    templatesByUrl.set(url, new Promise((resolve) => {
      loader.load(
        url,
        (gltf) => resolve(gltf.scene),
        undefined,
        (err) => {
          console.error(`Failed to load prop model (${url}):`, err);
          templatesByUrl.delete(url);
          resolve(null);
        },
      );
    }));
  }
  return templatesByUrl.get(url);
}

// A slow/failed load for one placement just means that one prop doesn't
// appear, never blocks the rest of the scene (same "don't let one bad
// asset" principle - each unique model URL is fetched once, including
// across repeated placements and matches. Returns once all placements are
// either added or skipped because their model failed to load.
export async function createProps(scene) {
  const templates = new Map(await Promise.all(
    [...new Set(PLACEMENTS.map(({ prop }) => PROP_URLS[prop]))]
      .map(async (url) => [url, await loadTemplate(url)]),
  ));

  for (const { prop, x, z, rotationY } of PLACEMENTS) {
    const template = templates.get(PROP_URLS[prop]);
    if (!template) continue;
    const model = template.clone(true);
    model.position.set(x, 0, z);
    model.rotation.y = rotationY;
    scene.add(model);
  }
}
