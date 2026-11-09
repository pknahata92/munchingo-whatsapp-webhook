'use strict';
// The 8:00 AM daily summary (Prashant, 9 Nov 2026). "Yesterday's orders" are the orders PAID yesterday (the invoice time), never
// orders that were only edited yesterday (MNG-9WZ6-2910, paid 29 Oct, came back as a new order after it was delivered on 8 Nov).
// And every morning it lists what is still to do: paid but not packed, and packed but not sent out.   node scripts/daily-summary-test.js
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const path = require('path');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://x'; process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x';
let DB_ERROR = null;
const sb = require.resolve('@supabase/supabase-js', { paths: [path.join(__dirname, '..')] });
const chain = () => { const q = { select: () => q, in: async () => (DB_ERROR ? { data: null, error: { message: DB_ERROR } } : { data: [], error: null }) }; return q; };
require.cache[sb] = { id: sb, filename: sb, loaded: true, exports: { createClient: () => ({ from: chain }) } };
const p = require.resolve('../utils/prices');
require.cache[p] = { id: p, filename: p, loaded: true, exports: { current: () => null, ensureFresh: async () => {}, isOn: () => false } };
const ds = require('../utils/dailySummary');
const t = require('../utils/emailTemplates');

(async () => {
  // ── which orders belong to the day (8 Nov IST) ──
  const SINCE = '2026-11-07T18:30:00.000Z', UNTIL = '2026-11-08T18:30:00.000Z';
  const ayush = { order_id: 'MNG-9WZ6-2910', status: 'paid', created_at: '2026-10-29T04:27:00.000Z', updated_at: '2026-11-08T09:27:00.000Z', total: 1036 };
  const fresh = { order_id: 'MNG-NEW1-0811', status: 'paid', created_at: '2026-11-08T05:00:00.000Z', updated_at: '2026-11-09T01:00:00.000Z', total: 518 };
  const noInv = { order_id: 'MNG-NOIN-0811', status: 'paid', created_at: '2026-11-08T03:00:00.000Z', updated_at: '2026-11-08T03:05:00.000Z', total: 600 };
  const invoices = {
    'MNG-9WZ6-2910': { invoice_no: 'MUN/26-27/0019', issued_at: '2026-10-29T04:30:00.000Z' },
    'MNG-NEW1-0811': { invoice_no: 'MUN/26-27/0030', issued_at: '2026-11-08T05:02:00.000Z' },
  };
  const day = ds.paidInDay([ayush, fresh, noInv], invoices, SINCE, UNTIL);
  const ids = day.map((o) => o.order_id);
  ok(!ids.includes('MNG-9WZ6-2910'), 'an order paid on 29 Oct and delivered on 8 Nov is not one of 8 Nov\'s orders');
  ok(ids.includes('MNG-NEW1-0811'), 'an order paid on 8 Nov and packed early next morning is still one of 8 Nov\'s orders');
  ok((day.find((o) => o.order_id === 'MNG-NEW1-0811') || {}).paid_at === '2026-11-08T05:02:00.000Z', 'the paid time is the invoice time');
  ok((day.find((o) => o.order_id === 'MNG-NOIN-0811') || {}).paid_at === noInv.updated_at, 'an order with no invoice falls back to its last update');
  ok(ids.join() === 'MNG-NOIN-0811,MNG-NEW1-0811', 'oldest payment first: ' + ids.join());
  ok(!('paid_at' in ayush) && !('paid_at' in fresh), 'the orders passed in are not changed');
  const preLaunch = { order_id: 'MNG-AUG1-0808', status: 'paid', created_at: '2026-08-08T10:00:00.000Z', updated_at: '2026-11-08T06:00:00.000Z', total: 500 };
  ok(ds.paidInDay([preLaunch], {}, SINCE, UNTIL).length === 0, 'a pre-launch order with no invoice, edited on 8 Nov, is not one of 8 Nov\'s orders (review finding 1)');

  // ── still to do ──
  const NOW = Date.parse('2026-11-09T02:30:00.000Z');   // 8:00 AM IST, 9 Nov
  const FROM = '2026-10-10T00:00:00+05:30';
  const shaped = [
    { id: 'MNG-OLD1-0808', state: 'topack', created_at: '2026-08-08T10:00:00.000Z', paid_at: '2026-08-08T10:00:00.000Z', name: 'Pre Launch', boxes: 2, items: [{ name: 'Atta Original', qty: 2, contents: '', boxes: 2 }] },
    { id: 'MNG-TP01-0811', state: 'topack', created_at: '2026-11-08T05:00:00.000Z', paid_at: '2026-11-08T05:02:00.000Z', name: 'Asha', boxes: 2, items: [{ name: 'Atta Kesari', qty: 2, contents: '', boxes: 2 }] },
    { id: 'MNG-TP02-0611', state: 'topack', created_at: '2026-11-06T05:00:00.000Z', paid_at: '2026-11-06T05:00:00.000Z', name: 'Riya <b>', boxes: 3, items: [{ name: 'Trio Set', qty: 1, contents: 'Original + Kesari + Ajwain', boxes: 3 }] },
    { id: 'MNG-SH01-0711', state: 'shipped', awaiting_pickup: true, created_at: '2026-11-07T05:00:00.000Z', packed_at: '2026-11-07T09:00:00.000Z', shipped_at: '2026-11-08T10:00:00.000Z', name: 'Meera', boxes: 4, items: [] },
    { id: 'MNG-PK01-0711', state: 'packed', created_at: '2026-11-07T05:00:00.000Z', packed_at: '2026-11-07T10:00:00.000Z', name: 'Kunal', boxes: 2, items: [] },
    { id: 'MNG-SH02-0711', state: 'shipped', awaiting_pickup: false, created_at: '2026-11-07T05:00:00.000Z', packed_at: '2026-11-07T09:00:00.000Z', shipped_at: '2026-11-07T12:00:00.000Z', name: 'Out', boxes: 2, items: [] },
    { id: 'MNG-DL01-0511', state: 'delivered', created_at: '2026-11-05T05:00:00.000Z', name: 'Done', boxes: 2, items: [] },
    { id: 'MNG-UNP1-0811', state: 'unpaid', created_at: '2026-11-08T05:00:00.000Z', name: 'Unpaid', boxes: 2, items: [] },
    { id: 'MNG-TST1-0811', state: 'test', created_at: '2026-11-08T05:00:00.000Z', name: 'Test', boxes: 2, items: [] },
    { id: 'MNG-CAN1-0811', state: 'cancelled', created_at: '2026-11-08T05:00:00.000Z', name: 'Cancel', boxes: 2, items: [] },
    { id: 'MNG-REF1-0811', state: 'refunded', created_at: '2026-11-08T05:00:00.000Z', name: 'Refund', boxes: 2, items: [] },
  ];
  const todo = ds.stillToDo(shaped, { from: FROM, now: NOW });
  ok(todo.toPack.map((o) => o.id).join() === 'MNG-TP02-0611,MNG-TP01-0811', 'to pack: paid and not packed, oldest first, the August pre-launch order left out: ' + todo.toPack.map((o) => o.id).join());
  ok(todo.toPack[0].waitingDays === 3 && todo.toPack[1].waitingDays === 1, 'to pack: calendar days since payment (6 Nov -> 3, 8 Nov -> 1)');
  ok(todo.notSent.map((o) => o.id).join() === 'MNG-PK01-0711,MNG-SH01-0711', 'not sent out: packed with no courier, then courier booked but not collected: ' + todo.notSent.map((o) => o.id).join());
  ok(todo.notSent[0].why === 'no courier booked' && todo.notSent[1].why === 'courier booked, not collected', 'not sent out: each says why');
  ok(todo.notSent[0].waitingDays === 2, 'not sent out: days since it was packed');
  ok(JSON.stringify(todo.flavours) === JSON.stringify([['Original', 1], ['Kesari', 3], ['Ajwain', 1]]), 'to pack: boxes to pull per Flavor, sets opened up: ' + JSON.stringify(todo.flavours));
  ok(todo.toPackBoxes === 5, 'to pack: box total');

  ok(ds.subjectTail({ toPack: [1, 2], notSent: [1] }) === ' · 2 to pack, 1 to send', 'subject says what is waiting');
  ok(ds.subjectTail({ toPack: [1], notSent: [] }) === ' · 1 to pack', 'subject: only packing waiting');
  ok(ds.subjectTail({ toPack: [], notSent: [] }) === '' && ds.subjectTail(null) === '', 'subject: nothing waiting or not read, no tail');

  // ── the email ──
  const html = t.dailySummaryHtml({ dayLabel: 'Sun, 8 Nov 2026', orders: [], todo });
  ok(/Still to do/.test(html), 'the email has a Still to do section');
  ok(html.includes('MNG-TP02-0611') && html.includes('Riya &lt;b&gt;') && !html.includes('Riya <b>'), 'to pack orders listed, names escaped');
  ok(/waiting 3 days/.test(html) && /waiting 1 day\b/.test(html), 'days waiting shown');
  ok(/Original 1 &middot; Kesari 3 &middot; Ajwain 1/.test(html), 'boxes to pull per Flavor shown');
  ok(/no courier booked &middot; 2 days/.test(html) && /courier booked, not collected &middot; 1 day\b/.test(html), 'not sent out orders say why and for how long');
  ok(html.indexOf('Still to do') < html.indexOf('No paid orders yesterday'), 'the to-do list comes first');
  ok(html.indexOf('>Paid on Sun, 8 Nov 2026<') > html.indexOf('Still to do') && html.indexOf('>Paid on Sun, 8 Nov 2026<') < html.indexOf('No paid orders yesterday'), 'the day\'s part has its own heading (right on re-sends too) after the to-do list');
  ok(/No paid orders yesterday/.test(html), 'a day with no new orders still says so');
  const empty = t.dailySummaryHtml({ dayLabel: 'x', orders: [], todo: { toPack: [], notSent: [], flavours: [], toPackBoxes: 0 } });
  ok(/Nothing waiting/.test(empty), 'nothing open: the email says nothing is waiting');
  const unread = t.dailySummaryHtml({ dayLabel: 'x', orders: [], todo: null });
  ok(/Could not read the open orders/.test(unread), 'open orders could not be read: the email says so instead of looking empty');
  ok(!/Still to do/.test(t.dailySummaryHtml({ dayLabel: 'x', orders: [] })), 'older callers without a to-do list get no section');

  // ── putting the day together (what the 8:00 AM route sends) ──
  const calls = {};
  const deps = {
    getPaidOrdersUpdatedSince: async (s) => { calls.since = s; return [ayush, fresh, noInv]; },
    getInvoicesByOrderIds: async (list) => { calls.invoiceIds = list; return invoices; },
    getCreditNotesBetween: async () => [],
    listSuggestionsBetween: async (a, b) => (a === SINCE && b === UNTIL ? [{ name: 'Om', kind: 'feedback', text: 'Good' }] : []),
    stockLines: async () => null,
    listOrders: async () => shaped,
  };
  const g = await ds.gatherDay({ since: SINCE, until: UNTIL, todayIst: '2026-11-09', now: NOW, from: FROM, deps });
  ok(calls.since === '2026-11-06T18:30:00.000Z', 'reads paid orders touched since the day BEFORE began (an invoice can land seconds after midnight; review finding 4)');
  ok(g.orders.map((o) => o.order_id).join() === 'MNG-NOIN-0811,MNG-NEW1-0811', 'the day\'s orders exclude the Sirsa order');
  ok(Object.keys(g.invoicesByOrder).join() === 'MNG-NEW1-0811', 'only the day\'s invoices are passed on (GST totals stay right)');
  ok(g.suggestions.length === 1 && g.suggestions[0].name === 'Om', 'the day\'s suggestions are passed on');
  ok(g.todo && g.todo.toPack.length === 2 && g.todo.notSent.length === 2, 'the to-do list is built from the admin\'s order list');
  const midnight = { order_id: 'MNG-MID1-0711', status: 'paid', created_at: '2026-11-07T18:20:00.000Z', updated_at: '2026-11-07T18:29:59.000Z', total: 518 };
  const pool = [midnight, ayush, fresh];
  const gm = await ds.gatherDay({ since: SINCE, until: UNTIL, todayIst: '2026-11-09', now: NOW, from: FROM, deps: { ...deps,
    getPaidOrdersUpdatedSince: async (s) => pool.filter((o) => o.updated_at >= s),
    getInvoicesByOrderIds: async () => ({ ...invoices, 'MNG-MID1-0711': { invoice_no: 'MUN/26-27/0029', issued_at: '2026-11-07T18:30:01.000Z' } }) } });
  ok(gm.orders.map((o) => o.order_id).includes('MNG-MID1-0711'), 'paid at 23:59:59 on 7 Nov, invoiced at 00:00:01 on 8 Nov: listed on 8 Nov, not lost');
  const g2 = await ds.gatherDay({ since: SINCE, until: UNTIL, todayIst: '2026-11-09', now: NOW, from: FROM, deps: { ...deps, listOrders: async () => { throw new Error('razorpay down'); } } });
  ok(g2.todo === null && g2.orders.length === 2, 'if the open orders cannot be read, the summary still goes with todo = null');

  // ── a failed invoice read must not be mistaken for "no invoices" (review finding 2) ──
  const database = require('../utils/database');
  DB_ERROR = 'timeout';
  let threw = false; try { await database.getInvoicesForSummary(['MNG-NEW1-0811']); } catch (e) { threw = /timeout/.test(e.message); }
  ok(threw, 'the summary\'s invoice read throws on a database error (the route then releases the day and retries)');
  ok(JSON.stringify(await database.getInvoicesByOrderIds(['MNG-NEW1-0811'])) === '{}', 'the admin\'s invoice read keeps its old forgiving behaviour');
  DB_ERROR = null;
  ok(JSON.stringify(await database.getInvoicesForSummary([])) === '{}', 'no orders: no read, empty map');
  const srvSrc = require('fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(/getInvoicesByOrderIds: database\.getInvoicesForSummary/.test(srvSrc), 'the 8:00 job uses the strict invoice read');

  // ── the email that goes out: subject, body, CSV paid time ──
  const mails = [];
  const rp = require.resolve('resend');
  require.cache[rp] = { id: rp, filename: rp, loaded: true, exports: { Resend: class { constructor() { this.emails = { send: async (x) => { mails.push(x); return { error: null }; } }; } } } };
  process.env.NOTIFY_EMAIL = 'owner@example.com';
  const { sendDailyDigestEmail } = require('../utils/mailer');
  await sendDailyDigestEmail({ dayLabel: 'Sun, 8 Nov 2026', ...g });
  const m = mails[0] || {};
  ok(m.subject === 'Munchingo Sun, 8 Nov 2026: 2 orders, Rs.1118 · 2 to pack, 2 to send', 'subject: the day\'s paid orders only, plus what is waiting: ' + m.subject);
  ok(/Still to do/.test(m.html || ''), 'the sent email carries the Still to do section');
  const csv = Buffer.from(((m.attachments || [])[0] || {}).content || '', 'base64').toString('utf8');
  ok(csv.includes('MNG-NEW1-0811') && csv.includes('8/11/2026, 10:32:00 am') && !csv.includes('MNG-9WZ6-2910'), 'CSV: paid time is the invoice time (10:32 IST), Sirsa order absent');

  console.log(`daily-summary-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
