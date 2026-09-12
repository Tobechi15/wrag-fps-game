import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { pool } from '../db/client.js';
import { router as authRouter } from '../auth/routes.js';
import { router as dashboardRouter } from './dashboard.js';
import { router as walletRouter } from './wallet.js';
import { router as adminRouter } from './admin.js';

const PgSession = connectPgSimple(session);

// Returns the configured Express app WITHOUT calling .listen() on it - see
// index.js, which mounts this onto the SAME http.Server the WebSocket game
// server attaches to and calls .listen() there, once, for both. (Used to
// be its own independent app.listen() on a second port - fine for local
// dev, but a hosting platform that only exposes ONE port per service - see
// Render's "No open ports detected on 0.0.0.0" error - never sees a
// service with a real WS+API split, since only one of the two ports it
// binds could ever be externally reachable anyway.)
export function createApiApp() {
  const app = express();

  // Almost every hosting platform terminates https at a proxy/load
  // balancer in front of this process, then forwards plain http internally
  // - so Express's own req.secure (what the cookie config below actually
  // checks) would see every request as insecure even when the real client
  // connection was https, silently never setting the secure cookie at all
  // (a DIFFERENT way to end up broken than hardcoding secure:true would -
  // see the session config below). Trusting the first proxy hop's
  // X-Forwarded-Proto header fixes that; harmless in local dev (isProduction
  // is false there, so this line has nothing to affect anyway).
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) app.set('trust proxy', 1);

  app.use(express.json());

  // Session cookie, backed by Postgres (not memory - survives a server
  // restart, and works correctly if this ever runs as more than one
  // process). createTableIfMissing means schema.sql doesn't need to define
  // the session table by hand.
  //
  // secure must be conditional, not hardcoded either way: every local dev
  // URL in this project is plain http://127.0.0.1, and a browser will
  // never send a `secure` cookie back over an insecure connection - hardcoding
  // true would silently break login on every dev machine. Hardcoding false
  // is what NODE_ENV=production is here to fix instead - once this actually
  // runs behind real https (see README when that day comes), the cookie
  // must stop being sent over any accidental/downgraded plain-http request,
  // or it's readable in cleartext to anything observing that connection.
  // Set NODE_ENV=production in the real deployment's environment (most
  // hosting platforms do this automatically) to get the secure behavior.
  app.use(session({
    store: new PgSession({ pool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true, // never readable from client-side JS - blocks a whole class of XSS-driven session theft
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  }));

  app.use('/api/auth', authRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/wallet', walletRouter);
  app.use('/api/admin', adminRouter);

  return app;
}
