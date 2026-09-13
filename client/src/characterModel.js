import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { assetUrl } from './assetPath.js';

// Real, animated character models (CC0, "Ultimate Modular Men" by
// Quaternius) - each a single self-contained .gltf (embedded base64
// buffer, flat solid-color materials, no separate texture files, so
// there's nothing to go stale/broken here). Copied into public/ so Vite
// serves them verbatim at a stable URL in both dev and a production
// build. Already authored close to real-world scale with feet at y=0
// (checked against the source .gltf's own bounding box - head tops out
// around y=1.85), so no rescaling here.
//
// Every variant ships the same 24 animation clips (Idle_Gun, Walk, Run,
// Death, HitRecieve, etc. - see remotePlayers.js for how they're driven),
// so swapping between them is just picking a different key - nothing else
// about how a character is animated/positioned changes.
export const CHARACTER_VARIANTS = ['Swat', 'Punk', 'Worker', 'Casual_2'];
export const DEFAULT_CHARACTER_VARIANT = 'Swat';

function urlFor(variant) {
  return assetUrl(`/assets/characters/${variant}.gltf`);
}

const loader = new GLTFLoader();
const templates = {}; // variant -> { scene, clips }, never added to a live scene directly - only ever cloned from
const loadPromises = {};

function loadVariant(variant) {
  if (!loadPromises[variant]) {
    loadPromises[variant] = new Promise((resolve) => {
      loader.load(
        urlFor(variant),
        (gltf) => {
          templates[variant] = { scene: gltf.scene, clips: gltf.animations };
          resolve();
        },
        undefined,
        (err) => {
          console.error(`Failed to load character model "${variant}":`, err);
          resolve(); // a failed load shouldn't block the rest of the app - remotePlayers.js falls back to a placeholder capsule
        },
      );
    });
  }
  return loadPromises[variant];
}

// Kicks off loading every variant - call once, as early as possible (see
// app.js), so they're very likely ready before a match actually starts
// (matchmaking/lobby time gives this a real head start). Preloading all of
// them (not just the local player's own pick) is necessary because any
// other participant in a match might have chosen a different one - see
// remotePlayers.js, which resolves each participant's variant from the
// roster the server sends.
export function preloadCharacterModels() {
  return Promise.all(CHARACTER_VARIANTS.map(loadVariant));
}

// A fresh, independent clone of the given variant (falling back to the
// default if an unrecognized/missing key is passed) ready to add to a
// scene, plus its own set of playable AnimationClips - or null if that
// variant isn't loaded yet (failed load, or called before
// preloadCharacterModels() resolves) - callers should have a placeholder
// fallback for that case, see remotePlayers.js. Uses SkeletonUtils.clone
// rather than Object3D.clone so the skeleton/skinning (and therefore the
// animations, which drive those same bones) is properly duplicated instead
// of shared - every live instance needs to be able to play a different
// animation/frame independently.
export function cloneCharacterModel(variant = DEFAULT_CHARACTER_VARIANT) {
  const template = templates[variant] ?? templates[DEFAULT_CHARACTER_VARIANT];
  if (!template) return null;
  return { model: cloneSkeleton(template.scene), clips: template.clips };
}
