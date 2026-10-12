'use strict';
// Delhivery pincode check against a stand-in for Delhivery's API (no real token, no network).   node scripts/pincode-test.js
let pass = 0, fail = 0, calls = 0, MODE = 'ok';
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const mod = '../utils/delhivery';
global.fetch = async (url, opts) => {
  calls++;
  if (MODE === 'timeout') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
  if (MODE === 'down') throw new Error('ECONNRESET');
  if (MODE === '500') return { ok: false, status: 500, json: async () => ({}) };
  const pin = /filter_codes=(\d+)/.exec(url)[1];
  ok(/Token tok_test/.test(opts.headers.Authorization), 'sends the token header');
  if (MODE === 'empty' || pin === '123456') return { ok: true, status: 200, json: async () => ({ delivery_codes: [] }) };
  if (MODE === 'noprepaid') return { ok: true, status: 200, json: async () => ({ delivery_codes: [{ postal_code: { pin: +pin, district: 'X', state_code: 'MH', pre_paid: 'N' } }] }) };
  return { ok: true, status: 200, json: async () => ({ delivery_codes: [{ postal_code: { pin: +pin, district: 'Mumbai', city: 'Mumbai', state_code: 'MH', pre_paid: 'Y', is_oda: 'N' } }] }) };
};
(async () => {
  delete process.env.DELHIVERY_API_TOKEN;
  let d = require(mod); let r = await d.checkPincode('400001');
  ok(r.valid && r.serviceable === null && r.reason === 'not_configured' && calls === 0, 'no token: unknown, no network call');
  process.env.DELHIVERY_API_TOKEN = 'tok_test'; d.clearCache();
  r = await d.checkPincode('abc'); ok(!r.valid && r.serviceable === false, 'bad format is invalid');
  r = await d.checkPincode('012345'); ok(!r.valid, 'a pincode cannot start with 0');
  r = await d.checkPincode('400001'); ok(r.serviceable === true && r.state === 'Maharashtra' && r.city === 'Mumbai', 'serviceable pincode with city and state');
  const n = calls; await d.checkPincode('400001'); ok(calls === n, 'second lookup is cached');
  r = await d.checkPincode('123456'); ok(r.serviceable === false && r.reason === 'not_in_network', 'empty answer means Delhivery does not serve it');
  MODE = 'noprepaid'; d.clearCache(); r = await d.checkPincode('400002'); ok(r.serviceable === false && r.reason === 'no_prepaid_delivery', 'no prepaid delivery is not serviceable');
  MODE = 'timeout'; d.clearCache(); r = await d.checkPincode('400003'); ok(r.serviceable === null && r.reason === 'timeout', 'a timeout is unknown, never a block');
  MODE = 'down'; d.clearCache(); r = await d.checkPincode('400004'); ok(r.serviceable === null && r.reason === 'unreachable', 'an outage is unknown, never a block');
  MODE = '500'; d.clearCache(); r = await d.checkPincode('400005'); ok(r.serviceable === null && /http_500/.test(r.reason), 'a 500 is unknown, never a block');
  const m = calls; await d.checkPincode('400005'); ok(calls === m, 'an unknown answer is also cached briefly');
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
