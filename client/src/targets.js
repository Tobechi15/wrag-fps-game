import * as THREE from 'three';

const TARGET_COLOR = 0xcc3333;
const HIT_FLASH_COLOR = 0xffff00;
const HIT_FLASH_DURATION_MS = 150;

// Adds a few static, hittable "dummy" boxes to the scene for the shooting
// mechanic to test against. Returns the array of meshes so the shooting
// system can raycast against exactly these objects (not everything in the
// scene, like the ground).
export function createTargets(scene) {
  const positions = [
    [-3, 1, -6],
    [0, 1, -8],
    [3, 1, -6],
  ];

  const geometry = new THREE.BoxGeometry(1, 2, 1);

  return positions.map(([x, y, z]) => {
    const material = new THREE.MeshStandardMaterial({ color: TARGET_COLOR });
    const target = new THREE.Mesh(geometry, material);
    target.position.set(x, y, z);
    scene.add(target);
    return target;
  });
}

// Brief color flash so a hit is visually obvious even before there's a
// score UI. Not gameplay logic, just feedback.
export function flashTargetHit(target) {
  target.material.color.setHex(HIT_FLASH_COLOR);
  setTimeout(() => {
    target.material.color.setHex(TARGET_COLOR);
  }, HIT_FLASH_DURATION_MS);
}
