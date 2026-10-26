'use strict';
// POST /api/stall/sync: the stall tally page saves its day here (see utils/stall.js). Needs the stall key in X-Stall-Key.
const express = require('express');
const { rateLimit } = require('../utils/rateLimit');
const stall = require('../utils/stall');

const router = express.Router();
router.post('/api/stall/sync', rateLimit({ windowMs: 60_000, max: 60 }), async (req, res) => {
  if (!process.env.STALL_KEY) return res.status(503).json({ ok: false, error: 'Stall saving is not switched on yet.' });
  if (!stall.keyOk(req.get('x-stall-key'))) return res.status(403).json({ ok: false, error: 'Wrong stall key.' });
  try { const out = await stall.sync(req.body); res.status(out.status).json(out.body); }
  catch (e) { console.error('[STALL] sync failed:', e.message); res.status(500).json({ ok: false, error: 'Could not save right now. It will retry.' }); }
});
module.exports = router;
