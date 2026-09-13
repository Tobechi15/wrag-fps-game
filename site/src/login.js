import { login } from './auth-client.js';
import { registerServiceWorker } from './registerServiceWorker.js';

registerServiceWorker();

const form = document.getElementById('login-form');
const errorEl = document.getElementById('auth-error');
const submitBtn = form.querySelector('.auth-submit');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.hidden = true;

  const formData = new FormData(form);
  const email = formData.get('email');
  const password = formData.get('password');

  submitBtn.disabled = true;
  submitBtn.textContent = 'Logging In...';

  try {
    await login(email, password);
    window.location.href = '/'; // back to the landing page, now logged in
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Log In';
  }
});
