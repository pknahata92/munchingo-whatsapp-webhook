'use strict';
// Public review page API (munchingo.com/review?t=<token>). The token is the buyer's proof of purchase; see utils/reviews.js.
const express = require('express');
const { rateLimit } = require('../utils/rateLimit');
const reviews = require('../utils/reviews');

const router = express.Router();
const send = (res, out) => res.status(out.status).json(out.body);

router.get('/api/review/:token', rateLimit({ windowMs: 60_000, max: 20 }), async (req, res) => {
  try { send(res, await reviews.getForm(req.params.token)); }
  catch (e) { console.error('[REVIEWS] form error:', e.message); res.status(500).json({ error: 'Something went wrong. Please try again in a minute.' }); }
});

router.post('/api/review/:token', rateLimit({ windowMs: 60_000, max: 5 }), async (req, res) => {
  try { send(res, await reviews.submit(req.params.token, req.body || {})); }
  catch (e) { console.error('[REVIEWS] submit error:', e.message); res.status(500).json({ error: 'Something went wrong. Please try again in a minute.' }); }
});

module.exports = router;
