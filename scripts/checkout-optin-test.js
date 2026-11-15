'use strict';
// Checkout WhatsApp opt-in: an unticked box at checkout; a ticked box joins `contacts` only when the order is paid.
//   node scripts/checkout-optin-test.js
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const optin = require('../utils/checkoutOptIn');
const contacts = require('../utils/contacts');

let store = {};
const NOW = Date.parse('2026-10-27T06:00:00Z');   // 11:30 IST
contacts.setDeps({
  db: {
    getContact: async (p) => store[p] || null,
    updateContact: async (p, f) => { store[p] = { ...store[p], ...f }; return store[p]; },
    insertContact: async (row) => { store[row.phone] = { ...row }; return row; },
  },
  wa: { sendButtons: async () => {}, sendText: async () => {} },
  now: () => NOW,
});

(async () => {
  // attach: only a strict true counts
  for (const v of [undefined, false, 'true', 1, 'yes', null, {}]) { const p = {}; optin.attach(p, v, NOW); ok(!('marketing' in p), 'not ticked: nothing stored for ' + JSON.stringify(v)); }
  const parts = {}; optin.attach(parts, true, NOW);
  ok(parts.marketing && parts.marketing.text === optin.CONSENT_TEXT && parts.marketing.at === new Date(NOW).toISOString(), 'ticked: the exact sentence and the time ride on the order');
  ok(optin.CONSENT_TEXT === 'Send me new Flavors and offers on WhatsApp. A few messages a month. Reply STOP any time.', 'the approved wording');

  ok(optin.CONSENT_TEXTS.v1 === optin.CONSENT_TEXT && optin.CONSENT_TEXTS.v2 === 'Send me fresh batches, new Flavors and one nudge when my box is likely running low, on WhatsApp. At most 3 a month. Reply STOP any time.', 'CONSENT_TEXTS: v1 is today\'s text, v2 is C4');
  { const p1 = {}; optin.attach(p1, true, NOW); const p2 = {}; optin.attach(p2, 'v2', NOW); const p3 = {}; optin.attach(p3, 'v3', NOW);
    ok(p1.marketing.text === optin.CONSENT_TEXTS.v1 && p2.marketing.text === optin.CONSENT_TEXTS.v2 && !('marketing' in p3), 'attach: true stores v1, "v2" stores v2, anything else nothing'); }

  const order = (over = {}) => ({ order_id: 'MNG-T1', customer_phone: '919876543210', customer_name: 'Asha', status: 'paid',
    delivery_address: { marketing: { text: optin.CONSENT_TEXT, at: '2026-10-27T05:50:00.000Z' } }, ...over });

  store = {};
  { const rv = await optin.onPaid(order({ delivery_address: { marketing: { text: optin.CONSENT_TEXTS.v2, at: '2026-10-27T05:50:00.000Z' } } }));
    const cv = store['919876543210'];
    ok(rv.joined && cv.consent_marketing === true && cv.consent_reminder === true && cv.consent_text === optin.CONSENT_TEXTS.v2, 'a v2 order joins with consent_reminder true and the v2 text'); }
  store = {};
  let r = await optin.onPaid(order());
  const c = store['919876543210'];
  ok(r.joined && c && c.consent_marketing === true && c.consent_text === optin.CONSENT_TEXT && c.consent_at === '2026-10-27T05:50:00.000Z', 'ticked + paid: joins with consent, sentence and tick time');
  ok(c.consent_reminder !== true && !('consent_reminder' in c), 'a v1 order joins without reminder consent (the field is not written; the column defaults to false)');
  ok(c.first_source === 'website:2026-10-27' && c.last_source === 'website:2026-10-27' && c.name === 'Asha', 'source is website:<IST day>, buyer name kept');

  // ── A8 fix 6: a v1 tick (an old checkout page still open) never lowers a reminder yes ──
  const V2AT = '2026-10-20T06:00:00.000Z';
  store = { '919876543210': { phone: '919876543210', consent_marketing: true, consent_reminder: true, consent_at: V2AT, consent_text: optin.CONSENT_TEXTS.v2, first_source: 'website:2026-10-20', last_source: 'website:2026-10-20' } };
  r = await optin.onPaid(order());
  { const x = store['919876543210'];
    ok(r.joined && x.consent_marketing === true && x.consent_reminder === true, 'v1 tick on a contact who said yes to reminders: consent_reminder stays true (' + JSON.stringify(x) + ')');
    ok(x.consent_text === optin.CONSENT_TEXTS.v2 && x.consent_at === V2AT, 'and the reminder yes record (v2 words and time) is left as it was');
    ok(x.last_source === 'website:2026-10-27', 'the new visit is still noted (last_source)'); }
  store = { '919876543210': { phone: '919876543210', consent_marketing: true, consent_reminder: false, consent_at: '2026-10-01T00:00:00Z', consent_text: 'fair', first_source: 'fair:2026-10-25' } };
  r = await optin.onPaid(order());
  ok(r.joined && store['919876543210'].consent_reminder === false && store['919876543210'].consent_text === optin.CONSENT_TEXT, 'v1 tick on a contact without a reminder yes: still no reminder consent, the v1 words recorded');
  store = { '919876543210': { phone: '919876543210', consent_marketing: true, consent_reminder: false, consent_at: '2026-10-01T00:00:00Z', consent_text: 'fair', first_source: 'fair:2026-10-25' } };
  r = await optin.onPaid(order({ delivery_address: { marketing: { text: optin.CONSENT_TEXTS.v2, at: '2026-10-27T05:50:00.000Z' } } }));
  ok(r.joined && store['919876543210'].consent_reminder === true && store['919876543210'].consent_text === optin.CONSENT_TEXTS.v2, 'a v2 tick still sets consent_reminder true');
  { const src = require('fs').readFileSync(require('path').join(__dirname, '../utils/checkoutOptIn.js'), 'utf8');
    ok(!/DRAFT/.test(src), 'checkoutOptIn.js no longer calls C4 a draft (approved)'); }
  { const src = require('fs').readFileSync(require('path').join(__dirname, '../utils/contacts.js'), 'utf8');
    ok(!/DRAFT C2|still wording it/.test(src), 'contacts.js no longer calls C2 a draft (approved)'); }

  store = {};
  r = await optin.onPaid(order({ delivery_address: {} }));
  ok(!r.joined && Object.keys(store).length === 0, 'unticked: nobody added');

  store = { '919876543210': { phone: '919876543210', consent_marketing: true, consent_at: '2026-10-01T00:00:00Z', consent_text: 'fair', first_source: 'fair:2026-10-25' } };
  r = await optin.onPaid(order({ delivery_address: {} }));
  ok(store['919876543210'].consent_marketing === true && store['919876543210'].consent_text === 'fair', 'unticked never removes an earlier yes');

  store = { '919876543210': { phone: '919876543210', consent_marketing: false, consent_at: '2026-10-27T05:55:00.000Z', consent_text: 'STOP', first_source: 'fair:2026-10-25' } };
  r = await optin.onPaid(order());
  ok(!r.joined && store['919876543210'].consent_marketing === false, 'STOP sent after the tick wins');

  store = { '919876543210': { phone: '919876543210', consent_marketing: false, consent_at: '2026-10-20T00:00:00Z', consent_text: 'STOP', first_source: 'fair:2026-10-25' } };
  r = await optin.onPaid(order());
  ok(r.joined && store['919876543210'].consent_marketing === true && store['919876543210'].first_source === 'fair:2026-10-25', 'a new tick after an old STOP is a fresh yes; first source kept');

  store = {};
  r = await optin.onPaid(order({ status: 'pending' }));
  ok(!r.joined && Object.keys(store).length === 0, 'unpaid order: nobody added');

  store = {};
  r = await optin.onPaid(order({ delivery_address: { recipientName: 'Ravi', recipientPhone: '919811111111', marketing: { text: optin.CONSENT_TEXT, at: '2026-10-27T05:50:00.000Z' } } }));
  ok(r.joined && store['919876543210'] && !store['919811111111'], 'gift: only the buyer joins, never the recipient');

  store = {};
  r = await optin.onPaid(order({ customer_phone: '12' }));
  ok(!r.joined && Object.keys(store).length === 0, 'bad phone: skipped, no crash');

  // wiring: checkout stores the tick, the paid webhook records it (cheap guard against the call being dropped)
  const fs = require('fs'), path = require('path');
  const co = fs.readFileSync(path.join(__dirname, '../routes/checkout.js'), 'utf8');
  ok(/marketing\b[^;]*\} = req\.body/.test(co) || /\bmarketing\b.*req\.body/.test(co), 'checkout reads the marketing field from the request');
  ok(/checkoutOptIn'\)\.attach\(parts, marketing\)/.test(co), 'checkout attaches the tick to the order');
  const srv = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  ok(/checkoutOptIn'\)\.onPaid\(/.test(srv), 'the paid webhook records the opt-in');
  console.log(`checkout-optin-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL: crashed', e.message); process.exit(1); });
