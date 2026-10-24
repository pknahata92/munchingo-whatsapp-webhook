'use strict';
// The 25 Oct 2026 flow: prices 259/299, Trio 799, minimum 2 boxes, Rs 49 shipping under Rs 777, and what that does downstream.
//   node scripts/pack-of-2-test.js
const path = require('path');
process.env.SUPABASE_URL = 'x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'x'; process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'x';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const stub = (rel, exp) => { const f = require.resolve(path.join(__dirname, '..', rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };

const saved = [], links = [];
stub('utils/database.js', {
  saveOrder: async (o) => { saved.push(o); }, updateOrderAddress: async () => {}, updateOrderPaymentLink: async () => {}, getOrder: async () => null,
  listSpendTiers: async () => [], setPrice: async () => {},
});
stub('utils/razorpay.js', { createPaymentLink: async (o) => { links.push(o); return { id: 'plink', url: 'https://rzp.io/x' }; }, orderIdFromReference: () => null });
stub('utils/stock.js', { ensureFresh: async () => {}, soldOutSlugs: () => [], sellable: async () => ({}) });
stub('utils/delhivery.js', { checkPincode: async () => ({ serviceable: true }) });
stub('utils/coupons.js', { validateCoupon: async () => ({ ok: false, error: 'That code is not valid.' }) });
stub('utils/mailer.js', { sendContactFormEmail: async () => {} });
stub('utils/rateLimit.js', { rateLimit: () => (req, res, next) => next() });
stub('utils/launch.js', { ordersOpen: () => true, CLOSED_MESSAGE: 'closed', isPreorder: () => false });

const S = require('../utils/shipping');
const catalog = require('../utils/catalog');
const { boxesIn } = require('../utils/orderText');

(async () => {
  // prices
  ok(catalog.priceForSlug('atta-original') === 259 && catalog.priceForSlug('atta-ajwain') === 259, 'Original and Ajwain are Rs 259');
  ok(catalog.priceForSlug('atta-kesari') === 299 && catalog.priceForSlug('atta-lite-sugar') === 299, 'Kesari and Sugar-Lite are Rs 299');
  ok(catalog.priceForSlug('trio-gift-set-ajwain-kesari-original') === 799 && catalog.priceForSlug('full-range-set') === 999, 'Trio Rs 799, Full Range Rs 999');
  const book = catalog.priceBook();
  ok(book['atta-original'].mrp === 300 && book['atta-kesari'].mrp === 350, 'the printed MRP (300 / 350) stays as the struck-through price');

  // shipping rule
  ok(S.shippingFor(518) === 49 && S.shippingFor(598) === 49 && S.shippingFor(776) === 49, 'under Rs 777 pays Rs 49');
  ok(S.shippingFor(777) === 0 && S.shippingFor(817) === 0 && S.shippingFor(799) === 0, 'from Rs 777 (3 boxes at Rs 259) shipping is free');
  ok(3 * 259 === S.FREE_FROM, 'three boxes at Rs 259 are exactly the free-shipping line');
  ok(S.isShippingItem(S.shippingItem(49)) && !S.isShippingItem({ slug: 'atta-original' }), 'the shipping line is recognised, goods are not');
  ok(S.goodsOnly([{ slug: 'atta-original' }, S.shippingItem(49)]).length === 1, 'goodsOnly drops the shipping line');
  ok(boxesIn(S.shippingItem(49)) === 0 && boxesIn({ slug: 'trio-gift-set-ajwain-kesari-original' }) === 3 && boxesIn({ slug: 'full-range-set' }) === 4, 'the shipping line is no box; gift sets are 3 and 4 boxes');

  // the checkout route, end to end against stand-ins
  const express = require('express');
  const app = express(); app.use(express.json()); app.use(require('../routes/checkout'));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { s: r.status, j: await r.json() }; };
  const buyer = { name: 'Test Buyer', phone: '9999900001', address: '1 Test Rd, Faridabad, Haryana - 121007', email: 't@example.com', addressParts: { state: 'Haryana', city: 'Faridabad', pincode: '121007' } };
  const cart = (...pairs) => pairs.map(([slug, qty]) => ({ slug, qty, name: slug, price: 1 }));

  let r = await post('/api/checkout', { ...buyer, items: cart(['atta-original', 1]), total: 259 });
  ok(r.s === 400 && /start at 2 boxes/.test(r.j.error) && /1 more box\b/.test(r.j.error), 'one box is refused: online orders start at 2 boxes');
  const before = saved.length;
  r = await post('/api/checkout', { ...buyer, items: cart(['atta-original', 1], ['atta-ajwain', 1]), total: 518 });
  ok(r.s === 200 && r.j.ok && saved.length === before + 1, 'a Pack of 2 (Original + Ajwain) is accepted');
  let o = saved[saved.length - 1];
  ok(o.total === 518 + 49, 'the order total is Rs 567: Rs 518 of boxes plus Rs 49 shipping');
  ok(o.items.length === 3 && S.isShippingItem(o.items[2]) && o.items[2].item_price === 49, 'the shipping fee is saved as its own line');
  ok(links[links.length - 1].amount === 567, 'the Razorpay amount includes shipping');
  r = await post('/api/checkout', { ...buyer, items: cart(['atta-kesari', 1], ['atta-lite-sugar', 1]), total: 598 });
  o = saved[saved.length - 1]; ok(r.j.ok && o.total === 598 + 49, 'Kesari + Sugar-Lite: Rs 598 + Rs 49 = Rs 647');
  r = await post('/api/checkout', { ...buyer, items: cart(['atta-original', 3]), total: 777 });
  o = saved[saved.length - 1]; ok(r.j.ok && o.total === 777 && o.items.length === 1, 'three boxes (Rs 777) ship free: no shipping line');
  r = await post('/api/checkout', { ...buyer, items: cart(['trio-gift-set-ajwain-kesari-original', 1]), total: 799 });
  o = saved[saved.length - 1]; ok(r.j.ok && o.total === 799 && o.items.length === 1, 'a Trio counts as 3 boxes, Rs 799, free shipping');
  r = await post('/api/checkout', { ...buyer, items: cart(['atta-original', 2]), total: 518 });
  o = saved[saved.length - 1]; if (!r.j.ok || o.total !== 567) console.log('DBG', JSON.stringify(r), o.total, JSON.stringify(o.items)); ok(r.j.ok && o.total === 567, 'two boxes of the same Flavor also make a Pack of 2');

  r = await post('/api/quote', { items: cart(['atta-original', 1], ['atta-kesari', 1]) });
  ok(r.j.ok && r.j.goodsTotal === 558 && r.j.shipping === 49 && r.j.finalTotal === 607 && r.j.boxes === 2 && r.j.minBoxes === 2 && r.j.freeFrom === 777, 'the quote shows goods, shipping, the payable total, boxes, the minimum and the free-shipping line');
  r = await post('/api/quote', { items: cart(['atta-original', 3]) });
  ok(r.j.shipping === 0 && r.j.finalTotal === 777, 'the quote for three boxes has no shipping');
  server.close();

  // the invoice carries shipping as a line, taxed with the goods, never discounted
  const { buildInvoice } = require('../utils/invoice');
  const order = { order_id: 'MNG-TEST-2510', customer_name: 'T', customer_phone: '919999900001', delivery_address: { raw: 'x, Jaipur, Rajasthan - 302001', state: 'Rajasthan', pincode: '302001' },
    items: [{ productName: 'Atta Original', quantity: 1, item_price: 259, slug: 'atta-original' }, { productName: 'Atta Ajwain', quantity: 1, item_price: 259, slug: 'atta-ajwain' }, S.shippingItem(49)], total: 567, discount_amount: 0 };
  let inv = buildInvoice(order, { invoiceNo: 'MUN/26-27/0100', issuedAt: new Date() });
  ok(inv.totalPaise === 56700 && inv.items.length === 3, 'the invoice total is Rs 567 with three lines');
  const ship = inv.items.find((i) => i.name === 'Shipping charges');
  ok(ship && ship.netPaise === 4900 && ship.discountPaise === 0, 'the shipping line is Rs 49 and undiscounted');
  ok(inv.taxablePaise + inv.cgstPaise + inv.sgstPaise + inv.igstPaise === 56700, 'taxable plus tax equals the total');
  const withDisc = buildInvoice({ ...order, total: 567 - 50, discount_amount: 50 }, { invoiceNo: 'MUN/26-27/0101', issuedAt: new Date() });
  const ship2 = withDisc.items.find((i) => i.name === 'Shipping charges');
  ok(ship2.netPaise === 4900 && withDisc.totalPaise === (567 - 50) * 100, 'a discount comes off the boxes only; shipping stays Rs 49');
  const { buildCreditNote } = require('../utils/creditNote');
  const cnFull = buildCreditNote(inv, { amountPaise: inv.totalPaise, refundId: 'r1', paymentId: 'p', reasonCode: 'other', creditNoteNo: 'CN/1', issuedAt: new Date() });
  ok(cnFull.amountPaise === 56700 && cnFull.items.length === 3, 'a full refund credits the shipping line too');

  // the admin view and the courier never see shipping as goods
  const { shapeOrder } = require('../utils/adminActions');
  const shaped = shapeOrder({ ...order, status: 'paid', payment_id: 'p', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, null, []);
  ok(shaped.boxes === 2 && shaped.items.length === 2 && shaped.shipping === 49, 'the admin view counts 2 boxes, lists 2 goods and shows shipping Rs 49 separately');
  const D = require('../utils/delhiveryShipment');
  const payload = (boxes) => D.buildPayload({ order: { ...order, delivery_address: { raw: '1 Test Road, Jaipur, Rajasthan - 302001', pincode: '302001', state: 'Rajasthan', city: 'Jaipur' } }, shaped: { ...shaped, boxes, ship_phone: '9999900001', ship_name: 'T', items: shaped.items } }).shipments[0];
  delete process.env.DELHIVERY_2BOX_MAILER;
  let sh = payload(2);
  ok(sh.shipment_length === '20.3' && !/Shipping/.test(sh.products_desc), 'a 2-box parcel is declared in the 8 in cube until the mailer is switched on; shipping is not in the product list');
  process.env.DELHIVERY_2BOX_MAILER = '1';
  sh = payload(2);
  ok(sh.shipment_length === '20' && sh.shipment_width === '15' && sh.shipment_height === '10' && sh.weight === '660', 'with DELHIVERY_2BOX_MAILER=1 a 2-box parcel is declared 20 x 15 x 10 cm and 660 g (1 kg slab)');
  sh = payload(3); ok(sh.shipment_length === '20.3', 'a 3-box parcel stays in the cube');
  delete process.env.DELHIVERY_2BOX_MAILER;

  console.log(`pack-of-2-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
