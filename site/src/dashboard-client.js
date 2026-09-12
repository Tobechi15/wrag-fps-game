// Real stats + recent match history, pulled from the matches table via
// server/src/api/dashboard.js. Same-origin via vite.config.js's /api proxy.
export async function fetchDashboardSummary() {
  const response = await fetch('/api/dashboard/summary');
  if (!response.ok) return null;
  return response.json();
}

// Demo/dev balance top-up (see server/src/api/wallet.js) - directly credits
// the same fake users.balance a real payment gateway would eventually credit
// after confirming an actual payment; no payment details are ever collected
// here. Throws with the server's own error message on a rejected amount so
// the caller can show it as-is.
export async function depositToWallet(amount) {
  const response = await fetch('/api/wallet/deposit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Deposit failed.');
  return body.balance;
}
