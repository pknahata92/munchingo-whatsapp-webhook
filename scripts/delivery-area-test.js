'use strict';
// Delhi NCR only (2 Nov 2026, Prashant): until boxes stop breaking in transit, orders outside NCR are refused on the website,
// in the pincode check and in the WhatsApp bot. DELIVERY_NATIONWIDE=1 on Render reopens all of India.   node scripts/delivery-area-test.js
const path = require('path');
process.env.SUPABASE_URL = 'x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'x'; process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'x';
delete process.env.DELIVERY_NATIONWIDE;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const stub = (rel, exp) => { const f = require.resolve(path.join(__dirname, '..', rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };

const saved = [], addresses = [], links = [], sent = [], pinCalls = [];
let pending = null;
stub('utils/database.js', new Proxy({
  saveOrder: async (o) => { saved.push(o); }, updateOrderAddress: async (id, a) => { addresses.push({ id, a }); }, updateOrderPaymentLink: async () => {},
  getOrder: async () => null, listSpendTiers: async () => [], setPrice: async () => {}, getRecentPendingOrder: async () => pending,
}, { get: (t, k) => t[k] || (async () => null) }));
stub('utils/razorpay.js', { createPaymentLink: async (o) => { links.push(o); return { id: 'plink', url: 'https://rzp.io/x' }; }, orderIdFromReference: () => null, expirePaymentLink: async () => {} });
stub('utils/stock.js', { ensureFresh: async () => {}, soldOutSlugs: () => [], sellable: async () => ({}) });
stub('utils/delhivery.js', { checkPincode: async (pin) => { pinCalls.push(pin); return { pin, valid: true, serviceable: true, city: 'X', state: 'Y' }; } });
stub('utils/coupons.js', { validateCoupon: async () => ({ ok: false, error: 'That code is not valid.' }) });
stub('utils/mailer.js', new Proxy({}, { get: () => async () => {} }));
stub('utils/rateLimit.js', { rateLimit: () => (req, res, next) => next() });
stub('utils/launch.js', { ordersOpen: () => true, CLOSED_MESSAGE: 'closed', isPreorder: () => false, dispatchLabel: () => '' });
stub('utils/whatsapp.js', new Proxy({ sendText: async (to, text) => { sent.push(text); }, sendButtons: async (to, text) => { sent.push(text); } }, { get: (t, k) => t[k] || (async () => {}) }));

const area = require('../utils/deliveryArea');
const MSG = 'We’re delivering in Delhi NCR only.';

(async () => {
  // the rule
  ok(area.MESSAGE === MSG, 'the message is exactly Prashant\'s words');
  for (const p of ['110001', '110096', '121007', '121001', '122001', '122018', '201301', '201010']) ok(area.inArea(p), 'NCR pincode ' + p + ' is in the area');
  for (const p of ['400001', '560034', '302001', '334401', '131001', '124001', '245101']) ok(!area.inArea(p), 'pincode ' + p + ' is outside NCR');
  ok(!area.inArea('') && !area.inArea('11000') && !area.inArea(null), 'no pincode is not in the area');
  ok(area.pinIn('42 Shanti Nagar, Koramangala, Bengaluru 560034') === '560034', 'finds the pincode in a typed address');
  ok(area.pinIn('B-12 Saket, New Delhi - 110017, call 9876543210') === '110017', 'a 10-digit phone number is not taken for the pincode');
  ok(area.pinIn('Flat 4, MG Road, Delhi') === null, 'no pincode typed: null');
  process.env.DELIVERY_NATIONWIDE = '1';
  ok(area.inArea('400001') && area.inArea('560034'), 'DELIVERY_NATIONWIDE=1 reopens all of India');
  delete process.env.DELIVERY_NATIONWIDE;

  // the website checkout and the pincode check
  const express = require('express');
  const app = express(); app.use(express.json()); app.use(require('../routes/checkout'));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { s: r.status, j: await r.json() }; };
  const buyer = (pin, city, state) => ({ name: 'Test Buyer', phone: '9999900001', email: 't@example.com', address: '1 Test Rd, ' + city + ', ' + state + ' - ' + pin, addressParts: { state, city, pincode: pin } });
  const items = [{ slug: 'atta-original', qty: 3, name: 'x', price: 1 }];

  let n = saved.length; pinCalls.length = 0;
  let r = await post('/api/checkout', { ...buyer('400001', 'Mumbai', 'Maharashtra'), items, total: 777 });
  ok(r.s === 400 && r.j.error === MSG && saved.length === n && links.length === 0, 'a Mumbai address is refused with the NCR message; no order, no payment link');
  ok(pinCalls.length === 0, 'Delhivery is not asked about a pincode we will not deliver to');
  r = await post('/api/checkout', { ...buyer('110017', 'New Delhi', 'Delhi'), items, total: 777 });
  ok(r.s === 200 && r.j.ok && saved.length === n + 1, 'a Delhi address is accepted');
  r = await post('/api/checkout', { ...buyer('122001', 'Gurugram', 'Haryana'), items, total: 777 });
  ok(r.j.ok && saved.length === n + 2, 'a Gurugram address is accepted');
  r = await post('/api/checkout', { name: 'Test Buyer', phone: '9999900001', email: 't@example.com', address: '1 Test Rd', addressParts: { city: 'Delhi' }, items, total: 777 });
  ok(r.s === 400 && r.j.error === MSG, 'an address without a pincode is refused while NCR-only is on');
  process.env.DELIVERY_NATIONWIDE = '1';
  r = await post('/api/checkout', { ...buyer('400001', 'Mumbai', 'Maharashtra'), items, total: 777 });
  ok(r.j.ok && saved.length === n + 3, 'with DELIVERY_NATIONWIDE=1 a Mumbai order goes through again');
  delete process.env.DELIVERY_NATIONWIDE;

  const get = async (p) => (await fetch(base + p)).json();
  let g = await get('/api/pincode/400001');
  ok(g.serviceable === false && g.outside === true && g.message === MSG, 'pincode check: Mumbai is not deliverable and carries the NCR message');
  g = await get('/api/pincode/201301');
  ok(g.serviceable === true && !g.outside, 'pincode check: Noida is deliverable');
  server.close();

  // the WhatsApp bot
  const h = require('../handlers/messageHandler');
  pending = { order_id: 'MNG-T1', total: 777, customer_name: 'Asha' };
  sent.length = 0; addresses.length = 0; links.length = 0;
  await h.routeText('919876543210', '42 Shanti Nagar, Koramangala, Bengaluru 560034', 'Asha');
  ok(sent.some((t) => t.includes(MSG)) && addresses.length === 0 && links.length === 0, 'bot: a Bengaluru address gets the NCR message; nothing saved, no payment link');
  sent.length = 0;
  await h.routeText('919876543210', 'Flat 4, Block C, Saket, New Delhi', 'Asha');
  ok(sent.some((t) => /pincode/i.test(t)) && addresses.length === 0, 'bot: an address without a pincode is asked for the pincode');
  sent.length = 0;
  await h.routeText('919876543210', 'Flat 4, Block C, Saket, New Delhi 110017', 'Asha');
  ok(addresses.length === 1 && links.length === 1, 'bot: a Delhi address is saved and the payment link is made');
  addresses.length = 0; links.length = 0; sent.length = 0;
  await h.routeInteractive('919876543210', { type: 'nfm_reply', nfm_reply: { response_json: JSON.stringify({ full_name: 'Asha', address_line: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' }) } }, 'Asha');
  ok(sent.some((t) => t.includes(MSG)) && addresses.length === 0 && links.length === 0, 'bot form: a Pune address gets the NCR message');
  await h.routeInteractive('919876543210', { type: 'nfm_reply', nfm_reply: { response_json: JSON.stringify({ full_name: 'Asha', address_line: '12 Sector 15', city: 'Faridabad', state: 'Haryana', pincode: '121007' }) } }, 'Asha');
  ok(addresses.length === 1 && links.length === 1, 'bot form: a Faridabad address goes through');
  sent.length = 0;
  await h.sendShippingInfo('919876543210');
  ok(sent.some((t) => t.includes(MSG)) && !sent.some((t) => /across India|all major cities/i.test(t)), 'bot shipping info says NCR only, not across India');
  process.env.DELIVERY_NATIONWIDE = '1'; sent.length = 0;
  await h.sendShippingInfo('919876543210');
  ok(sent.some((t) => /across India/.test(t)), 'reopened: shipping info says across India again');
  delete process.env.DELIVERY_NATIONWIDE;

  console.log(`delivery-area-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
