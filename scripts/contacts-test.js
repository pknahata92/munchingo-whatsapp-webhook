'use strict';
// Contact capture: a buyer at an event scans the counter QR, WhatsApp opens with "FAIR" typed, they send it; we keep their
// number and WhatsApp name, ask once for marketing consent with two buttons, and record the answer word for word.
// STOP always withdraws consent.   node scripts/contacts-test.js
const fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

function fakes(startMs) {
  const rows = {}; const sent = [];
  let t = startMs;
  return {
    rows, sent, tick: (ms) => { t += ms; },
    deps: {
      now: () => t,
      db: {
        getContact: async (phone) => (rows[phone] ? { ...rows[phone] } : null),
        // Strict like Postgres: a new row must carry first_source (NOT NULL); an existing row is changed with an update only.
        insertContact: async (row) => { if (rows[row.phone]) throw new Error('duplicate key'); if (!row.first_source) throw new Error('null value in column "first_source"'); rows[row.phone] = { ...row }; return rows[row.phone]; },
        updateContact: async (phone, fields) => { if (!rows[phone]) throw new Error('no such contact'); if ('first_source' in fields && !fields.first_source) throw new Error('null first_source'); rows[phone] = { ...rows[phone], ...fields }; return rows[phone]; },
      },
      wa: {
        sendButtons: async (to, body, buttons) => { sent.push({ to, kind: 'buttons', body, buttons }); },
        sendText: async (to, text) => { sent.push({ to, kind: 'text', text }); },
      },
    },
  };
}

(async () => {
  const c = require('../utils/contacts');

  // ── which messages are a sign-up or a stop ──
  ok(c.signupSource('FAIR') === 'fair' && c.signupSource('fair') === 'fair' && c.signupSource('  Fair  ') === 'fair', 'FAIR in any case is a fair sign-up');
  ok(c.signupSource('FAIR - I bought Munchingo at the Diwali fair') === 'fair', 'the pre-typed QR message is a fair sign-up');
  ok(c.signupSource('JOIN') === 'join' && c.signupSource('JOIN - Send me Munchingo launches and offers') === 'join', 'JOIN (poster and coupon-card QR) is its own sign-up source');
  ok(c.signupSource('join us?') === null && c.signupSource('joined') === null, 'other messages starting with join are not sign-ups');
  ok(c.signupSource('fairly good cookies') === null && c.signupSource('hi') === null && c.signupSource('') === null && c.signupSource(null) === null, 'other messages are not sign-ups');
  ok(c.isStop('STOP') && c.isStop('stop') && c.isStop(' Stop. ') && c.isStop('unsubscribe'), 'STOP and unsubscribe withdraw consent');
  ok(!c.isStop('stop subscription') && !c.isStop("don't stop") && !c.isStop('stopped'), 'longer messages with "stop" in them are not STOP');

  // ── sign-up: saves the contact, asks once with two buttons ──
  const START = Date.parse('2026-10-25T06:00:00Z');   // 11:30 IST
  let f = fakes(START); c.setDeps(f.deps);
  await c.handleSignup('919810000001', 'Riya Kapoor', 'fair');
  let row = f.rows['919810000001'];
  ok(row && row.name === 'Riya Kapoor' && row.first_source === 'fair:2026-10-25' && row.last_source === 'fair:2026-10-25', 'the contact is saved with name and the event day in IST (' + JSON.stringify(row) + ')');
  ok(row.consent_marketing === undefined || row.consent_marketing === null, 'no consent is assumed from the scan');
  { const g = fakes(START); c.setDeps(g.deps); await c.handleSignup('919810000003', 'Asha', 'join');
    ok(g.rows['919810000003'].first_source === 'join:2026-10-25' && g.sent[0].kind === 'buttons', 'a JOIN sign-up is saved as join:<IST day> and asked the same question'); c.setDeps(f.deps); }
  let m = f.sent[0];
  ok(f.sent.length === 1 && m.kind === 'buttons' && m.to === '919810000001', 'one button message is sent back');
  ok(m.body === c.CONSENT_QUESTION && /^Thanks for stopping by Munchingo! 🍪/.test(m.body) && !/picking/.test(m.body) && /Reply STOP any time/.test(m.body) && /Flavors/.test(m.body), 'the consent question is the agreed wording (fits buyers and browsers)');
  ok(JSON.stringify(m.buttons) === JSON.stringify([{ id: 'optin_yes', title: 'Yes, keep me posted' }, { id: 'optin_no', title: 'No thanks' }]), 'two buttons: yes and no');
  ok(m.buttons.every((b) => b.title.length <= 20), 'button titles fit WhatsApp\'s 20-character limit');

  // ── answering ──
  f.tick(60 * 1000);
  await c.handleOptIn('919810000001', true);
  row = f.rows['919810000001'];
  ok(row.consent_marketing === true && row.consent_at === new Date(START + 60000).toISOString() && row.consent_text === c.CONSENT_QUESTION, 'yes records consent, the time and the exact question asked');
  ok(f.sent[1].kind === 'buttons' && /on the list/.test(f.sent[1].body) && JSON.stringify(f.sent[1].buttons) === JSON.stringify([{ id: 'btn_products', title: '🛒 Browse Products' }]), 'yes gets a thank-you with a Browse Products button');
  await c.handleOptIn('919810000001', false);
  row = f.rows['919810000001'];
  ok(row.consent_marketing === false && row.consent_text === c.CONSENT_QUESTION, 'no records a refusal');
  ok(f.sent[2].kind === 'buttons' && /won't send offers/.test(f.sent[2].body) && JSON.stringify(f.sent[2].buttons) === JSON.stringify([{ id: 'btn_products', title: '🛒 Browse Products' }]), 'no gets a polite reply with a Browse Products button');

  // ── coming back on another day keeps the first source and the earlier answer ──
  await c.handleOptIn('919810000001', true);
  f.tick(24 * 3600 * 1000);
  await c.handleSignup('919810000001', 'Riya K', 'FAIR');
  row = f.rows['919810000001'];
  ok(row.first_source === 'fair:2026-10-25' && row.last_source === 'fair:2026-10-26' && row.name === 'Riya K', 'a second scan updates last source and name, keeps first source');
  ok(row.consent_marketing === true, 'a second scan does not wipe the earlier yes');
  { const L = f.sent[f.sent.length - 1]; ok(L.kind === 'buttons' && /already on the list/.test(L.body) && JSON.stringify(L.buttons) === JSON.stringify([{ id: 'btn_products', title: '🛒 Browse Products' }]), 'someone already opted in is not asked again, and can go straight to products'); }

  // ── STOP ──
  await c.handleStop('919810000001');
  row = f.rows['919810000001'];
  ok(row.consent_marketing === false && row.consent_text === 'STOP', 'STOP withdraws consent and says how');
  ok(/won't send you offers/.test(f.sent[f.sent.length - 1].text), 'STOP is confirmed');
  await c.handleStop('919899999999');
  ok(f.rows['919899999999'] && f.rows['919899999999'].consent_marketing === false && f.rows['919899999999'].first_source === 'stop', 'STOP from an unknown number is kept as a do-not-message record');
  await c.handleOptIn('919877777777', true);
  ok(f.rows['919877777777'] && f.rows['919877777777'].consent_marketing === true && f.rows['919877777777'].first_source === 'button', 'a yes from a number we never saved (stale button) is still recorded');

  // ── a database failure never leaves the buyer without a reply ──
  f = fakes(START); f.deps.db.insertContact = f.deps.db.updateContact = async () => { throw new Error('db down'); }; c.setDeps(f.deps);
  let threw = false; try { await c.handleSignup('919810000002', 'Om', 'fair'); } catch (e) { threw = true; }
  ok(!threw && f.sent.length === 1 && f.sent[0].kind === 'buttons', 'a failed save still asks the question and does not throw');
  await c.handleOptIn('919810000002', true);
  ok(/didn't go through/.test(f.sent[1].text) && !/on the list/.test(f.sent[1].text), 'a yes that could not be saved is NOT confirmed; the buyer is asked to tap again');
  await c.handleStop('919810000002');
  ok(/didn't go through/.test(f.sent[2].text) && !/won't send/.test(f.sent[2].text), 'a STOP that could not be saved is NOT confirmed');

  ok(c.BUTTONS.every((b) => b.title.length <= 20) && '🛒 Browse Products'.length <= 20, 'the shop button title fits 20 characters');
  // ── wiring: the bot checks STOP and sign-ups before anything else, and routes the two buttons ──
  const h = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'messageHandler.js'), 'utf8');
  const body = h.slice(h.indexOf('async function routeText('));
  const iStop = body.indexOf('contacts.isStop('), iSign = body.indexOf('contacts.signupSource('), iLang = body.indexOf('HINDI_ENABLED()'), iHi = body.indexOf('/^(hi|hello');
  ok(iStop > 0 && iSign > 0 && iStop < iLang && iSign < iLang && iSign < iHi, 'routeText checks STOP and sign-ups first');
  ok(/case 'optin_yes':/.test(h) && /case 'optin_no':/.test(h), 'routeInteractive handles both buttons');
  ok(/case 'btn_products':\s*return sendProductList\(to\)/.test(h), 'the Browse Products button opens the product list');

  // ── the table ──
  const sql = fs.readFileSync(path.join(__dirname, '..', 'contacts_migration.sql'), 'utf8').replace(/\s+/g, ' ').toLowerCase();
  for (const col of ['phone text primary key', 'name text', 'first_source text not null', 'last_source text', 'consent_marketing boolean', 'consent_at timestamptz', 'consent_text text', 'created_at timestamptz not null default now()', 'updated_at timestamptz not null default now()']) ok(sql.includes(col), 'contacts has: ' + col);
  ok(/alter table contacts enable row level security/.test(sql), 'row level security on contacts');
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'database.js'), 'utf8');
  const ex = (dbSrc.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/) || ['', ''])[1];
  ok(['getContact', 'insertContact', 'updateContact'].every((n) => new RegExp('\\b' + n + '\\b').test(ex) && new RegExp('async function ' + n + '\\(').test(dbSrc)), 'database.js defines and exports getContact, insertContact, updateContact');
  const upd = dbSrc.slice(dbSrc.indexOf('async function updateContact('), dbSrc.indexOf('async function updateContact(') + 400);
  ok(/\.update\(/.test(upd) && !/upsert/.test(upd), 'updateContact uses a plain update, never an upsert (an upsert row without first_source breaks NOT NULL)');

  console.log(`contacts-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
