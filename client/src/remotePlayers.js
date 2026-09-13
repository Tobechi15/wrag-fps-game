import * as THREE from 'three';
import { AnimationMixer, LoopRepeat, LoopOnce } from 'three';
import { cloneCharacterModel, CHARACTER_VARIANTS } from './characterModel.js';
import { cloneRemoteWeaponModel, getRemoteWeaponMuzzleOffsetZ } from './weapon.js';
import { SEND_INTERVAL_MS } from './network.js';

const CAPSULE_RADIUS = 0.3;
const CAPSULE_LENGTH = 1.1; // straight cylinder part, excluding the rounded caps
const CAPSULE_TOTAL_HEIGHT = CAPSULE_LENGTH + CAPSULE_RADIUS * 2; // 1.7m, roughly a person
const CAPSULE_CENTER_Y = CAPSULE_TOTAL_HEIGHT / 2; // so its bottom sits on the ground (y=0)

const PLAYER_COLOR = 0x3366ff; //
const BOT_COLOR = 0xff4433; // the theme's "danger" accent - bots read as hostile, never disguised as real players
const ALLY_COLOR = 0x22c55e; // the theme's "success" accent - Coop teammates, real or bot, read as friendly

// Where the held weapon sits on the character rig's own wrist bone - every
// variant in this pack shares one skeleton (verified directly: bone names
// and bind-pose transforms are byte-identical across Swat/Punk/Worker/
// Casual_2), so one fixed transform works for all of them. The bone is
// named "WristR" at RUNTIME (see WRIST_BONE_NAME below) even though the
// raw .gltf source file on disk names it "Wrist.R" (with a dot) - confirmed
// directly by dumping every actual node name Three.js produced at load
// time: THREE's GLTFLoader strips "." from node names across the board
// (dots are reserved for animation-track path syntax, "nodeName.property" -
// see THREE.PropertyBinding - so a literal dot IN a name would collide with
// that), for every bone in this rig, not just this one. Measured (not
// guessed) from the rig's actual bind pose in a Node harness, the same
// "read real bone world positions, don't guess" methodology arms.js used
// for the first-person arms: every finger's base knuckle bone sits at
// local (0, ~0.028, 0) relative to the wrist, and the forearm sits at
// local (0, ~-0.235, 0) - i.e. this rig's wrist-local +Y axis is "toward
// the fingers," -Y is "back toward the arm." GUN_GRIP_BASE_ROTATION aligns
// the gun model's own muzzle axis (local -Z, see weapon.js's
// normalizeGunModel) with that +Y "toward the fingers" direction -
// GUN_GRIP_OFFSET nudges it slightly past the wrist joint into the palm
// rather than centering it exactly on the joint itself.
const WRIST_BONE_NAME = 'WristR';
const GUN_GRIP_BASE_ROTATION = new THREE.Quaternion().setFromUnitVectors(
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(0, 1, 0),
);

// TUNE THE GUN'S ROTATION HERE - applied ON TOP of the base alignment
// above, in the gun's own local space (post-base-rotation), in RADIANS
// (Math.PI = 180°, Math.PI / 2 = 90°). This is the one to edit if the gun
// looks rotated the wrong way in the hand: x = pitch (tips the muzzle up/
// down), y = yaw (swings the muzzle left/right), z = roll (rotates it
// around its own barrel axis - e.g. Math.PI flips it upside down). Start
// with one axis at a time in small steps (e.g. Math.PI / 8) rather than
// guessing a full rotation at once.
const GUN_GRIP_MANUAL_ROTATION = { x: -1.5, y: 0.3, z: 1.5 };

// Position nudge - see the comment above GUN_GRIP_BASE_ROTATION.
const GUN_GRIP_OFFSET = new THREE.Vector3(0, 0.15, -0.05);

// A manual nudge for where a REMOTE participant's muzzle flash/tracer
// spawn (see getMuzzleWorldPosition below), ON TOP OF the gun's own
// measured tip - independent of GUN_GRIP_OFFSET/GUN_GRIP_MANUAL_ROTATION
// above, which move the whole held gun model in the hand. Use this if the
// gun's placement in the hand looks right but the flash still lands slightly
// off its visible tip. In the gun model's own local space: x = left(-)/
// right(+), y = down(-)/up(+), z = back-toward-grip(+)/further-out-past-
// the-muzzle(-).
const REMOTE_MUZZLE_FLASH_MANUAL_OFFSET = new THREE.Vector3(0, 0, 0);

const ANIMATION_CROSSFADE_SECONDS = 0.2;
const MOVEMENT_THRESHOLD = 0.01; // meters between updates below which a participant counts as standing still

// A remote participant's position/yaw used to SNAP straight to whatever
// network.js's 'move' messages last reported (arriving at most every
// SEND_INTERVAL_MS, i.e. ~20Hz) - fine over a perfect connection, but any
// real-world latency/jitter (worse on mobile networks than wired/Wi-Fi)
// meant they visibly teleported between updates instead of walking
// smoothly. Every upsert() now instead retargets a short lerp from
// wherever the model currently IS (not from the previous network snapshot
// - so a late-arriving update never causes a visible pop back) to the
// newly reported position/yaw, played out over this many seconds by
// tick() below. Padded a bit past the raw send interval so ordinary
// jitter (a packet a little later than usual) still finishes smoothly
// rather than visibly pausing at the target while waiting for the next one.
const REMOTE_INTERP_SECONDS = (SEND_INTERVAL_MS / 1000) * 1.3;

// Shortest-path angle lerp (plain THREE.MathUtils.lerp would spin the long
// way around whenever a turn crosses the -PI/PI wrap, e.g. facing 179°
// turning to -179° is a 2° turn, not a 358° one).
function lerpAngle(start, end, t) {
  let delta = (end - start) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  else if (delta < -Math.PI) delta += Math.PI * 2;
  return start + delta * t;
}
const DEATH_DISPLAY_SECONDS = 3; // how long a corpse stays visible after 'player-left' before actually being removed
const FALL_SECONDS = 0.7; // procedural topple duration, well within DEATH_DISPLAY_SECONDS
const FALL_SETTLE_DEPTH = 0.08; // how far the body sinks/settles into the ground as it finishes falling - see the easing note below

// A character model gets a random fall STYLE each death for variety, not
// always the same animation - 'animated' plays the pack's one real Death
// clip (weighted to come up more often, since it's the "proper" one);
// 'forward'/'backward' are procedural topples (pivoted around the root's
// own origin, which sits at the character's feet - see characterModel.js -
// so a 90-degree rotation there is a geometrically correct "pivot at the
// feet and swing to the ground" fall). The capsule fallback has no Death
// clip to draw from, so it always falls procedurally too.
const CHARACTER_FALL_STYLES = ['animated', 'animated', 'forward', 'backward'];

function pickFallStyle(hasDeathClip) {
  if (!hasDeathClip) return Math.random() < 0.5 ? 'forward' : 'backward';
  return CHARACTER_FALL_STYLES[Math.floor(Math.random() * CHARACTER_FALL_STYLES.length)];
}

// Eased rather than linear - a constant-speed rotation reads as a stiff
// plank falling over. This front-loads the rotation (fast, like a body
// actually losing balance under gravity) then eases off toward the ground
// (like the fall arresting against the ground/its own limbs) instead of
// travelling at one constant angular speed the whole way, which is most of
// what "fluid instead of rigid" comes down to for a single rotating rigid
// body with no per-limb physics.
function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}

// Manages a mesh/model for every OTHER connected participant (never the
// local player, who only sees through their own camera) - real players and
// bots alike. Prefers the real, animated character model (see
// characterModel.js); falls back to the old placeholder capsule if that
// model isn't loaded yet (very unlikely in practice - preloading starts as
// soon as the page loads, well before matchmaking finds a match) or failed
// to load.
export function createRemotePlayerManager(scene) {
  const entriesById = new Map(); // id -> { root, mixer, idleAction, moveAction, deathClip, isMoving, lastPosition }
  const dyingEntries = []; // { entry, elapsed } - see remove() below

  // A floating text tag above the character's head - the ONLY
  // identification signal for the real character model path (its
  // materials are shared across every clone - see createCharacterEntry -
  // so they're never retinted per instance the way the capsule fallback
  // can be). A bot's tag is its own callsign (not a generic "BOT" label -
  // still satisfies the same fairness principle: once real value is on the
  // line, silently padding a match with bots that look like real players
  // is a disclosure problem, and a bot callsign pattern reads as
  // obviously bot-like on its own), colored green if it's an ally, red
  // otherwise - so allegiance is visible at a glance without a second
  // stacked tag. A real player gets a green "ALLY" tag only when they are
  // one; nothing at all otherwise (their name isn't shown - no
  // "disclosure" reason to label a real opponent).
  function createTagSprite(text, hexColor, height) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(10, 11, 13, 0.85)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = hexColor;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
    ctx.fillStyle = hexColor;
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(1, 0.25, 1);
    sprite.position.set(0, height, 0); // above the character's head (model is ~1.85m tall)
    sprite.userData.ownedMaterial = true; // has its own canvas texture - safe (and necessary) to dispose per-instance
    return sprite;
  }

  function findClip(clips, name) {
    return clips.find((clip) => clip.name === name) ?? null;
  }

  // The real character model, already ~life-size with feet at y=0 (see
  // characterModel.js). Its materials/geometry are shared across every
  // clone (SkeletonUtils.clone doesn't duplicate them) - cheap, but means
  // they must NEVER be disposed per-instance (see remove() below) since
  // other live instances still reference them. Each instance gets its own
  // AnimationMixer, since each needs to be at a different point in its own
  // idle/run cycle independently.
  function createCharacterEntry(id, isBot, characterVariant, isAlly, callsign) {
    const cloned = cloneCharacterModel(characterVariant);
    if (!cloned) return null;
    const { model, clips } = cloned;

    const mixer = new AnimationMixer(model);
    // A bot standing still is - by bot.js's own design - always in its
    // ATTACK state (patrol never stops moving except to hold position and
    // fire at a target it's found), so "not moving" means "aiming", not
    // "idle" - unlike a real player, who might just be standing around.
    // That's what was meant by "bots are not pointing their gun to shoot":
    // Idle_Gun read as a neutral ready stance, not an aimed one.
    const idleClip = isBot
      ? findClip(clips, 'Idle_Gun_Pointing') ?? findClip(clips, 'Idle_Gun')
      : findClip(clips, 'Idle_Gun') ?? findClip(clips, 'Idle');
    // Bots patrol at BOT_SPEED=4m/s now (was 2/Walk - a plain walking pace
    // read as too passive/unthreatening, per the user's "make bots run not
    // walk") - both bots and real players use the Run clip.
    const moveClip = findClip(clips, 'Run');
    const idleAction = idleClip ? mixer.clipAction(idleClip) : null;
    const moveAction = moveClip ? mixer.clipAction(moveClip) : null;
    idleAction?.setLoop(LoopRepeat).play();
    const deathClip = findClip(clips, 'Death'); // played once on remove() - see the module comment there

    if (isBot) {
      model.add(createTagSprite(callsign ?? 'BOT', isAlly ? '#22c55e' : '#ff4433', 2));
    } else if (isAlly) {
      model.add(createTagSprite('ALLY', '#22c55e', 2));
    }
    scene.add(model);

    // Held weapon - parented directly to the wrist BONE (a real Object3D
    // in the cloned skeleton, not just a named reference) so it inherits
    // that bone's animated transform automatically every frame, same as
    // any other attachment to a rigged joint - no per-frame syncing code
    // needed here at all. Null if the wrist bone isn't found (would mean
    // this pack's rig changed, or GLTFLoader's name-sanitizing behavior
    // changed - see WRIST_BONE_NAME's comment above for why the name isn't
    // simply "Wrist.R" - either way the character should still render
    // without a gun rather than throw) or the weapon template hasn't
    // finished preloading yet (see app.js's preloadRemoteWeaponModel - by
    // the time a match actually starts this is normally already long done).
    const wristBone = model.getObjectByName(WRIST_BONE_NAME);
    let gunMesh = null;
    if (!wristBone) {
      console.warn(`remotePlayers: no "${WRIST_BONE_NAME}" bone found on the ${characterVariant ?? '(bot)'} model - held weapon skipped for id ${id}.`);
    } else {
      gunMesh = cloneRemoteWeaponModel();
      if (!gunMesh) {
        console.warn(`remotePlayers: remote weapon template not loaded yet - held weapon skipped for id ${id}.`);
      } else {
        gunMesh.quaternion.copy(GUN_GRIP_BASE_ROTATION).multiply(
          new THREE.Quaternion().setFromEuler(new THREE.Euler(
            GUN_GRIP_MANUAL_ROTATION.x,
            GUN_GRIP_MANUAL_ROTATION.y,
            GUN_GRIP_MANUAL_ROTATION.z,
          )),
        );
        gunMesh.position.copy(GUN_GRIP_OFFSET);
        wristBone.add(gunMesh);
      }
    }

    return {
      root: model,
      mixer,
      idleAction,
      moveAction,
      deathClip,
      currentAction: idleAction,
      isMoving: false,
      lastPosition: null,
      gunMesh,
      hasReceivedUpdate: false,
      interpFrom: null,
      interpTo: null,
      interpElapsed: 0,
    };
  }

  // Placeholder capsule - used only if the real model isn't available yet.
  // Unlike the shared character model, this mesh owns its geometry and
  // material outright (a fresh instance per call), so it's fully
  // disposable on removal. No animation to drive, so mixer/actions are null
  // - see setMovementState below for how that's handled.
  function createCapsuleEntry(isBot, isAlly, callsign) {
    const geometry = new THREE.CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_LENGTH, 4, 8);
    // Ally takes priority over the plain bot/player color - a teammate
    // should read as friendly even if they happen to be a bot filling out
    // your Coop side.
    const color = isAlly ? ALLY_COLOR : (isBot ? BOT_COLOR : PLAYER_COLOR);
    const material = new THREE.MeshStandardMaterial({ color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.disposable = true;
    mesh.userData.isCapsuleFallback = true;
    if (isBot) {
      mesh.add(createTagSprite(callsign ?? 'BOT', isAlly ? '#22c55e' : '#ff4433', 2));
    } else if (isAlly) {
      mesh.add(createTagSprite('ALLY', '#22c55e', 2));
    }
    scene.add(mesh);
    return {
      root: mesh, mixer: null, idleAction: null, moveAction: null, deathClip: null, currentAction: null, isMoving: false, lastPosition: null, gunMesh: null,
      hasReceivedUpdate: false,
      interpFrom: null,
      interpTo: null,
      interpElapsed: 0,
    };
  }

  // A bot has no account/loadout to pick a variant, so it gets a
  // deterministic-per-id one instead (same id -> same variant for its
  // whole time in the match, but which one varies bot to bot) - visual
  // variety among bots rather than every bot looking identical.
  function pickBotVariant(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
    return CHARACTER_VARIANTS[Math.abs(hash) % CHARACTER_VARIANTS.length];
  }

  function createEntry(id, isBot, characterVariant, isAlly, callsign) {
    const variant = isBot ? pickBotVariant(id) : characterVariant;
    return createCharacterEntry(id, isBot, variant, isAlly, callsign) ?? createCapsuleEntry(isBot, isAlly, callsign);
  }

  // Crossfades from whichever animation is currently playing to the one
  // appropriate for the participant's just-observed movement state -
  // Idle_Gun when their position hasn't meaningfully changed since the last
  // update, Run/Walk when it has. A no-op for the capsule fallback (no
  // actions to play) and a no-op if this particular clip wasn't found in
  // the model (defensive - every variant in the pack ships the same 24
  // clips, but this keeps a missing name from throwing).
  function setMovementState(entry, isMoving) {
    if (entry.isMoving === isMoving) return;
    entry.isMoving = isMoving;

    const nextAction = isMoving ? entry.moveAction : entry.idleAction;
    if (!nextAction || nextAction === entry.currentAction) return;

    nextAction.reset().fadeIn(ANIMATION_CROSSFADE_SECONDS).play();
    entry.currentAction?.fadeOut(ANIMATION_CROSSFADE_SECONDS);
    entry.currentAction = nextAction;
  }

  // Creates a participant's entry if we haven't seen this id before (styled
  // according to isBot/characterVariant/isAlly at creation time only -
  // later upsert() calls for the same id can't change what model they're
  // wearing, same as isBot - fine, since team never changes mid-match),
  // then moves it to their latest reported position/yaw and updates its
  // animation state. Used for the initial match roster and every
  // subsequent move update alike. characterVariant comes from the server
  // (see index.js's ?character= query param on the websocket connection,
  // relayed in match-start/player-moved) - a real player's own choice from
  // the dashboard selector; undefined falls back to characterModel.js's
  // default. isAlly is computed by the CALLER (gameScreen.js), comparing
  // this participant's teamId against the local player's own - this module
  // has no concept of "my own team" - and only ever means anything in Coop
  // (see match.js's modeConfig.teams); everywhere else it's just false.
  function upsert(id, position, yaw, isBot = false, characterVariant, isAlly = false, callsign) {
    let entry = entriesById.get(id);
    if (!entry) {
      entry = createEntry(id, isBot, characterVariant, isAlly, callsign);
      entriesById.set(id, entry);
    }

    if (entry.lastPosition) {
      const dx = position.x - entry.lastPosition.x;
      const dz = position.z - entry.lastPosition.z;
      setMovementState(entry, Math.sqrt(dx * dx + dz * dz) > MOVEMENT_THRESHOLD);
    }
    entry.lastPosition = { x: position.x, z: position.z };

    // We only place on the ground plane (x, z) and ignore the sent y - our
    // world has no jumping/verticality yet, so treating every participant
    // as standing on y=0 keeps them from floating oddly. The capsule
    // fallback needs its center raised to CAPSULE_CENTER_Y to sit on the
    // ground; the real character model is already grounded at its own
    // origin (see characterModel.js), so it uses y=0 directly.
    const groundY = entry.root.userData.isCapsuleFallback ? CAPSULE_CENTER_Y : 0;
    // The Swat model's authored "forward" faces the opposite way from our
    // yaw convention (confirmed in-browser: characters were walking
    // backwards) - the capsule fallback has no visible front, so the
    // offset only applies to the real character model.
    const yawOffset = entry.root.userData.isCapsuleFallback ? 0 : Math.PI;
    const targetYaw = yaw + yawOffset;

    if (!entry.hasReceivedUpdate) {
      // First sighting of this id - nothing to interpolate FROM yet, so
      // place it immediately rather than lerping in from the origin.
      entry.root.position.set(position.x, groundY, position.z);
      entry.root.rotation.y = targetYaw;
      entry.hasReceivedUpdate = true;
    } else {
      // Retarget the lerp from wherever the model is RIGHT NOW (which may
      // be mid-lerp toward the previous update, not necessarily the
      // previous update's own endpoint) - so a new update never causes a
      // visible pop back to some earlier point before smoothing onward.
      entry.interpFrom = { x: entry.root.position.x, z: entry.root.position.z, yaw: entry.root.rotation.y };
      entry.interpTo = { x: position.x, z: position.z, y: groundY, yaw: targetYaw };
      entry.interpElapsed = 0;
    }
  }

  // Actually tears down one corpse's resources - called once
  // DEATH_DISPLAY_SECONDS has elapsed since remove() below, never
  // immediately on death.
  function disposeEntry(entry) {
    const { root } = entry;
    scene.remove(root);
    root.traverse((child) => {
      // Never dispose shared resources (the cached character template's
      // geometry/materials, reused by every other live clone) - only
      // things this specific instance owns outright: the capsule
      // fallback's own geometry/material, and the bot label sprite's
      // canvas texture (always instance-owned, on either path).
      if (!root.userData.disposable && !child.userData.ownedMaterial) return;
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (child.material.map) child.material.map.dispose();
        child.material.dispose();
      }
    });
    entry.mixer?.stopAllAction();
  }

  // Advances every live participant's animation by one frame, and every
  // corpse's death sequence (fall + fade-to-actual-removal) - called from
  // the render loop (see gameScreen.js). A no-op for any entry still on the
  // capsule fallback (mixer is null there).
  function tick(deltaSeconds) {
    for (const entry of entriesById.values()) {
      entry.mixer?.update(deltaSeconds);

      if (entry.interpFrom && entry.interpTo) {
        entry.interpElapsed += deltaSeconds;
        const t = Math.min(entry.interpElapsed / REMOTE_INTERP_SECONDS, 1);
        entry.root.position.set(
          THREE.MathUtils.lerp(entry.interpFrom.x, entry.interpTo.x, t),
          entry.interpTo.y,
          THREE.MathUtils.lerp(entry.interpFrom.z, entry.interpTo.z, t),
        );
        entry.root.rotation.y = lerpAngle(entry.interpFrom.yaw, entry.interpTo.yaw, t);
        if (t >= 1) entry.interpFrom = null; // arrived - nothing left to advance until the next upsert() retargets it
      }
    }

    for (let i = dyingEntries.length - 1; i >= 0; i--) {
      const dying = dyingEntries[i];
      dying.elapsed += deltaSeconds;

      if (dying.elapsed >= DEATH_DISPLAY_SECONDS) {
        disposeEntry(dying.entry);
        dyingEntries.splice(i, 1);
        continue;
      }

      if (dying.style === 'animated') {
        // Plays the Death clip out (see remove() below) - this entry was
        // already removed from entriesById by remove(), so the loop above
        // no longer reaches it; this is its only mixer update per frame.
        dying.entry.mixer.update(deltaSeconds);
        continue;
      }

      // Procedural topple (forward or backward - see CHARACTER_FALL_STYLES),
      // capped at 90 degrees so it doesn't keep rotating through the
      // remaining display time. Pivots around the root's own origin:
      // feet-level (y=0) for the real character model (see the module
      // comment on CHARACTER_FALL_STYLES for why that needs no further
      // position correction), center-height for the capsule fallback
      // (which DOES need one, since its origin is at CAPSULE_CENTER_Y, not
      // its base). The eased rotation plus a small extra downward "settle"
      // as it finishes (the body sinking slightly into the ground, on top
      // of the pivot itself) are what read as fluid rather than a stiff
      // plank falling at constant speed - see easeOutCubic above.
      const linearProgress = Math.min(dying.elapsed / FALL_SECONDS, 1);
      const fallProgress = easeOutCubic(linearProgress);
      const angle = (Math.PI / 2) * fallProgress * dying.fallDirection;
      dying.entry.root.rotation.x = angle;

      const settle = -FALL_SETTLE_DEPTH * fallProgress;
      if (dying.entry.root.userData.isCapsuleFallback) {
        dying.entry.root.position.y = CAPSULE_CENTER_Y * (1 - fallProgress) + CAPSULE_RADIUS * fallProgress + settle;
      } else {
        dying.entry.root.position.y = settle;
      }
    }
  }

  // A participant's match ended (elimination, disconnect, or the match
  // resolving around them - see match.js's broadcastToOthers calls) - was
  // an instant disappearance before; now plays a death animation (a fall
  // for the capsule fallback, since it has no Death clip) and keeps the
  // corpse visible for DEATH_DISPLAY_SECONDS before actually tearing it
  // down (see the dyingEntries loop in tick() above). Removed from
  // entriesById immediately either way, since match ids are never reused -
  // a later upsert() for this same id within the same match never happens.
  function remove(id) {
    const entry = entriesById.get(id);
    if (!entry) return;
    entriesById.delete(id);

    const style = pickFallStyle(Boolean(entry.deathClip));

    if (style === 'animated') {
      const deathAction = entry.mixer.clipAction(entry.deathClip);
      deathAction.setLoop(LoopOnce);
      deathAction.clampWhenFinished = true;
      deathAction.reset().fadeIn(ANIMATION_CROSSFADE_SECONDS).play();
      entry.currentAction?.fadeOut(ANIMATION_CROSSFADE_SECONDS);
      entry.currentAction = deathAction;
    }

    const fallDirection = style === 'backward' ? -1 : 1;
    // id is carried along even though nothing in tick()'s own processing
    // needs it - respawn() below uses it to find and cancel THIS specific
    // corpse if the same id needs to reappear before its fall finishes.
    dyingEntries.push({
      id, entry, elapsed: 0, style, fallDirection,
    });
  }

  // A mid-match respawn (Coop's 2 lives, Private's unlimited - see
  // match.js's respawnPlayer/'player-respawned') - unlike a normal death,
  // this id is coming right back, so it can't just wait out the normal
  // DEATH_DISPLAY_SECONDS fall like a permanent elimination does. Cancels
  // whatever's left of this id's previous life FIRST (its corpse mid-fall,
  // if the death animation hasn't finished yet - normal removal already
  // happened via remove()/'player-left', so entriesById itself should
  // already be clear, but is checked too, defensively) so the fresh upsert
  // below can never end up rendering two instances of the same id at once.
  function respawn(id, position, yaw, isBot, characterVariant, isAlly, callsign) {
    const dyingIndex = dyingEntries.findIndex((dying) => dying.id === id);
    if (dyingIndex !== -1) {
      disposeEntry(dyingEntries[dyingIndex].entry);
      dyingEntries.splice(dyingIndex, 1);
    }
    const stale = entriesById.get(id);
    if (stale) {
      disposeEntry(stale);
      entriesById.delete(id);
    }

    upsert(id, position, yaw, isBot, characterVariant, isAlly, callsign);
  }

  // The real world position of this participant's gun muzzle right now -
  // used by gameScreen.js's 'shot-fired' handler so a remote participant's
  // muzzle flash/tracer spawns from their actual held weapon instead of an
  // approximate point near their reported position. Returns null if this
  // id has no entry (already removed) or no gun (capsule fallback, or the
  // weapon template hadn't finished preloading when they were created) -
  // callers should fall back to the server-reported shot origin in that case.
  function getMuzzleWorldPosition(id, target) {
    const entry = entriesById.get(id);
    if (!entry?.gunMesh) return null;
    target.set(
      REMOTE_MUZZLE_FLASH_MANUAL_OFFSET.x,
      REMOTE_MUZZLE_FLASH_MANUAL_OFFSET.y,
      getRemoteWeaponMuzzleOffsetZ() + REMOTE_MUZZLE_FLASH_MANUAL_OFFSET.z,
    );
    entry.gunMesh.updateMatrixWorld(true);
    entry.gunMesh.localToWorld(target);
    return target;
  }

  return {
    upsert, remove, respawn, tick, getMuzzleWorldPosition,
  };
}
