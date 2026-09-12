// Thin wrapper around the auth API. Every call is same-origin thanks to
// vite.config.js's /api proxy (see the comment there for why that matters
// for session cookies), so no CORS or credentials juggling is needed.

async function parseJsonResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

export async function fetchCurrentUser() {
  const response = await fetch('/api/auth/me');
  if (!response.ok) return null;
  const data = await response.json();
  return data.user;
}

export async function login(email, password) {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await parseJsonResponse(response);
  return data.user;
}

export async function signup(email, password, callsign) {
  const response = await fetch('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, callsign }),
  });
  const data = await parseJsonResponse(response);
  return data.user;
}

export async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
}

// Exchanges the current session for a short-lived token the game client can
// hand to the WS server, so match results get attached to this account -
// see server/src/auth/playTokens.js for the full reasoning.
export async function fetchPlayToken() {
  const response = await fetch('/api/auth/play-token', { method: 'POST' });
  const data = await parseJsonResponse(response);
  return data.token;
}

export async function updateCallsign(callsign) {
  const response = await fetch('/api/auth/account', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  const data = await parseJsonResponse(response);
  return data.user;
}

export async function changePassword(currentPassword, newPassword) {
  const response = await fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  await parseJsonResponse(response);
}
