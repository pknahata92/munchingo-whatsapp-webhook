'use strict';
// A7b: marketing templates go through the Marketing Messages API only when MM_API_ENABLED is on; utility templates never do.
const fs = require('fs'), path = require('path');
const axios = require('axios');
const wa = require('../utils/whatsapp');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL: ' + m); } };

const calls = [];
let script = [];   // per-call: 'ok' | an error object
axios.post = async (url, payload) => {
  calls.push({ url, payload });
  const next = script.length ? script.shift() : 'ok';
  if (next !== 'ok') { const e = new Error('Request failed'); e.response = { status: next.status || 400, data: { error: next } }; throw e; }
  return { data: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.X' + calls.length }] } };
};
process.env.PHONE_NUMBER_ID = '111'; process.env.WHATSAPP_TOKEN = 'x';
const reset = (s = []) => { calls.length = 0; script = s; };
const HDR = { type: 'image', link: 'https://munchingo.com/a.jpg' };
const opts = { quickReplies: ['j7_remind'], urlIndex: 1, urlSuffix: 'shop?utm_source=whatsapp', header: HDR };

(async () => {
  ok(typeof wa.sendMarketingTemplate === 'function', 'whatsapp.js exports sendMarketingTemplate');
  if (typeof wa.sendMarketingTemplate !== 'function') { console.log(`whatsapp-transport-test: ${pass} passed, ${fail} failed`); process.exit(1); }

  // flag off: today's /messages path, same payload as sendTemplateWithButtons
  delete process.env.MM_API_ENABLED; reset();
  let out = await wa.sendMarketingTemplate('91999', 'munchingo_fresh_batch', 'en', ['Asha', 'Sat', 'Original'], opts);
  ok(calls.length === 1 && calls[0].url.endsWith('/111/messages'), 'flag off: one call to /messages (got ' + JSON.stringify(calls.map((c) => c.url)) + ')');
  const direct = (() => { const c = calls[0].payload; return c; })();
  reset(); await wa.sendTemplateWithButtons('91999', 'munchingo_fresh_batch', 'en', ['Asha', 'Sat', 'Original'], opts);
  ok(JSON.stringify(direct) === JSON.stringify(calls[0].payload), 'flag off: payload identical to sendTemplateWithButtons');
  ok(out.transport === 'cloud', 'flag off: result says transport cloud');
  for (const v of ['', '0', 'false', 'no']) { process.env.MM_API_ENABLED = v; reset(); await wa.sendMarketingTemplate('91999', 't', 'en', ['a']); ok(calls[0].url.endsWith('/messages'), `MM_API_ENABLED='${v}' stays off`); }

  // flag on: /marketing_messages, identical payload
  for (const v of ['1', 'true', 'TRUE']) {
    process.env.MM_API_ENABLED = v; reset();
    out = await wa.sendMarketingTemplate('91999', 'munchingo_fresh_batch', 'en', ['Asha', 'Sat', 'Original'], opts);
    ok(calls.length === 1 && calls[0].url.endsWith('/111/marketing_messages'), `MM_API_ENABLED='${v}': one call to /marketing_messages`);
    ok(JSON.stringify(calls[0].payload) === JSON.stringify(direct), 'flag on: payload identical to the /messages payload');
    ok(out.transport === 'mm' && out.messages[0].id === 'wamid.X1', 'flag on: response keeps messages[0].id and says transport mm');
  }
  // no body params, header only (greeting broadcast)
  process.env.MM_API_ENABLED = '1'; reset();
  await wa.sendMarketingTemplate('91999', 'munchingo_diwali_2026', 'en', [], { header: { type: 'video', link: 'https://m/v.mp4' } });
  const comps = calls[0].payload.template.components;
  ok(comps.length === 1 && comps[0].type === 'header', 'header-only template: no empty body component');

  // not onboarded / not eligible: retry once on /messages, never twice
  for (const err of [{ code: 100, error_subcode: 33, message: 'Unsupported post request. Object with ID does not exist' }, { code: 200, message: 'Phone number is not onboarded to Marketing Messages API' }, { code: 131055, message: 'not eligible for marketing_messages' }]) {
    reset([err]);
    out = await wa.sendMarketingTemplate('91999', 't', 'en', ['a']);
    ok(calls.length === 2 && calls[0].url.endsWith('/marketing_messages') && calls[1].url.endsWith('/messages') && out.transport === 'cloud', 'not-onboarded error ' + err.code + ': retried once on /messages (urls ' + calls.map((c) => c.url.split('/').pop()) + ')');
  }
  // fallback also failing: error surfaces, only two calls
  reset([{ code: 100, error_subcode: 33, message: 'Unsupported post request' }, { code: 131000, message: 'boom' }]);
  let threw = null; try { await wa.sendMarketingTemplate('91999', 't', 'en', ['a']); } catch (e) { threw = e; }
  ok(threw && calls.length === 2, 'fallback that fails too throws, no third call');

  // every other error is returned unchanged, with no fallback (131049 keeps the 48 h rule)
  for (const err of [{ code: 131049, message: 'This message was not delivered to maintain healthy ecosystem engagement.' }, { code: 131026, message: 'Message undeliverable' }, { code: 131063, message: 'Marketing templates disabled for Cloud API' }, { code: 190, message: 'token' }]) {
    reset([err]); threw = null;
    try { await wa.sendMarketingTemplate('91999', 't', 'en', ['a']); } catch (e) { threw = e; }
    ok(threw && calls.length === 1 && threw.response.data.error.code === err.code, 'error ' + err.code + ' thrown unchanged, no fallback');
  }
  // network error (no response) is not a rejection: no fallback (could double-send)
  axios.post = async (url) => { calls.push({ url }); throw new Error('socket hang up'); };
  reset(); threw = null; try { await wa.sendMarketingTemplate('91999', 't', 'en', ['a']); } catch (e) { threw = e; }
  ok(threw && calls.length === 1, 'a network error with no response never falls back (no double send)');

  // utility and other senders never use MM, even with the flag on
  axios.post = async (url, payload) => { calls.push({ url, payload }); return { data: { messages: [{ id: 'w' }] } }; };
  process.env.MM_API_ENABLED = '1'; reset();
  await wa.sendTemplateWithButtons('91999', 'munchingo_checkin_v1', 'en', ['A', 'MN1', 'x'], { quickReplies: ['a', 'b'] });
  await wa.sendTemplate('91999', 'munchingo_order_confirmed', 'en', ['A']);
  await wa.sendTemplateWithUrlButton('91999', 'munchingo_review_request', 'en', ['A', 'MN1'], 'tok');
  await wa.sendText('91999', 'hi');
  ok(calls.length === 4 && calls.every((c) => c.url.endsWith('/messages')), 'check-in, order updates, review request and free-form stay on /messages with the flag on');

  // wiring: callers
  const rd = (f) => fs.readFileSync(path.join(__dirname, '..', 'utils', f), 'utf8');
  ok(/sendMarketingTemplate/.test(rd('broadcast.js')) && !/sendTemplateWith/.test(rd('broadcast.js')), 'broadcast.js sends through sendMarketingTemplate');
  ok(/sendMarketingTemplate/.test(rd('reorders.js')) && !/sendTemplateWith/.test(rd('reorders.js')), 'reorders.js sends through sendMarketingTemplate');
  ok(!/sendMarketingTemplate/.test(rd('reviews.js')) && !/sendMarketingTemplate/.test(rd('journey.js')) && !/sendMarketingTemplate/.test(rd('refundTemplates.js')) && !/sendMarketingTemplate/.test(rd('ownerAlerts.js')), 'utility senders (J3 check-in, J4, refunds, owner alerts) do not use it');

  console.log(`whatsapp-transport-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
