import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { pool } from '../db/client.js';
import { router as authRouter } from '../auth/routes.js';
import { router as dashboardRouter } from './dashboard.js';
import { router as walletRouter } from './wallet.js';
import { router as adminRouter } from './admin.js';

const PORT = 8081;
const PgSession = connectPgSimple(session);

export function startApiServer() {
  const app = express();

  app.use(express.json());

  // Session cookie, backed by Postgres (not memory - survives a server
  // restart, and works correctly if this ever runs as more than one
  // process). createTableIfMissing means schema.sql doesn't need to define
  // the session table by hand.
  //
  // FLAG FOR LATER: secure:false and sameSite:'lax' are fine for local http
  // dev, but once this is deployed for real over https, secure must become
  // true (cookie only sent over https) - see README when that day comes.
  app.use(session({
    store: new PgSession({ pool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true, // never readable from client-side JS - blocks a whole class of XSS-driven session theft
      secure: false,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  }));

  app.use('/api/auth', authRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/wallet', walletRouter);
  app.use('/api/admin', adminRouter);

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`API server listening on http://127.0.0.1:${PORT}`);
  });
}
