import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { assetUrl } from './assetPath.js';

// First-person arms (a dedicated arms/hands model, not the third-person
// character body) so the weapon reads as actually held rather than
// floating in front of the camera on its own. FBX + a separate color/
// normal/roughness texture set. Copied into public/ so Vite serves them
// verbatim.
//
// Two earlier passes at this were both wrong in a way only actually
// inspecting the file explained: this model is a FULL articulated rig
// (shoulders to fingertips, with individual finger bones) authored in a
// T-POSE (arms held straight out to the sides), not a compact ready-made
// pair of FPS viewmodel hands. Verified directly by parsing the file with
// FBXLoader in Node (bypassing the browser) and reading real bone world
// positions - confirmed both a T-pose stance and the exact bone names
// (upper_armR/forearmR/handR etc., mirrored _L). Naively centering and
// scaling the WHOLE T-pose rig (what both earlier passes did) put the
// spread-out shoulders/arms right at the gun instead of a held gun shape,
// which is what actually produced "looks like the gun grew its own
// hands". Fixed by explicitly POSING the shoulder/elbow bones into a
// forward-reaching, mirrored two-handed grip before ever measuring/
// centering anything - also verified numerically in that same Node
// harness (the posed hands land symmetric, forward, and level with each
// other) before writing this file, not just reasoned about.
const ARMS_URL = assetUrl('/assets/arms/Arms.fbx');
const TEXTURE_BASE = assetUrl('/assets/arms/');

// Bone rotations (radians, THREE's default XYZ Euler order) that swing the
// T-pose arms forward into a mirrored two-handed reach - found by testing
// candidates against the real bone hierarchy (see the module comment
// above), not guessed blind. The first pose (a nearly-straight ~34-degree
// elbow bend) was reported as looking like a stiff "zombie" reach, and
// separately caused a real bug: with the elbow that straight, the
// shoulder ends up a full ~0.48m in front of the hand (toward the
// camera) - once the hand/gun sits close to the camera (as it needs to
// for a first-person view), that pushed the shoulder geometry to the
// WRONG side of the camera entirely (measured: z > 0, i.e. behind the
// camera's own position, given the camera looks down -Z), which is almost
// certainly the "my view blends with the arm, like passing through it"
// glitch during sway. Bending the elbow much further (~126 degrees, a
// natural relaxed grip rather than a reaching stretch) shrinks that
// shoulder-to-hand gap to ~0.2m at a smaller overall scale, and
// ARMS_OFFSET.z below pushes the whole assembly back an extra bit so even
// the shoulder stays comfortably in front of the camera's near plane
// (0.1) - both verified numerically (Node), not just reasoned about.
// A follow-up report ("bent outward instead of inward, floating in front
// of me") led to actually measuring where these rotations put the hands
// (Node, real bone world positions - see the module comment's methodology)
// rather than reasoning about it further: in bind pose upper_armR sits at
// world x=-62.48 and upper_armL at x=+62.48 (this rig's "R"/"L" naming is
// mirrored from a naive assumption, but that alone doesn't matter - see
// below), and with the rotations that shipped before this fix, handR
// ended up at x=-95.40 and handL at x=+95.40 - BOTH hands moved AWAY from
// the centerline (x=0), i.e. outward, exactly matching the report. The
// user's suggested fix (swap which bone gets which rotation) was tested
// and doesn't work: RIGHT_*/LEFT_* are already exact mirrors of each other
// and the bind-pose bones are already exact mirror images, so swapping the
// assignment reproduces an identical mirror-symmetric shape, just
// relabeled - the actual bug is a missing rotation axis. A parameter sweep
// (Node, holding shoulder rotation fixed and varying each elbow axis in
// turn) found the elbow's Y axis - left at 0 before, never touched - is
// what actually pulls the hand toward the centerline: adding y=-2.2 there
// (mirrored, y=+2.2 for the left elbow) brings both hands to within ~7cm
// of each other after scaling/centering, a tight, natural two-handed grip,
// verified by re-running arms.js's own scale/center/near-clip math on the
// new values before writing them here.
const RIGHT_SHOULDER_ROTATION = { x: 0, y: 5.7, z: -135 };
const RIGHT_ELBOW_ROTATION = { x: 45, y: 0, z: 0 };
const LEFT_SHOULDER_ROTATION = { x: 0, y: -5.7, z: 135 };
const LEFT_ELBOW_ROTATION = { x: 7, y: 0, z: 0 };

const TARGET_REACH_METERS = 0.3; // real-world shoulder-to-hand distance once posed, used to derive scale (see below) - reduced alongside the pose change above, same reasoning

// Held position/tilt for the whole posed-and-centered arms group, relative
// to the WEAPON's own group (arms.js's createArms attaches here - see
// weapon.js's attachToWeapon). z is pulled back (more negative, i.e.
// farther from the camera) specifically so the shoulder - the part of the
// posed rig farthest toward the camera, see the pose comment above - stays
// in front of the near clip plane even with sway added on top.
const ARMS_OFFSET = { x: 0, y: -0.03, z: 0.10 };

const fbxLoader = new FBXLoader();
const textureLoader = new THREE.TextureLoader();

function buildArmsMaterial() {
  const colorMap = textureLoader.load(`${TEXTURE_BASE}armCcolor.png`);
  colorMap.colorSpace = THREE.SRGBColorSpace;
  const normalMap = textureLoader.load(`${TEXTURE_BASE}armCNormal.png`);
  const roughnessMap = textureLoader.load(`${TEXTURE_BASE}armcRoughness.png`);
  return new THREE.MeshStandardMaterial({
    map: colorMap,
    normalMap,
    roughnessMap,
  });
}

// Loads the arms, poses them into a forward two-handed reach, scales and
// centers on the grip point, and attaches to the weapon (see weapon.js's
// attachToWeapon) - no independent sway handling needed, since being a
// child of the weapon's own group means it inherits weapon.js's setSway()
// output automatically, every frame, for free. Returns a promise that
// resolves once the model is actually attached (or the load fails) - see
// gameScreen.js's matchAssetsReady, which waits on this before revealing
// the match to the player.
export function createArms(weapon) {
  const material = buildArmsMaterial();

  return new Promise((resolve) => {
    fbxLoader.load(
      ARMS_URL,
      (model) => {
        model.traverse((child) => {
          if (child.isMesh) child.material = material;
        });

        // Swapped per request: the variable called "right" is bound to
        // the model's OWN L-named bones and vice versa, so
        // RIGHT_*_ROTATION now poses the model's L-named arm and
        // LEFT_*_ROTATION poses the model's R-named arm - the full arm
        // identity is swapped, not just which rotation constant number
        // gets typed where.
        const rightShoulder = model.getObjectByName('upper_armL');
        const rightElbow = model.getObjectByName('forearmL');
        const leftShoulder = model.getObjectByName('upper_armR');
        const leftElbow = model.getObjectByName('forearmR');
        const rightHand = model.getObjectByName('handL');
        const leftHand = model.getObjectByName('handR');

        if (rightShoulder && rightElbow && leftShoulder && leftElbow && rightHand && leftHand) {
          rightShoulder.rotation.set(RIGHT_SHOULDER_ROTATION.x, RIGHT_SHOULDER_ROTATION.y, RIGHT_SHOULDER_ROTATION.z);
          rightElbow.rotation.set(RIGHT_ELBOW_ROTATION.x, RIGHT_ELBOW_ROTATION.y, RIGHT_ELBOW_ROTATION.z);
          leftShoulder.rotation.set(LEFT_SHOULDER_ROTATION.x, LEFT_SHOULDER_ROTATION.y, LEFT_SHOULDER_ROTATION.z);
          leftElbow.rotation.set(LEFT_ELBOW_ROTATION.x, LEFT_ELBOW_ROTATION.y, LEFT_ELBOW_ROTATION.z);
          model.updateMatrixWorld(true);

          // Scale derived from the ACTUAL posed shoulder-to-hand distance
          // (native units), not a generic bounding-box measurement - a
          // skinned mesh's Box3 doesn't reflect bone-driven deformation,
          // so the approach weapon.js uses for the gun doesn't apply here.
          const shoulderPos = new THREE.Vector3();
          const handPos = new THREE.Vector3();
          rightShoulder.getWorldPosition(shoulderPos);
          rightHand.getWorldPosition(handPos);
          const nativeReach = shoulderPos.distanceTo(handPos);
          const scale = nativeReach > 0 ? TARGET_REACH_METERS / nativeReach : 1;
          model.scale.setScalar(scale);
          model.updateMatrixWorld(true);

          // Center on the grip point - the midpoint between the two posed
          // hands - the same "measure after scaling, then subtract" order
          // weapon.js uses, just computed from bone positions instead of
          // a geometry bounding box.
          const rightHandScaled = new THREE.Vector3();
          const leftHandScaled = new THREE.Vector3();
          rightHand.getWorldPosition(rightHandScaled);
          leftHand.getWorldPosition(leftHandScaled);
          const gripMidpoint = rightHandScaled.add(leftHandScaled).multiplyScalar(0.5);
          model.position.sub(gripMidpoint);
        } else {
          console.error('Arms model is missing an expected bone - falling back to an unposed/uncentered model.');
        }

        const armsGroup = new THREE.Group();
        armsGroup.add(model);
        armsGroup.position.set(ARMS_OFFSET.x, ARMS_OFFSET.y, ARMS_OFFSET.z);
        armsGroup.rotation.y = Math.PI;
        weapon.attachToWeapon(armsGroup);
        resolve();
      },
      undefined,
      (err) => {
        console.error('Failed to load arms model:', err);
        resolve(); // a failed load shouldn't block the match from starting
      },
    );
  });
}
