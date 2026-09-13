// Registers sw.js (see site/public/sw.js) - imported once from every page's
// own entry script (main.js/login.js/signup.js/dashboard.js/account.js/
// admin.js) rather than duplicated inline in each, since it's the exact
// same call everywhere. Guarded on browser support (older browsers/some
// embedded webviews have no navigator.serviceWorker at all) and wrapped so
// a registration failure never breaks the page it's called from - this is
// purely what makes "Add to Home Screen" a real install prompt instead of
// just a shortcut, not something any page's own functionality depends on.
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.error('Service worker registration failed:', err);
    });
  });
}
