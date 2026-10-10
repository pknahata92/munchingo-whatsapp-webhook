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
    if (err instanceof actions.AdminError) return res.status(err.status).json({ ok: false, error: err.message, ...err.extra });
    console.error('[ADMIN] error:', err.response?.data ? JSON.stringify(err.response.data) : err.message);
    res.status(500).json({ ok: false, error: err.response?.data?.error?.description || err.message });
  }
};

// The page itself holds no data; every data call needs a signed session.
const isAdminHost = (req) => req.hostname === 'admin.munchingo.com';
router.get(['/admin', '/'], (req, res, next) => {
  if (req.path === '/' && !isAdminHost(req)) return next(); // '/' stays the health check on other hosts
  res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  res.sendFile(path.join(__dirname, '..', 'admin', 'index.html'));
});

router.get('/admin/logo.png', (req, res) => res.set('Cache-Control', 'public, max-age=86400').sendFile(path.join(__dirname, '..', 'assets', 'logo-tm.png')));

// ── Sign in ───────────────────────────────────────────────────────────────
router.post('/admin/api/login', rateLimit({ windowMs: 15 * 60_000, max: 8 }), async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  try {
    if (await auth.isAllowed(email)) await require('../utils/mailer').sendAdminCode(email, auth.issueCode(email));
  } catch (err) { console.error('[ADMIN] could not send code:', err.message); }
  // Same answer whether or not the address is allowed, so the allow-list cannot be probed.
  res.json({ ok: true, message: 'If that address is allowed, a 6-digit code is on its way.' });
});

router.post('/admin/api/verify', rateLimit({ windowMs: 15 * 60_000, max: 20 }), async (req, res) => {
  const { email, code } = req.body || {};
  const user = auth.verifyCode(email, code) && await auth.resolveUser(email);
  if (!user) return res.status(401).json({ ok: false, error: 'That code is not right, or it has expired.' });
  console.log(`[ADMIN] ${user.email} (${user.role}) signed in`);
  res.json({ ok: true, token: auth.issueToken(user.email), email: user.email, role: user.role });
});

// ── Everything below needs a valid session ──────────────────────────────────
router.use('/admin/api', auth.requireAdmin);

const owner = auth.requireOwner;
const enc = (req) => ({ orderId: req.params.id, actor: req.admin });

router.get('/admin/api/me', (req, res) => res.json({ ok: true, email: req.admin.email, name: req.admin.name, role: req.admin.role, reasons: Object.fromEntries(Object.entries(REASONS).map(([k, v]) => [k, v.label])) }));
router.get('/admin/api/summary', wrap(async () => ({ summary: await actions.summary() })));
router.get('/admin/api/orders', wrap(async () => { const orders = await actions.listOrders(); return { orders, moneyLive: !!orders.moneyLive, truncated: orders.length >= 600 }; }));
router.get('/admin/api/orders/:id', wrap(async (req) => ({ order: (await actions.getOrderDetail(req.params.id)).shaped })));

// Staff and owner: move an order forward, add notes, print.
router.post('/admin/api/orders/:id/advance', wrap(async (req) => actions.advance({ ...enc(req), to: (req.body || {}).to, carrier: (req.body || {}).carrier, awb: (req.body || {}).awb })));
router.post('/admin/api/orders/bulk-pack', wrap(async (req) => actions.bulkPack({ ids: (req.body || {}).ids, actor: req.admin })));
router.post('/admin/api/picklist', wrap(async (req) => actions.pickList((req.body || {}).ids)));
router.post('/admin/api/orders/:id/note', wrap(async (req) => actions.saveNote(req.params.id, (req.body || {}).note, req.admin)));

// Owner only: money, undo, stock, team.
router.post('/admin/api/orders/:id/refund', owner, wrap(async (req) => ({ refund: await actions.startRefund({ ...req.body, ...enc(req) }) })));
router.post('/admin/api/orders/:id/cancel', owner, wrap(async (req) => actions.cancelUnpaid(req.params.id, req.admin)));
router.post('/admin/api/orders/:id/resend-invoice', owner, wrap(async (req) => actions.resendInvoice(req.params.id, req.admin)));
router.post('/admin/api/orders/:id/undo', owner, wrap(async (req) => actions.undoStep(enc(req))));
router.get('/admin/api/stock', owner, wrap(async () => ({ stock: await actions.stockList() })));
router.post('/admin/api/stock', owner, wrap(async (req) => actions.setStock({ slug: (req.body || {}).slug, available: (req.body || {}).available, actor: req.admin })));
router.get('/admin/api/team', owner, wrap(async () => ({ team: await actions.listTeam() })));
router.post('/admin/api/team', owner, wrap(async (req) => actions.saveTeamMember({ ...(req.body || {}), actor: req.admin })));

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
