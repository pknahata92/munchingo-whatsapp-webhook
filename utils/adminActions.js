'use strict';

/** Everything the admin page can do. Pure functions of (inputs) so the HTTP layer stays thin. */
const db = require('./database');
const { contentsOf, boxesIn } = require('./orderText');
const { reasonOf, REASONS } = require('./refundReasons');

class AdminError extends Error { constructor(msg, status = 400, extra = {}) { super(msg); this.status = status; this.extra = extra; } }

const rupees = (paise) => Math.round(paise) / 100;

// Money really received, straight from Razorpay: payment_id -> { rupees: captured minus refunded, covers: since }.
// Cached for 2 minutes and shared by every call. If Razorpay cannot be reached the screen falls back to the database
// figures and says so (money.live = false) instead of showing wrong numbers as if they were right.
let rzCache = null;
async function razorpayMoney(sinceMs) {
  if (rzCache && Date.now() - rzCache.at < 120_000 && rzCache.since <= sinceMs) return rzCache.p;
  const p = (async () => {
    try {
      const items = await require('./razorpay').listPayments(Math.floor(sinceMs / 1000));
      const byId = {}, refundedFull = new Set(), paidAt = {};
      items.forEach((x) => {
        if (x.status !== 'captured' && x.status !== 'refunded') return;   // failed / abandoned attempts are not money
        byId[x.id] = Math.max(0, (x.amount - (x.amount_refunded || 0))) / 100;
        if (x.created_at) paidAt[x.id] = new Date(x.created_at * 1000).toISOString();
        if (x.status === 'refunded' || (x.amount_refunded || 0) >= x.amount) refundedFull.add(x.id);
      });
      return { live: true, byId, refundedFull, paidAt, since: sinceMs };
    } catch (err) {
      console.error('[ADMIN] could not read Razorpay payments:', err.response ? JSON.stringify(err.response.data) : err.message);
      return { live: false, byId: {}, refundedFull: new Set(), paidAt: {}, since: sinceMs };
    }
  })();
  rzCache = { at: Date.now(), since: sinceMs, p };
  return p;
}

// What the screen needs for one order: status, money, items with gift-set contents, invoice/credit-note links.
function shapeOrder(o, invoice, creditNotes = [], money = null) {
  const refundedPaise = creditNotes.reduce((n, c) => n + c.amount_paise, 0);
  const totalPaise = Math.round(Number(o.total) * 100);
  const items = (o.items || []).map((it) => ({ name: it.productName || it.product_retailer_id, qty: it.quantity, unit: it.unit || '', contents: contentsOf(it), price: it.item_price, boxes: boxesIn(it) * (it.quantity || 1) }));
  let state = 'topack';
  if (/^pending/.test(o.status)) state = 'unpaid';
  else if (o.status === 'cancelled' && !o.payment_id) state = 'cancelled';
  else if (o.status === 'cancelled' || (refundedPaise > 0 && refundedPaise >= totalPaise)) state = 'refunded';
  else if (money && money.live && o.payment_id && o.status === 'paid' && money.refundedFull.has(o.payment_id)) state = 'refunded';   // fully refunded at Razorpay; the order is closed below
  else if (money && money.live && o.payment_id && o.status === 'paid' && !(o.payment_id in money.byId)) state = 'test';   // paid in the database, unknown to Razorpay: a test-phase order
  else if (o.delivered_at) state = 'delivered';
  else if (o.shipped_at) state = 'shipped';
  else if (o.packed_at) state = 'packed';
  return {
    id: o.order_id, state, status: o.status,
    created_at: o.created_at, paid_at: o.status === 'paid' || o.payment_id ? ((money && money.paidAt && money.paidAt[o.payment_id]) || o.updated_at) : null,
    name: o.customer_name, phone: o.customer_phone, email: o.customer_email || '',
    address: (o.delivery_address && o.delivery_address.raw) || '', gift_note: o.gift_note || '',
    coupon: o.coupon_code || '', discount: Number(o.discount_amount || 0), total: Number(o.total),
    payment_id: o.payment_id || '', boxes: items.reduce((n, i) => n + i.boxes, 0), items,
    invoice_missing: !invoice && o.status === 'paid' && !!o.payment_id, invoice_no: invoice ? invoice.invoice_no : '', supply: invoice ? invoice.supply_type : '',
    received: money && money.live && o.payment_id in money.byId ? money.byId[o.payment_id] : (state === 'unpaid' || state === 'cancelled' || state === 'test' ? 0 : Math.max(0, Number(o.total) - rupees(refundedPaise))),
    refunded: rupees(refundedPaise), refundable: rupees(Math.max(0, totalPaise - refundedPaise)),
    credit_notes: creditNotes.map((c) => ({ no: c.credit_note_no, amount: rupees(c.amount_paise), reason: (c.data && c.data.reasonLabel) || c.reason_code || '', at: c.issued_at, full: c.is_full })),
    packed_at: o.packed_at || null, packed_by: o.packed_by || '', delivered_at: o.delivered_at || null, delivered_by: o.delivered_by || '',
    shipped_at: o.shipped_at || null, carrier: o.carrier || '', awb: o.awb || '', admin_note: o.admin_note || '',
  };
}

// One load of the order list is shared by everything that asks within 3 s (the tiles and the list load together).
// Any change made through the admin clears it at once.
let listCache = null;
const bust = () => { listCache = null; };
function listOrders() {
  if (listCache && Date.now() - listCache.at < 3000) return listCache.p;
  const p = loadOrders();
  listCache = { at: Date.now(), p };
  p.catch(() => { if (listCache && listCache.p === p) listCache = null; });
  return p;
}
async function loadOrders() {
  const orders = await db.listRecentOrders(600);
  const ids = orders.map((o) => o.order_id);
  const invoices = await db.getInvoicesByOrderIds(ids);
  const cns = await db.getCreditNotesByOrderIds(ids);
  const money = orders.length ? await razorpayMoney(Math.min(...orders.map((o) => Date.parse(o.created_at))) - 86400_000) : null;
  const byOrder = {};
  cns.forEach((c) => { (byOrder[c.order_id] = byOrder[c.order_id] || []).push(c); });
  // A paid order whose payment Razorpay shows as fully refunded is closed here too (the refund notice can arrive late or
  // not at all). Same call the refund flow uses; the credit note still comes from that flow.
  if (money && money.live) {
    orders.filter((o) => o.status === 'paid' && o.payment_id && money.refundedFull.has(o.payment_id)).forEach((o) => {
      db.markOrderRefunded(o.order_id).then(() => { o.status = 'cancelled'; logEvent(o.order_id, 'auto_cancelled', null, { meta: { reason: 'fully refunded at Razorpay' } }); })
        .catch((e) => console.error('[ADMIN] could not close refunded order', o.order_id, e.message));
    });
  }
  const shaped = orders.map((o) => shapeOrder(o, invoices[o.order_id], byOrder[o.order_id] || [], money));
  shaped.moneyLive = !!(money && money.live);
  return shaped;
}

async function getOrderDetail(orderId) {
  const o = await db.getOrder(orderId);
  if (!o) throw new AdminError('No such order', 404);
  const invoice = await db.getInvoiceByOrder(orderId).catch(() => null);
  const cns = await db.getCreditNotesByOrder(orderId).catch(() => []);
  const shaped = shapeOrder(o, invoice, cns);
  shaped.events = (await db.listOrderEvents(orderId)).map((e) => ({ event: e.event, from: e.from_state, to: e.to_state, by: e.actor_name || e.actor_email || '', at: e.created_at, meta: e.meta || null }));
  return { order: o, invoice, shaped };
}

// Start a refund in Razorpay. The refund.processed webhook then does the credit note, Zoho and customer message.
async function startRefund({ orderId, amountRupees, reasonCode = 'other', note = '', confirmShipped = false, actor }) {
  const { order, shaped } = await getOrderDetail(orderId);
  if ((shaped.state === 'shipped' || shaped.state === 'delivered') && !confirmShipped) {
    throw new AdminError(`This order is already ${shaped.state}. Refunding does not bring the parcel back. Confirm to go ahead.`, 409, { needsConfirm: 'shipped' });
  }
  if (order.status !== 'paid') throw new AdminError(`Order is "${order.status}"; only paid orders can be refunded.`, 409);
  if (!order.payment_id) throw new AdminError('This order has no payment id.', 409);
  if (!REASONS[reasonCode]) throw new AdminError('Pick a reason.');
  const remainingPaise = Math.round(shaped.refundable * 100);
  const amountPaise = amountRupees ? Math.round(Number(amountRupees) * 100) : remainingPaise;
  if (!(amountPaise > 0) || amountPaise > remainingPaise) throw new AdminError(`Amount must be between ₹0.01 and ₹${shaped.refundable.toFixed(2)} (what is still refundable).`);
  const refund = await require('./razorpay').createRefund({ paymentId: order.payment_id, amountPaise, notes: { order_id: orderId, reason_code: reasonCode, note: String(note).slice(0, 200) } });
  console.log(`[ADMIN] Refund ${refund.id} started for ${orderId}: Rs ${amountPaise / 100} (${reasonCode})`);
  await logEvent(orderId, 'refund_started', actor, { meta: { refundId: refund.id, amountRupees: amountPaise / 100, reason: reasonCode, orderWas: shaped.state } });
  return { refundId: refund.id, amountRupees: amountPaise / 100, reason: reasonOf(reasonCode).label };
}

// Owner: a paid order whose invoice was never created (the post-payment steps log errors but do not retry).
// Runs the same steps as the payment webhook (invoice, emails, WhatsApp invoice, Zoho); safe to repeat, an existing invoice is reused.
async function issueMissingInvoice(orderId, actor) {
  const { order, invoice } = await getOrderDetail(orderId);
  if (order.status !== 'paid') throw new AdminError('Only paid orders get an invoice.', 409);
  if (invoice) throw new AdminError(`This order already has invoice ${invoice.invoice_no}. Use Resend invoice.`, 409);
  const done = await require('./invoiceFlow').processPaidOrder({ order, phone: order.customer_phone });
  if (!done || !done.invoice) throw new AdminError('The invoice could not be created. Check the server logs.', 500);
  await logEvent(orderId, 'invoice_issued', actor, { meta: { invoiceNo: done.invoice.invoiceNo } });
  return { invoiceNo: done.invoice.invoiceNo };
}

async function cancelUnpaid(orderId, actor) {
  const { order } = await getOrderDetail(orderId);
  if (!/^pending/.test(order.status)) throw new AdminError(`Order is "${order.status}". Paid orders are cancelled by refunding them.`, 409);
  if (order.payment_link_id) await require('./razorpay').expirePaymentLink(order.payment_link_id);
  await db.cancelOrder(orderId);
  bust();
  await logEvent(orderId, 'cancelled_unpaid', actor);
  return { orderId };
}

async function resendInvoice(orderId, actor) {
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
  await logEvent(orderId, 'invoice_resent', actor, { meta: { via: sent } });
  return { sent };
}

const who = (actor) => ({ actor_email: actor && actor.email || null, actor_name: actor && (actor.name || actor.email) || null });
async function logEvent(orderId, event, actor, { from = null, to = null, meta = null } = {}) {
  bust();
  await db.logOrderEvent({ order_id: orderId, event, from_state: from, to_state: to, meta, ...who(actor) });
}

// Forward-only path for a paid order. Nothing can be skipped; only the owner can step back (undoStep).
const NEXT = { topack: 'packed', packed: 'shipped', shipped: 'delivered' };
const stampOf = { packed: 'packed', shipped: 'shipped', delivered: 'delivered' };

async function advance({ orderId, to, actor, carrier = 'Delhivery', awb = '' }) {
  const { order, shaped } = await getOrderDetail(orderId);
  if (order.status !== 'paid') throw new AdminError('Only paid orders can be moved forward.', 409);
  if (shaped.state === 'refunded') throw new AdminError('This order has been refunded.', 409);
  const from = shaped.state;
  if (NEXT[from] !== to) throw new AdminError(from === to || ['packed', 'shipped', 'delivered'].indexOf(from) > ['packed', 'shipped', 'delivered'].indexOf(to)
    ? `Already ${from}.` : `This order is "${from}"; the next step is "${NEXT[from] || 'none'}".`, 409);
  if (to === 'shipped' && !String(awb || '').trim()) throw new AdminError('Enter the tracking (AWB) number first. The customer is emailed it.');
  const now = new Date().toISOString();
  const by = actor.name || actor.email;
  let fields; let where;
  if (to === 'packed') { fields = { packed_at: now, packed_by: by }; where = { status: 'paid', packed_at: null, shipped_at: null }; }
  else if (to === 'shipped') {
    fields = { shipped_at: now, carrier: String(carrier || 'Delhivery').slice(0, 40), awb: String(awb || '').trim().slice(0, 40) };
    where = { status: 'paid', shipped_at: null, delivered_at: null };
  } else { fields = { delivered_at: now, delivered_by: by }; where = { status: 'paid', delivered_at: null }; }
  if (!(await db.updateOrderIf(orderId, where, fields))) throw new AdminError('Someone else just changed this order. Refresh and look again.', 409);
  await logEvent(orderId, to, actor, { from, to, meta: to === 'shipped' ? { carrier: fields.carrier, awb: fields.awb } : null });
  let emailed = false;
  if (to === 'shipped' && order.customer_email) {
    const trackUrl = /delhivery/i.test(fields.carrier) && fields.awb ? `https://www.delhivery.com/track/package/${encodeURIComponent(fields.awb)}` : '';
    try { await require('./mailer').sendShippedEmail({ order, carrier: fields.carrier, awb: fields.awb, trackUrl }); emailed = true; } catch (e) { console.error('[ADMIN] shipped email failed:', e.message); }
  }
  return { state: to, emailed };
}

// Owner only: undo the latest step (delivered -> shipped -> packed -> to pack). The customer is not un-emailed.
async function undoStep({ orderId, actor }) {
  const { order, shaped } = await getOrderDetail(orderId);
  if (order.status !== 'paid') throw new AdminError('Only paid orders have steps to undo.', 409);
  const from = shaped.state;
  const steps = {
    delivered: { to: 'shipped', where: {}, fields: { delivered_at: null, delivered_by: null } },
    shipped: { to: 'packed', where: { delivered_at: null }, fields: { shipped_at: null, carrier: null, awb: null } },
    packed: { to: 'topack', where: { shipped_at: null }, fields: { packed_at: null, packed_by: null } },
  };
  const step = steps[from];
  if (!step) throw new AdminError('Nothing to undo on this order.', 409);
  if (!(await db.updateOrderIf(orderId, { status: 'paid', ...step.where }, step.fields))) throw new AdminError('Someone else just changed this order. Refresh and look again.', 409);
  await logEvent(orderId, 'undo', actor, { from, to: step.to, meta: from === 'shipped' ? { carrier: order.carrier, awb: order.awb } : null });
  return { state: step.to };
}

// Mark many "to pack" orders packed in one go (same rules, one event each). Returns what happened per order.
async function bulkPack({ ids, actor }) {
  const results = [];
  for (const id of Array.from(new Set(ids || [])).slice(0, 100)) {
    try { await advance({ orderId: id, to: 'packed', actor }); results.push({ id, ok: true }); }
    catch (e) { results.push({ id, ok: false, error: e.message }); }
  }
  return { results, packed: results.filter((r) => r.ok).length };
}

// Data for the pick list (flavour totals) and packing slips for the given orders.
async function pickList(ids) {
  const out = []; const allItems = [];
  for (const id of Array.from(new Set(ids || [])).slice(0, 100)) {
    const { order, shaped } = await getOrderDetail(id);
    if (order.status !== 'paid') continue;
    (order.items || []).forEach((it) => allItems.push(it));
    out.push({ id: shaped.id, name: shaped.name, phone: shaped.phone, address: shaped.address, gift_note: shaped.gift_note, boxes: shaped.boxes, items: shaped.items.map((i) => ({ name: i.name, qty: i.qty, contents: i.contents })) });
  }
  return { flavours: require('./orderText').flavourTotals(allItems), orders: out };
}

async function saveNote(orderId, note, actor) {
  await db.updateOrderFields(orderId, { admin_note: String(note || '').slice(0, 1000) });
  await logEvent(orderId, 'note', actor);
  return {};
}

async function summary() {
  const all = await listOrders();
  const IST = 5.5 * 3600 * 1000;
  const today = new Date(Date.now() + IST).toISOString().slice(0, 10);
  const istDay = (iso) => new Date(Date.parse(iso) + IST).toISOString().slice(0, 10);
  const paidToday = all.filter((o) => o.paid_at && !['unpaid', 'cancelled', 'test'].includes(o.state) && istDay(o.paid_at) === today);
  return {
    today: { orders: paidToday.length, boxes: paidToday.reduce((n, o) => n + o.boxes, 0), revenue: paidToday.reduce((n, o) => n + o.received, 0) },
    receivedTotal: all.filter((o) => o.state !== 'test').reduce((n, o) => n + o.received, 0),
    moneyLive: !!all.moneyLive,
    test: all.filter((o) => o.state === 'test').length,
    topack: all.filter((o) => o.state === 'topack').length,
    unpaid: all.filter((o) => o.state === 'unpaid').length,
    packed: all.filter((o) => o.state === 'packed').length,
    shipped: all.filter((o) => o.state === 'shipped').length,
    delivered: all.filter((o) => o.state === 'delivered').length,
    refunded: all.filter((o) => o.state === 'refunded').length,
  };
}

// ── Team (owner only) ──
const auth = require('./adminAuth');
async function listTeam() {
  const rows = await db.listAdminUsers().catch(() => []);
  const seen = new Set(rows.map((r) => r.email));
  const envOwners = (process.env.ADMIN_EMAILS || process.env.NOTIFY_EMAIL || '').split(',').map((e) => e.trim().toLowerCase()).filter((e) => e && !seen.has(e));
  return [...envOwners.map((email) => ({ email, name: '', role: 'owner', active: true, permanent: true })),
    ...rows.map((r) => ({ email: r.email, name: r.name || '', role: r.role, active: r.active, permanent: auth.isEnvOwner(r.email) }))];
}
async function saveTeamMember({ email, name = '', role = 'staff', active = true, actor }) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new AdminError('Enter a valid email address.');
  if (!['owner', 'staff'].includes(role)) throw new AdminError('Role must be owner or staff.');
  if (auth.isEnvOwner(e) && (role !== 'owner' || !active)) throw new AdminError('This address is a permanent owner set on the server. Change ADMIN_EMAILS on Render to demote it.', 409);
  if (e === actor.email && (role !== 'owner' || !active)) throw new AdminError('You cannot demote or disable yourself.', 409);
  auth.clearUserCache();
  await db.upsertAdminUser({ email: e, name: String(name).slice(0, 60), role, active: !!active, created_by: actor.email });
  console.log(`[ADMIN] ${actor.email} set ${e} -> ${role}${active ? '' : ' (disabled)'}`);
  return {};
}

// ── Stock (owner only) ──
const stock = require('./stock');
const { BASE_SLUGS, nameForSlug } = require('./catalog');
async function stockList() {
  await stock.refresh();
  const out = stock.soldOutSlugs() || [];
  return BASE_SLUGS.map((slug) => ({ slug, name: nameForSlug(slug), available: !out.includes(slug) }));
}
async function setStock({ slug, available, actor }) {
  if (!BASE_SLUGS.includes(slug)) throw new AdminError('Unknown flavour.');
  await stock.setAvailable(slug, !!available, actor.email);
  console.log(`[ADMIN] ${actor.email} marked ${slug} ${available ? 'available' : 'SOLD OUT'}`);
  return {};
}

module.exports = { issueMissingInvoice, AdminError, shapeOrder, listOrders, getOrderDetail, startRefund, cancelUnpaid, resendInvoice, advance, undoStep, bulkPack, pickList, saveNote, summary, listTeam, saveTeamMember, stockList, setStock };
