'use strict';

/** Everything the admin page can do. Pure functions of (inputs) so the HTTP layer stays thin. */
const db = require('./database');
const { contentsOf, boxesIn } = require('./orderText');
const { reasonOf, REASONS } = require('./refundReasons');

class AdminError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

const rupees = (paise) => Math.round(paise) / 100;

// What the screen needs for one order: status, money, items with gift-set contents, invoice/credit-note links.
function shapeOrder(o, invoice, creditNotes = []) {
  const refundedPaise = creditNotes.reduce((n, c) => n + c.amount_paise, 0);
  const totalPaise = Math.round(Number(o.total) * 100);
  const items = (o.items || []).map((it) => ({ name: it.productName || it.product_retailer_id, qty: it.quantity, unit: it.unit || '', contents: contentsOf(it), price: it.item_price, boxes: boxesIn(it) * (it.quantity || 1) }));
  let state = 'topack';
  if (/^pending/.test(o.status)) state = 'unpaid';
  else if (o.status === 'cancelled' && !o.payment_id) state = 'cancelled';
  else if (o.status === 'cancelled' || (refundedPaise > 0 && refundedPaise >= totalPaise)) state = 'refunded';
  else if (o.shipped_at) state = 'shipped';
  return {
    id: o.order_id, state, status: o.status,
    created_at: o.created_at, paid_at: o.status === 'paid' || o.payment_id ? o.updated_at : null,
    name: o.customer_name, phone: o.customer_phone, email: o.customer_email || '',
    address: (o.delivery_address && o.delivery_address.raw) || '', gift_note: o.gift_note || '',
    coupon: o.coupon_code || '', discount: Number(o.discount_amount || 0), total: Number(o.total),
    payment_id: o.payment_id || '', boxes: items.reduce((n, i) => n + i.boxes, 0), items,
    invoice_no: invoice ? invoice.invoice_no : '', supply: invoice ? invoice.supply_type : '',
    refunded: rupees(refundedPaise), refundable: rupees(Math.max(0, totalPaise - refundedPaise)),
    credit_notes: creditNotes.map((c) => ({ no: c.credit_note_no, amount: rupees(c.amount_paise), reason: (c.data && c.data.reasonLabel) || c.reason_code || '', at: c.issued_at, full: c.is_full })),
    shipped_at: o.shipped_at || null, carrier: o.carrier || '', awb: o.awb || '', admin_note: o.admin_note || '',
  };
}

async function listOrders() {
  const orders = await db.listRecentOrders(300);
  const ids = orders.map((o) => o.order_id);
  const invoices = await db.getInvoicesByOrderIds(ids);
  const cns = await db.getCreditNotesByOrderIds(ids);
  const byOrder = {};
  cns.forEach((c) => { (byOrder[c.order_id] = byOrder[c.order_id] || []).push(c); });
  return orders.map((o) => shapeOrder(o, invoices[o.order_id], byOrder[o.order_id] || []));
}

async function getOrderDetail(orderId) {
  const o = await db.getOrder(orderId);
  if (!o) throw new AdminError('No such order', 404);
  const invoice = await db.getInvoiceByOrder(orderId).catch(() => null);
  const cns = await db.getCreditNotesByOrder(orderId).catch(() => []);
  return { order: o, invoice, shaped: shapeOrder(o, invoice, cns) };
}

// Start a refund in Razorpay. The refund.processed webhook then does the credit note, Zoho and customer message.
async function startRefund({ orderId, amountRupees, reasonCode = 'other', note = '' }) {
  const { order, shaped } = await getOrderDetail(orderId);
  if (order.status !== 'paid') throw new AdminError(`Order is "${order.status}"; only paid orders can be refunded.`, 409);
  if (!order.payment_id) throw new AdminError('This order has no payment id.', 409);
  if (!REASONS[reasonCode]) throw new AdminError('Pick a reason.');
  const remainingPaise = Math.round(shaped.refundable * 100);
  const amountPaise = amountRupees ? Math.round(Number(amountRupees) * 100) : remainingPaise;
  if (!(amountPaise > 0) || amountPaise > remainingPaise) throw new AdminError(`Amount must be between ₹0.01 and ₹${shaped.refundable.toFixed(2)} (what is still refundable).`);
  const refund = await require('./razorpay').createRefund({ paymentId: order.payment_id, amountPaise, notes: { order_id: orderId, reason_code: reasonCode, note: String(note).slice(0, 200) } });
  console.log(`[ADMIN] Refund ${refund.id} started for ${orderId}: Rs ${amountPaise / 100} (${reasonCode})`);
  return { refundId: refund.id, amountRupees: amountPaise / 100, reason: reasonOf(reasonCode).label };
}

async function cancelUnpaid(orderId) {
  const { order } = await getOrderDetail(orderId);
  if (!/^pending/.test(order.status)) throw new AdminError(`Order is "${order.status}". Paid orders are cancelled by refunding them.`, 409);
  if (order.payment_link_id) await require('./razorpay').expirePaymentLink(order.payment_link_id);
  await db.cancelOrder(orderId);
  return { orderId };
}

async function resendInvoice(orderId) {
  const { order, invoice } = await getOrderDetail(orderId);
  if (!invoice) throw new AdminError('No invoice exists for this order yet.', 409);
  const { renderInvoicePdf } = require('./invoice');
  const pdf = await renderInvoicePdf(invoice.data);
  const sent = [];
  if (order.customer_email) {
    await require('./mailer').sendCustomerConfirmationEmail({ order, invoice: invoice.data, pdf });
    sent.push('email');
  }
  if (process.env.INVOICE_WA_TEMPLATE && order.customer_phone) {
    const wa = require('./whatsapp');
    const filename = `Munchingo-Invoice-${invoice.invoice_no.replace(/\//g, '-')}.pdf`;
    const mediaId = await wa.uploadMedia(pdf, 'application/pdf', filename);
    await wa.sendDocumentTemplate(order.customer_phone, process.env.INVOICE_WA_TEMPLATE, 'en', { mediaId, filename },
      [order.customer_name || 'there', invoice.invoice_no, order.order_id, (invoice.total_paise / 100).toFixed(2)]);
    sent.push('WhatsApp');
  }
  if (!sent.length) throw new AdminError('The customer has no email and WhatsApp invoices are not switched on.', 409);
  return { sent };
}

async function markShipped({ orderId, carrier = 'Delhivery', awb = '' }) {
  const { order } = await getOrderDetail(orderId);
  if (order.status !== 'paid') throw new AdminError('Only paid orders can be marked shipped.', 409);
  const cleanAwb = String(awb).trim().slice(0, 40);
  await db.updateOrderFields(orderId, { shipped_at: new Date().toISOString(), carrier: String(carrier).slice(0, 40), awb: cleanAwb });
  let emailed = false;
  if (order.customer_email) {
    const trackUrl = /delhivery/i.test(carrier) && cleanAwb ? `https://www.delhivery.com/track/package/${encodeURIComponent(cleanAwb)}` : '';
    try { await require('./mailer').sendShippedEmail({ order, carrier, awb: cleanAwb, trackUrl }); emailed = true; } catch (e) { console.error('[ADMIN] shipped email failed:', e.message); }
  }
  return { emailed };
}

async function saveNote(orderId, note) {
  await db.updateOrderFields(orderId, { admin_note: String(note || '').slice(0, 1000) });
  return {};
}

async function summary() {
  const all = await listOrders();
  const IST = 5.5 * 3600 * 1000;
  const today = new Date(Date.now() + IST).toISOString().slice(0, 10);
  const istDay = (iso) => new Date(Date.parse(iso) + IST).toISOString().slice(0, 10);
  const paidToday = all.filter((o) => o.paid_at && o.state !== 'unpaid' && o.state !== 'cancelled' && istDay(o.paid_at) === today);
  return {
    today: { orders: paidToday.length, boxes: paidToday.reduce((n, o) => n + o.boxes, 0), revenue: paidToday.reduce((n, o) => n + o.total, 0) },
    topack: all.filter((o) => o.state === 'topack').length,
    unpaid: all.filter((o) => o.state === 'unpaid').length,
    shipped: all.filter((o) => o.state === 'shipped').length,
    refunded: all.filter((o) => o.state === 'refunded').length,
  };
}

module.exports = { AdminError, shapeOrder, listOrders, getOrderDetail, startRefund, cancelUnpaid, resendInvoice, markShipped, saveNote, summary };
