'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const auth = require('../utils/adminAuth');
const actions = require('../utils/adminActions');
const { rateLimit } = require('../utils/rateLimit');
const { REASONS } = require('../utils/refundReasons');

const wrap = (fn) => async (req, res) => {
  try { res.json({ ok: true, ...(await fn(req)) }); }
  catch (err) {
    if (err instanceof actions.AdminError) return res.status(err.status).json({ ok: false, error: err.message });
    console.error('[ADMIN] error:', err.response?.data ? JSON.stringify(err.response.data) : err.message);
    res.status(500).json({ ok: false, error: err.response?.data?.error?.description || err.message });
  }
};

// The page itself holds no data; every data call needs a signed session.
router.get('/admin', (req, res) => {
  res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  res.sendFile(path.join(__dirname, '..', 'admin', 'index.html'));
});

router.get('/admin/logo.png', (req, res) => res.set('Cache-Control', 'public, max-age=86400').sendFile(path.join(__dirname, '..', 'assets', 'logo-tm.png')));

// ── Sign in ───────────────────────────────────────────────────────────────
router.post('/admin/api/login', rateLimit({ windowMs: 15 * 60_000, max: 8 }), async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  try {
    if (auth.isAllowed(email)) await require('../utils/mailer').sendAdminCode(email, auth.issueCode(email));
  } catch (err) { console.error('[ADMIN] could not send code:', err.message); }
  // Same answer whether or not the address is allowed, so the allow-list cannot be probed.
  res.json({ ok: true, message: 'If that address is allowed, a 6-digit code is on its way.' });
});

router.post('/admin/api/verify', rateLimit({ windowMs: 15 * 60_000, max: 20 }), (req, res) => {
  const { email, code } = req.body || {};
  if (!auth.verifyCode(email, code)) return res.status(401).json({ ok: false, error: 'That code is not right, or it has expired.' });
  console.log(`[ADMIN] ${String(email).toLowerCase()} signed in`);
  res.json({ ok: true, token: auth.issueToken(email), email: String(email).toLowerCase() });
});

// ── Everything below needs a valid session ──────────────────────────────────
router.use('/admin/api', auth.requireAdmin);

router.get('/admin/api/me', (req, res) => res.json({ ok: true, email: req.admin.email, reasons: Object.fromEntries(Object.entries(REASONS).map(([k, v]) => [k, v.label])) }));
router.get('/admin/api/summary', wrap(async () => ({ summary: await actions.summary() })));
router.get('/admin/api/orders', wrap(async () => ({ orders: await actions.listOrders() })));
router.get('/admin/api/orders/:id', wrap(async (req) => ({ order: (await actions.getOrderDetail(req.params.id)).shaped })));

router.post('/admin/api/orders/:id/refund', wrap(async (req) => ({ refund: await actions.startRefund({ orderId: req.params.id, ...req.body }) })));
router.post('/admin/api/orders/:id/cancel', wrap(async (req) => actions.cancelUnpaid(req.params.id)));
router.post('/admin/api/orders/:id/resend-invoice', wrap(async (req) => actions.resendInvoice(req.params.id)));
router.post('/admin/api/orders/:id/ship', wrap(async (req) => actions.markShipped({ orderId: req.params.id, ...req.body })));
router.post('/admin/api/orders/:id/note', wrap(async (req) => actions.saveNote(req.params.id, (req.body || {}).note)));

// Invoice / credit note PDFs (fetched with the session header, then opened as a blob by the page).
router.get('/admin/api/orders/:id/invoice.pdf', async (req, res) => {
  try {
    const { invoice } = await actions.getOrderDetail(req.params.id);
    if (!invoice) return res.status(404).json({ ok: false, error: 'No invoice yet.' });
    const pdf = await require('../utils/invoice').renderInvoicePdf(invoice.data);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="Munchingo-Invoice-${invoice.invoice_no.replace(/\//g, '-')}.pdf"` }).send(pdf);
  } catch (err) { res.status(err.status || 500).json({ ok: false, error: err.message }); }
});

module.exports = router;
