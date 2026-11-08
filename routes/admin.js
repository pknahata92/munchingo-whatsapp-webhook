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

// Label sheet tool: both files are public code (a library and our own layout script), so no session is needed to load them.
const LIB = path.join(__dirname, '..', 'node_modules', 'pdf-lib', 'dist', 'pdf-lib.min.js');
const PDFJS = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build');
router.get('/admin/pdf.min.js', (req, res) => res.set({ 'Cache-Control': 'public, max-age=86400', 'Content-Type': 'application/javascript; charset=utf-8' }).sendFile(path.join(PDFJS, 'pdf.min.js')));
router.get('/admin/pdf.worker.min.js', (req, res) => res.set({ 'Cache-Control': 'public, max-age=86400', 'Content-Type': 'application/javascript; charset=utf-8' }).sendFile(path.join(PDFJS, 'pdf.worker.min.js')));
router.get('/admin/pdf-lib.min.js', (req, res) => res.set({ 'Cache-Control': 'public, max-age=86400', 'Content-Type': 'application/javascript; charset=utf-8' }).sendFile(LIB));
router.get('/admin/pickfooter.js', (req, res) => res.set({ 'Cache-Control': 'no-cache', 'Content-Type': 'application/javascript; charset=utf-8' }).sendFile(path.join(__dirname, '..', 'admin', 'pickfooter.js')));
router.get('/admin/labelsheet.js', (req, res) => res.set({ 'Cache-Control': 'no-cache', 'Content-Type': 'application/javascript; charset=utf-8' }).sendFile(path.join(__dirname, '..', 'admin', 'labelsheet.js')));

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

router.get('/admin/api/me', (req, res) => res.json({ ok: true, email: req.admin.email, name: req.admin.name, role: req.admin.role, dispatchFrom: new Date(require('../utils/launch').dispatchFrom()).toISOString(), reasons: Object.fromEntries(Object.entries(REASONS).map(([k, v]) => [k, v.label])) }));
router.get('/admin/api/summary', wrap(async () => ({ summary: await actions.summary() })));
router.get('/admin/api/orders', wrap(async () => { const orders = await actions.listOrders(); return { orders, moneyLive: !!orders.moneyLive, truncated: orders.length >= 600 }; }));
router.get('/admin/api/orders/:id', wrap(async (req) => ({ order: (await actions.getOrderDetail(req.params.id)).shaped })));

// Staff and owner: move an order forward, add notes, print.
// `override` is the owner's note for packing when no lot that can ship covers the order; advance() honours it only for the owner.
router.post('/admin/api/orders/:id/advance', wrap(async (req) => actions.advance({ ...enc(req), to: (req.body || {}).to, carrier: (req.body || {}).carrier, awb: (req.body || {}).awb, method: (req.body || {}).method, deliverNow: !!(req.body || {}).deliverNow, override: (req.body || {}).override })));
router.post('/admin/api/orders/:id/delhivery-shipment', wrap(async (req) => actions.createDelhiveryShipment({ ...enc(req), weightGrams: (req.body || {}).weightGrams })));
router.post('/admin/api/pickup', wrap(async (req) => actions.requestDelhiveryPickup({ ids: (req.body || {}).ids, actor: req.admin })));
router.post('/admin/api/labels', wrap(async (req) => actions.shippingLabels((req.body || {}).ids)));
// Stock ledger (staff and owner can receive, take out, count and flag; owner adds items and sets levels). See utils/inventory.js.
const stock = () => require('../utils/inventory');
const sw = (fn) => wrap(async (req) => { try { const out = await fn(req, stock().instance()); if (req.method === 'POST') { try { require('../utils/channelSync').nudge('stock'); } catch (_) {} } return out; } catch (e) { if (e instanceof stock().StockError) throw new actions.AdminError(e.message, e.status, e.extra); throw e; } });
// Meta and Google lines ride along with the stock, so the Stock screen and Needs you now get them in one call. Never blocks the stock.
const chan = () => require('../utils/channelSync');
const channelsOrNull = async () => { try { return await chan().status(); } catch (e) { console.error('[CHANNELS] could not read the channel lines for the admin:', e.message); return null; } };
router.get('/admin/api/inventory', sw(async (req, inv) => { const [overview, channels] = await Promise.all([inv.overview(), channelsOrNull()]); return { ...overview, channels }; }));
router.get('/admin/api/inventory/history', sw((req, inv) => inv.history({ slug: req.query.slug, limit: Number(req.query.limit) || 40, types: req.query.types ? String(req.query.types).split(',') : null })));
router.get('/admin/api/inventory/receipt', sw((req, inv) => inv.receipt({ id: Number(req.query.id) })));
// Biscuits arrive only through Stock, New delivery (every box gets its lot and the hold check): inventory.receive refuses a new biscuit
// receipt when this flag is set. Packaging receipts and corrections of an old receipt (`replaces`) work as before; internal callers
// (the practice seed, tests) call inventory.receive directly and are not blocked.
router.post('/admin/api/inventory/receive', sw((req, inv) => inv.receive({ ...(req.body || {}), actor: req.admin, isOwner: req.admin.role === 'owner', biscuitsViaDelivery: true })));   // flags after the spread: a client can never claim isOwner or lift the block
router.post('/admin/api/inventory/take', sw((req, inv) => inv.take({ ...(req.body || {}), actor: req.admin })));
router.post('/admin/api/inventory/take-many', sw((req, inv) => inv.takeMany({ ...(req.body || {}), actor: req.admin })));
router.post('/admin/api/inventory/event-return', sw((req, inv) => inv.eventReturn({ ...(req.body || {}), actor: req.admin })));
router.post('/admin/api/inventory/pause', sw(async (req) => {
  const slug = String((req.body || {}).slug || ''); const paused = !!(req.body || {}).paused;
  if (!['atta-original', 'atta-kesari', 'atta-ajwain', 'atta-lite-sugar'].includes(slug)) throw new (stock().StockError)('Only the four flavours can be paused on the website.');
  await require('../utils/stock').setAvailable(slug, !paused, req.admin.email, paused ? 'Paused from Inventory' : 'Resumed from Inventory');
  return { ok: true };
}));
router.get('/admin/api/inventory/flow', sw((req, inv) => inv.flow()));
// Batch receiving (spec 6.3, 6.6). One Krazy Bakers delivery in one save (lots start on hold): staff and owner. utils/deliveries.js
// throws the inventory's StockError, so sw() answers its refusals in plain words like every stock call.
router.post('/admin/api/stock/deliveries', sw((req) => require('../utils/deliveries').instance().save(req.body || {}, { actor: req.admin, isOwner: req.admin.role === 'owner' })));
// For Needs attention: boxes packed without a lot (lines; Assign lot is owner only, below), and packs whose lots could not be checked or
// whose boxes could not be written off (unplanned; null if those could not be read, so the lines still show). Staff and owner.
router.get('/admin/api/stock/needs-lot', sw(async (req, inv) => {
  const [lines, unplanned] = await Promise.all([inv.needsLot(), actions.unplannedPacks().catch((e) => { console.error('[STOCK] could not read the unplanned packs:', e.message); return null; })]);
  return { lines, unplanned };
}));
// Batch receiving, Task 10: deliveries, lots, trace search, photos (spec 6.3-6.9). Staff and owner unless marked; the owner-only routes use
// the `owner` guard AND set isOwner from the session after the body spread. utils/deliveries.js throws the inventory's StockError.
const dl = () => require('../utils/deliveries').instance();
const who = (req) => ({ actor: req.admin, isOwner: req.admin.role === 'owner' });
const slugOf = (req) => (req.query.slug ? String(req.query.slug) : ((req.body || {}).slug ? String((req.body || {}).slug) : undefined));
const lotIn = (req) => ({ ...(req.body || {}), code: req.params.code, slug: slugOf(req) });   // the code is in the URL, the flavour may be in the query or the body
router.get('/admin/api/stock/deliveries/prefill', sw(async () => dl().lastPrefill()));   // before :id, or "prefill" would be read as a delivery number
router.get('/admin/api/stock/deliveries/:id', sw((req) => dl().deliveryPage(req.params.id, who(req))));
router.post('/admin/api/stock/deliveries/:id/correct', sw((req) => dl().correctDelivery({ ...(req.body || {}), id: req.params.id }, who(req))));
router.get('/admin/api/stock/lots', sw(async () => ({ lots: await dl().listLots() })));
router.get('/admin/api/stock/lots/:code/buyers.csv', async (req, res) => {   // raw: the answer is a file, not JSON
  try {
    const csv = await dl().buyersCsv(req.params.code, slugOf(req));
    const name = String(req.params.code).replace(/[^A-Za-z0-9-]/g, '') || 'lot';
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="buyers-${name}.csv"`, 'Cache-Control': 'no-store' }).send(csv);
  } catch (e) {
    if (e instanceof stock().StockError) return res.status(e.status).json({ ok: false, error: e.message, ...e.extra });
    console.error('[ADMIN] buyers.csv error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
router.get('/admin/api/stock/lots/:code', sw((req) => dl().lotPage(req.params.code, slugOf(req))));
router.get('/admin/api/stock/search', sw((req) => dl().search(req.query.q)));
router.post('/admin/api/stock/lots/:code/release', sw((req) => dl().release(lotIn(req), who(req))));
router.post('/admin/api/stock/lots/:code/reject', owner, sw((req) => dl().reject(lotIn(req), who(req))));
router.post('/admin/api/stock/lots/:code/hold', owner, sw((req) => dl().hold(lotIn(req), who(req))));
router.post('/admin/api/stock/lots/:code/fix', owner, sw((req) => dl().fixLot(lotIn(req), who(req))));
router.post('/admin/api/stock/lots/:code/broken', sw((req) => dl().brokenWhileCartoning(lotIn(req), who(req))));
router.post('/admin/api/stock/expired', owner, sw((req) => dl().throwExpired(req.body || {}, who(req))));
// Photos live in a private bucket (utils/stockPhotos.js). The phone sends the shrunk JPEG as a data URL; a link to see one lasts 10 minutes.
router.post('/admin/api/stock/photo', sw((req) => require('../utils/stockPhotos').upload((req.body || {}).dataUrl)));
router.get('/admin/api/stock/photo', sw(async (req) => ({ url: await require('../utils/stockPhotos').url(String(req.query.path || '')) })));
router.post('/admin/api/inventory/hamper', sw((req, inv) => inv.offlineHamper({ ...(req.body || {}), actor: req.admin })));
router.post('/admin/api/inventory/count', sw((req, inv) => inv.count({ ...(req.body || {}), actor: req.admin })));
router.post('/admin/api/inventory/low', sw((req, inv) => inv.setLow({ slug: (req.body || {}).slug, low: !!(req.body || {}).low })));
router.post('/admin/api/inventory/reverse', sw((req, inv) => inv.reverse({ id: Number((req.body || {}).id), reason: (req.body || {}).reason, actor: req.admin, isOwner: req.admin.role === 'owner' })));
// Meta and Google follow the admin (utils/channelSync.js). Staff and owner see the lines; only the owner switches, checks or sets up.
// errors: what the run after Test with Original, Switch on all four or Check now could not do, in plain words, apart from the lines.
const BAD_SWITCH = 'Choose Meta or Google, and off, test or all.';
const READ_FAIL = 'Could not read the Meta and Google status just now. Try again.';
const chanFail = (e) => { console.error('[CHANNELS] could not answer the admin:', e && e.message); return new actions.AdminError(READ_FAIL, 503); };
// A status that cannot be built (a bug) reaches the owner as plain words, never as a raw TypeError; the detail stays in the log.
const chanCall = async (fn) => { try { return await fn(); } catch (e) { throw chanFail(e); } };
router.get('/admin/api/channels', wrap(async () => ({ channels: await chanCall(() => chan().status()) })));
router.post('/admin/api/channels/mode', owner, wrap(async (req) => {
  const { channel, mode } = req.body || {};
  // Fixed lists first: a key such as __proto__ or constructor must never reach the saved state.
  if (!['meta', 'google'].includes(channel) || !['off', 'test', 'all'].includes(mode)) throw new actions.AdminError(BAD_SWITCH, 400);
  let out;
  try { out = await chan().setMode(channel, mode, req.admin); }
  catch (e) { if (/^Choose /.test(e.message)) throw new actions.AdminError(BAD_SWITCH, 400); throw chanFail(e); }
  const { errors = [], ...channels } = out || {};
  // setMode answers with the old state when it could not save: never report a switch (above all Switch off) that did not happen
  if (!channels[channel] || channels[channel].mode !== mode) throw new actions.AdminError(`Could not switch ${channel === 'meta' ? 'Meta' : 'Google'} just now. Try again.`, 503);
  return { channels, errors };
}));
router.post('/admin/api/channels/check', owner, wrap(async () => { const { errors = [], ...channels } = await chanCall(() => chan().checkNow()); return { channels, errors }; }));
router.post('/admin/api/channels/setup-google', owner, wrap(async (req) => {
  const r = await chan().setupGoogle(req.admin);   // never rejects: a failure comes back as r.error, with the steps done so far
  return { ok: !r.error, steps: r.steps || [], missing: r.missing || [], error: r.error ? String(r.error).replace(/^google: /i, '') : undefined, channels: await chanCall(() => chan().status()) };
}));
// Reviews and founding tasters (owner only). See utils/adminReviews.js.
const rv = () => require('../utils/adminReviews');
const rw = (fn) => wrap(async (req) => { try { return await fn(req); } catch (e) { if (e instanceof rv().ReviewError) throw new actions.AdminError(e.message, e.status); throw e; } });
router.get('/admin/api/reviews', owner, rw(() => rv().list()));
router.post('/admin/api/reviews/:id/publish', owner, rw((req) => rv().publish(req.params.id, req.admin)));
router.post('/admin/api/reviews/:id/hide', owner, rw((req) => rv().hide(req.params.id, (req.body || {}).reason, req.admin)));
// Suggestions and feedback from WhatsApp (utils/suggestions.js), newest first; the owner marks what happened to each.
const SUGGESTION_STATUS = ['new', 'planned', 'done', 'not_for_us'];
router.get('/admin/api/suggestions', owner, wrap(async () => ({ rows: await require('../utils/database').listSuggestions() })));
router.post('/admin/api/suggestions/:id/status', owner, wrap(async (req) => {
  const status = String((req.body || {}).status || '');
  if (!SUGGESTION_STATUS.includes(status)) throw new actions.AdminError('Choose Planned, Done, Not for us or New.', 400);
  const row = await require('../utils/database').setSuggestionStatus(Number(req.params.id), status, req.admin.email);
  if (!row) throw new actions.AdminError('No such suggestion.', 404);
  return { row };
}));
router.get('/admin/api/founding-tasters', owner, rw(async () => ({ rows: await rv().tasterCandidates() })));
router.post('/admin/api/founding-tasters', owner, rw((req) => rv().saveTasters((req.body || {}).rows, req.admin)));
router.post('/admin/api/orders/:id/known', owner, rw((req) => rv().setKnown(req.params.id, (req.body || {}).known)));
router.post('/admin/api/inventory/item', owner, sw((req, inv) => inv.addItem(req.body || {})));
router.post('/admin/api/inventory/item/remove', owner, sw((req, inv) => inv.removeItem({ slug: (req.body || {}).slug, isOwner: req.admin.role === 'owner' })));   // packaging only; archives, never deletes
router.post('/admin/api/inventory/rename-lot', owner, sw((req, inv) => inv.renameLot({ ...(req.body || {}), actor: req.admin, isOwner: true })));
router.post('/admin/api/inventory/level', owner, sw((req, inv) => inv.setLevel({ slug: (req.body || {}).slug, lowLevel: (req.body || {}).lowLevel })));
router.post('/admin/api/orders/:id/assign-lot', owner, sw((req, inv) => inv.assignLot({ ...(req.body || {}), orderId: req.params.id, actor: req.admin, isOwner: req.admin.role === 'owner' })));   // { slug, lot }; isOwner after the spread
router.post('/admin/api/orders/bulk-pack', wrap(async (req) => actions.bulkPack({ ids: (req.body || {}).ids, actor: req.admin })));
router.post('/admin/api/picklist', wrap(async (req) => actions.pickList((req.body || {}).ids)));
router.post('/admin/api/orders/:id/address', wrap(async (req) => actions.saveAddress({ orderId: req.params.id, address: (req.body || {}).address, actor: req.admin })));
router.post('/admin/api/orders/:id/note', wrap(async (req) => actions.saveNote(req.params.id, (req.body || {}).note, req.admin)));

// Owner only: money, undo, stock, team.
router.post('/admin/api/orders/:id/refund', owner, wrap(async (req) => ({ refund: await actions.startRefund({ ...req.body, ...enc(req) }) })));
router.post('/admin/api/orders/:id/payment-link', wrap(async (req) => actions.sendPaymentLink({ ...enc(req), fresh: !!(req.body || {}).fresh, email: !!(req.body || {}).email, whatsapp: !!(req.body || {}).whatsapp, lang: (req.body || {}).lang })));
router.post('/admin/api/orders/:id/cancel', owner, wrap(async (req) => actions.cancelUnpaid(req.params.id, req.admin)));
router.post('/admin/api/orders/:id/issue-invoice', owner, wrap(async (req) => actions.issueMissingInvoice(req.params.id, req.admin)));
router.post('/admin/api/orders/:id/billing-state', owner, wrap(async (req) => actions.setBillingState({ orderId: req.params.id, state: (req.body || {}).state, actor: req.admin })));
router.post('/admin/api/orders/:id/retry-zoho', owner, wrap(async (req) => actions.retryZoho(req.params.id, req.admin)));
router.post('/admin/api/orders/:id/whatsapp-update', owner, wrap(async (req) => actions.sendWhatsappUpdate(req.params.id, req.admin)));
router.post('/admin/api/orders/:id/resend-invoice', owner, wrap(async (req) => actions.resendInvoice(req.params.id, req.admin)));
router.post('/admin/api/orders/:id/undo', owner, wrap(async (req) => actions.undoStep(enc(req))));
router.get('/admin/api/coupons', owner, wrap(async () => require('../utils/adminCoupons').list()));
router.get('/admin/api/coupons/generate', owner, wrap(async (req) => ({ code: await require('../utils/adminCoupons').generateCode(req.query.prefix) })));
router.post('/admin/api/coupons', owner, wrap(async (req) => require('../utils/adminCoupons').create(req.body || {}, req.admin)));
router.post('/admin/api/coupons/:code/delete', owner, wrap(async (req) => require('../utils/adminCoupons').remove(req.params.code, req.admin)));
router.post('/admin/api/coupons/:code', owner, wrap(async (req) => require('../utils/adminCoupons').update(req.params.code, req.body || {}, req.admin)));
router.get('/admin/api/offers', owner, wrap(async () => require('../utils/adminOffers').list()));
router.post('/admin/api/offers', owner, wrap(async (req) => require('../utils/adminOffers').create(req.body || {}, req.admin)));
router.post('/admin/api/offers/:id/delete', owner, wrap(async (req) => require('../utils/adminOffers').remove(req.params.id, req.admin)));
router.post('/admin/api/offers/:id', owner, wrap(async (req) => require('../utils/adminOffers').update(req.params.id, req.body || {}, req.admin)));
router.get('/admin/api/stock', owner, wrap(async () => ({ stock: await actions.stockList() })));
router.post('/admin/api/stock', owner, wrap(async (req) => actions.setStock({ slug: (req.body || {}).slug, available: (req.body || {}).available, actor: req.admin })));
router.get('/admin/api/prices', owner, wrap(async () => actions.priceList()));
router.post('/admin/api/prices', owner, wrap(async (req) => actions.setPrice({ ...(req.body || {}), actor: req.admin })));
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

// A photo that is too big for the body parser (413) reads like our own size message. Mounted by server.js (and the practice admin) right
// after express.json, because a parser error never reaches the router.
router.photoTooLarge = (err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) return res.status(413).json({ ok: false, error: 'The photo is too large. Take it again.' });
  next(err);
};

module.exports = router;
