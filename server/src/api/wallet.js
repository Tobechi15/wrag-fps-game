import { Router } from 'express';
import { requireAuth } from '../auth/routes.js';
import { creditDeposit } from '../economy/wallet.js';

export const router = Router();

// Demo/dev balance top-up - directly credits the same fake `users.balance`
// used for entry stakes and match winnings. No payment details are ever
// collected here; this is the seam a real payment gateway's confirmation
// webhook would call into once one exists, not a real transaction of any
// kind - see DEV_README.md. A fixed allow-list keeps this from being an
// arbitrary "set my balance to anything" endpoint even though it's just a
// demo.
const ALLOWED_DEPOSIT_AMOUNTS = [100, 500, 1000, 5000];

router.post('/deposit', requireAuth, async (req, res) => {
  const amount = Number(req.body?.amount);
  if (!ALLOWED_DEPOSIT_AMOUNTS.includes(amount)) {
    return res.status(400).json({ error: 'Invalid deposit amount.' });
  }

  const balance = await creditDeposit(req.session.userId, amount);
  res.status(200).json({ balance });
});
