import * as THREE from 'three';
import { fetchCurrentUser, fetchPlayToken, logout } from './auth-client.js';
import { fetchDashboardSummary, depositToWallet } from './dashboard-client.js';
import { wirePlaceholderLinks, showToast } from './toast.js';
import { loadCharacterPreview } from './characterPreview.js';
import { createAudioManager } from './audio.js';
import { registerServiceWorker } from './registerServiceWorker.js';

registerServiceWorker();

// The actual, already-working game client (Part A). The dashboard's Play
// button fetches a one-time token first (see auth-client.js's
// fetchPlayToken) so the game server can attach this match's result to the
// real account instead of playing fully anonymously. VITE_GAME_CLIENT_URL
// (see .env.example) is the real deployed client's URL, baked in at build
// time - set as a Vercel project env var; falls back to the local dev
// default when unset.
const GAME_CLIENT_URL = import.meta.env.VITE_GAME_CLIENT_URL ?? 'http://127.0.0.1:5173/';

const ROTATION_SPEED = 0.4; // radians/second
const BOB_AMPLITUDE = 0.035;
const BOB_SPEED = 1.1;
const CAMERA_ORBIT_RANGE = 0.9; // how far the camera drifts toward the cursor

async function initDashboard() {
  const user = await fetchCurrentUser();
  if (!user) {
    window.location.href = '/login.html';
    return;
  }

  document.getElementById('dash-callsign').textContent = user.callsign;
  document.getElementById('dashboard-ui').hidden = false;
  // See .env.example's ADMIN_EMAILS - only an account flagged is_admin
  // ever sees this link at all (the /admin.html page itself re-checks the
  // same flag server-side, so hiding this is a convenience, not the
  // actual gate).
  document.getElementById('nav-admin-link').hidden = !user.isAdmin;

  document.getElementById('dash-logout').addEventListener('click', async () => {
    await logout();
    window.location.href = '/';
  });

  wireDeployButton();
  wirePlayModeSelector();
  wireTabRow('mode-tabs');
  wireStatsToggle();
  wireDockToggle();
  wirePlaceholderLinks();
  wireDepositModal();
  // The stage needs to exist before the selector can tell it to swap
  // models on a click - startCharacterStage() returns a handle exposing
  // updatePreview() for exactly that.
  const stage = startCharacterStage();
  wireLoadoutSelector(stage.updatePreview);
  loadDashboardSummary();

  // Every browser requires a user gesture on THIS page before it'll let
  // audio actually play - calling playMusic() here, immediately on page
  // load, has no gesture to point to yet (a click on the previous page,
  // e.g. login's submit button, doesn't carry over), so the browser
  // silently rejects it and audio.js's own .catch(() => {}) swallows that
  // with no visible sign anything failed. Try immediately anyway (harmless
  // if blocked, and covers a browser that's lenient about it, or a real
  // click already in flight), but ALSO start on the first genuine
  // interaction with this page - whichever happens first actually starts
  // the music, and the deferred listener otherwise never fires again.
  const audio = createAudioManager();
  audio.playMusic();
  const startMusicOnFirstInteraction = () => {
    audio.playMusic(); // idempotent - playMusic() itself no-ops if music is already going
    document.removeEventListener('click', startMusicOnFirstInteraction);
    document.removeEventListener('keydown', startMusicOnFirstInteraction);
    document.removeEventListener('touchstart', startMusicOnFirstInteraction);
  };
  document.addEventListener('click', startMusicOnFirstInteraction);
  document.addEventListener('keydown', startMusicOnFirstInteraction);
  document.addEventListener('touchstart', startMusicOnFirstInteraction);
}

// Fetches a one-time play token, then navigates into the real game client
// with it attached. If the token request fails (API/DB hiccup), falls back
// to plain anonymous play rather than blocking the player entirely - a
// broken account link shouldn't mean you can't play at all. The loadout
// selector's picks (see wireLoadoutSelector) ride along on the same URL -
// character needs to reach the game SERVER (other players in the match see
// your pick), gun only ever affects your own first-person view, but both
// are simplest to hand off the same way as the token.
function wireDeployButton() {
  const deployBtn = document.getElementById('deploy-btn');
  deployBtn.addEventListener('click', async (event) => {
    event.preventDefault();
    const loadoutParams = new URLSearchParams();
    const character = localStorage.getItem('wrag.characterVariant');
    const gun = localStorage.getItem('wrag.gunVariant');
    if (character) loadoutParams.set('character', character);
    if (gun) loadoutParams.set('gun', gun);
    // Which Play Mode tab is selected (see wirePlayModeSelector) - always
    // set explicitly, including the 'versus' default, so the game client
    // never has to guess what mode to start (see client/src/app.js).
    loadoutParams.set('mode', localStorage.getItem('wrag.playMode') ?? 'versus');

    try {
      const token = await fetchPlayToken();
      loadoutParams.set('token', token);
      window.location.href = `${GAME_CLIENT_URL}?${loadoutParams.toString()}`;
    } catch (err) {
      console.error('Could not get a play token, deploying anonymously:', err);
      showToast('Could not link this match to your account - deploying anonymously.');
      const query = loadoutParams.toString();
      window.location.href = query ? `${GAME_CLIENT_URL}?${query}` : GAME_CLIENT_URL;
    }
  });
}

// Demo/dev balance top-up (see server/src/api/wallet.js and account.js's
// matching copy of this wiring) - a fixed set of preset amounts, no
// free-form input, so this stays an obvious demo action.
function wireDepositModal() {
  const modal = document.getElementById('deposit-modal');
  const errorEl = document.getElementById('deposit-error');

  const openModal = () => {
    errorEl.hidden = true;
    modal.hidden = false;
  };
  const closeModal = () => { modal.hidden = true; };

  document.getElementById('deposit-btn').addEventListener('click', openModal);
  document.getElementById('deposit-cancel-btn').addEventListener('click', closeModal);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal(); // click on the backdrop itself, not the panel
  });

  document.querySelectorAll('.deposit-amount-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      errorEl.hidden = true;
      btn.disabled = true;
      try {
        await depositToWallet(Number(btn.dataset.amount));
        closeModal();
        await loadDashboardSummary(); // refreshes the nav balance badge with the new total
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });
  });
}

// Real stats + recent match history from the matches table, replacing the
// placeholder numbers this page shipped with before match recording existed.
async function loadDashboardSummary() {
  const summary = await fetchDashboardSummary();
  if (!summary) return; // API/DB hiccup - leave the zeroed placeholders rather than crash the page

  document.getElementById('dash-matches-played').textContent = summary.stats.totalMatches;
  document.getElementById('dash-stat-kills').textContent = summary.stats.totalKills;
  document.getElementById('dash-stat-extractions').textContent = summary.stats.successfulMatches;
  document.getElementById('dash-stat-rate').textContent = `${summary.stats.extractionRate}%`;
  document.getElementById('dash-stat-earned').textContent = summary.stats.totalEarned.toLocaleString('en-US');

  // Quick-glance balance in the nav badge - the full Wallet card (with the
  // Withdraw action) lives on the account page now, not here. This is the
  // REAL, spendable `users.balance` (see server/src/economy/wallet.js) -
  // NOT the same number as the "Total Earned" stat above anymore, now that
  // Versus/Coop/Private entry stakes actually deduct from it.
  const balanceText = summary.balance.toLocaleString('en-US');
  document.getElementById('nav-balance').innerHTML = `${balanceText} <span class="unit">PTS</span>`;

  const historyEl = document.getElementById('mini-history');
  if (summary.recentMatches.length === 0) return; // the "no matches yet" placeholder row already covers this

  historyEl.innerHTML = '';
  for (const match of summary.recentMatches) {
    const row = document.createElement('div');
    row.className = 'mini-history-row';
    const isWin = match.result !== 'eliminated';
    const resultLabel = match.result === 'eliminated' ? 'Eliminated' : `+${match.finalPot}`;
    row.innerHTML = `
      <span>${formatResultName(match.result)} · #${match.rank}/${match.totalPlayers}</span>
      <span class="${isWin ? 'success' : 'danger'}">${resultLabel}</span>
    `;
    historyEl.appendChild(row);
  }
}

function formatResultName(result) {
  const names = {
    eliminated: 'Eliminated',
    'last-standing': 'Last Standing',
    'time-limit': 'Time Expired',
  };
  return names[result] || result;
}

// The real Play Mode picker - Battle Royale (Versus, the full-width
// "main" tab) plus Co-op/Private/Survival in the row below it, all one
// mutually-exclusive group despite the two different tab styles (see
// dashboard.css's .playmode-main/.playmode-secondary). Persisted the same
// way the loadout picks are (localStorage, read back by wireDeployButton
// when building the game client URL) so the choice survives a page
// refresh, defaulting to Battle Royale/'versus' the first time a player
// visits.
function wirePlayModeSelector() {
  const mainBtn = document.querySelector('.playmode-main');
  const secondaryButtons = Array.from(document.querySelectorAll('#playmode-tabs .tab-btn'));
  if (!mainBtn) return;
  const allButtons = [mainBtn, ...secondaryButtons];

  // .playmode-main ships with `active` already set in the static HTML
  // (dashboard.html) so Battle Royale reads as selected before any JS runs
  // at all - but that meant this on-load initialization only ever ADDED
  // `active` to whichever mode was actually stored, never removing it from
  // that hardcoded starting point first. A returning player with anything
  // OTHER than 'versus' stored (e.g. Co-op) ended up with BOTH buttons
  // showing active at once. Clearing every button first, exactly like the
  // click handler below already does, is what actually enforces "one at a
  // time" - adding to the right one alone was never enough on its own.
  const stored = localStorage.getItem('wrag.playMode');
  const initiallyActive = allButtons.find((btn) => btn.dataset.mode === stored) ?? mainBtn;
  allButtons.forEach((btn) => btn.classList.remove('active'));
  initiallyActive.classList.add('active');
  if (!stored) localStorage.setItem('wrag.playMode', initiallyActive.dataset.mode);

  allButtons.forEach((button) => {
    button.addEventListener('click', () => {
      allButtons.forEach((btn) => btn.classList.remove('active'));
      button.classList.add('active');
      localStorage.setItem('wrag.playMode', button.dataset.mode);
    });
  });
}

// Cosmetic only for now - these represent stake tiers that don't have real
// content behind them yet ("make room for" them, per the brief - the
// structure exists, the systems don't). Unrelated to Play Mode above -
// this is the separate Standard/High Stakes row (#mode-tabs).
function wireTabRow(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll('.tab-btn:not(:disabled)').forEach((tab) => {
    tab.addEventListener('click', () => {
      container.querySelectorAll('.tab-btn').forEach((el) => el.classList.remove('active'));
      tab.classList.add('active');
    });
  });
}

// The real Character/Weapon selector: picks are persisted in localStorage
// (this origin only - the game client runs on a different port/origin, so
// it can't read this storage directly, which is why wireDeployButton reads
// the same keys back out and passes them along on the URL instead) and
// default to each group's first option (Swat / Assault Rifle) the first
// time a player visits. Clicking a loadout tab (Character/Weapon) swaps
// which option group is visible - separate from wireTabRow's generic
// active-highlight behavior, since this dock also needs to show/hide a
// whole panel, not just restyle the clicked tab. `onSelectionChanged` (the
// character stage's updatePreview - see initDashboard) fires after every
// pick, character or gun alike, since either one changes what the live
// preview should show.
function wireLoadoutSelector(onSelectionChanged) {
  const tabsContainer = document.getElementById('loadout-tabs');
  if (!tabsContainer) return;

  const optionGroups = document.querySelectorAll('.loadout-options');
  optionGroups.forEach((group) => {
    const storageKey = group.dataset.storageKey;
    const options = Array.from(group.querySelectorAll('.loadout-option'));
    const stored = localStorage.getItem(storageKey);
    const initiallyActive = options.find((btn) => btn.dataset.value === stored) ?? options[0];
    initiallyActive.classList.add('active');
    if (!stored) localStorage.setItem(storageKey, initiallyActive.dataset.value);

    options.forEach((option) => {
      option.addEventListener('click', () => {
        options.forEach((btn) => btn.classList.remove('active'));
        option.classList.add('active');
        localStorage.setItem(storageKey, option.dataset.value);
        onSelectionChanged?.();
      });
    });
  });

  tabsContainer.querySelectorAll('.tab-btn').forEach((tab) => {
    tab.addEventListener('click', () => {
      tabsContainer.querySelectorAll('.tab-btn').forEach((el) => el.classList.remove('active'));
      tab.classList.add('active');
      const targetPanelId = tab.dataset.panel;
      optionGroups.forEach((group) => { group.hidden = group.id !== targetPanelId; });
    });
  });
}

// Mobile dock switcher (see dashboard.css's max-width:1000px block) - only
// meaningful below that breakpoint, where dashboard.html marks dock-left/
// dock-profile with a `dock-collapsed` class up front (dock-right, the
// Play Mode/Deploy dock, starts the one visible one - it holds the primary
// "Play Now" action). Replaces the old approach of squeezing all three
// panels onto the screen at once at half their intended width, which is
// what was actually causing the clutter/overlap - the panels' own content
// never got any smaller, so shrinking their BOX just meant that content
// overflowed it. Above the breakpoint this class has no effect at all
// (dashboard.css only defines `.dock-collapsed { display: none }` inside
// the media query), so a desktop window resized narrower then wider again
// always ends up with every dock visible, regardless of this class.
function wireDockToggle() {
  const toggleButtons = Array.from(document.querySelectorAll('.dock-toggle-btn'));
  const docks = Array.from(document.querySelectorAll('.dock'));
  if (toggleButtons.length === 0) return;

  function showOnly(dockClass) {
    docks.forEach((dock) => dock.classList.toggle('dock-collapsed', !dock.classList.contains(dockClass)));
    toggleButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.dock === dockClass));
  }

  toggleButtons.forEach((button) => {
    button.addEventListener('click', () => {
      // Tapping the already-open dock's own button closes it (leaving
      // none open, e.g. to see the character stage unobstructed) - a real
      // show/hide toggle per button, not just an exclusive tab switcher.
      if (button.classList.contains('active')) {
        docks.forEach((dock) => dock.classList.add('dock-collapsed'));
        toggleButtons.forEach((btn) => btn.classList.remove('active'));
      } else {
        showOnly(button.dataset.dock);
      }
    });
  });
}

function wireStatsToggle() {
  const toggleBtn = document.getElementById('stats-toggle');
  const labelEl = document.getElementById('stats-toggle-label');
  const panel = document.getElementById('stats-panel');
  if (!toggleBtn || !panel) return;

  toggleBtn.addEventListener('click', () => {
    const isHidden = panel.hidden;
    panel.hidden = !isHidden;
    labelEl.textContent = isHidden ? 'Hide Stats & History' : 'View Stats & History';
  });
}

// The centerpiece: the player's actual chosen character+gun (see
// characterPreview.js), slowly rotating on a glowing pedestal, center-
// frame, playing its idle-aiming animation - a live preview of exactly
// what they'll look like in-match, not a placeholder. Returns
// { updatePreview } so wireLoadoutSelector can tell it to swap models
// whenever the player picks something different.
function startCharacterStage() {
  const root = document.getElementById('stage-root');

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  root.appendChild(renderer.domElement);

  const scene = new THREE.Scene(); // no background - the page's own dark bg shows through the transparent canvas

  const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 100);
  const cameraTarget = new THREE.Vector3(0, 1.05, 0);
  const cameraBasePosition = new THREE.Vector3(0, 1.5, 4.2);
  camera.position.copy(cameraBasePosition);
  camera.lookAt(cameraTarget);

  // Lighting: a soft ambient fill, a warm key light from the front-above,
  // and an accent-colored rim light from behind to catch the silhouette -
  // the "premium spotlight" look rather than flat, even lighting.
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
  keyLight.position.set(2, 4, 3);
  scene.add(keyLight);

  const rimLight = new THREE.PointLight(0xff6a3d, 6, 8);
  rimLight.position.set(-1.5, 1.8, -2);
  scene.add(rimLight);

  const fillLight = new THREE.PointLight(0x3b82f6, 2.5, 8);
  fillLight.position.set(1.8, 1, -1.5);
  scene.add(fillLight);

  // The live preview swaps out entirely on every selection change (see
  // updatePreview below) - `character` is a stable wrapper Group that the
  // rotate/bob animation always applies to, so swapping its contents never
  // has to touch that logic. `currentPreview` tracks the loaded
  // model+mixer+dispose for whatever's showing now, so it can be torn down
  // cleanly before the next one loads in.
  const character = new THREE.Group();
  scene.add(character);
  let currentPreview = null;
  let loadToken = 0; // guards against a slow earlier load clobbering a faster later one if the player clicks around quickly

  async function updatePreview() {
    const characterKey = localStorage.getItem('wrag.characterVariant') ?? 'Swat';
    const gunKey = localStorage.getItem('wrag.gunVariant') ?? 'AssaultRifle_1';
    const thisLoad = ++loadToken;

    let preview;
    try {
      preview = await loadCharacterPreview(characterKey, gunKey);
    } catch (err) {
      console.error(`Failed to load character preview (${characterKey}/${gunKey}):`, err);
      return;
    }
    if (thisLoad !== loadToken) {
      // A newer selection was made while this one was still loading -
      // discard it unused rather than showing a stale pick.
      preview.dispose();
      return;
    }

    currentPreview?.dispose();
    character.clear();
    character.add(preview.group);
    currentPreview = preview;
  }

  updatePreview();

  // --- Pedestal: a physical platform plus a pulsing glow ring.
  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 0.95, 0.12, 48),
    new THREE.MeshStandardMaterial({ color: 0x15171b, metalness: 0.3, roughness: 0.6 }),
  );
  scene.add(pedestal);

  const glowRingMaterial = new THREE.MeshBasicMaterial({
    color: 0xff6a3d,
    transparent: true,
    opacity: 0.6,
    side: THREE.DoubleSide,
  });
  const glowRing = new THREE.Mesh(new THREE.RingGeometry(0.92, 1.02, 64), glowRingMaterial);
  glowRing.rotation.x = -Math.PI / 2;
  glowRing.position.y = 0.061;
  scene.add(glowRing);

  // Mouse-driven camera orbit: the camera drifts gently toward the cursor,
  // consistent with the tilt/parallax interactivity established on the
  // landing page - lets you "look around" the character a little.
  let targetOffsetX = 0;
  let targetOffsetY = 0;
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!prefersReducedMotion) {
    window.addEventListener('mousemove', (event) => {
      targetOffsetX = (event.clientX / window.innerWidth - 0.5) * CAMERA_ORBIT_RANGE;
      targetOffsetY = (event.clientY / window.innerHeight - 0.5) * CAMERA_ORBIT_RANGE * 0.4;
    });
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const clock = new THREE.Clock();

  function animate() {
    requestAnimationFrame(animate);
    const deltaSeconds = clock.getDelta();
    const elapsedSeconds = clock.getElapsedTime();

    character.rotation.y += ROTATION_SPEED * deltaSeconds;
    character.position.y = Math.sin(elapsedSeconds * BOB_SPEED) * BOB_AMPLITUDE;
    currentPreview?.tick(deltaSeconds);

    glowRingMaterial.opacity = 0.45 + Math.sin(elapsedSeconds * 1.6) * 0.2;

    // Smoothly ease the camera toward the mouse-driven offset rather than
    // snapping - a small lerp each frame reads as "gliding", not jittery.
    camera.position.x += (cameraBasePosition.x + targetOffsetX - camera.position.x) * 0.05;
    camera.position.y += (cameraBasePosition.y + targetOffsetY - camera.position.y) * 0.05;
    camera.lookAt(cameraTarget);

    renderer.render(scene, camera);
  }

  animate();

  return { updatePreview };
}

initDashboard();
