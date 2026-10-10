'use strict';
/**
 * Practice copy of the admin page running on FAKE orders (no database, no email, no Razorpay).
 *   node scripts/admin-dev.js          -> http://localhost:8430/admin   (login code is printed here and saved to /tmp/admin-dev-code.txt)
 */
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');
process.env.ADMIN_EMAILS = 'owner@example.com';
process.env.DIGEST_SECRET = 'dev-only-secret';
process.env.RESEND_API_KEY = 'x';
const stub = (rel, exp) => { const f = require.resolve(path.join(root, rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };

const { buildInvoice } = require('../utils/invoice');
const now = Date.now();
const mk = (id, mins, status, extra) => ({ order_id: id, created_at: new Date(now - mins * 60000).toISOString(), updated_at: new Date(now - (mins - 1) * 60000).toISOString(), status, customer_name: 'Customer ' + id.slice(-4), customer_phone: '9198100' + id.replace(/\D/g, '').slice(0, 5).padEnd(5, '0'), customer_email: 'c@example.com', total: 665, discount_amount: 74, coupon_code: 'FOUNDING10', payment_id: status === 'paid' ? 'pay_' + id : null, gift_note: null, delivery_address: { raw: '43/14, Faridabad, Haryana - 121007', state: 'Haryana' }, items: [{ slug: 'trio-gift-set-kesari-lite-sugar-original', productName: 'Trio Gift Set', quantity: 1, item_price: 739, unit: '750g' }], ...extra });
const orders = [
  mk('MNG-AAAA-1010', 30, 'paid', { gift_note: 'Happy Birthday to Prashant' }),
  mk('MNG-BBBB-1010', 90, 'paid', { total: 518, discount_amount: 0, coupon_code: null, items: [{ slug: 'atta-original', productName: 'Atta Original', quantity: 2, item_price: 259, unit: '250g' }] }),
  mk('MNG-CCCC-1009', 1500, 'paid', { shipped_at: new Date(now - 1000000).toISOString(), carrier: 'Delhivery', awb: '1234567890' }),
  mk('MNG-DDDD-1009', 1700, 'pending_payment', { payment_id: null, payment_link_id: 'plink_1' }),
  mk('MNG-EEEE-1008', 3000, 'cancelled', {}),
];
const invoices = {};
orders.filter((o) => o.payment_id).forEach((o, i) => { const inv = buildInvoice(o, { invoiceNo: `MUN/26-27/${String(i + 1).padStart(4, '0')}`, issuedAt: new Date(o.created_at) }); invoices[o.order_id] = { order_id: o.order_id, invoice_no: inv.invoiceNo, supply_type: inv.supplyType, total_paise: inv.totalPaise, data: inv }; });
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
});
stub('utils/mailer.js', {
  sendAdminCode: async (email, code) => { fs.writeFileSync('/tmp/admin-dev-code.txt', code); console.log('[dev] login code for', email, '=', code); },
  sendShippedEmail: async ({ order }) => console.log('[dev] shipped email ->', order.customer_email),
  sendCustomerConfirmationEmail: async ({ order }) => console.log('[dev] invoice email ->', order.customer_email),
});
stub('utils/razorpay.js', {
  createRefund: async ({ paymentId, amountPaise, notes }) => { console.log('[dev] Razorpay refund', paymentId, amountPaise, notes); return { id: 'rfnd_dev_' + Date.now(), status: 'processed' }; },
  expirePaymentLink: async () => true,
});
const express = require('express');
const app = express();
app.use(express.json());
app.use(require('../routes/admin'));
app.listen(8430, () => console.log('Admin practice copy: http://localhost:8430/admin'));
