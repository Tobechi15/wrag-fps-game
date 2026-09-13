import { fetchCurrentUser, updateCallsign, changePassword } from './auth-client.js';
import { fetchDashboardSummary, depositToWallet } from './dashboard-client.js';
import { wirePlaceholderLinks } from './toast.js';
import { registerServiceWorker } from './registerServiceWorker.js';

registerServiceWorker();

async function initAccountPage() {
  const user = await fetchCurrentUser();
  if (!user) {
    window.location.href = '/login.html';
    return;
  }

  document.getElementById('account-email').textContent = user.email;
  document.getElementById('account-created').textContent = new Date(user.createdAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  document.querySelector('#callsign-form [name="callsign"]').value = user.callsign;

  wireCallsignForm();
  wirePasswordForm();
  wirePlaceholderLinks();
  wireDepositModal();
  loadWalletBalance();
}

// The REAL, spendable balance - same users.balance figure the dashboard's
// nav badge shows (see server/src/economy/wallet.js/api/dashboard.js) - NOT
// the "Total Earned" lifetime stat, now that Versus/Coop/Private entry
// stakes actually deduct from it.
async function loadWalletBalance() {
  const summary = await fetchDashboardSummary();
  if (!summary) return;
  const balanceText = summary.balance.toLocaleString('en-US');
  document.getElementById('wallet-balance').innerHTML = `${balanceText} <span class="unit">PTS</span>`;
}

// Demo/dev balance top-up (see server/src/api/wallet.js) - a fixed set of
// preset amounts, no free-form input, so this stays an obvious demo action
// rather than resembling a real checkout flow.
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
        await loadWalletBalance();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });
  });
}

function wireCallsignForm() {
  const form = document.getElementById('callsign-form');
  const errorEl = document.getElementById('callsign-error');
  const successEl = document.getElementById('callsign-success');
  const submitBtn = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.hidden = true;
    successEl.hidden = true;

    const callsign = new FormData(form).get('callsign');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    try {
      await updateCallsign(callsign);
      successEl.hidden = false;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save Callsign';
    }
  });
}

function wirePasswordForm() {
  const form = document.getElementById('password-form');
  const errorEl = document.getElementById('password-error');
  const successEl = document.getElementById('password-success');
  const submitBtn = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.hidden = true;
    successEl.hidden = true;

    const formData = new FormData(form);
    const currentPassword = formData.get('currentPassword');
    const newPassword = formData.get('newPassword');

    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    try {
      await changePassword(currentPassword, newPassword);
      successEl.hidden = false;
      form.reset();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Change Password';
    }
  });
}

initAccountPage();
