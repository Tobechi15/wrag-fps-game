import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { query } from '../db/client.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { issuePlayToken } from './playTokens.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const MIN_CALLSIGN_LENGTH = 3;
const MAX_CALLSIGN_LENGTH = 20;

// Brute-force protection on login specifically - per the project brief's
// explicit ask for rate-limiting once accounts exist. Keyed by IP, which is
// coarse (shared-IP users share a bucket) but standard for a prototype.
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' },
});

function publicUser(row) {
  // Never send password_hash back to the client, ever - not even to the
  // account owner. This is the one function every route MUST funnel a user
  // row through before responding.
  return {
    id: row.id, email: row.email, callsign: row.callsign, createdAt: row.created_at, isAdmin: Boolean(row.is_admin),
  };
}

// Comma-separated allow-list (see .env.example) - an account matching one
// of these gets is_admin auto-set the next time it logs in (see the login
// route below). No admin-management UI exists; this env var IS the
// mechanism - editing it and having that account log in again is the
// whole workflow. Lowercased once here since email comparison is always
// case-insensitive (see normalizedEmail in the login route).
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? '')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

export const router = Router();

router.post('/signup', async (req, res) => {
  const { email, password, callsign } = req.body ?? {};

  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }
  if (typeof callsign !== 'string' || callsign.length < MIN_CALLSIGN_LENGTH || callsign.length > MAX_CALLSIGN_LENGTH) {
    return res.status(400).json({ error: `Callsign must be ${MIN_CALLSIGN_LENGTH}-${MAX_CALLSIGN_LENGTH} characters.` });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const passwordHash = await hashPassword(password);
    const result = await query(
      `INSERT INTO users (email, password_hash, callsign)
       VALUES ($1, $2, $3)
       RETURNING id, email, callsign, created_at`,
      [normalizedEmail, passwordHash, callsign.trim()],
    );
    const user = result.rows[0];

    // Regenerate the session id on privilege change (here: becoming
    // authenticated) - standard defense against session fixation.
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Could not start a session.' });
      req.session.userId = user.id;
      res.status(201).json({ user: publicUser(user) });
    });
  } catch (err) {
    if (err.code === '23505') { // unique_violation on email
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }
    console.error('Signup failed:', err);
    res.status(500).json({ error: 'Signup failed. Try again.' });
  }
});

router.post('/login', loginRateLimiter, async (req, res) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const result = await query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
    const user = result.rows[0];

    // Same generic error whether the email doesn't exist or the password
    // is wrong - never reveal which one it was (avoids leaking which
    // emails have accounts).
    const invalidCredentials = () => res.status(401).json({ error: 'Invalid email or password.' });

    if (!user) return invalidCredentials();
    const passwordMatches = await verifyPassword(password, user.password_hash);
    if (!passwordMatches) return invalidCredentials();

    // Awaited (not fire-and-forget) so an email just added to ADMIN_EMAILS
    // takes effect on this very login, not the one after - mutate the
    // in-memory row too so publicUser(user) below reflects it immediately
    // without a second round-trip to re-read the row.
    if (!user.is_admin && ADMIN_EMAILS.includes(normalizedEmail)) {
      await query('UPDATE users SET is_admin = true WHERE id = $1', [user.id]);
      user.is_admin = true;
    }

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Could not start a session.' });
      req.session.userId = user.id;
      res.status(200).json({ user: publicUser(user) });
    });
  } catch (err) {
    console.error('Login failed:', err);
    res.status(500).json({ error: 'Login failed. Try again.' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.status(204).end();
  });
});

router.get('/me', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not logged in.' });
  }
  const result = await query('SELECT id, email, callsign, created_at, is_admin FROM users WHERE id = $1', [req.session.userId]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  res.status(200).json({ user: publicUser(user) });
});

// Reusable guard for any route that requires a logged-in user.
export function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not logged in.' });
  }
  next();
}

// Gates the admin dashboard (server/src/api/admin.js) - a real DB check,
// not just a session flag, so revoking an email from ADMIN_EMAILS (see
// above) actually takes effect on that account's NEXT request rather than
// only at their next login. A generic 404 (not 403) on failure - same
// "don't reveal this exists" reasoning as login's invalidCredentials,
// just for "is there even an admin area" instead of "does this account
// exist."
export async function requireAdmin(req, res, next) {
  if (!req.session.userId) {
    return res.status(404).json({ error: 'Not found.' });
  }
  const result = await query('SELECT is_admin FROM users WHERE id = $1', [req.session.userId]);
  if (!result.rows[0]?.is_admin) {
    return res.status(404).json({ error: 'Not found.' });
  }
  next();
}

// Exchanges the dashboard's HTTP session for a short-lived token the game
// client can hand to the WS server - see auth/playTokens.js for why this
// hop exists at all (the game server can't see this page's session cookie,
// different origin/protocol entirely).
router.post('/play-token', requireAuth, async (req, res) => {
  const result = await query('SELECT callsign FROM users WHERE id = $1', [req.session.userId]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  const token = issuePlayToken(req.session.userId, user.callsign);
  res.status(200).json({ token });
});

// Account settings page: view/update callsign. Email is intentionally not
// editable here - changing it safely would need re-verification (proving
// you own the new address), which is a bigger feature than this prototype
// needs yet.
router.patch('/account', requireAuth, async (req, res) => {
  const { callsign } = req.body ?? {};
  if (typeof callsign !== 'string' || callsign.length < MIN_CALLSIGN_LENGTH || callsign.length > MAX_CALLSIGN_LENGTH) {
    return res.status(400).json({ error: `Callsign must be ${MIN_CALLSIGN_LENGTH}-${MAX_CALLSIGN_LENGTH} characters.` });
  }

  const result = await query(
    `UPDATE users SET callsign = $1 WHERE id = $2 RETURNING id, email, callsign, created_at`,
    [callsign.trim(), req.session.userId],
  );
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  res.status(200).json({ user: publicUser(user) });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};

  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'Current and new password are required.' });
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }

  const result = await query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: 'Not logged in.' });

  const currentPasswordMatches = await verifyPassword(currentPassword, user.password_hash);
  if (!currentPasswordMatches) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  const newPasswordHash = await hashPassword(newPassword);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newPasswordHash, req.session.userId]);
  res.status(200).json({ ok: true });
});
