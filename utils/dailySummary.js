'use strict';
// The 8:00 AM daily summary's data (Prashant, 9 Nov 2026).   Tests: scripts/daily-summary-test.js
//  - "Yesterday's orders" = orders PAID in the IST day. The paid time is the invoice's issued_at, written when the money lands.
//    updated_at alone is wrong: packing, shipping or a note moves it, so an old order came back as a new one (MNG-9WZ6-2910).
//  - "Still to do" = every open order, every morning: paid but not packed, and packed but not sent out.

const { FLAVOURS } = require('./orderText');

// Orders created before this are pre-launch test orders (paid in the database, unknown to the live Razorpay account).
// Same cutoff as the stock's committed count (utils/inventory.js ORDERS_FROM_DEFAULT).
const OPEN_FROM = '2026-10-10T00:00:00+05:30';
const DAY = 86400000, IST = 5.5 * 3600 * 1000;

const paidAtOf = (o, inv) => (inv && inv.issued_at) || o.updated_at;

/** Orders paid in [sinceISO, untilISO), oldest payment first, each a copy with paid_at set. No invoice: the last update stands in. */
function paidInDay(orders, invoicesByOrder, sinceISO, untilISO) {
  const a = Date.parse(sinceISO), b = Date.parse(untilISO);
  return (orders || [])
    .map((o) => ({ ...o, paid_at: paidAtOf(o, (invoicesByOrder || {})[o.order_id]) }))
    .filter((o) => { const t = Date.parse(o.paid_at); return t >= a && t < b; })
    .sort((x, y) => Date.parse(x.paid_at) - Date.parse(y.paid_at));
}

// Whole calendar days in IST between a time and now (paid on 6 Nov, read on 9 Nov = 3).
const istDay = (ms) => Math.floor((ms + IST) / DAY);
const daysSince = (iso, now) => Math.max(0, istDay(now) - istDay(Date.parse(iso)));

const SHORT = Object.fromEntries(FLAVOURS.flatMap((f) => [[f.name, f.short], [f.short, f.short]]));

/** Boxes to pull per Flavor across admin-shaped items ({ name, qty, contents }), sets opened up, in the usual Flavor order. */
function flavoursToPull(items) {
  const n = {};
  for (const it of items || []) {
    const qty = Number(it.qty) || 0;
    const names = it.contents ? String(it.contents).split(' + ') : [SHORT[it.name] || it.name];
    for (const f of names) n[f] = (n[f] || 0) + qty;
  }
  const order = FLAVOURS.map((f) => f.short);
  return Object.entries(n).filter(([, q]) => q > 0).sort((x, y) => (order.indexOf(x[0]) + 1 || 99) - (order.indexOf(y[0]) + 1 || 99));
}

/** From the admin's shaped order list: { toPack, notSent, flavours, toPackBoxes }, oldest first. */
function stillToDo(shaped, { from = OPEN_FROM, now = Date.now() } = {}) {
  const t0 = Date.parse(from);
  const open = (shaped || []).filter((o) => Date.parse(o.created_at) >= t0);
  const line = (o, at, why) => ({ id: o.id, name: o.name, boxes: o.boxes, since: at, waitingDays: daysSince(at, now), ...(why ? { why } : {}) });
  const byAge = (x, y) => Date.parse(x.since) - Date.parse(y.since);
  const packing = open.filter((o) => o.state === 'topack');
  const toPack = packing.map((o) => line(o, o.paid_at || o.created_at)).sort(byAge);
  const notSent = open.filter((o) => o.state === 'packed' || (o.state === 'shipped' && o.awaiting_pickup))
    .map((o) => (o.state === 'packed' ? line(o, o.packed_at || o.created_at, 'no courier booked') : line(o, o.shipped_at || o.packed_at || o.created_at, 'courier booked, not collected')))
    .sort(byAge);
  return { toPack, notSent, flavours: flavoursToPull(packing.flatMap((o) => o.items || [])), toPackBoxes: packing.reduce((s, o) => s + (Number(o.boxes) || 0), 0) };
}

/** " · 2 to pack, 1 to send" for the subject line; '' when nothing waits or the list could not be read. */
function subjectTail(todo) {
  if (!todo) return '';
  const parts = [];
  if (todo.toPack.length) parts.push(`${todo.toPack.length} to pack`);
  if (todo.notSent.length) parts.push(`${todo.notSent.length} to send`);
  return parts.length ? ' · ' + parts.join(', ') : '';
}

/** Everything the summary email needs for the IST day [since, until). todo is null when the open orders could not be read. */
async function gatherDay({ since, until, todayIst, now = Date.now(), from = OPEN_FROM, deps }) {
  const touched = await deps.getPaidOrdersUpdatedSince(since);   // a later edit only moves updated_at forward, so nothing paid that day is missed
  const allInvoices = await deps.getInvoicesByOrderIds(touched.map((o) => o.order_id));
  const orders = paidInDay(touched, allInvoices, since, until);
  const invoicesByOrder = {};
  orders.forEach((o) => { if (allInvoices[o.order_id]) invoicesByOrder[o.order_id] = allInvoices[o.order_id]; });
  const creditNotes = await deps.getCreditNotesBetween(since, until);
  let suggestions = [];
  try { suggestions = await deps.listSuggestionsBetween(since, until); } catch (e) { console.error('[DIGEST] suggestions not read:', e.message); }
  let stockLines = null;
  try { stockLines = await deps.stockLines(todayIst); } catch (e) { console.error('[DIGEST] stock lines not read:', e.message); }
  let todo = null;
  try { todo = stillToDo(await deps.listOrders(), { from, now }); } catch (e) { console.error('[DIGEST] open orders not read:', e.message); }
  return { orders, invoicesByOrder, creditNotes, suggestions, stockLines, todo };
}

module.exports = { paidInDay, stillToDo, subjectTail, gatherDay, flavoursToPull, OPEN_FROM };
