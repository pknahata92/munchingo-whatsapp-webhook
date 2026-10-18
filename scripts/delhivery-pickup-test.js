'use strict';
// Delhivery pickup request (util + admin action) against a stand-in for Delhivery's API (no token, no network, no database).
//   node scripts/delhivery-pickup-test.js
let pass = 0, fail = 0, MODE = 'ok', last = null, calls = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
global.fetch = async (url, opts) => {
  last = { url, opts }; calls++;
  if (MODE === 'down') throw new Error('ECONNRESET');
  if (MODE === '401') return { ok: false, status: 401, text: async () => '{}' };
  if (MODE === 'reject') return { ok: false, status: 400, text: async () => JSON.stringify({ error: 'Pickup request for this slot already exists', pickup_id: 555 }) };
  if (MODE === 'nopid') return { ok: true, status: 200, text: async () => '{}' };
  return { ok: true, status: 200, text: async () => JSON.stringify({ pickup_id: 987654321, incoming_center_name: 'Faridabad_MathuraRoad_GW', pickup_date: '2026-10-20' }) };
};

(async () => {
  delete process.env.DELHIVERY_API_TOKEN; delete process.env.DELHIVERY_PICKUP_LOCATION; delete process.env.DELHIVERY_PICKUP_TIME;
  const p = require('../utils/delhiveryPickup');

  // pickupWhen: today if before the 14:00 IST cut-off, otherwise tomorrow (IST dates), never a past date.
  const at = (iso) => p.pickupWhen(new Date(iso));
  ok(at('2026-10-19T06:00:00Z').date === '2026-10-19', '11:30 IST books today');          // 11:30 IST
  ok(at('2026-10-19T09:00:00Z').date === '2026-10-20', '14:30 IST books tomorrow');        // 14:30 IST
  ok(at('2026-10-19T19:00:00Z').date === '2026-10-20', '00:30 IST next day books that day, not a past one'); // 20 Oct 00:30 IST
  ok(at('2026-10-19T06:00:00Z').time === '14:00:00', 'default slot 14:00');
  process.env.DELHIVERY_PICKUP_TIME = '11:30:00'; ok(at('2026-10-19T06:00:00Z').time === '11:30:00', 'slot from env'); delete process.env.DELHIVERY_PICKUP_TIME;

  let e = await p.requestPickup({ count: 3 }).catch((x) => x);
  ok(e instanceof p.PickupError && e.status === 503 && calls === 0, 'no token: clear error, no call');
  process.env.DELHIVERY_API_TOKEN = 'tok_test';

  const r = await p.requestPickup({ count: 13, now: new Date('2026-10-19T06:00:00Z') });
  ok(r.pickupId === '987654321' && r.count === 13 && r.date === '2026-10-19' && r.location === 'Munchingo', 'returns pickup id, count, date, location');
  const sent = JSON.parse(last.opts.body);
  ok(/\/fm\/request\/new\/$/.test(last.url) && last.opts.method === 'POST', 'endpoint and method');
  ok(/Token tok_test/.test(last.opts.headers.Authorization) && /json/.test(last.opts.headers['Content-Type']), 'token header, JSON body');
  ok(sent.pickup_location === 'Munchingo' && sent.expected_package_count === 13 && sent.pickup_date === '2026-10-19' && sent.pickup_time === '14:00:00', 'payload fields');
  process.env.DELHIVERY_PICKUP_LOCATION = 'FOTOBAR B2C'; await p.requestPickup({ count: 2 }); ok(JSON.parse(last.opts.body).pickup_location === 'FOTOBAR B2C', 'location from env'); delete process.env.DELHIVERY_PICKUP_LOCATION;

  for (const bad of [0, -1, 1.5, 101, 'x', undefined]) { e = await p.requestPickup({ count: bad }).catch((x) => x); ok(e instanceof p.PickupError && e.status === 400, 'bad count refused: ' + bad); }
  e = await p.requestPickup({ count: 2, date: '19-10-2026' }).catch((x) => x); ok(e instanceof p.PickupError && /date/.test(e.message), 'malformed date refused');

  MODE = 'reject'; e = await p.requestPickup({ count: 2 }).catch((x) => x); ok(/already exists/.test(e.message) && e.status === 502, 'Delhivery rejection surfaces its reason');
  MODE = '401'; e = await p.requestPickup({ count: 2 }).catch((x) => x); ok(/token/.test(e.message), '401 says the token was rejected');
  MODE = 'nopid'; e = await p.requestPickup({ count: 2 }).catch((x) => x); ok(e instanceof p.PickupError && /Check Delhivery One/.test(e.message), 'ok reply without a pickup id is not trusted');
  MODE = 'down'; e = await p.requestPickup({ count: 2 }).catch((x) => x); ok(/reach/.test(e.message), 'network failure is a clear error');
  MODE = 'ok';

  // Admin action: eligible orders only, one Delhivery request for all, one event each, no double request.
  const db = require('../utils/database');
  const events = {};
  const orders = {
    A1: { order_id: 'A1', status: 'paid', carrier: 'Delhivery', awb: '67409110000044', shipped_at: 'x' },
    A2: { order_id: 'A2', status: 'paid', carrier: 'Delhivery', awb: '67409110000055', shipped_at: 'x' },
    A3: { order_id: 'A3', status: 'paid', carrier: 'Delhivery', awb: '67409110000066', shipped_at: 'x' },
    P1: { order_id: 'P1', status: 'paid', carrier: 'Porter', awb: 'link', shipped_at: 'x' },
    D1: { order_id: 'D1', status: 'paid', carrier: 'Delhivery', awb: '67409110000077', shipped_at: 'x', delivered_at: 'y' },
    K1: { order_id: 'K1', status: 'paid', carrier: '', awb: '', packed_at: 'z' },
  };
  db.getOrder = async (id) => orders[id] || null;
  db.getInvoiceByOrder = async () => null; db.getCreditNotesByOrder = async () => [];
  db.listOrderEvents = async (id) => events[id] || [];
  db.logOrderEvent = async (ev) => { (events[ev.order_id] = events[ev.order_id] || []).push({ ...ev, created_at: new Date().toISOString() }); };
  const actions = require('../utils/adminActions');
  const actor = { email: 'o@x', name: 'Owner', role: 'owner' };
  calls = 0;
  const res = await actions.requestDelhiveryPickup({ ids: ['A1', 'A2', 'P1', 'D1', 'K1', 'NOPE'], actor, now: new Date('2026-10-19T06:00:00Z') });
  ok(calls === 1 && JSON.parse(last.opts.body).expected_package_count === 2, 'ONE Delhivery request for the 2 eligible parcels');
  ok(res.pickupId === '987654321' && res.count === 2 && res.requested.length === 2, 'result names the pickup and count');
  ok(res.skipped.length === 4 && res.skipped.some((s) => s.orderId === 'P1' && /Delhivery/.test(s.reason)) && res.skipped.some((s) => s.orderId === 'NOPE'), 'others skipped with a reason');
  ok((events.A1 || []).some((x) => x.event === 'delhivery_pickup_requested' && x.meta.pickupId === '987654321'), 'event logged with the pickup id');
  calls = 0;
  e = await actions.requestDelhiveryPickup({ ids: ['A1', 'A2'], actor, now: new Date('2026-10-19T06:00:00Z') }).catch((x) => x);
  ok(e instanceof actions.AdminError && /already/.test(e.message) && calls === 0, 'asking again for the same parcels is refused without calling Delhivery');
  const r3 = await actions.requestDelhiveryPickup({ ids: ['A1', 'A3'], actor, now: new Date('2026-10-19T06:00:00Z') });
  ok(r3.count === 1 && r3.requested[0] === 'A3' && r3.skipped.some((s) => s.orderId === 'A1' && /already/.test(s.reason)), 'a mixed ask only requests the new parcel');
  e = await actions.requestDelhiveryPickup({ ids: ['P1'], actor }).catch((x) => x); ok(e instanceof actions.AdminError && e.status === 409, 'nothing eligible is a clear error');
  MODE = 'reject'; events.A3 = []; e = await actions.requestDelhiveryPickup({ ids: ['A3'], actor }).catch((x) => x); ok(e instanceof actions.AdminError && /already exists/.test(e.message) && !(events.A3 || []).length, 'Delhivery failure: no event logged, nothing marked requested');
  console.log(`delhivery-pickup-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
