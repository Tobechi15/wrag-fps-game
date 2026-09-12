import * as THREE from 'three';

// Builds the empty world: a flat ground plane + basic lighting.
// Returns the scene so main.js can add the camera/player and later,
// weapons, targets, and other players into it.
export function createScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb); // simple sky-blue backdrop

  // Ground plane. PlaneGeometry is created flat on the XY plane by default,
  // so we rotate it -90deg around X to lay it flat on the ground (XZ plane).
  const groundGeometry = new THREE.PlaneGeometry(100, 100);
  const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x4a7c3a });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Ambient light so nothing is pitch black in shadow.
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  // Directional light acts like the sun, casts shadows for depth cues.
  const sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
  sunLight.position.set(20, 30, 10);
  sunLight.castShadow = true;
  scene.add(sunLight);

  return scene;
}
