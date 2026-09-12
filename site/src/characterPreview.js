import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { AnimationMixer, LoopRepeat } from 'three';

// Live character/gun preview for the dashboard's showcase stage - loads
// the SAME assets client/'s game does (copied into this project's public/
// too, since these are two separate Vite projects with no shared package -
// see client/src/characterModel.js's equivalent comment), so what a player
// picks here is exactly what they'll look like in-match.
const CHARACTER_URL_BASE = '/assets/characters/';
const GUN_VARIANTS = {
  AssaultRifle_1: { url: '/assets/weapons/AssaultRifle_1.fbx', targetLength: 0.9 },
  Pistol_1: { url: '/assets/weapons/Pistol_1.fbx', targetLength: 0.32 },
  Shotgun_1: { url: '/assets/weapons/Shotgun_1.fbx', targetLength: 1.0 },
  SniperRifle_1: { url: '/assets/weapons/SniperRifle_1.fbx', targetLength: 1.2 },
};
const DEFAULT_GUN_VARIANT = 'AssaultRifle_1';
// Same reverse-engineered fix as client/src/weapon.js - see that file's
// comment for why this exists and what to check if a gun still looks wrong.
const GUN_YAW_CORRECTION = Math.PI / 2;
// Small offset from the wrist bone's own position, since the bone's origin
// is the joint itself, not where a gripped weapon's centerline sits in the
// hand - a guess I couldn't preview, but a much smaller and more forgiving
// one now that the gun tracks the actual animated hand position (see
// attachGunToHand below) instead of a single fixed guess relative to the
// whole character.
const GUN_HAND_OFFSET = { x: 0, y: -0.02, z: 0.08 };

// GUN_HAND_TILT is NOT a guess - a screenshot showed the gun floating at
// an odd angle above the hand, and simply combining the wrist bone's own
// world rotation with a small manual tilt (the first attempt) produced an
// essentially arbitrary result, because the bone's own local axes don't
// point where you'd assume: measured directly (Node, applying the
// character's own bone quaternion to unit vectors), the wrist's local +Y
// ("up") actually points toward world -Y (down), and its local -Z points
// sideways, not forward. This value is the exact local correction solved
// for algebraically (tilt = wristRotation^-1 * desiredWorldRotation) so
// the gun's own barrel axis ends up pointing down-and-slightly-forward in
// WORLD space (a relaxed low-ready hold) - verified by re-applying the
// combined rotation and confirming the resulting barrel direction matches,
// not just computed and assumed correct.
const GUN_HAND_TILT = { x: 1.496, y: 0.271, z: 2.935 };

// buildGunGroup used to center the gun on its exact geometric bounding-box
// center (a 50/50 split of its length either side of the attach point) -
// fine for weapon.js's fixed, dead-ahead FPS placement, but wrong here:
// once GUN_HAND_TILT rotates the gun to its held angle, a 50/50 split puts
// HALF the gun's full length swinging up behind the wrist - measured
// directly (Node, this exact wrist pose): with a 0.9m rifle that's a
// ~0.42m rise in world Y, landing within 0.27m of BOTH the elbow and
// shoulder bones, which is what actually produced "gun is on the elbow" -
// the attach point itself was correct, but that much of the model swung up
// past it. Shifting the centering point (not a guess - swept fractions in
// Node and picked the one where the trailing end no longer reaches above
// elbow height at all, with the best remaining clearance) fixes this
// without needing to touch the orientation math above, which was already
// correct.
const GUN_GRIP_CENTER_FRACTION = 0.2;

const gltfLoader = new GLTFLoader();
const fbxLoader = new FBXLoader();

function loadCharacter(characterKey) {
  return new Promise((resolve, reject) => {
    gltfLoader.load(`${CHARACTER_URL_BASE}${characterKey}.gltf`, resolve, undefined, reject);
  });
}

function loadGunModel(url) {
  return new Promise((resolve, reject) => {
    fbxLoader.load(url, resolve, undefined, reject);
  });
}

// Normalizes a loaded gun FBX the same way client/src/weapon.js does
// (unknown native scale/orientation - measure and correct rather than
// guess a fixed transform). Returns the assembled gunGroup - NOT attached
// anywhere yet, see trackHandBone below for why.
function buildGunGroup(gunModel, targetLength) {
  gunModel.updateMatrixWorld(true);
  const initialSize = new THREE.Box3().setFromObject(gunModel).getSize(new THREE.Vector3());
  if (initialSize.x > initialSize.z) {
    gunModel.rotation.y = GUN_YAW_CORRECTION;
    gunModel.updateMatrixWorld(true);
  }
  const rotatedSize = new THREE.Box3().setFromObject(gunModel).getSize(new THREE.Vector3());
  const largestDimension = Math.max(rotatedSize.x, rotatedSize.y, rotatedSize.z);
  const scale = largestDimension > 0 ? targetLength / largestDimension : 1;
  gunModel.scale.setScalar(scale);
  gunModel.updateMatrixWorld(true);
  const center = new THREE.Box3().setFromObject(gunModel).getCenter(new THREE.Vector3());
  // See GUN_GRIP_CENTER_FRACTION above - shifts the attach point off the
  // geometric center so the held gun doesn't swing a huge trailing length
  // up past the wrist once GUN_HAND_TILT is applied.
  center.z += targetLength * (0.5 - GUN_GRIP_CENTER_FRACTION);
  gunModel.position.sub(center);

  const gunGroup = new THREE.Group();
  gunGroup.add(gunModel);
  return gunGroup;
}

// A first attempt PARENTED the gun as a child of the "Wrist.R" bone
// directly - the raw glTF data confirms that bone genuinely exists at a
// sane point in the skeleton, but the result (screenshotted) had the gun
// sunk into the floor, presumably some skinning/bind-pose matrix quirk in
// how a plain Object3D child behaves under a Bone. Sidestepped here rather
// than re-guessed: gunGroup is a SIBLING (added to the top-level `group`,
// same as the character), and every frame (see tick() below) its
// position/rotation are set by reading the wrist bone's actual current
// WORLD transform (post-animation) and converting that into `group`'s
// local space - this genuinely tracks wherever the idle animation poses
// the hand, without relying on parent/child bone attachment at all.
function trackHandBone(characterRoot, group, gunGroup) {
  // Found and fixed the actual bug behind "gun sunk in the floor": the raw
  // glTF node is named "Wrist.R" (confirmed directly in the source JSON),
  // but GLTFLoader strips dots when building the three.js scene graph, so
  // it comes out the other end named "WristR" - getObjectByName('Wrist.R')
  // was silently returning null every time, this function's early-return
  // fired, and the gun just sat at gunGroup's default (0,0,0) - the
  // character root's own origin, i.e. the floor. Verified directly (not
  // reasoned about) by parsing this exact file with GLTFLoader in Node
  // and listing the resulting node names.
  const handBone = characterRoot.getObjectByName('WristR');
  if (!handBone) return null;

  const worldPosition = new THREE.Vector3();
  const worldQuaternion = new THREE.Quaternion();
  const offset = new THREE.Vector3(GUN_HAND_OFFSET.x, GUN_HAND_OFFSET.y, GUN_HAND_OFFSET.z);
  const tiltQuaternion = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(GUN_HAND_TILT.x, GUN_HAND_TILT.y, GUN_HAND_TILT.z),
  );

  return function updateGunTransform() {
    handBone.getWorldPosition(worldPosition);
    handBone.getWorldQuaternion(worldQuaternion);

    // Small hand-relative offset, rotated into world space by the bone's
    // current orientation, then converted into group's local space
    // alongside the position itself - so the offset stays "a bit forward
    // of the palm" regardless of which way the hand is currently turned.
    worldPosition.add(offset.clone().applyQuaternion(worldQuaternion));
    group.worldToLocal(worldPosition);
    gunGroup.position.copy(worldPosition);
    gunGroup.quaternion.copy(worldQuaternion).multiply(tiltQuaternion);
  };
}

// Loads and assembles one character+gun preview. Returns
// { group, tick(deltaSeconds), dispose() } - group is ready to add to a
// scene; tick must be called every frame to advance the idle animation
// (and, if a hand bone was found, keep the gun tracking it); dispose
// releases this specific instance's resources (the character/gun are
// freshly loaded per call, not cached/shared, since the dashboard only
// ever shows one at a time - unlike client/'s remotePlayers.js, which
// needs many simultaneous instances and caches templates for that reason).
export async function loadCharacterPreview(characterKey, gunKey) {
  const gunVariant = GUN_VARIANTS[gunKey] ?? GUN_VARIANTS[DEFAULT_GUN_VARIANT];
  const [gltf, gunModel] = await Promise.all([
    loadCharacter(characterKey),
    loadGunModel(gunVariant.url),
  ]);

  const characterRoot = gltf.scene;
  const mixer = new AnimationMixer(characterRoot);
  // Idle_Gun (a relaxed two-handed ready stance) rather than
  // Idle_Gun_Pointing - a screenshot of the latter showed the arm thrown
  // forward in a single-arm pointing gesture, nothing like a natural
  // weapon hold, which made a plausible gun placement much harder.
  const idleClip = gltf.animations.find((clip) => clip.name === 'Idle_Gun')
    ?? gltf.animations.find((clip) => clip.name === 'Idle');
  if (idleClip) mixer.clipAction(idleClip).setLoop(LoopRepeat).play();
  mixer.update(0); // pose the skeleton once synchronously, so the first frame's hand-tracking below isn't reading a stale bind pose

  const gunGroup = buildGunGroup(gunModel, gunVariant.targetLength);

  const group = new THREE.Group();
  group.add(characterRoot);
  group.add(gunGroup);

  const updateGunTransform = trackHandBone(characterRoot, group, gunGroup);

  function tick(deltaSeconds) {
    mixer.update(deltaSeconds);
    updateGunTransform?.();
  }

  function dispose() {
    mixer.stopAllAction();
    group.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => {
          Object.values(material).forEach((value) => {
            if (value?.isTexture) value.dispose();
          });
          material.dispose();
        });
      }
    });
  }

  return { group, tick, dispose };
}
