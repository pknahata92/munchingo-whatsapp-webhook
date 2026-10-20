'use strict';
// Delhivery tracking status -> stage, against a stand-in for Delhivery's API (no token, no network).
//   node scripts/delhivery-track-test.js
let pass = 0, fail = 0, MODE = 'ok', STATUS = {}, lastUrl = '', lastHeaders = null;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
global.fetch = async (url, opts) => {
  lastUrl = String(url); lastHeaders = opts && opts.headers;
  if (MODE === 'down') throw new Error('ECONNRESET');
  if (MODE === '401') return { ok: false, status: 401, text: async () => '{}' };
  if (MODE === 'empty') return { ok: true, status: 200, text: async () => JSON.stringify({ ShipmentData: [] }) };
  if (MODE === 'junk') return { ok: true, status: 200, text: async () => '<html>' };
  return { ok: true, status: 200, text: async () => JSON.stringify({ ShipmentData: [{ Shipment: { AWB: '1', Status: STATUS } }] }) };
};

(async () => {
  delete process.env.DELHIVERY_API_TOKEN;
  const t = require('../utils/delhiveryTrack');
  const st = (Status, StatusType = 'UD') => ({ Status, StatusType });

  // Pure mapping. Anything we do not recognise is "unknown" (no customer message is ever sent on a guess).
  for (const [s, want] of [
    [st('Manifested'), 'booked'], [st('Not Picked'), 'booked'], [st('Pickup Pending', 'PP'), 'booked'], [st('Pickup Scheduled', 'PP'), 'booked'],
    [st('In Transit'), 'picked_up'], [st('Pending'), 'picked_up'], [st('Picked Up', 'PU'), 'picked_up'],
    [st('Dispatched'), 'out_for_delivery'], [st('Out For Delivery'), 'out_for_delivery'],
    [st('Delivered', 'DL'), 'delivered'],
    [st('RTO'), 'returning'], [st('Returned', 'RT'), 'returning'], [st('In Transit', 'RT'), 'returning'],
    [st('Something New'), 'unknown'], [{}, 'unknown'], [null, 'unknown'],
  ]) ok(t.stageOf(s) === want, `stageOf(${JSON.stringify(s)}) = ${want}, got ${t.stageOf(s)}`);

  let r = await t.fetchStage('1234567890123');
  ok(r.stage === 'unknown' && /token/i.test(r.error), 'no token: unknown with a clear error, no call');
  process.env.DELHIVERY_API_TOKEN = 'tok_test';

  STATUS = st('In Transit');
  r = await t.fetchStage('1234567890123');
  ok(r.stage === 'picked_up', 'fetch maps the live status');
  ok(/waybill=1234567890123/.test(lastUrl) && lastHeaders && lastHeaders.Authorization === 'Token tok_test', 'asks for that waybill with the Token header');

  r = await t.fetchStage('12 34;rm'); ok(r.stage === 'unknown' && /awb/i.test(r.error), 'rejects a malformed tracking number before any call');
  for (const m of ['down', '401', 'empty', 'junk']) { MODE = m; r = await t.fetchStage('1234567890123'); ok(r.stage === 'unknown' && r.error, `${m}: unknown with error, never throws`); }

  console.log(`delhivery-track: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
