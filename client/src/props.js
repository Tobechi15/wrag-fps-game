import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Decorative set-dressing (CC0, Kenney's Platformer Kit) scattered near the
// map's existing cover (see map.js's WALLS) - purely visual. Already
// authored close to real-world scale (a crate is ~0.5m per side - checked
// against the source .glb's own bounding box), so no rescaling here.
// Deliberately NOT part of the wall collision system: these are small
// enough relative to the walls that clipping through one is a minor
// cosmetic gap for now, not a gameplay-affecting one - a real per-prop
// collider is a reasonable follow-up if that turns out to bother anyone in
// practice, but wasn't worth the added complexity for a first pass.
const PROP_URLS = {
  crate: '/assets/props/crate.glb',
  crateStrong: '/assets/props/crate-strong.glb',
  barrel: '/assets/props/barrel.glb',
  fenceStraight: '/assets/props/fence-straight.glb',
  fenceCorner: '/assets/props/fence-corner.glb',
  chest: '/assets/props/chest.glb',
};

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

// Fire-and-forget per prop - a slow/failed load for one placement just
// means that one prop doesn't appear, never blocks the rest of the scene
// (same "don't let one bad asset take down the whole page" principle as
// characterModel.js's preload).
export function createProps(scene) {
  for (const { prop, x, z, rotationY } of PLACEMENTS) {
    const url = PROP_URLS[prop];
    loader.load(
      url,
      (gltf) => {
        const model = gltf.scene;
        model.position.set(x, 0, z);
        model.rotation.y = rotationY;
        scene.add(model);
      },
      undefined,
      (err) => console.error(`Failed to load prop "${prop}" (${url}):`, err),
    );
  }
}
