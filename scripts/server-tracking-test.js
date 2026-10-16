'use strict';
// Server-side purchase tracking against stand-ins for Meta, GA4 and the database.   node scripts/server-tracking-test.js
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const crypto = require('crypto');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const T0 = Date.parse('2026-10-16T10:00:00Z');
const ORDER = {
  order_id: 'MNG-TEST-1610', status: 'paid', customer_name: 'Asha Rao Sharma', customer_phone: '919999900001', customer_email: ' Asha@Example.COM ',
  total: 899, updated_at: new Date(T0).toISOString(), created_at: new Date(T0 - 600000).toISOString(),
  delivery_address: { raw: '12 MG Road, Pune, Maharashtra - 411001' },
  items: [{ productName: 'Atta Original', quantity: 2, item_price: 300 }, { productName: 'Munchingo Trio Gift Set (Original, Kesari, Ajwain)', quantity: 1, item_price: 739 }],
};
const EVENTS = {};
const store = {
  orders: [ORDER],
  getOrder: async (id) => store.orders.find((o) => o.order_id === id) || null,
  listOrderEvents: async (id) => EVENTS[id] || [],
  logOrderEvent: async (e) => { (EVENTS[e.order_id] = EVENTS[e.order_id] || []).push(e); },
  getOrdersPaidSince: async (a, b) => store.orders.filter((o) => o.status === 'paid' && o.updated_at >= a && o.updated_at < b),
};
let calls = [], META_OK = true, GA_OK = true;
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body); calls.push({ url, body });
  if (/graph\.facebook\.com/.test(url)) return { ok: META_OK, status: META_OK ? 200 : 400, text: async () => (META_OK ? '{"events_received":1}' : '{"error":"bad token tok_secret"}') };
  return { ok: GA_OK, status: GA_OK ? 204 : 500, text: async () => '' };
};

(async () => {
  delete process.env.META_CAPI_TOKEN; delete process.env.GA4_API_SECRET;
  const tr = require('../utils/serverTracking'); tr.setDeps(store);

  // payloads
  const m = tr.buildMetaBody(ORDER, { testCode: 'TEST123' }); const e = m.data[0];
  ok(e.event_name === 'Purchase' && e.event_id === 'MNG-TEST-1610' && e.action_source === 'website', 'meta: event name, id = order id, website');
  ok(e.custom_data.value === 899 && e.custom_data.currency === 'INR' && e.custom_data.num_items === 3, 'meta: value, currency, item count');
  ok(JSON.stringify(e.custom_data.content_ids) === JSON.stringify(['91slwpjdqq']), 'meta: only catalogue boxes in content_ids (gift set left out)');
  ok(e.user_data.em[0] === sha('asha@example.com'), 'meta: email trimmed, lowercased, hashed');
  ok(e.user_data.ph[0] === sha('919999900001'), 'meta: phone hashed with country code');
  ok(e.user_data.fn[0] === sha('asha') && e.user_data.ln[0] === sha('sharma'), 'meta: first/last name hashed');
  ok(e.user_data.st[0] === sha('maharashtra') && e.user_data.zp[0] === sha('411001'), 'meta: state and pincode parsed from the address and hashed');
  ok(!JSON.stringify(m).includes('Asha') && !JSON.stringify(m).includes('example.com'), 'meta: no plain-text personal data in the request');
  ok(m.test_event_code === 'TEST123', 'meta: test event code passed through');
  ok(e.event_time === Math.floor(T0 / 1000), 'meta: event time = payment time');
  const g = tr.buildGa4Body(ORDER);
  ok(g.events[0].name === 'purchase' && g.events[0].params.transaction_id === 'MNG-TEST-1610' && g.events[0].params.value === 899, 'ga4: purchase with transaction id and value');
  ok(g.events[0].params.items.length === 2 && g.events[0].params.items[0].price === 300, 'ga4: items with price');

  // not configured: nothing happens
  let r = await tr.sweepOnce(T0 + 3600e3);
  ok(r.skipped === 'not_configured' && calls.length === 0, 'no secrets: sweep does nothing and makes no network call');

  // configured
  process.env.META_CAPI_TOKEN = 'tok_secret'; process.env.GA4_API_SECRET = 'ga_secret';
  r = await tr.sweepOnce(T0 + 5 * 60e3);
  ok(r.checked === 0 && calls.length === 0, 'order only 5 minutes old: left alone so the browser can report first');
  r = await tr.sweepOnce(T0 + 30 * 60e3);
  ok(r.sent === 1 && calls.length === 2, 'order 30 minutes old: Meta and GA4 each called once');
  ok(/pixel|975114194987428/.test(calls[0].url) || /975114194987428/.test(calls[0].url), 'meta: the pixel id is in the URL');
  ok(/measurement_id=G-456YHSDMX6/.test(calls[1].url), 'ga4: measurement id in the URL');
  ok((EVENTS['MNG-TEST-1610'] || []).some((x) => x.event === 'purchase_tracked_server' && x.meta.meta === 'sent' && x.meta.ga4 === 'sent'), 'recorded as sent in order_events');
  calls = []; r = await tr.sweepOnce(T0 + 60 * 60e3);
  ok(calls.length === 0, 'second sweep: nothing is sent twice');

  // browser handshake after the server already sent GA4
  let c = await tr.claimBrowser('MNG-TEST-1610');
  ok(c.ok && c.fire === false && c.reason === 'server_sent', 'browser asks after the server sent: told not to fire');
  c = await tr.claimBrowser('MNG-NOPE-0000'); ok(!c.ok && c.fire === false, 'unknown order: refused');

  // browser first, then sweep: GA4 skipped, Meta still sent (Meta de-duplicates on event_id)
  const O2 = { ...ORDER, order_id: 'MNG-TWO-1610' }; store.orders.push(O2); calls = [];
  c = await tr.claimBrowser('MNG-TWO-1610'); ok(c.ok && c.fire === true, 'browser asks first: allowed to fire');
  c = await tr.claimBrowser('MNG-TWO-1610'); ok(c.fire === false && c.reason === 'already_reported', 'second device or refresh: told not to fire again');
  r = await tr.sweepOnce(T0 + 30 * 60e3);
  ok(calls.length === 1 && /graph\.facebook\.com/.test(calls[0].url), 'browser already reported: only Meta is sent, GA4 skipped');
  ok(EVENTS['MNG-TWO-1610'].find((x) => x.event === 'purchase_tracked_server').meta.ga4 === 'skipped_browser_reported', 'recorded as skipped');

  // failures: retried, secret never logged, capped at 3
  const O3 = { ...ORDER, order_id: 'MNG-THREE-1610' }; store.orders.push(O3); META_OK = false; calls = [];
  const errs = []; const orig = console.error; console.error = (...a) => errs.push(a.join(' '));
  for (let i = 0; i < 5; i++) await tr.sweepOnce(T0 + 30 * 60e3);
  console.error = orig;
  const fails = EVENTS['MNG-THREE-1610'].filter((x) => x.event === 'purchase_server_failed').length;
  ok(fails === 3, 'failed order is retried and then given up after 3 tries (got ' + fails + ')');
  ok(!errs.join(' ').includes('tok_secret'), 'the token never appears in the logs');
  ok(!(EVENTS['MNG-THREE-1610'] || []).some((x) => x.event === 'purchase_tracked_server'), 'a failed order is not marked as sent');

  console.log(`server tracking: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
