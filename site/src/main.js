import { fetchCurrentUser, logout } from './auth-client.js';
import { wirePlaceholderLinks } from './toast.js';

// Motion layer for the landing page: live-match panel ticking, scroll
// reveal, 3D mouse-tilt on cards, and a parallax hero background - the
// "flashy, 3D-feeling" pass the user asked for after the first restrained
// version felt too flat/static.

// Shows the logged-in nav (callsign + Log Out) instead of Log In, if a
// session already exists - checked once on load via the same /api/auth/me
// the login/signup pages use. Also points every "Play Now" button (nav,
// hero, final CTA) at the right real destination: the dashboard if you're
// already logged in, or signup if you're not - no more dead placeholder
// links now that both destinations actually exist.
async function initAuthNav() {
  const signedOut = document.getElementById('nav-actions-signed-out');
  const signedIn = document.getElementById('nav-actions-signed-in');
  const callsignEl = document.getElementById('nav-callsign');
  const logoutBtn = document.getElementById('nav-logout');

  const user = await fetchCurrentUser();
  const playDestination = user ? '/dashboard.html' : '/signup.html';
  document.querySelectorAll('.play-now-btn').forEach((el) => {
    el.href = playDestination;
  });

  if (!signedOut || !signedIn) return;

  if (user) {
    callsignEl.textContent = user.callsign;
    signedOut.hidden = true;
    signedIn.hidden = false;
  }

  logoutBtn?.addEventListener('click', async () => {
    await logout();
    window.location.reload();
  });
}

function formatCountdown(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function startLiveMatchDemo() {
  const timerEl = document.getElementById('live-timer');
  const potEl = document.getElementById('live-pot');
  if (!timerEl || !potEl) return;

  let secondsRemaining = 8 * 60 + 42;
  let pot = 2400;

  setInterval(() => {
    secondsRemaining = secondsRemaining > 0 ? secondsRemaining - 1 : 8 * 60 + 42;
    timerEl.textContent = formatCountdown(secondsRemaining);

    // Occasionally bump the pot to suggest a live, progressing match.
    if (Math.random() < 0.15) {
      pot += Math.floor(Math.random() * 40) + 10;
      potEl.textContent = pot.toLocaleString('en-US');
    }
  }, 1000);
}

// Fades/lifts each .reveal element in once it scrolls into view, staggering
// siblings slightly so groups (like the how-it-works steps) don't all pop
// in at the exact same instant. Restrained per the design brief - runs
// once per element, no scroll-jank re-triggering.
function startScrollReveal() {
  const elements = document.querySelectorAll('.reveal');
  if (elements.length === 0) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry, index) => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      setTimeout(() => el.classList.add('visible'), index * 60);
      observer.unobserve(el);
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });

  elements.forEach((el) => observer.observe(el));
}

// 3D tilt-on-hover for .tilt elements: rotates toward the cursor position
// within the element, with a touch of translateZ "lift". Disabled when the
// user prefers reduced motion.
function startTiltEffect() {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) return;

  const MAX_DEGREES = 16;
  document.querySelectorAll('.tilt').forEach((el) => {
    el.addEventListener('mousemove', (event) => {
      const rect = el.getBoundingClientRect();
      const relativeX = (event.clientX - rect.left) / rect.width - 0.5;
      const relativeY = (event.clientY - rect.top) / rect.height - 0.5;
      const rotateY = (relativeX * MAX_DEGREES).toFixed(2);
      const rotateX = (-relativeY * MAX_DEGREES).toFixed(2);
      el.style.transform = `perspective(700px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateZ(30px) scale(1.03)`;
    });
    el.addEventListener('mouseleave', () => {
      el.style.transform = '';
    });
  });
}

// Parallax on the hero's grid backdrop and glow orbs - each layer moves at
// a different rate as you scroll, the classic multi-layer depth cue that
// sells "3D" on an otherwise flat page. Throttled to one update per frame.
function startHeroParallax() {
  const backdrop = document.querySelector('.hero-backdrop');
  const glow1 = document.querySelector('.hero-glow-1');
  const glow2 = document.querySelector('.hero-glow-2');
  if (!backdrop) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = window.scrollY;
      backdrop.style.transform = `translateY(${y * 0.35}px)`;
      // Glow orbs already own `transform` via their CSS drift animation
      // (see .glow-orb/@keyframes orb-drift) - using margin here instead
      // avoids the two systems fighting over the same property each frame.
      if (glow1) glow1.style.marginTop = `${y * 0.15}px`;
      if (glow2) glow2.style.marginTop = `${y * -0.2}px`;
      ticking = false;
    });
  });
}

// The hero glow orbs also drift gently toward the cursor - a second,
// pointer-driven depth layer on top of the scroll parallax.
function startHeroMouseParallax() {
  const hero = document.querySelector('.hero');
  const glow1 = document.querySelector('.hero-glow-1');
  const glow2 = document.querySelector('.hero-glow-2');
  if (!hero || (!glow1 && !glow2)) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  hero.addEventListener('mousemove', (event) => {
    const rect = hero.getBoundingClientRect();
    const relativeX = (event.clientX - rect.left) / rect.width - 0.5;
    const relativeY = (event.clientY - rect.top) / rect.height - 0.5;
    if (glow1) {
      glow1.style.marginLeft = `${relativeX * 40}px`;
      glow1.style.marginTop = `${relativeY * 40}px`;
    }
    if (glow2) {
      glow2.style.marginLeft = `${relativeX * -30}px`;
      glow2.style.marginTop = `${relativeY * -30}px`;
    }
  });
}

startLiveMatchDemo();
wirePlaceholderLinks();
startScrollReveal();
startTiltEffect();
startHeroParallax();
startHeroMouseParallax();
initAuthNav();
