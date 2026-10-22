'use strict';
/**
 * Practice copy of the admin page running on FAKE orders (no database, no email, no Razorpay).
 *   node scripts/admin-dev.js          -> http://localhost:8430/admin   (login code is printed here and saved to /tmp/admin-dev-code.txt)
 */
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');
process.env.ADMIN_EMAILS = 'owner@example.com';
const team = [{ email: 'staff@example.com', name: 'Staff', role: 'staff', active: true, created_at: new Date().toISOString() }];
const events = [];
const priceRows = [{ slug: 'atta-original', price: 300, mrp: 300 }, { slug: 'atta-ajwain', price: 300, mrp: 300 }, { slug: 'atta-kesari', price: 350, mrp: 350 }, { slug: 'atta-lite-sugar', price: 350, mrp: 350 }, { slug: 'trio-gift-set', price: 739, mrp: null }, { slug: 'full-range-set', price: 999, mrp: null }];
const spendTiers = [{ id: 1, min_singles: 1500, discount: 100, label: null, starts_at: null, ends_at: null, active: true, created_at: '2026-10-12T00:00:00Z' }];
let tierSeq = 1;
const coupons = [
  { code: 'FOUNDING10', type: 'percent', value: 10, max_discount_amount: 100, min_order_value: 0, scope_slug: null, max_uses: 100, uses_count: 3, max_uses_per_customer: 1, expires_at: '2026-12-31T18:29:59Z', active: true, created_at: '2026-09-01T00:00:00Z' },
  { code: 'OLD5', type: 'flat', value: 50, min_order_value: 499, scope_slug: null, max_uses: null, uses_count: 0, max_uses_per_customer: 1, expires_at: '2026-01-01T00:00:00Z', active: true, created_at: '2026-01-01T00:00:00Z' },
];
const couponReds = [
  { coupon_code: 'FOUNDING10', customer_phone: '919810000001', discount_amount: 74 }, { coupon_code: 'FOUNDING10', customer_phone: '919810000002', discount_amount: 100 }, { coupon_code: 'FOUNDING10', customer_phone: '919810000003', discount_amount: 90 },
];
const stockRows = ['atta-original', 'atta-kesari', 'atta-lite-sugar', 'atta-ajwain'].map((slug) => ({ slug, available: true }));
process.env.DIGEST_SECRET = 'dev-only-secret';
process.env.RESEND_API_KEY = 'x';
const stub = (rel, exp) => { const f = require.resolve(path.join(root, rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };

const { buildInvoice } = require('../utils/invoice');
const now = Date.now();
const mk = (id, mins, status, extra) => ({ order_id: id, created_at: new Date(now - mins * 60000).toISOString(), updated_at: new Date(now - (mins - 1) * 60000).toISOString(), status, customer_name: 'Customer ' + id.slice(-4), customer_phone: '9198100' + id.replace(/\D/g, '').slice(0, 5).padEnd(5, '0'), customer_email: 'c@example.com', total: 665, discount_amount: 74, coupon_code: 'FOUNDING10', payment_id: status === 'paid' ? 'pay_' + id : null, gift_note: null, delivery_address: { raw: '43/14, Faridabad, Haryana - 121007', state: 'Haryana' }, items: [{ slug: 'trio-gift-set-kesari-lite-sugar-original', productName: 'Trio Gift Set', quantity: 1, item_price: 739, unit: '750g' }], ...extra });
const orders = [
  mk('MNG-AAAA-1010', 30, 'paid', { gift_note: 'Happy Birthday to Prashant' }),
  mk('MNG-BBBB-1010', 90, 'paid', { total: 518, discount_amount: 0, coupon_code: null, items: [{ slug: 'atta-original', productName: 'Atta Original', quantity: 2, item_price: 259, unit: '250g' }] }),
  mk('MNG-GGGG-1010', 55, 'paid', { gift_note: 'Happy Diwali', delivery_address: { raw: 'Flat 4, Bandra, Mumbai, Maharashtra - 400050', state: 'Maharashtra', recipientName: 'Anita Rao', recipientPhone: '919820012345' } }),
  mk('MNG-FFFF-1010', 50, 'paid', { total: 777, discount_amount: 0, coupon_code: null, items: [{ slug: 'atta-kesari', productName: 'Atta Kesari', quantity: 3, item_price: 299, unit: '250g' }] }),
  mk('MNG-GGGG-1008', 4000, 'paid', { packed_at: new Date(now - 3000000).toISOString(), packed_by: 'Staff' }),
  mk('MNG-HHHH-1007', 6000, 'paid', { shipped_at: new Date(now - 4000000).toISOString(), delivered_at: new Date(now - 1000000).toISOString(), carrier: 'Delhivery', awb: '99887766' }),
  mk('MNG-HAND-1012', 95000, 'paid', {}),
  mk('MNG-PORT-1012', 95001, 'paid', {}),
  mk('MNG-OTHR-1012', 95002, 'paid', {}),
  mk('MNG-TEST-1001', 90000, 'paid', {}),
  mk('MNG-CCCC-1009', 1500, 'paid', { shipped_at: new Date(now - 1000000).toISOString(), carrier: 'Delhivery', awb: '1234567890' }),
  mk('MNG-WITH-1009', 1400, 'paid', { customer_name: 'Collins Courier', packed_at: new Date(now - 90000000).toISOString(), shipped_at: new Date(now - 80000000).toISOString(), carrier: 'Delhivery', awb: '5566778899' }),   // shipped, courier has collected it (marker event seeded below)
  // Two orders either side of Indian midnight on 20/21 Oct (UTC date is the same for both): they must land under different day headers.
  mk('MNG-ISTA-1000', 1, 'paid', { customer_name: 'Ist Alpha', created_at: '2026-10-20T17:00:00.000Z', updated_at: '2026-10-20T17:00:00.000Z' }),
  mk('MNG-ISTB-1000', 1, 'paid', { customer_name: 'Ist Beta', created_at: '2026-10-20T19:00:00.000Z', updated_at: '2026-10-20T19:00:00.000Z' }),
  // Delivered practice orders for the review feature: one 6 days ago (due for an ask), one 15 days ago by a founding taster.
  mk('MNG-REVA-1001', 9000, 'paid', { customer_name: 'Riya Kapoor', delivery_address: { raw: 'Flat 2, Bandra, Mumbai, Maharashtra - 400050', state: 'Maharashtra', source: { how: 'friend_family' } }, packed_at: new Date(now - 9000 * 60000).toISOString(), shipped_at: new Date(now - 8600 * 60000).toISOString(), delivered_at: new Date(now - 6 * 86400000).toISOString(), carrier: 'Delhivery', awb: '7788990011', items: [{ slug: 'trio-gift-set-kesari-lite-sugar-original', productName: 'Trio Gift Set', quantity: 1, item_price: 799, unit: '750g' }] }),
  mk('MNG-REVB-1002', 25000, 'paid', { created_at: '2026-10-14T06:00:00.000Z', customer_name: 'Founding Taster', customer_phone: '919810000777', packed_at: new Date(now - 25000 * 60000).toISOString(), shipped_at: new Date(now - 24000 * 60000).toISOString(), delivered_at: new Date(now - 15 * 86400000).toISOString(), carrier: 'Delhivery', awb: '7788990022', items: [{ slug: 'atta-original', productName: 'Atta Original', quantity: 2, item_price: 300, unit: '250g' }, { slug: 'atta-ajwain', productName: 'Atta Ajwain', quantity: 1, item_price: 300, unit: '250g' }] }),
  mk('MNG-DDDD-1009', 1700, 'pending_payment', { payment_id: null, payment_link_id: 'plink_1', payment_link_url: 'https://rzp.io/rzp/OLD' }),
  mk('MNG-UUUU-1011', 20, 'pending_payment', { payment_id: null, payment_link_id: 'plink_2', payment_link_url: 'https://rzp.io/rzp/FRESH', total: 900, discount_amount: 0, coupon_code: null, items: [{ slug: 'atta-original', productName: 'Atta Original', quantity: 3, item_price: 300, unit: '250g' }] }),
  mk('MNG-WAFA-1011', 25, 'pending_payment', { payment_id: null, payment_link_id: 'plink_4', payment_link_url: 'https://rzp.io/rzp/WAFA', customer_phone: '919999900000' }),
  mk('MNG-NOEM-1011', 30, 'pending_payment', { payment_id: null, payment_link_id: 'plink_3', payment_link_url: 'https://rzp.io/rzp/NOEM', customer_email: null }),
  mk('MNG-EEEE-1008', 3000, 'cancelled', {}),
];
events.push({ order_id: 'MNG-WITH-1009', event: 'courier_picked_up', actor_name: 'System', created_at: new Date(now - 70000000).toISOString() });
const reviews = [
  { id: 1, order_id: 'MNG-REVB-1002', customer_phone: '919810000777', ratings: { 'atta-original': 1, 'atta-ajwain': 4 }, comment: '<img src=x onerror=alert(1)>', display_name: 'Founding', city: 'Delhi', consent_publish: false, network: false, founding_taster: true, status: 'new', hidden_reason: null, created_at: new Date(now - 2 * 86400000).toISOString() },
  { id: 2, order_id: 'MNG-REVA-1001', customer_phone: '919810000101', ratings: { 'atta-original': 5, 'atta-kesari': 4, 'atta-lite-sugar': 5 }, comment: 'Kesari is the one', display_name: 'Riya', city: 'Mumbai', consent_publish: true, network: true, founding_taster: false, status: 'new', hidden_reason: null, created_at: new Date(now - 86400000).toISOString() },
]; let reviewSeq = 2;
const tasters = [{ phone: '919810000777', name: 'Founding Taster', first_order_id: 'MNG-REVB-1002', note: 'practice', added_at: new Date(now - 20 * 86400000).toISOString() }];
const invoices = {};
orders.filter((o) => o.payment_id && o.order_id !== 'MNG-FFFF-1010').forEach((o, i) => { const inv = buildInvoice(o, { invoiceNo: `MUN/26-27/${String(i + 1).padStart(4, '0')}`, issuedAt: new Date(o.created_at) }); invoices[o.order_id] = { order_id: o.order_id, invoice_no: inv.invoiceNo, supply_type: inv.supplyType, total_paise: inv.totalPaise, data: inv }; });
const cns = [{ order_id: 'MNG-EEEE-1008', credit_note_no: 'CN/26-27/0001', amount_paise: 66500, issued_at: new Date(now - 2900000).toISOString(), is_full: true, reason_code: 'out_of_stock', data: { reasonLabel: 'Out of stock' } }];

stub('utils/database.js', {
  listRecentOrders: async () => orders,
  getInvoicesByOrderIds: async (ids) => Object.fromEntries(ids.filter((i) => invoices[i]).map((i) => [i, invoices[i]])),
  getCreditNotesByOrderIds: async (ids) => cns.filter((c) => ids.includes(c.order_id)),
  getOrder: async (id) => orders.find((o) => o.order_id === id) || null,
  getInvoiceByOrder: async (id) => invoices[id] || null,
  getCreditNotesByOrder: async (id) => cns.filter((c) => c.order_id === id),
  updateOrderFields: async (id, f) => Object.assign(orders.find((o) => o.order_id === id), f),
  cancelOrder: async (id) => { orders.find((o) => o.order_id === id).status = 'cancelled'; return true; },
  getAdminUser: async (e) => team.find((t) => t.email === e) || null,
  listAdminUsers: async () => team,
  upsertAdminUser: async (r) => { const i = team.findIndex((t) => t.email === r.email); if (i >= 0) Object.assign(team[i], r); else team.push({ ...r, created_at: new Date().toISOString() }); },
  logOrderEvent: async (ev) => events.push({ ...ev, created_at: new Date().toISOString() }),
  listOrderEvents: async (id) => events.filter((e) => e.order_id === id),
  listOrderEventsByName: async (name, ids) => events.filter((e) => e.event === name && ids.includes(e.order_id)),
  claimOrderEvent: async (ev) => { if (events.some((e) => e.order_id === ev.order_id && e.event === ev.event)) return false; events.push({ ...ev, created_at: new Date().toISOString() }); return true; },
  insertReview: async (row) => { if (reviews.some((r) => r.order_id === row.order_id)) throw new Error('duplicate'); const r = { id: ++reviewSeq, status: 'new', hidden_reason: null, created_at: new Date().toISOString(), ...row }; reviews.push(r); return { id: r.id }; },
  getReviewByOrder: async (id) => reviews.find((r) => r.order_id === id) || null,
  listReviews: async ({ limit = 200 } = {}) => reviews.slice().reverse().slice(0, limit),
  updateReview: async (id, f) => { Object.assign(reviews.find((r) => r.id === Number(id)) || {}, f); },
  listFoundingTasters: async () => tasters.slice(),
  setFoundingTasters: async (rows) => { tasters.length = 0; rows.forEach((r) => tasters.push({ added_at: new Date().toISOString(), ...r })); },
  listDeliveredOrders: async ({ since }) => orders.filter((o) => o.status === 'paid' && o.delivered_at && o.delivered_at >= since),
  setKnownToUs: async (id, known) => { const o = orders.find((x) => x.order_id === id); if (o) o.known_to_us = !!known; },
  updateOrderIf: async (id, where, fields) => { const o = orders.find((x) => x.order_id === id); if (Object.entries(where).some(([k, v]) => (v === null ? o[k] != null : o[k] !== v))) return false; Object.assign(o, fields); return true; },
  reserveInvoiceNumber: async () => 100 + Object.keys(invoices).length,
  saveInvoice: async ({ invoice, fy, seq }) => { const row = { order_id: invoice.orderId, invoice_no: invoice.invoiceNo, supply_type: invoice.supplyType, total_paise: invoice.totalPaise, data: invoice, fy, seq }; invoices[invoice.orderId] = row; return row; },
  markInvoice: async (id, f) => { if (invoices[id]) Object.assign(invoices[id], f); },
  getCreditNotesByOrder: async (id) => cns.filter((c) => c.order_id === id),
  markCreditNote: async (no, f) => { const c = cns.find((x) => x.credit_note_no === no); if (c) Object.assign(c, f); },
  markOrderRefunded: async (id) => { orders.find((o) => o.order_id === id).status = 'cancelled'; },
  listPrices: async () => priceRows,
  setPrice: async ({ slug, price, mrp }) => { const r = priceRows.find((x) => x.slug === slug); if (r) { r.price = price; r.mrp = mrp; } else priceRows.push({ slug, price, mrp }); },
  updateOrderPaymentLink: async (id, { paymentLinkId, paymentLinkUrl }) => Object.assign(orders.find((o) => o.order_id === id), { payment_link_id: paymentLinkId, payment_link_url: paymentLinkUrl }),
  offersReady: async () => global.__couponCols !== false,
  listSpendTiers: async () => spendTiers.slice().sort((a, b) => a.min_singles - b.min_singles),
  insertSpendTier: async (row) => { const r = { id: ++tierSeq, created_at: new Date().toISOString(), active: true, ...row }; spendTiers.push(r); return r; },
  updateSpendTier: async (id, f) => Object.assign(spendTiers.find((t) => String(t.id) === String(id)), f),
  deleteSpendTier: async (id) => { const i = spendTiers.findIndex((t) => String(t.id) === String(id)); if (i >= 0) spendTiers.splice(i, 1); },
  listCouponOrderTotals: async () => orders.filter((o) => o.coupon_code && o.payment_id).map((o) => ({ coupon_code: o.coupon_code, total: o.total })),
  couponColumnsReady: async () => global.__couponCols !== false,
  listCoupons: async () => coupons.slice().reverse(),
  listCouponRedemptions: async () => couponReds,
  getCoupon: async (c) => coupons.find((x) => x.code === c) || null,
  insertCoupon: async (row) => { const r = { uses_count: 0, created_at: new Date().toISOString(), ...row }; coupons.push(r); return r; },
  updateCouponRow: async (c, f) => Object.assign(coupons.find((x) => x.code === c), f),
  countCouponRedemptions: async (c) => couponReds.filter((r) => r.coupon_code === c).length,
  deleteCouponRow: async (c) => { coupons.splice(coupons.findIndex((x) => x.code === c), 1); },
  getOrdersInTransit: async () => orders.filter((o) => o.status === 'paid' && o.shipped_at && !o.delivered_at),
  listStock: async () => stockRows,
  setStock: async (slug, available) => { stockRows.find((r) => r.slug === slug).available = available; },
});
stub('utils/mailer.js', {
  sendAdminCode: async (email, code) => { fs.writeFileSync('/tmp/admin-dev-code-' + email.split('@')[0] + '.txt', code); fs.writeFileSync('/tmp/admin-dev-code.txt', code); console.log('[dev] login code for', email, '=', code); },
  sendShippedEmail: async ({ order }) => console.log('[dev] shipped email ->', order.customer_email),
  sendPackedEmail: async ({ order }) => console.log('[dev] packed email ->', order.customer_email),
  sendDeliveredEmail: async ({ order }) => console.log('[dev] delivered email ->', order.customer_email),
  sendOwnerPaidEmail: async () => console.log('[dev] owner email'),
  sendPaymentReminderEmail: async ({ email, paymentUrl }) => console.log('[dev] payment reminder ->', email, paymentUrl),
  sendCustomerConfirmationEmail: async ({ order }) => console.log('[dev] invoice email ->', order.customer_email),
});
stub('utils/refundTemplates.js', { sendScenario: async (to, key, data) => { if (to === '919999900000') throw new Error('Template name does not exist in the translation'); console.log('[dev] WhatsApp template', key, '->', to, JSON.stringify(data)); return { ok: true }; } });
stub('utils/zohoBooks.js', { configured: () => true, syncPaidOrder: async () => ({ invoiceId: 'zoho_inv_dev' }), syncCreditNote: async () => ({ creditNoteId: 'zoho_cn_dev' }) });
stub('utils/razorpay.js', {
  createRefund: async ({ paymentId, amountPaise, notes }) => { console.log('[dev] Razorpay refund', paymentId, amountPaise, notes); return { id: 'rfnd_dev_' + Date.now(), status: 'processed' }; },
  expirePaymentLink: async () => true,
  createPaymentLink: async ({ orderId, regenerated }) => ({ id: 'plink_new_' + Date.now(), url: 'https://rzp.io/rzp/NEW' + (regenerated ? 'R' : '') }),
  listPayments: async () => orders.filter((o) => o.payment_id && o.order_id !== 'MNG-TEST-1001').map((o) => ({ id: o.payment_id, amount: Math.round(o.total * 100), amount_refunded: 0, status: 'captured' })),
});
const express = require('express');
const app = express();
app.use(express.json());
app.post('/dev/track', (req, res) => { global.__trackStatus = (req.body && req.body.status) || 'Manifested'; res.json({ ok: true }); });   // practice copy only: what the stand-in Delhivery tracking says
app.post('/dev/sweep', async (req, res) => res.json(await require('../utils/orderUpdates').sweepOnce()));
app.post('/dev/couponcols', (req, res) => { global.__couponCols = !!(req.body && req.body.ready); res.json({ ok: true }); });   // practice copy only: pretend the coupons migration has / has not run
app.use(require('../routes/admin'));
// Practice-only stand-in for Delhivery's API (shipment creation and labels) so the ship and label buttons can be clicked through.
process.env.DELHIVERY_API_TOKEN = 'tok_dev';
{
  const real = global.fetch; let seq = 0;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (/\/api\/cmu\/create\.json/.test(u)) {
      const data = JSON.parse(new URLSearchParams(opts.body).get('data'));
      const sh = data.shipments[0];
      const out = sh.pin === '400050' ? { success: false, packages: [{ status: 'Fail', remarks: ['Pincode not serviceable'] }] } : { success: true, packages: [{ status: 'Success', waybill: String(880000000000 + (++seq)) }] };
      const buf = Buffer.from(JSON.stringify(out)); return { ok: true, status: 200, text: async () => buf.toString() };
    }
    if (/\/api\/v1\/packages\/json\//.test(u)) { const st = global.__trackStatus || 'Manifested'; const buf = Buffer.from(JSON.stringify({ ShipmentData: [{ Shipment: { Status: { Status: st, StatusType: st === 'Delivered' ? 'DL' : 'UD' } } }] })); return { ok: true, status: 200, text: async () => buf.toString() }; }
    if (/\/api\/v1\/packages\/json\//.test(u)) { const st = global.__trackStatus || 'Manifested'; const buf = Buffer.from(JSON.stringify({ ShipmentData: [{ Shipment: { Status: { Status: st, StatusType: st === 'Delivered' ? 'DL' : 'UD' } } }] })); return { ok: true, status: 200, text: async () => buf.toString() }; }
    if (/packing_slip\?wbns=/.test(u)) {
      const PDFLib = require('pdf-lib'); const d2 = await PDFLib.PDFDocument.create(); const p2 = d2.addPage([288, 432]);
      p2.drawRectangle({ x: 2, y: 2, width: 284, height: 428, borderWidth: 1, color: PDFLib.rgb(1, 1, 1), borderColor: PDFLib.rgb(0, 0, 0) });
      const buf = Buffer.from(await d2.save()); return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    }
    return real(url, opts);
  };
}
// Stock ledger on fake data: an in-memory store with a Kesari lot already received, so the Inventory screens have something to show.
{
  const inv = require(path.join(root, 'utils/inventory.js'));
  const store = require('./inventory-memstore').memStore(new Date(Date.now() - 86400_000).toISOString());
  store.paused = async () => stockRows.filter((r) => r.available === false).map((r) => r.slug);   // the practice copy's Pause selling switch
  const real = inv.makeInventory(store);
  real.receive({ slug: 'atta-kesari', received: 160, lot: '15OCT26', bestBefore: '2027-01-13', actor: { email: 'staff@example.com', name: 'Staff' } }).catch(() => {});
  real.receive({ slug: 'atta-lite-sugar', received: 33, damaged: 3, lot: '15OCT26', bestBefore: '2027-01-13', note: '3 crushed', actor: { email: 'staff@example.com', name: 'Staff' } }).catch(() => {});
  inv.instance = () => real;
}
app.listen(8430, () => console.log('Admin practice copy: http://localhost:8430/admin'));
