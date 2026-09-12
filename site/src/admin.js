import { fetchCurrentUser } from './auth-client.js';
import {
  fetchHouseLedger, fetchLiveStats, fetchAdminUsers, fetchAdminMatches, adjustUserBalance,
} from './admin-client.js';

const format = (n) => n.toLocaleString('en-US');

const RESULT_NAMES = {
  eliminated: 'Eliminated',
  'last-standing': 'Last Standing',
  'team-victory': 'Team Victory',
  'time-limit': 'Time Expired',
};
function formatResultName(result) {
  return RESULT_NAMES[result] ?? result;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// callsign/email are USER-CHOSEN strings (see server/src/auth/routes.js's
// signup - the email pattern in particular allows '<'/'>' in the local
// part, so an email is just as capable of carrying an HTML payload as a
// callsign is) - every row below interpolates them into innerHTML for
// simplicity, so this escape is the one thing standing between that and a
// stored-XSS hole via a malicious signup. Every other interpolated field on
// this page (mode/result/numbers/dates) is server-computed from a fixed
// enum or a number, never free text, so it doesn't need this.
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function initAdminPage() {
  const user = await fetchCurrentUser();
  if (!user) {
    window.location.href = '/login.html';
    return;
  }
  // Not an admin - the API would 404 anyway (see requireAdmin), but
  // redirecting here avoids showing an empty/error page to someone who
  // just isn't flagged, same "don't even hint this exists" reasoning.
  if (!user.isAdmin) {
    window.location.href = '/dashboard.html';
    return;
  }

  const errorEl = document.getElementById('admin-error');
  const showError = (message) => {
    errorEl.textContent = message;
    errorEl.hidden = false;
  };

  await Promise.all([
    loadLedger(),
    loadLiveStats(showError),
    loadUsers(showError),
    loadMatches(showError),
  ]);

  // Live stats refresh on their own timer (nothing else here does - the
  // ledger/users/matches are all "as of page load," refreshed by reloading
  // the page, but "how many people are online right now" goes stale fast
  // enough that a fixed page load isn't useful for it).
  setInterval(() => loadLiveStats(showError), LIVE_STATS_REFRESH_MS);

  wireUserSearch(showError);
}

async function loadLedger() {
  const ledger = await fetchHouseLedger();
  const errorEl = document.getElementById('admin-error');
  if (!ledger) {
    errorEl.textContent = 'Could not load the house ledger. Try refreshing.';
    errorEl.hidden = false;
    return;
  }

  document.getElementById('admin-rake-collected').innerHTML = `${format(ledger.rakeCollected)} <span class="unit">PTS</span>`;
  document.getElementById('admin-profit').innerHTML = `${format(ledger.profit)} <span class="unit">PTS</span>`;
  document.getElementById('admin-stakes-collected').innerHTML = `${format(ledger.stakesCollected)} <span class="unit">PTS</span>`;
  document.getElementById('admin-stakes-refunded').innerHTML = `${format(ledger.stakesRefunded)} <span class="unit">PTS</span>`;
  document.getElementById('admin-net-stakes').innerHTML = `${format(ledger.netStakesCollected)} <span class="unit">PTS</span>`;
  document.getElementById('admin-winnings-paid').innerHTML = `${format(ledger.winningsPaid)} <span class="unit">PTS</span>`;

  // Profit reads as a loss (danger) rather than a gain (success) if the
  // ledger ever actually goes negative - a real possibility early on with
  // few matches played (e.g. one player deposits nothing, wins a match
  // some OTHER player's stake funded, before enough volume evens out).
  const profitEl = document.getElementById('admin-profit');
  profitEl.classList.toggle('success', ledger.profit >= 0);
  profitEl.classList.toggle('danger', ledger.profit < 0);
}

const LIVE_STATS_REFRESH_MS = 10000;

async function loadLiveStats(showError) {
  const stats = await fetchLiveStats();
  if (!stats) {
    showError('Could not load live server stats.');
    return;
  }
  const show = (value) => (value === null || value === undefined ? '—' : format(value));
  document.getElementById('admin-live-connected').textContent = show(stats.connectedPlayers);
  document.getElementById('admin-live-matches').textContent = show(stats.activeMatches);
  document.getElementById('admin-live-versus-queue').textContent = show(stats.versusQueueSize);
  document.getElementById('admin-live-coop-queue').textContent = show(stats.coopQueueSize);
  document.getElementById('admin-live-rooms').textContent = show(stats.roomCount);
  document.getElementById('admin-live-room-players').textContent = show(stats.waitingPlayers);
}

// Renders the users table from whatever rows fetchAdminUsers() returned -
// shared by the initial load and every subsequent search, so both always
// build the exact same row shape (including the balance-adjust mini-form).
function renderUsers(users, showError) {
  const tbodyEl = document.getElementById('admin-users-tbody');
  const emptyEl = document.getElementById('admin-users-empty');
  tbodyEl.innerHTML = '';

  if (users.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  for (const u of users) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${escapeHtml(u.callsign)}${u.isAdmin ? ' <span class="admin-badge">ADMIN</span>' : ''}</td>
      <td class="admin-cell-mono">${escapeHtml(u.email)}</td>
      <td class="admin-cell-mono admin-balance-value">${format(u.balance)}</td>
      <td class="admin-cell-mono">${u.matchesPlayed}</td>
      <td class="admin-cell-mono">${format(u.survivalBestScore)}</td>
      <td class="admin-cell-mono">${formatDate(u.createdAt)}</td>
      <td class="admin-balance-form">
        <input type="number" class="admin-balance-input" placeholder="±amount" aria-label="Balance adjustment for ${escapeHtml(u.callsign)}" />
        <button type="button" class="btn admin-balance-btn">Apply</button>
      </td>
    `;

    const input = row.querySelector('.admin-balance-input');
    const btn = row.querySelector('.admin-balance-btn');
    const balanceValueEl = row.querySelector('.admin-balance-value');
    btn.addEventListener('click', async () => {
      const amount = Number.parseInt(input.value, 10);
      if (!Number.isInteger(amount) || amount === 0) return;
      btn.disabled = true;
      try {
        const newBalance = await adjustUserBalance(u.id, amount);
        balanceValueEl.textContent = format(newBalance);
        input.value = '';
      } catch (err) {
        showError(err.message);
      } finally {
        btn.disabled = false;
      }
    });

    tbodyEl.appendChild(row);
  }
}

async function loadUsers(showError, search = '') {
  const users = await fetchAdminUsers(search);
  if (!users) {
    showError('Could not load the users list.');
    return;
  }
  renderUsers(users, showError);
}

// Debounced so every keystroke in the search box doesn't fire its own
// request - waits for a short pause in typing instead.
function wireUserSearch(showError) {
  const searchInput = document.getElementById('admin-user-search');
  let debounceId = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceId);
    debounceId = setTimeout(() => loadUsers(showError, searchInput.value.trim()), 250);
  });
}

async function loadMatches(showError) {
  const matches = await fetchAdminMatches();
  if (!matches) {
    showError('Could not load recent matches.');
    return;
  }
  const tbodyEl = document.getElementById('admin-matches-tbody');
  const emptyEl = document.getElementById('admin-matches-empty');
  tbodyEl.innerHTML = '';

  if (matches.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  for (const m of matches) {
    const isWin = m.result !== 'eliminated';
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${escapeHtml(m.callsign)}</td>
      <td class="admin-cell-mono">${m.mode}</td>
      <td>${formatResultName(m.result)}</td>
      <td class="admin-cell-mono">${m.kills}</td>
      <td class="admin-cell-mono">#${m.rank}/${m.totalPlayers}</td>
      <td class="admin-cell-mono ${isWin ? 'success' : 'danger'}">${format(m.finalPot)}</td>
      <td class="admin-cell-mono">${formatDate(m.playedAt)}</td>
    `;
    tbodyEl.appendChild(row);
  }
}

initAdminPage();
