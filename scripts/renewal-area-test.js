'use strict';
// Delhi NCR only covers Subscribe & Save renewals too (3 Nov 2026): a subscriber whose address is outside NCR gets no
// renewal order and no payment link; Prashant is alerted and the renewal waits (next date not moved), so it goes
// through by itself once DELIVERY_NATIONWIDE=1 reopens India.   node scripts/renewal-area-test.js
const path = require('path');
process.env.SUPABASE_URL = 'x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'x'; process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'x';
process.env.DIGEST_SECRET = 'test-secret';
process.env.PORT = String(41000 + Math.floor(Math.random() * 2000));
delete process.env.DELIVERY_NATIONWIDE;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const stub = (rel, exp) => { const f = require.resolve(path.join(__dirname, '..', rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };

const saved = [], links = [], alerts = [], processed = [], sentWa = [];
let due = [];
stub('utils/database.js', new Proxy({
  saveOrder: async (o) => { saved.push(o); }, updateOrderAddress: async () => {}, updateOrderPaymentLink: async () => {},
  getOrder: async (id) => ({ order_id: id, status: 'paid' }),
}, { get: (t, k) => t[k] || (async () => null) }));
stub('utils/subscriptions.js', {
  getDueSubscriptions: async () => due, markRenewalProcessed: async (id) => { processed.push(id); },
  attachSubscriptionToOrder: async () => {}, setSubscriptionStatus: async () => {}, createSubscription: async () => ({ id: 1 }),
});
stub('utils/razorpay.js', new Proxy({ createPaymentLink: async (o) => { links.push(o); return { id: 'plink', url: 'https://rzp.io/x' }; } }, { get: (t, k) => t[k] || (() => null) }));
stub('utils/mailer.js', new Proxy({ sendHumanHandoffAlert: async (a) => { alerts.push(a); } }, { get: (t, k) => t[k] || (async () => {}) }));
stub('utils/whatsapp.js', new Proxy({ sendText: async (to, t) => { sentWa.push(t); } }, { get: (t, k) => t[k] || (async () => {}) }));
stub('utils/stock.js', { ensureFresh: async () => {}, soldOutSlugs: () => [], sellable: async () => ({}) });
stub('utils/catalog.js', new Proxy({ priceForSlug: () => 259, isAvailable: () => true, BASE_SLUGS: ['atta-original'] }, { get: (t, k) => (k in t ? t[k] : () => null) }));
for (const f of ['utils/serverTracking.js', 'utils/orderUpdates.js', 'utils/ownerAlerts.js']) stub(f, new Proxy({}, { get: () => () => {} }));

const sub = (id, address) => ({ id, last_order_id: 'MNG-PAID', customer_phone: '919999900001', customer_name: 'Asha', customer_email: 'a@example.com',
  delivery_address: address, items: [{ slug: 'atta-original', name: 'Atta Original', unit: '250g', quantity: 3 }], discount_pct: 10, frequency_days: 30 });

(async () => {
  require('../server');
  await new Promise((r) => setTimeout(r, 400));
  const run = async () => (await fetch(`http://127.0.0.1:${process.env.PORT}/internal/subscription-renewals?secret=test-secret`)).json();

  due = [sub(1, '12 Marine Drive, Mumbai, Maharashtra - 400001'), sub(2, 'B-12 Saket, New Delhi, Delhi - 110017')];
  let r = await run();
  const mumbai = r.results.find((x) => x.id === 1), delhi = r.results.find((x) => x.id === 2);
  ok(mumbai && mumbai.ok === false && mumbai.reason === 'outside_delivery_area', 'a Mumbai subscriber is skipped as outside the delivery area (got: ' + JSON.stringify(mumbai) + ')');
  ok(saved.length === 1 && links.length === 1, 'only the Delhi renewal makes an order and a payment link (orders ' + saved.length + ', links ' + links.length + ')');
  ok(!processed.includes(1) && processed.includes(2), 'the Mumbai renewal date is not moved, so it retries; Delhi is marked done');
  ok(alerts.length === 1 && /outside Delhi NCR/i.test(alerts[0].message) && /#1\b/.test(alerts[0].message), 'Prashant is alerted about the skipped subscriber');
  ok(sentWa.length === 1, 'the Mumbai subscriber gets no WhatsApp message');
  ok(delhi && delhi.ok === true, 'the Delhi renewal goes through');

  saved.length = 0; links.length = 0; alerts.length = 0;
  due = [sub(3, 'Flat 4, Block C, Saket, New Delhi')];
  r = await run();
  ok(r.results[0].reason === 'outside_delivery_area' && links.length === 0, 'an address with no pincode is not renewed while NCR-only is on');

  saved.length = 0; links.length = 0; alerts.length = 0;
  process.env.DELIVERY_NATIONWIDE = '1';
  due = [sub(4, '12 Marine Drive, Mumbai, Maharashtra - 400001')];
  r = await run();
  ok(r.results[0].ok === true && links.length === 1 && alerts.length === 0, 'with DELIVERY_NATIONWIDE=1 the Mumbai renewal goes through again');

  console.log(`renewal-area-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
