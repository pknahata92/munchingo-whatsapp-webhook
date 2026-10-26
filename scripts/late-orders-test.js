'use strict';
// Delivery dates and LATE orders (27 Oct 2026). Delhivery's promised date is read during the tracking sweep and saved on the
// order; the admin shows it and flags a shipped order LATE when it is past that date, or, with no courier date, more than
// 7 days after the courier collected it.   node scripts/late-orders-test.js
const fs = require('fs'), path = require('path');
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 're_test';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const DAY = 86400000;

(async () => {
  const track = require('../utils/delhiveryTrack');

  // ── reading the date from Delhivery's tracking reply ──
  ok(track.eddOf({ PromisedDeliveryDate: '2026-10-27T23:59:59' }) === '2026-10-27T18:29:59.000Z', 'a date without a zone is India time (got ' + track.eddOf({ PromisedDeliveryDate: '2026-10-27T23:59:59' }) + ')');
  ok(track.eddOf({ ExpectedDeliveryDate: '2026-10-28T10:00:00+05:30' }) === '2026-10-28T04:30:00.000Z', 'an expected date with a zone is read as given');
  ok(track.eddOf({ promised_delivery_date: 1793125799000 }) === new Date(1793125799000).toISOString(), 'milliseconds are read too (Delhivery One shape)');
  ok(track.eddOf({ PromisedDeliveryDate: '2026-10-27T23:59:59', ExpectedDeliveryDate: '2026-10-30T23:59:59' }) === '2026-10-27T18:29:59.000Z', 'the promised date wins over the expected one');
  ok(track.eddOf({ ExpectedDeliveryDate: '' }) === null && track.eddOf({}) === null && track.eddOf(null) === null && track.eddOf({ ExpectedDeliveryDate: 'soon' }) === null, 'no date or junk gives no date');
  ok(track.eddOf({ ExpectedDeliveryDate: '1970-01-01T00:00:00' }) === null && track.eddOf({ ExpectedDeliveryDate: 0 }) === null, 'empty Delhivery dates (0, 1970) are ignored');

  // fetchStage hands the date back with the stage
  const realFetch = global.fetch; process.env.DELHIVERY_API_TOKEN = 'tok';
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ShipmentData: [{ Shipment: { Status: { Status: 'In Transit', StatusType: 'UD' }, PromisedDeliveryDate: '2026-10-27T23:59:59' } }] }) });
  let r = await track.fetchStage('67409110000140');
  ok(r.stage === 'picked_up' && r.edd === '2026-10-27T18:29:59.000Z', 'fetchStage returns the stage and the promised date (' + JSON.stringify(r) + ')');
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ShipmentData: [{ Shipment: { Status: { Status: 'In Transit', StatusType: 'UD' } } }] }) });
  r = await track.fetchStage('67409110000140');
  ok(r.stage === 'picked_up' && r.edd === null, 'no date in the reply: edd is null, the stage still works');
  global.fetch = realFetch;

  // ── the LATE rule ──
  const { lateInfo } = require('../utils/adminActions');
  const now = Date.parse('2026-10-28T06:00:00Z');
  let l = lateInfo({ state: 'shipped', expected: '2026-10-27T18:29:59.000Z', pickedUpAt: '2026-10-21T10:00:00Z', trackable: true, now });
  ok(l.late === true && l.days === 1 && l.basis === 'courier', 'past the courier date by a few hours: LATE, 1 day (' + JSON.stringify(l) + ')');
  l = lateInfo({ state: 'shipped', expected: '2026-10-24T18:29:59.000Z', pickedUpAt: '2026-10-21T10:00:00Z', trackable: true, now });
  ok(l.late && l.days === 4, 'four days past the courier date: 4 days late');
  l = lateInfo({ state: 'shipped', expected: '2026-10-29T18:29:59.000Z', pickedUpAt: '2026-10-15T10:00:00Z', trackable: true, now });
  ok(l.late === false && l.basis === 'courier', 'before the courier date: not late, even if it has been out a long time (the courier date wins)');
  l = lateInfo({ state: 'shipped', expected: null, pickedUpAt: new Date(now - 8 * DAY).toISOString(), trackable: true, now });
  ok(l.late === true && l.basis === 'seven_days' && l.days === 1, 'no courier date, collected 8 days ago: LATE by the 7-day rule (' + JSON.stringify(l) + ')');
  l = lateInfo({ state: 'shipped', expected: null, pickedUpAt: new Date(now - 6 * DAY).toISOString(), trackable: true, now });
  ok(l.late === false, 'no courier date, collected 6 days ago: not late yet');
  l = lateInfo({ state: 'shipped', expected: null, pickedUpAt: null, trackable: true, shippedAt: new Date(now - 20 * DAY).toISOString(), now });
  ok(l.late === false, 'Delhivery has not collected it: not LATE (it already shows Awaiting pickup)');
  l = lateInfo({ state: 'shipped', expected: null, pickedUpAt: null, trackable: false, shippedAt: new Date(now - 9 * DAY).toISOString(), now });
  ok(l.late === true && l.basis === 'seven_days', 'hand or Porter delivery with no tracking: 7 days after it was sent');
  for (const st of ['delivered', 'packed', 'topack', 'cancelled', 'refunded']) ok(lateInfo({ state: st, expected: '2026-10-20T00:00:00Z', pickedUpAt: '2026-10-10T00:00:00Z', trackable: true, now }).late === false, 'a ' + st + ' order is never LATE');

  // ── the sweep saves the date (and only when it changed); a failed save never stops the sweep ──
  const updates = require('../utils/orderUpdates');
  const saved = [], logged = [];
  const order = (id, edd) => ({ order_id: id, status: 'paid', shipped_at: '2026-10-21T00:00:00Z', carrier: 'Delhivery', awb: '67409110000140', expected_delivery_at: edd });
  const fake = (orders, stageEdd, failSave) => ({
    db: { getOrdersInTransit: async () => orders, listOrderEvents: async () => [{ event: 'courier_picked_up' }, { event: 'shipped', meta: {} }], logOrderEvent: async (e) => logged.push(e), updateOrderIf: async () => true,
      setExpectedDelivery: async (id, at) => { if (failSave) throw new Error('column missing'); saved.push([id, at]); } },
    track: { fetchStage: async () => ({ stage: 'picked_up', edd: stageEdd }) },
    notify: { notifyShipped: async () => ({ sent: false }), notifyDelivered: async () => ({ sent: false }), notifyPacked: async () => ({ sent: false }) },
    mail: { sendShippedEmail: async () => ({}), sendStatusEmail: async () => ({}) },
  });
  updates.setDeps(fake([order('MNG-A', null), order('MNG-B', '2026-10-27T18:29:59.000Z')], '2026-10-27T18:29:59.000Z'));
  let sw = await updates.sweepOnce();
  ok(saved.length === 1 && saved[0][0] === 'MNG-A' && saved[0][1] === '2026-10-27T18:29:59.000Z', 'the sweep saves a new date, and skips an order that already has the same date (' + JSON.stringify(saved) + ')');
  saved.length = 0;
  updates.setDeps(fake([order('MNG-C', '2026-10-27T18:29:59.000Z')], '2026-10-29T18:29:59.000Z'));
  await updates.sweepOnce();
  ok(saved.length === 1 && saved[0][1] === '2026-10-29T18:29:59.000Z', 'a date Delhivery moved is updated');
  updates.setDeps(fake([order('MNG-D', null)], '2026-10-27T18:29:59.000Z', true));
  let threw = false; try { sw = await updates.sweepOnce(); } catch (e) { threw = true; }
  ok(!threw && sw.checked === 1, 'a failed date save does not stop the sweep');

  // ── what the admin gets for an order ──
  const db = require('../utils/database');
  const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'database.js'), 'utf8');
  ok(/async function setExpectedDelivery\(/.test(src) && /\bsetExpectedDelivery\b/.test((src.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/) || ['', ''])[1]), 'database.js defines and exports setExpectedDelivery');
  ok(typeof db.setExpectedDelivery === 'function', 'setExpectedDelivery loads');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'delivery_date_migration.sql'), 'utf8').replace(/\s+/g, ' ').toLowerCase();
  ok(sql.includes('alter table orders add column if not exists expected_delivery_at timestamptz'), 'migration adds orders.expected_delivery_at');

  console.log(`late-orders-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log(`late-orders-test: ${pass} passed, ${fail} failed`); process.exit(1); });
