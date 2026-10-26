'use strict';
// Stall tally storage: snapshot sync, soft-delete, buyer contacts only with the marketing tick, key check.   node scripts/stall-sync-test.js
const http = require('http'), express = require('express');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
process.env.RESEND_API_KEY = 'x';
const stall = require('../utils/stall');

const store = { days: {}, orders: {}, contacts: {} };
stall.setDeps({
  now: () => Date.parse('2026-10-27T10:00:00Z'),
  db: {
    upsertStallDay: async (day, opening) => { store.days[day] = opening; },
    upsertStallOrders: async (rows) => { rows.forEach((r) => { store.orders[r.id] = { ...(store.orders[r.id] || {}), ...r }; }); },
    listStallOrderIds: async (day) => Object.values(store.orders).filter((o) => o.day === day).map((o) => ({ id: o.id, deleted_at: o.deleted_at })),
    markStallOrdersDeleted: async (ids) => { ids.forEach((i) => { store.orders[i].deleted_at = 'x'; }); },
    getContact: async (p) => store.contacts[p] || null,
    insertContact: async (r) => { if (store.contacts[r.phone]) throw new Error('dup'); if (!r.first_source) throw new Error('first_source'); store.contacts[r.phone] = { ...r }; },
    updateContact: async (p, f) => { Object.assign(store.contacts[p], f); },
  },
});
const line = (item, name, price, mix) => ({ item, name, price, hamper: false, mix });
const order = (id, n, extra) => ({ id, n, t: Date.parse('2026-10-27T09:30:00Z'), pay: 'upi', lines: [line('original', 'Original', 200, { original: 1 })], ...extra });
const CONSENT = 'OK to send me new Flavors and offers on WhatsApp? A few messages a month at most. Reply STOP any time to stop.';

(async () => {
  ok(stall.normalisePhone('98765 43210') === '919876543210' && stall.normalisePhone('+91 98765-43210') === '919876543210' && stall.normalisePhone('09876543210') === '919876543210', 'phone formats are normalised');
  ok(stall.normalisePhone('12345') === null && stall.normalisePhone('5876543210') === null && stall.normalisePhone('') === null, 'bad phones are refused');
  ok(stall.validate({ day: 'x', orders: [] }).error, 'bad day refused');
  ok(stall.validate({ day: '2026-10-27', orders: [order('a', 1), order('a', 2)] }).error, 'repeated id refused');
  ok(stall.validate({ day: '2026-10-27', orders: [order('a', 1, { pay: 'card' })] }).error, 'bad payment refused');
  ok(stall.validate({ day: '2026-10-27', orders: [order('a', 1, { lines: [line('x', 'X', 99999, {})] })] }).error, 'absurd price refused');
  ok(stall.validate({ day: '2026-10-27', orders: [order('a', 1, { lines: [line('x', 'X', 10, { banana: 1 })] })] }).error, 'unknown flavor refused');

  // sync saves; a resend is harmless
  const snap = { day: '2026-10-27', opening: { original: 20, kesari: 10 }, orders: [order('a1', 1), order('a2', 2, { pay: 'cash', lines: [line('h3', 'Hamper of 3', 799, { original: 1, ajwain: 1, kesari: 1 })] })] };
  let r = await stall.sync(snap);
  ok(r.status === 200 && r.body.orders === 2 && Object.keys(store.orders).length === 2 && store.orders.a2.total === 799, 'a day is saved with totals worked out on the server');
  ok(store.days['2026-10-27'].original === 20, 'opening stock saved');
  r = await stall.sync(snap); ok(r.status === 200 && Object.keys(store.orders).length === 2, 'a resend does not duplicate');
  // deleting a customer on the iPad marks it deleted, never loses it
  r = await stall.sync({ ...snap, orders: [snap.orders[0]] }); ok(store.orders.a2.deleted_at && !store.orders.a1.deleted_at && r.body.deleted === 1, 'a customer missing from the snapshot is soft-deleted');
  r = await stall.sync(snap); ok(store.orders.a2.deleted_at === null, 'and comes back if it reappears (undo of a delete)');

  // buyers: only with the tick and a valid number
  const buyer = (extra) => ({ name: 'Asha Sharma', phone: '98765 43210', consent: true, consentText: CONSENT, ...extra });
  await stall.sync({ ...snap, orders: [order('b1', 1, { buyer: buyer() })] });
  ok(store.orders.b1.contact_phone === '919876543210' && store.contacts['919876543210'] && store.contacts['919876543210'].consent_marketing === true, 'ticked buyer: saved as a contact with consent');
  const c = store.contacts['919876543210'];
  ok(c.first_source === 'stall:2026-10-27' && c.consent_text === CONSENT && c.name === 'Asha Sharma', 'contact keeps source, the exact wording and the name');
  await stall.sync({ ...snap, orders: [order('b2', 1, { buyer: buyer({ phone: '9811111111', consent: false }) })] });
  ok(!store.contacts['919811111111'] && store.orders.b2.contact_phone === null, 'NO tick: nothing about the buyer is stored');
  await stall.sync({ ...snap, orders: [order('b3', 1, { buyer: buyer({ phone: '123' }) })] });
  ok(store.orders.b3.contact_phone === null && Object.keys(store.contacts).length === 1, 'a ticked box with a bad number saves no contact');
  await stall.sync({ ...snap, orders: [order('b4', 1, { buyer: { name: 'No Consent Field', phone: '9822222222' } })] });
  ok(!store.contacts['919822222222'], 'a buyer without an explicit consent flag is ignored');
  // an existing contact (joined on WhatsApp earlier) is updated, name kept
  store.contacts['919833333333'] = { phone: '919833333333', name: 'WA Name', first_source: 'join:2026-10-25', consent_marketing: null };
  await stall.sync({ ...snap, orders: [order('b5', 1, { buyer: buyer({ phone: '9833333333', name: 'Typed Name' }) })] });
  ok(store.contacts['919833333333'].consent_marketing === true && store.contacts['919833333333'].name === 'WA Name' && store.contacts['919833333333'].first_source === 'join:2026-10-25', 'existing contact: consent recorded, original name and first source kept');

  // the route and the key
  const app = express(); app.use(express.json({ limit: '1mb' })); app.use(require('../routes/stall'));
  const srv = http.createServer(app); await new Promise((res) => srv.listen(0, res)); const port = srv.address().port;
  const post = (key, body) => new Promise((res) => { const d = JSON.stringify(body); const q = http.request({ port, path: '/api/stall/sync', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d), ...(key ? { 'X-Stall-Key': key } : {}) } }, (rs) => { let t = ''; rs.on('data', (x) => t += x); rs.on('end', () => res({ status: rs.statusCode, body: t })); }); q.end(d); });
  delete process.env.STALL_KEY; ok((await post('k', snap)).status === 503, 'no STALL_KEY on the server: saving is off (503)');
  process.env.STALL_KEY = 'secret-key-1';
  ok((await post(null, snap)).status === 403 && (await post('wrong', snap)).status === 403, 'missing or wrong key: 403');
  const good = await post('secret-key-1', snap); ok(good.status === 200 && JSON.parse(good.body).ok, 'right key: saved');
  ok((await post('secret-key-1', { day: 'bad' })).status === 400, 'bad body: 400');
  srv.close();
  console.log(`stall-sync-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
