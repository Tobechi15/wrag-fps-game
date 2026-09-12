// Small shared toast used across pages for "this isn't built yet" clicks
// (dashboard customization/game-mode placeholders, etc). A `data-placeholder`
// attribute's VALUE becomes the toast message; leave it empty for a
// generic fallback.
const DEFAULT_MESSAGE = 'Not connected yet — coming in a future update.';

export function showToast(message) {
  let toast = document.getElementById('placeholder-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'placeholder-toast';
    toast.className = 'placeholder-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toast._hideTimeout);
  toast._hideTimeout = setTimeout(() => toast.classList.remove('visible'), 2200);
}

export function wirePlaceholderLinks() {
  document.querySelectorAll('[data-placeholder]').forEach((el) => {
    el.addEventListener('click', (event) => {
      event.preventDefault();
      showToast(el.dataset.placeholder || DEFAULT_MESSAGE);
    });
  });
}
