import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

// Real weapon models (CC0, "Ultimate Gun Pack" by Quaternius), FBX format
// (this pack ships no glTF export). Copied into public/ so Vite serves
// them verbatim. Each FBX's native unit scale and orientation aren't
// something this project can inspect ahead of time (binary format, no easy
// way to read it outside a real 3D viewer) - so instead of guessing a
// scale factor, the loaded model's own bounding box is measured and
// normalized to its targetLength below (a rough real-world approximation
// per weapon type, since a pistol and a sniper rifle obviously shouldn't
// render at the same size).
//
// The orientation fix (WEAPON_YAW_CORRECTION) was reverse-engineered from
// how the assault rifle actually looked in-browser (flat, centered on
// screen, facing the camera) rather than verified directly: that reads as
// the model's length (barrel) axis running along local X instead of Z, so
// its "side" faced the camera dead-on instead of its muzzle receding away
// into the screen - fixed by rotating 90 degrees around Y whenever the
// measured X extent is the larger of the two horizontal dimensions. Applied
// to every variant here since they're all from the same pack/exporter, but
// only actually confirmed correct for the assault rifle - if another gun
// still looks wrong, this shared correction (or a per-gun override) is the
// first thing to check.
export const GUN_VARIANTS = {
  AssaultRifle_1: { url: '/assets/weapons/AssaultRifle_1.fbx', targetLength: 0.9, label: 'Assault Rifle' },
  Pistol_1: { url: '/assets/weapons/Pistol_1.fbx', targetLength: 0.32, label: 'Pistol' },
  Shotgun_1: { url: '/assets/weapons/Shotgun_1.fbx', targetLength: 1.0, label: 'Shotgun' },
  SniperRifle_1: { url: '/assets/weapons/SniperRifle_1.fbx', targetLength: 1.2, label: 'Sniper Rifle' },
};
export const DEFAULT_GUN_VARIANT = 'AssaultRifle_1';
const WEAPON_YAW_CORRECTION = Math.PI / 2;

// Held position: closer to camera and offset to the bottom-right, the
// standard FPS viewmodel look, rather than sitting dead-center facing
// straight down the barrel - only the front (body + muzzle) reads as
// clearly in view, with the rear/grip end falling toward the screen edge.
//
// Two earlier passes tried to fix crosshair misalignment by adding
// pitch/yaw tilt to angle the barrel "back toward center" - backwards.
// Perspective projection means any line kept PARALLEL to the camera's own
// forward axis converges toward the screen's exact center as it recedes
// into the distance, regardless of where it's offset to on screen - the
// same reason two railway tracks (parallel, but offset from your feet)
// visually meet at a single vanishing point straight ahead of you. So the
// barrel doesn't need aiming AT the crosshair at all - it needs to be
// perfectly PARALLEL to camera-forward (zero pitch/yaw), and the
// perspective math handles the rest on its own. WEAPON_TILT below is now
// just a tiny cosmetic roll - if the muzzle still doesn't track the
// crosshair, the x/y here should stay at 0, not grow again.
const WEAPON_POSITION = { x: 0.16, y: -0.22, z: -0.38 };
const WEAPON_TILT = { x: 0, y: 0, z: -0.03 };

// The weapon sways MORE than the camera itself does (see player.js's
// getSway()) - a bigger, more visible swing on the held gun reads clearly
// as "you're moving" without the disorienting feel of swinging the whole
// camera that far. Position multiplier scales player.js's sway offset
// (meters); rotation multiplier converts that same horizontal sway into a
// visible side-to-side tilt/bend (radians per meter of camera sway) - the
// bend is the more important of the two (asked for explicitly - "bend the
// gun slightly sideways while running"), so it's weighted higher than the
// position shift, which was part of what read as "too fast and jumpy"
// before player.js's sway itself was also slowed down.
const WEAPON_SWAY_POSITION_MULTIPLIER = 1.8; // was 2.5
const WEAPON_SWAY_ROTATION_MULTIPLIER = 2.8; // was 2.2

// A manual nudge for where the muzzle flash/tracer spawn, ON TOP OF the
// auto-measured tip (see normalizeGunModel's muzzleOffsetZ) - independent
// of WEAPON_POSITION/WEAPON_TILT above, which move the whole held gun
// model itself. Use this if the gun's own placement looks right but the
// flash still lands slightly off its visible tip. In the gun model's own
// local space (same axes as the model itself, post-orient/scale/center):
// x = left(-)/right(+), y = down(-)/up(+), z = back-toward-grip(+)/
// further-out-past-the-muzzle(-) (the model's forward is -Z, so a more
// negative z pushes the spawn point further forward past the tip).
const MUZZLE_FLASH_MANUAL_OFFSET = { x: 0.1, y: 0, z: -0.7 };

const loader = new FBXLoader();

// Shared FBX post-processing: auto-orients (see WEAPON_YAW_CORRECTION's
// comment above), scales to targetLength, and centers on its own geometry -
// used both for the local first-person weapon below AND, via
// preloadRemoteWeaponModel/cloneRemoteWeaponModel further down, for the
// held weapon third-person remote players/bots now show (see
// remotePlayers.js). Returns the muzzle's LOCAL Z offset alongside the
// processed model - the model's forward-most point along its own length
// axis (already rotated to align with -Z), measured from the CENTERED
// bounding box's own min.z rather than assumed to be exactly half the
// total measured length forward of center: a real gun's stock/grip end is
// shorter than its barrel end, so "half of total length" overshoots past
// the true muzzle tip toward the grip - this reads the model's own
// asymmetric geometry instead of assuming it's symmetric around its center.
function normalizeGunModel(model, targetLength) {
  model.updateMatrixWorld(true);
  const initialSize = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
  if (initialSize.x > initialSize.z) {
    model.rotation.y = WEAPON_YAW_CORRECTION;
    model.updateMatrixWorld(true);
  }

  // Re-measure AFTER any rotation above - swapping X/Z changes the box.
  const rotatedSize = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
  const largestDimension = Math.max(rotatedSize.x, rotatedSize.y, rotatedSize.z);
  const scale = largestDimension > 0 ? targetLength / largestDimension : 1;
  model.scale.setScalar(scale);
  model.updateMatrixWorld(true);

  // Center the model on its own geometry - an FBX's pivot isn't
  // guaranteed to sit at the muzzle/grip in a way that "just works" at
  // position (0,0,0), so this centers it instead of trusting the
  // source pivot.
  const center = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
  model.position.sub(center);
  model.updateMatrixWorld(true);

  // NOW measure the muzzle offset, on the final centered/scaled model -
  // the more-negative-Z face of its own bounding box.
  const centeredBox = new THREE.Box3().setFromObject(model);
  return { model, muzzleOffsetZ: centeredBox.min.z };
}

// Placeholder weapon: a simple box "attached" to the camera by being added
// as a child of it. Since it's a child, it automatically inherits the
// camera's position/rotation each frame - no manual syncing needed. Shown
// immediately so the player isn't empty-handed for the moment it takes the
// real model to load (normally near-instant - each FBX is ~36KB), then
// swapped out once it's ready.
export function createWeapon(camera, gunKey = DEFAULT_GUN_VARIANT) {
  const variant = GUN_VARIANTS[gunKey] ?? GUN_VARIANTS[DEFAULT_GUN_VARIANT];

  const geometry = new THREE.BoxGeometry(0.1, 0.1, 0.5);
  const material = new THREE.MeshStandardMaterial({ color: 0x222222 });
  const placeholder = new THREE.Mesh(geometry, material);
  placeholder.position.set(WEAPON_POSITION.x, WEAPON_POSITION.y, WEAPON_POSITION.z);
  camera.add(placeholder);

  const pendingAttachments = []; // see attachToWeapon() below
  let resolveReady;
  // Resolves once the real model has replaced the placeholder (or the load
  // fails and it's just staying a placeholder) - see gameScreen.js's
  // matchAssetsReady, which waits on this before revealing the match to
  // the player, so nobody sees the placeholder box swap into the real gun
  // mid-view.
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  // The muzzle flash/tracer effects (see shootEffects.js) need a world
  // position to spawn at, but the real model doesn't finish loading
  // synchronously - callers read this each time they need it rather than
  // receiving a one-time value, so it's correct before AND after the swap.
  const handle = {
    weaponGroup: null, // set once the real model loads
    muzzleOffsetZ: null, // set alongside weaponGroup - see getMuzzleWorldPosition below
    ready,
    // Parents `object3D` under the (centered, normalized) gun model itself
    // - used by arms.js so the arms move in EXACT lockstep with the gun
    // (including its sway) rather than being independently positioned and
    // kept in sync by hand, which is what let them drift apart into
    // "floating disconnected from the gun" before. If the gun hasn't
    // finished loading yet, queues the attachment for once it has -
    // both loads are small/fast, so this window is normally brief.
    attachToWeapon(object3D) {
      if (handle.weaponGroup) handle.weaponGroup.add(object3D);
      else pendingAttachments.push(object3D);
    },
    getMuzzleWorldPosition(target) {
      const anchor = handle.weaponGroup ?? placeholder;
      // handle.muzzleOffsetZ (set once the real model loads, see
      // normalizeGunModel above) is the model's own measured forward-most
      // point, not a symmetric half-length guess - falls back to the
      // placeholder box's own half-depth while the real model is still
      // loading. MUZZLE_FLASH_MANUAL_OFFSET (see above) is added on top,
      // in the same local space, for independent fine-tuning.
      const baseZ = handle.weaponGroup ? handle.muzzleOffsetZ : -0.3;
      target.set(
        MUZZLE_FLASH_MANUAL_OFFSET.x,
        MUZZLE_FLASH_MANUAL_OFFSET.y,
        baseZ + MUZZLE_FLASH_MANUAL_OFFSET.z,
      );
      // Called from a click handler, not the render loop - matrixWorld is
      // usually fresh as of the last frame either way, but this guarantees
      // it rather than relying on that timing.
      anchor.updateMatrixWorld(true);
      anchor.localToWorld(target);
      return target;
    },
    // Called every frame from gameScreen.js's animate loop with
    // player.js's getSway() output - re-applies the weapon's held
    // position/tilt as BASE + exaggerated sway each time, rather than
    // accumulating deltas, so it can never drift.
    setSway(sway) {
      const anchor = handle.weaponGroup ?? placeholder;
      anchor.position.set(
        WEAPON_POSITION.x + sway.x * WEAPON_SWAY_POSITION_MULTIPLIER,
        WEAPON_POSITION.y + sway.y * WEAPON_SWAY_POSITION_MULTIPLIER,
        WEAPON_POSITION.z,
      );
      if (handle.weaponGroup) {
        handle.weaponGroup.rotation.set(
          WEAPON_TILT.x,
          WEAPON_TILT.y,
          WEAPON_TILT.z - sway.x * WEAPON_SWAY_ROTATION_MULTIPLIER,
        );
      }
    },
  };

  loader.load(
    variant.url,
    (model) => {
      const { muzzleOffsetZ } = normalizeGunModel(model, variant.targetLength);
      handle.muzzleOffsetZ = muzzleOffsetZ;

      // Wrap in a group so the held placement/tilt stays independent of
      // the centering offset applied above.
      const weaponGroup = new THREE.Group();
      weaponGroup.add(model);
      weaponGroup.position.set(WEAPON_POSITION.x, WEAPON_POSITION.y, WEAPON_POSITION.z);
      weaponGroup.rotation.set(WEAPON_TILT.x, WEAPON_TILT.y, WEAPON_TILT.z);
      camera.add(weaponGroup);
      camera.remove(placeholder);
      handle.weaponGroup = weaponGroup;
      for (const object3D of pendingAttachments) weaponGroup.add(object3D);
      pendingAttachments.length = 0;
      resolveReady();
    },
    undefined,
    (err) => {
      console.error(`Failed to load weapon model "${gunKey}", keeping the placeholder box:`, err);
      resolveReady(); // a failed load shouldn't block the match from starting - same tolerance as characterModel.js's preload
    },
  );

  return handle;
}

// Held weapon for every OTHER connected participant (real player or bot -
// see remotePlayers.js) - always the same variant regardless of that
// participant's own loadout choice, since gun variant was never something
// this project syncs across clients in the first place (only cosmetic to
// each player's own first-person view - see app.js's module comment). A
// compact pistol, not whatever this client's own local weapon happens to
// be: it's parented to a character's wrist BONE (remotePlayers.js), and a
// short weapon clips far less than a long rifle against a not-perfectly-
// tuned hand placement.
const REMOTE_WEAPON_VARIANT = GUN_VARIANTS.Pistol_1;
let remoteWeaponTemplate = null; // the processed (oriented/scaled/centered) model, never added to a live scene directly - only ever cloned from, same pattern as characterModel.js's `templates`
let remoteWeaponMuzzleOffsetZ = 0;
let remoteWeaponLoadPromise = null;

// Call once, as early as possible (see app.js), so it's very likely ready
// before a match actually starts - same reasoning/timing as
// characterModel.js's preloadCharacterModels().
export function preloadRemoteWeaponModel() {
  if (!remoteWeaponLoadPromise) {
    remoteWeaponLoadPromise = new Promise((resolve) => {
      loader.load(
        REMOTE_WEAPON_VARIANT.url,
        (model) => {
          const result = normalizeGunModel(model, REMOTE_WEAPON_VARIANT.targetLength);
          remoteWeaponTemplate = result.model;
          remoteWeaponMuzzleOffsetZ = result.muzzleOffsetZ;
          resolve();
        },
        undefined,
        (err) => {
          console.error('Failed to load the remote-player weapon model:', err);
          resolve(); // a failed load shouldn't block the rest of the app - remotePlayers.js just shows no gun for anyone
        },
      );
    });
  }
  return remoteWeaponLoadPromise;
}

// A fresh clone for one remote character to hold (see remotePlayers.js,
// which parents this to that character's Wrist.R bone) - or null if the
// template isn't loaded yet. Not skinned/rigged (a plain static prop, no
// armature of its own), so an ordinary deep clone is enough - unlike
// characterModel.js's SkeletonUtils.clone, there's no skeleton/skinning
// here that would otherwise end up SHARED (and therefore fighting over one
// pose) across every instance.
export function cloneRemoteWeaponModel() {
  return remoteWeaponTemplate ? remoteWeaponTemplate.clone(true) : null;
}

// The muzzle's local Z offset on that same template (see
// normalizeGunModel) - remotePlayers.js/gameScreen.js use this to compute
// a real world muzzle position for a remote participant's shot, instead of
// the old "approximate gun-height point above their reported position"
// guess this replaces.
export function getRemoteWeaponMuzzleOffsetZ() {
  return remoteWeaponMuzzleOffsetZ;
}
