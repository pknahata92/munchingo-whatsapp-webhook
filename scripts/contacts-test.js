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
        saveContact: async (row) => { rows[row.phone] = { ...(rows[row.phone] || {}), ...row }; return rows[row.phone]; },
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
  let m = f.sent[0];
  ok(f.sent.length === 1 && m.kind === 'buttons' && m.to === '919810000001', 'one button message is sent back');
  ok(m.body === c.CONSENT_QUESTION && /Reply STOP any time/.test(m.body) && /Flavors/.test(m.body), 'the consent question is the agreed wording');
  ok(JSON.stringify(m.buttons) === JSON.stringify([{ id: 'optin_yes', title: 'Yes, keep me posted' }, { id: 'optin_no', title: 'No thanks' }]), 'two buttons: yes and no');
  ok(m.buttons.every((b) => b.title.length <= 20), 'button titles fit WhatsApp\'s 20-character limit');

  // ── answering ──
  f.tick(60 * 1000);
  await c.handleOptIn('919810000001', true);
  row = f.rows['919810000001'];
  ok(row.consent_marketing === true && row.consent_at === new Date(START + 60000).toISOString() && row.consent_text === c.CONSENT_QUESTION, 'yes records consent, the time and the exact question asked');
  ok(f.sent[1].kind === 'text' && /on the list/.test(f.sent[1].text), 'yes gets a thank-you');
  await c.handleOptIn('919810000001', false);
  row = f.rows['919810000001'];
  ok(row.consent_marketing === false && row.consent_text === c.CONSENT_QUESTION, 'no records a refusal');
  ok(/won't send offers/.test(f.sent[2].text), 'no gets a polite reply');

  // ── coming back on another day keeps the first source and the earlier answer ──
  await c.handleOptIn('919810000001', true);
  f.tick(24 * 3600 * 1000);
  await c.handleSignup('919810000001', 'Riya K', 'FAIR');
  row = f.rows['919810000001'];
  ok(row.first_source === 'fair:2026-10-25' && row.last_source === 'fair:2026-10-26' && row.name === 'Riya K', 'a second scan updates last source and name, keeps first source');
  ok(row.consent_marketing === true, 'a second scan does not wipe the earlier yes');
  ok(f.sent[f.sent.length - 1].kind === 'text' && /already on the list/.test(f.sent[f.sent.length - 1].text), 'someone already opted in is not asked again');

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
  f = fakes(START); f.deps.db.saveContact = async () => { throw new Error('db down'); }; c.setDeps(f.deps);
  let threw = false; try { await c.handleSignup('919810000002', 'Om', 'fair'); } catch (e) { threw = true; }
  ok(!threw && f.sent.length === 1 && f.sent[0].kind === 'buttons', 'a failed save still asks the question and does not throw');

  // ── wiring: the bot checks STOP and sign-ups before anything else, and routes the two buttons ──
  const h = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'messageHandler.js'), 'utf8');
  const body = h.slice(h.indexOf('async function routeText('));
  const iStop = body.indexOf('contacts.isStop('), iSign = body.indexOf('contacts.signupSource('), iLang = body.indexOf('HINDI_ENABLED()'), iHi = body.indexOf('/^(hi|hello');
  ok(iStop > 0 && iSign > 0 && iStop < iLang && iSign < iLang && iSign < iHi, 'routeText checks STOP and sign-ups first');
  ok(/case 'optin_yes':/.test(h) && /case 'optin_no':/.test(h), 'routeInteractive handles both buttons');

  // ── the table ──
  const sql = fs.readFileSync(path.join(__dirname, '..', 'contacts_migration.sql'), 'utf8').replace(/\s+/g, ' ').toLowerCase();
  for (const col of ['phone text primary key', 'name text', 'first_source text not null', 'last_source text', 'consent_marketing boolean', 'consent_at timestamptz', 'consent_text text', 'created_at timestamptz not null default now()', 'updated_at timestamptz not null default now()']) ok(sql.includes(col), 'contacts has: ' + col);
  ok(/alter table contacts enable row level security/.test(sql), 'row level security on contacts');
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'database.js'), 'utf8');
  const ex = (dbSrc.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/) || ['', ''])[1];
  ok(/\bgetContact\b/.test(ex) && /\bsaveContact\b/.test(ex) && /async function getContact\(/.test(dbSrc) && /async function saveContact\(/.test(dbSrc), 'database.js defines and exports getContact and saveContact');

  console.log(`contacts-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
