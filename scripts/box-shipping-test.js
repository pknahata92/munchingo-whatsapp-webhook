'use strict';
// Box shipping and Subscribe & Save (9 Nov 2026): any order holding a gift box ships free (the Rs 777 line stays for singles);
// Subscribe & Save is 5%; renewals follow the same shipping rule.   node scripts/box-shipping-test.js
const path = require('path');
process.env.SUPABASE_URL = 'x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'x'; process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'x';
process.env.DIGEST_SECRET = 'test-secret';
process.env.PORT = String(43000 + Math.floor(Math.random() * 2000));
delete process.env.DELIVERY_NATIONWIDE;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const stub = (rel, exp) => { const f = require.resolve(path.join(__dirname, '..', rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };

const saved = [], links = [], emails = [], processed = [];
let due = [];
stub('utils/database.js', new Proxy({
  saveOrder: async (o) => { saved.push(o); }, updateOrderAddress: async () => {}, updateOrderPaymentLink: async () => {}, getOrder: async (id) => ({ order_id: id, status: 'paid' }),
  listSpendTiers: async () => [], setPrice: async () => {},
}, { get: (t, k) => t[k] || (async () => null) }));
stub('utils/subscriptions.js', {
  getDueSubscriptions: async () => due, markRenewalProcessed: async (id) => { processed.push(id); },
  attachSubscriptionToOrder: async () => {}, setSubscriptionStatus: async () => {}, createSubscription: async () => ({ id: 1 }),
});
stub('utils/razorpay.js', new Proxy({ createPaymentLink: async (o) => { links.push(o); return { id: 'plink', url: 'https://rzp.io/x' }; }, orderIdFromReference: () => null }, { get: (t, k) => t[k] || (() => null) }));
stub('utils/mailer.js', new Proxy({ sendSubscriptionRenewalEmail: async (e) => { emails.push(e); } }, { get: (t, k) => t[k] || (async () => {}) }));
stub('utils/whatsapp.js', new Proxy({}, { get: () => async () => {} }));
stub('utils/stock.js', { ensureFresh: async () => {}, soldOutSlugs: () => [], sellable: async () => ({}) });
stub('utils/delhivery.js', { checkPincode: async () => ({ serviceable: true }) });
stub('utils/coupons.js', { validateCoupon: async () => ({ ok: false, error: 'That code is not valid.' }) });
stub('utils/rateLimit.js', { rateLimit: () => (req, res, next) => next() });
stub('utils/launch.js', { ordersOpen: () => true, CLOSED_MESSAGE: 'closed', isPreorder: () => false });
for (const f of ['utils/serverTracking.js', 'utils/orderUpdates.js', 'utils/ownerAlerts.js']) stub(f, new Proxy({}, { get: () => () => {} }));

const S = require('../utils/shipping');
const TRIO = 'trio-gift-set-ajwain-kesari-original';

(async () => {
  // unit checks
  ok(S.shippingFor(518) === 49, 'Rs 518 of singles pays Rs 49');
  ok(S.shippingFor(628) === 49, 'Rs 628 of singles pays Rs 49');
  ok(S.shippingFor(749, { hasGiftBox: true }) === 0, 'Rs 749 with a gift box ships free');
  ok(S.shippingFor(749) === 49, 'Rs 749 without a gift box pays Rs 49');
  ok(S.shippingFor(777) === 0, 'Rs 777 ships free');
  ok(S.shippingFor(999, { hasGiftBox: true }) === 0, 'Rs 999 with a gift box ships free');
  ok(S.hasGiftBox([{ slug: TRIO }]) === true && S.hasGiftBox([{ slug: 'full-range-set' }]) === true, 'a Trio and the Full Range are gift boxes');
  ok(S.hasGiftBox([{ slug: 'atta-original' }, S.shippingItem(49), { productName: 'x' }]) === false, 'singles, the shipping line and slugless items are not gift boxes');
  ok(S.hasGiftBox([]) === false && S.hasGiftBox(undefined) === false, 'no items, no gift box');

  // checkout route
  const express = require('express');
  const app = express(); app.use(express.json()); app.use(require('../routes/checkout'));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { s: r.status, j: await r.json() }; };
  const buyer = { name: 'Test Buyer', phone: '9999900001', address: '1 Test Rd, Faridabad, Haryana - 121007', email: 't@example.com', addressParts: { state: 'Haryana', city: 'Faridabad', pincode: '121007' } };
  const cart = (...pairs) => pairs.map(([slug, qty]) => ({ slug, qty, name: slug, price: 1 }));

  let r = await post('/api/checkout', { ...buyer, items: cart([TRIO, 1]), total: 749 });
  let o = saved[saved.length - 1];
  ok(r.j.ok && o.total === 749 && o.items.length === 1 && !o.items.some(S.isShippingItem), 'a Rs 749 Trio saves total 749 with no shipping line');
  ok(links[links.length - 1].amount === 749, 'the Razorpay amount for the Trio is 749');
  r = await post('/api/checkout', { ...buyer, items: cart(['atta-original', 1], ['atta-ajwain', 1]), total: 518 });
  o = saved[saved.length - 1];
  ok(r.j.ok && o.total === 567 && o.items.some(S.isShippingItem), '2 singles save 567 (518 + 49 shipping)');
  r = await post('/api/checkout', { ...buyer, items: cart(['full-range-set', 1]), total: 999 });
  o = saved[saved.length - 1]; ok(r.j.ok && o.total === 999 && !o.items.some(S.isShippingItem), 'the Full Range saves 999, no shipping');

  r = await post('/api/quote', { items: cart([TRIO, 1]) });
  ok(r.j.ok && r.j.shipping === 0 && r.j.giftBoxFree === true && r.j.finalTotal === 749, 'quote for the Rs 749 box: shipping 0, giftBoxFree true');
  r = await post('/api/quote', { items: cart(['atta-original', 1], ['atta-ajwain', 1]) });
  ok(r.j.shipping === 49 && r.j.giftBoxFree === false, 'quote for 2 singles: shipping 49, giftBoxFree false');
  r = await post('/api/quote', { items: cart(['atta-original', 3]) });
  ok(r.j.shipping === 0 && r.j.giftBoxFree === false, 'quote for 3 singles (777): free, but not because of a gift box');
  r = await post('/api/quote', { items: cart(['full-range-set', 1]) });
  ok(r.j.shipping === 0 && r.j.giftBoxFree === false, 'quote for the Full Range (999, above the line): free, giftBoxFree false');

  // Subscribe & Save 5%
  r = await post('/api/checkout', { ...buyer, items: cart(['atta-original', 1], ['atta-ajwain', 1], ['atta-kesari', 1]), total: 817, subscribe: true });
  o = saved[saved.length - 1];
  ok(r.j.ok && o.discountAmount === Math.round(817 * 0.05) && o.discountAmount === 41 && o.total === 776, 'Subscribe & Save on 3 singles (817): discount 41, final 776 (got ' + (o && o.discountAmount) + ' / ' + (o && o.total) + ')');
  r = await post('/api/quote', { items: cart(['atta-original', 1], ['atta-ajwain', 1], ['atta-kesari', 1]), subscribe: true });
  ok(r.j.discount && r.j.discount.amount === 41 && r.j.finalTotal === 776, 'the quote agrees: 41 off, 776');
  r = await post('/api/checkout', { ...buyer, email: '', items: cart(['atta-original', 2]), total: 518, subscribe: true });
  ok(r.s === 400, 'subscribing without an email is still refused');
  server.close();

  // renewals
  require('../server');
  await new Promise((r2) => setTimeout(r2, 400));
  const run = async () => (await fetch(`http://127.0.0.1:${process.env.PORT}/internal/subscription-renewals?secret=test-secret`)).json();
  const sub = (id, items, pct = 5) => ({ id, last_order_id: 'MNG-PAID', customer_phone: '919999900001', customer_name: 'Asha', customer_email: 'a@example.com',
    delivery_address: 'B-12 Saket, New Delhi, Delhi - 110017', items, discount_pct: pct, frequency_days: 30 });
  saved.length = 0; links.length = 0;
  due = [sub(10, [{ slug: TRIO, name: 'Trio', unit: null, quantity: 1 }])];
  let res = await run();
  o = saved[0];
  ok(res.results[0].ok === true && o && o.total === 749 && !o.items.some(S.isShippingItem) && links[0].amount === 749, 'a Trio renewal charges 749 with no shipping line (got ' + JSON.stringify(res.results[0]) + ' ' + (o && o.total) + ')');
  saved.length = 0; links.length = 0;
  due = [sub(11, [{ slug: 'atta-original', name: 'Atta Original', unit: '250g', quantity: 2 }])];
  res = await run(); o = saved[0];
  ok(res.results[0].ok === true && o.total === 518 - Math.round(518 * 0.05) + 49 && o.items.some(S.isShippingItem), 'a 2-single renewal still pays shipping and keeps its stored 5%');
  saved.length = 0; links.length = 0; processed.length = 0;
  due = [sub(12, [{ slug: 'trio-gift-set-bogus-bogus-bogus', name: 'Bad', unit: null, quantity: 1 }])];
  res = await run();
  ok(res.results[0].ok === false && saved.length === 0 && links.length === 0 && !processed.includes(12), 'a renewal with an invalid Trio slug makes no order (no NaN total) and is not marked done (got ' + JSON.stringify(res.results[0]) + ')');

  console.log(`box-shipping-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
