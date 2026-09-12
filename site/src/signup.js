import { signup } from './auth-client.js';

const form = document.getElementById('signup-form');
const errorEl = document.getElementById('auth-error');
const submitBtn = form.querySelector('.auth-submit');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.hidden = true;

  const formData = new FormData(form);
  const callsign = formData.get('callsign');
  const email = formData.get('email');
  const password = formData.get('password');

  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating Account...';

  try {
    await signup(email, password, callsign);
    window.location.href = '/'; // back to the landing page, now logged in
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Account';
  }
});
