import * as THREE from 'three';
import { assetUrl } from './assetPath.js';

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
].map(assetUrl);

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

// Fixed pool sizes for muzzle flashes / tracers / sparks - see the big
// comment above createShootEffects for why these are pre-built once
// instead of allocated per shot. Generously sized for how many effects can
// plausibly be alive at once (lifespans are all under a quarter-second),
// with real headroom for several bots engaging simultaneously - not a hard
// cap on shots themselves, just on how many of their VISUAL effects can be
// mid-flight at the same instant.
const FLASH_POOL_SIZE = 16;
const TRACER_POOL_SIZE = 16;
const SPARK_POOL_SIZE = 64; // SPARK_COUNT (6) per shot - enough for ~10 shots' worth of sparks alive at once

// Muzzle flash + a fast-traveling tracer streak + a small burst of ejected
// spark particles - triggered for the local player's own shots (see
// gameScreen.js's onFire) AND for every other participant's shots relayed
// by the server (see match.js's 'shot-fired' broadcast, handled in
// gameScreen.js's network handlers) - remote participants have no
// rendered weapon model to flash from, so their flash/sparks spawn at an
// approximate gun-height point above their reported position instead (see
// gameScreen.js's 'shot-fired' handler).
//
// Every flash/tracer/spark object this manager will ever show is created
// ONCE, up front, and reused for the rest of the match - triggerShot() only
// ever pulls an already-built object out of its pool, repositions/restyles
// it, and flips it visible; tick() returns it to the pool when its lifespan
// ends instead of disposing it. The previous version allocated a brand-new
// geometry+material (tracers) or material (flashes/sparks) on every single
// shot and disposed them a fraction of a second later - fine for the
// occasional shot, but with several bots actively engaging at once
// (server-relayed 'shot-fired' messages, same path as the local player's
// own shots) that meant frequent allocation + WebGL resource teardown
// churn, which is exactly what players reported as hitching/hanging during
// firefights - and exactly what was absent while bots were just patrolling,
// since none of this code runs at all until a shot is actually fired.
export function createShootEffects(scene) {
  const textureLoader = new THREE.TextureLoader();
  const flareTextures = MUZZLE_FLASH_TEXTURE_URLS.map((url) => textureLoader.load(url));
  const sparkTexture = createSparkTexture();

  // Every tracer is geometrically identical (only its position/orientation
  // differ, both handled per-instance below) - one shared geometry for the
  // whole pool, same as the flash/spark pools already share their textures.
  const tracerGeometry = new THREE.CylinderGeometry(TRACER_RADIUS, TRACER_RADIUS, TRACER_LENGTH, 6, 1, true);
  tracerGeometry.rotateX(Math.PI / 2); // authored along +Y - rotate so local +Z ("forward") is the long axis, matching how `direction` is used below

  function additiveSpriteMaterial(map, color) {
    return new THREE.SpriteMaterial({
      map, color, transparent: true, depthTest: false, blending: THREE.AdditiveBlending,
    });
  }

  function buildFlashPool() {
    const pool = [];
    for (let i = 0; i < FLASH_POOL_SIZE; i++) {
      const sprite = new THREE.Sprite(additiveSpriteMaterial(flareTextures[0], 0xffb347));
      sprite.visible = false;
      sprite.renderOrder = 999;
      scene.add(sprite);
      pool.push(sprite);
    }
    return pool;
  }

  function buildTracerPool() {
    const pool = [];
    for (let i = 0; i < TRACER_POOL_SIZE; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xfff2c0, transparent: true, depthTest: false, blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(tracerGeometry, material);
      mesh.visible = false;
      mesh.renderOrder = 999;
      scene.add(mesh);
      pool.push(mesh);
    }
    return pool;
  }

  function buildSparkPool() {
    const pool = [];
    for (let i = 0; i < SPARK_POOL_SIZE; i++) {
      const sprite = new THREE.Sprite(additiveSpriteMaterial(sparkTexture, 0xffcc66));
      sprite.visible = false;
      sprite.renderOrder = 999;
      scene.add(sprite);
      pool.push(sprite);
    }
    return pool;
  }

  const flashPool = buildFlashPool();
  const tracerPool = buildTracerPool();
  const sparkPool = buildSparkPool();
  // Stacks of currently-unused pooled objects - triggerShot() pops from
  // these, tick() pushes back onto them once an effect's lifespan ends.
  const freeFlashes = [...flashPool];
  const freeTracers = [...tracerPool];
  const freeSparks = [...sparkPool];

  const activeEffects = []; // { object, elapsed, lifespan, kind, pool, ...kind-specific fields }

  function spawnMuzzleFlash(worldPosition) {
    const sprite = freeFlashes.pop();
    if (!sprite) return; // pool exhausted - an implausible number of simultaneous flashes already on screen, just skip this one
    const texture = flareTextures[Math.floor(Math.random() * flareTextures.length)];
    sprite.material.map = texture;
    sprite.material.opacity = 1;
    // A slight random roll so repeated flashes from the same weapon don't
    // look like a stamped-down copy of each other.
    sprite.material.rotation = Math.random() * Math.PI * 2;
    sprite.position.copy(worldPosition);
    sprite.scale.setScalar(MUZZLE_FLASH_SIZE);
    sprite.visible = true;
    activeEffects.push({
      object: sprite, elapsed: 0, lifespan: MUZZLE_FLASH_LIFESPAN, kind: 'flash', pool: freeFlashes,
    });
  }

  // A short, thin, glowing cylinder oriented along the direction of
  // travel (a true 3D streak, not a camera-facing sprite) - it translates
  // forward each frame, giving a genuine "flying round" look rather than a
  // blob that just fades in place.
  function spawnTracer(worldOrigin, direction) {
    const mesh = freeTracers.pop();
    if (!mesh) return;
    mesh.material.opacity = 1;
    mesh.position.copy(worldOrigin);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
    mesh.visible = true;
    activeEffects.push({
      object: mesh,
      elapsed: 0,
      lifespan: TRACER_LIFESPAN,
      kind: 'tracer',
      pool: freeTracers,
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
      const sprite = freeSparks.pop();
      if (!sprite) break; // pool exhausted - drop the rest of this burst rather than the whole shot's effects

      const spreadAngle = (Math.random() - 0.5) * 0.6;
      const spreadRoll = Math.random() * Math.PI * 2;
      const velocity = direction.clone()
        .addScaledVector(right, Math.sin(spreadAngle) * Math.cos(spreadRoll))
        .addScaledVector(up, Math.sin(spreadAngle) * Math.sin(spreadRoll))
        .normalize()
        .multiplyScalar(SPARK_SPEED_MIN + Math.random() * (SPARK_SPEED_MAX - SPARK_SPEED_MIN));

      sprite.material.opacity = 1;
      sprite.position.copy(worldOrigin);
      sprite.scale.setScalar(SPARK_SIZE * (0.6 + Math.random() * 0.6));
      sprite.visible = true;
      activeEffects.push({
        object: sprite,
        elapsed: 0,
        lifespan: SPARK_LIFESPAN_MIN + Math.random() * (SPARK_LIFESPAN_MAX - SPARK_LIFESPAN_MIN),
        kind: 'spark',
        pool: freeSparks,
        origin: worldOrigin.clone(),
        velocity,
      });
    }
  }

  // Returns a finished effect's object to its pool instead of disposing it
  // - just hides it and makes it available for the next spawn* call.
  function releaseEffect(effect) {
    effect.object.visible = false;
    effect.pool.push(effect.object);
  }

  function tick(deltaSeconds) {
    for (let i = activeEffects.length - 1; i >= 0; i--) {
      const effect = activeEffects[i];
      effect.elapsed += deltaSeconds;

      if (effect.elapsed >= effect.lifespan) {
        releaseEffect(effect);
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
    for (const sprite of flashPool) { scene.remove(sprite); sprite.material.dispose(); }
    for (const mesh of tracerPool) { scene.remove(mesh); mesh.material.dispose(); }
    for (const sprite of sparkPool) { scene.remove(sprite); sprite.material.dispose(); }
    tracerGeometry.dispose();
    activeEffects.length = 0;
    for (const texture of flareTextures) texture.dispose();
    sparkTexture.dispose();
  }

  return { triggerShot, tick, dispose };
}
