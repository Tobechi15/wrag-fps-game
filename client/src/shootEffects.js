import * as THREE from 'three';

// Real flash sprite art (CC0-adjacent asset pack, "BinbunVFX Muzzle Flash")
// - the pack itself ships as Godot scenes/materials (.tscn/.tres/.gd),
// which don't carry over to this Three.js project at all, but the actual
// flash textures underneath are plain PNGs (a white/grey burst on black,
// meant for additive blending - exactly what spawnMuzzleFlash already
// does) and drop straight in. Four variants, picked at random per shot
// (see spawnMuzzleFlash) purely for visual variety, same reasoning as the
// random material.rotation roll this replaces from the old canvas-drawn
// version.
const MUZZLE_FLASH_TEXTURE_URLS = [
  '/assets/effects/muzzleFlash/flash_front_01.png',
  '/assets/effects/muzzleFlash/flash_front_02.png',
  '/assets/effects/muzzleFlash/flash_front_03.png',
  '/assets/effects/muzzleFlash/flash_front_04.png',
];

const MUZZLE_FLASH_LIFESPAN = 0.05; // seconds
const MUZZLE_FLASH_SIZE = 0.4;
const TRACER_LIFESPAN = 0.15; // seconds
const TRACER_SPEED = 140; // meters/second - fast enough to read as "instant-ish" but still visible as travel
const TRACER_LENGTH = 0.9;
const TRACER_RADIUS = 0.012;
const SPARK_COUNT = 6;
const SPARK_LIFESPAN_MIN = 0.12;
const SPARK_LIFESPAN_MAX = 0.22;
const SPARK_SPEED_MIN = 3;
const SPARK_SPEED_MAX = 7;
const SPARK_GRAVITY = 9.8;
const SPARK_SIZE = 0.05;

// A small soft dot, reused for individual spark particles.
function createSparkTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.5, 'rgba(255,200,120,0.9)');
  gradient.addColorStop(1, 'rgba(255,150,60,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(canvas);
}

// Muzzle flash + a fast-traveling tracer streak + a small burst of ejected
// spark particles - triggered for the local player's own shots (see
// gameScreen.js's onFire) AND for every other participant's shots relayed
// by the server (see match.js's 'shot-fired' broadcast, handled in
// gameScreen.js's network handlers) - remote participants have no
// rendered weapon model to flash from, so their flash/sparks spawn at an
// approximate gun-height point above their reported position instead (see
// gameScreen.js's 'shot-fired' handler).
export function createShootEffects(scene) {
  const textureLoader = new THREE.TextureLoader();
  const flareTextures = MUZZLE_FLASH_TEXTURE_URLS.map((url) => textureLoader.load(url));
  const sparkTexture = createSparkTexture();
  const activeEffects = []; // { object, elapsed, lifespan, kind, ...kind-specific fields }

  function additiveSpriteMaterial(map, color) {
    return new THREE.SpriteMaterial({
      map, color, transparent: true, depthTest: false, blending: THREE.AdditiveBlending,
    });
  }

  function spawnMuzzleFlash(worldPosition) {
    const texture = flareTextures[Math.floor(Math.random() * flareTextures.length)];
    const sprite = new THREE.Sprite(additiveSpriteMaterial(texture, 0xffb347));
    sprite.position.copy(worldPosition);
    // A slight random roll so repeated flashes from the same weapon don't
    // look like a stamped-down copy of each other.
    sprite.material.rotation = Math.random() * Math.PI * 2;
    sprite.scale.setScalar(MUZZLE_FLASH_SIZE);
    sprite.renderOrder = 999;
    scene.add(sprite);
    activeEffects.push({
      object: sprite, elapsed: 0, lifespan: MUZZLE_FLASH_LIFESPAN, kind: 'flash',
    });
  }

  // A short, thin, glowing cylinder oriented along the direction of
  // travel (a true 3D streak, not a camera-facing sprite) - it translates
  // forward each frame, giving a genuine "flying round" look rather than a
  // blob that just fades in place.
  function spawnTracer(worldOrigin, direction) {
    const geometry = new THREE.CylinderGeometry(TRACER_RADIUS, TRACER_RADIUS, TRACER_LENGTH, 6, 1, true);
    // Cylinders are authored along +Y - rotate the geometry itself so the
    // mesh's local +Z (its "forward") is the long axis instead, matching
    // how `direction` is used below.
    geometry.rotateX(Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      color: 0xfff2c0, transparent: true, depthTest: false, blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 999;
    mesh.position.copy(worldOrigin);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
    scene.add(mesh);
    activeEffects.push({
      object: mesh,
      elapsed: 0,
      lifespan: TRACER_LIFESPAN,
      kind: 'tracer',
      direction: direction.clone(),
      origin: worldOrigin.clone(),
    });
  }

  // A small burst of individual sparks ejected from the muzzle at
  // randomized short angles around the fire direction, arcing slightly
  // under gravity - the "shower of sparks" a muzzle flash actually throws,
  // distinct from the single tracer streak carrying the round itself.
  function spawnSparkBurst(worldOrigin, direction) {
    const right = new THREE.Vector3().crossVectors(direction, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, direction).normalize();

    for (let i = 0; i < SPARK_COUNT; i++) {
      const spreadAngle = (Math.random() - 0.5) * 0.6;
      const spreadRoll = Math.random() * Math.PI * 2;
      const velocity = direction.clone()
        .addScaledVector(right, Math.sin(spreadAngle) * Math.cos(spreadRoll))
        .addScaledVector(up, Math.sin(spreadAngle) * Math.sin(spreadRoll))
        .normalize()
        .multiplyScalar(SPARK_SPEED_MIN + Math.random() * (SPARK_SPEED_MAX - SPARK_SPEED_MIN));

      const sprite = new THREE.Sprite(additiveSpriteMaterial(sparkTexture, 0xffcc66));
      sprite.position.copy(worldOrigin);
      sprite.scale.setScalar(SPARK_SIZE * (0.6 + Math.random() * 0.6));
      sprite.renderOrder = 999;
      scene.add(sprite);
      activeEffects.push({
        object: sprite,
        elapsed: 0,
        lifespan: SPARK_LIFESPAN_MIN + Math.random() * (SPARK_LIFESPAN_MAX - SPARK_LIFESPAN_MIN),
        kind: 'spark',
        origin: worldOrigin.clone(),
        velocity,
      });
    }
  }

  function disposeEffect(effect) {
    scene.remove(effect.object);
    effect.object.geometry?.dispose();
    effect.object.material.dispose();
  }

  function tick(deltaSeconds) {
    for (let i = activeEffects.length - 1; i >= 0; i--) {
      const effect = activeEffects[i];
      effect.elapsed += deltaSeconds;

      if (effect.elapsed >= effect.lifespan) {
        disposeEffect(effect);
        activeEffects.splice(i, 1);
        continue;
      }

      const progress = effect.elapsed / effect.lifespan;
      if (effect.kind === 'flash') {
        effect.object.material.opacity = 1 - progress;
        effect.object.scale.setScalar(MUZZLE_FLASH_SIZE * (1 + progress * 0.6));
      } else if (effect.kind === 'tracer') {
        const distance = TRACER_SPEED * effect.elapsed;
        effect.object.position.copy(effect.origin).addScaledVector(effect.direction, distance + TRACER_LENGTH / 2);
        effect.object.material.opacity = 1 - progress;
      } else {
        // spark: ballistic arc under a light gravity pull, fading out.
        const t = effect.elapsed;
        effect.object.position.set(
          effect.origin.x + effect.velocity.x * t,
          effect.origin.y + effect.velocity.y * t - 0.5 * SPARK_GRAVITY * t * t,
          effect.origin.z + effect.velocity.z * t,
        );
        effect.object.material.opacity = 1 - progress;
      }
    }
  }

  // triggerShot: the one entry point callers use - a shot always produces
  // a muzzle flash, a flying tracer streak, and a small spark burst,
  // whether it's the local player's own weapon or a remote participant's
  // (see the module comment above).
  function triggerShot(muzzleWorldPosition, direction) {
    spawnMuzzleFlash(muzzleWorldPosition);
    spawnTracer(muzzleWorldPosition, direction);
    spawnSparkBurst(muzzleWorldPosition, direction);
  }

  function dispose() {
    for (const effect of activeEffects) disposeEffect(effect);
    activeEffects.length = 0;
    for (const texture of flareTextures) texture.dispose();
    sparkTexture.dispose();
  }

  return { triggerShot, tick, dispose };
}
