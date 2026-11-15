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
        touchInbound: async (phone, at) => { if (rows[phone]) rows[phone].last_inbound_at = at; },
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
  ok(m.body === c.CONSENT_QUESTION && /^Thanks for stopping by Munchingo! 🍪/.test(m.body) && !/picking/.test(m.body) && /Reply STOP any time/.test(m.body) && /Flavor/.test(m.body) && /a few weeks after an order, when your box is probably running low\?/.test(m.body) && /At most 3 a month/.test(m.body) && !/offers/.test(m.body), 'the consent question is the new wording that names the reorder nudge');
  ok(JSON.stringify(m.buttons) === JSON.stringify([{ id: 'optin2_yes', title: 'Yes, keep me posted' }, { id: 'optin2_no', title: 'No thanks' }]), 'two buttons: yes and no, with the C2 ids optin2_yes / optin2_no (got ' + JSON.stringify(m.buttons) + ')');
  ok(m.buttons.every((b) => b.title.length <= 20), 'button titles fit WhatsApp\'s 20-character limit');

  // ── answering ──
  f.tick(60 * 1000);
  await c.handleOptIn('919810000001', true);
  row = f.rows['919810000001'];
  ok(row.consent_reminder === true, 'yes to the new question also sets consent_reminder');
  ok(row.consent_marketing === true && row.consent_at === new Date(START + 60000).toISOString() && row.consent_text === c.CONSENT_QUESTION, 'yes records consent, the time and the exact question asked');
  ok(f.sent[1].kind === 'buttons' && /on the list/.test(f.sent[1].body) && JSON.stringify(f.sent[1].buttons) === JSON.stringify([{ id: 'btn_products', title: '🛒 Browse Products' }]), 'yes gets a thank-you with a Browse Products button');
  await c.handleOptIn('919810000001', false);
  row = f.rows['919810000001'];
  ok(row.consent_marketing === false && row.consent_reminder === false && row.consent_text === c.CONSENT_QUESTION, 'no records a refusal (and no reminder consent)');
  ok(f.sent[2].kind === 'buttons' && /No problem, I won't send these\. Enjoy them\. 🍪/.test(f.sent[2].body) && JSON.stringify(f.sent[2].buttons) === JSON.stringify([{ id: 'btn_products', title: '🛒 Browse Products' }]), 'no gets a polite reply with a Browse Products button');

  // ── A8 fix 2: a tap on the OLD question (sent before the C2 push, ids optin_yes / optin_no) records the OLD words ──
  const V1 = 'Thanks for stopping by Munchingo! 🍪\n\nCan we send you new Flavors, launches and offers on WhatsApp? A few messages a month at most. Reply STOP any time to stop.';
  ok(c.CONSENT_QUESTION_V1 === V1, 'the v1 question is kept word for word, for taps on it');
  {
    const g = fakes(START); c.setDeps(g.deps);
    await c.handleOptIn('919810000020', true, 'v1');
    let r1 = g.rows['919810000020'];
    ok(r1 && r1.consent_marketing === true && r1.consent_reminder === false && r1.consent_text === V1, 'old Yes: consent with the v1 words and consent_reminder false (' + JSON.stringify(r1) + ')');
    ok(g.sent[0] && g.sent[0].kind === 'buttons' && /on the list/.test(g.sent[0].body), 'old Yes: the same thank-you');
    await c.handleOptIn('919810000020', false, 'v1');
    r1 = g.rows['919810000020'];
    ok(r1.consent_marketing === false && r1.consent_reminder === false && r1.consent_text === V1, 'old No: a refusal with the v1 words');
    // a v1 Yes never lowers a reminder yes the contact gave elsewhere (as the checkout v1 tick, fix 6)
    const V2AT = '2026-10-20T06:00:00.000Z', V2 = require('../utils/checkoutOptIn').CONSENT_TEXTS.v2;
    g.rows['919810000021'] = { phone: '919810000021', first_source: 'website:2026-10-20', consent_marketing: true, consent_reminder: true, consent_at: V2AT, consent_text: V2 };
    await c.handleOptIn('919810000021', true, 'v1');
    r1 = g.rows['919810000021'];
    ok(r1.consent_marketing === true && r1.consent_reminder === true && r1.consent_text === V2 && r1.consent_at === V2AT, 'old Yes from a contact who already said yes to reminders: the record is left as it was (' + JSON.stringify(r1) + ')');
    ok(/on the list/.test(g.sent[g.sent.length - 1].body), 'and still gets the thank-you');
    await c.handleOptIn('919810000022', true);
    ok(g.rows['919810000022'].consent_reminder === true && g.rows['919810000022'].consent_text === c.CONSENT_QUESTION, 'no version given = the C2 question (consent_reminder true)');
    c.setDeps(f.deps);
  }

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
  ok(row.consent_marketing === false && row.consent_reminder === false && row.consent_text === 'STOP', 'STOP withdraws consent and the reminder consent, and says how');
  ok(f.sent[f.sent.length - 1].text === "Done, I won't send you these messages. You can still message us here any time.", 'STOP is confirmed (C6)');
  await c.handleStop('919899999999');
  ok(f.rows['919899999999'] && f.rows['919899999999'].consent_marketing === false && f.rows['919899999999'].first_source === 'stop', 'STOP from an unknown number is kept as a do-not-message record');
  await c.handleOptIn('919877777777', true);
  ok(f.rows['919877777777'] && f.rows['919877777777'].consent_marketing === true && f.rows['919877777777'].first_source === 'button', 'a yes from a number we never saved (stale button) is still recorded');

  // ── A8 fix 5: STOP still works on a database without the consent_reminder column (backend live before the migration) ──
  for (const msg of ["Could not find the 'consent_reminder' column of 'contacts' in the schema cache", 'column "consent_reminder" of relation "contacts" does not exist']) {
    const g = fakes(START); c.setDeps(g.deps);
    const strict = (fn) => async (...a) => { const fields = a[a.length - 1] && typeof a[a.length - 1] === 'object' ? a[a.length - 1] : a[0]; if ('consent_reminder' in fields) throw new Error(msg); return fn(...a); };
    g.deps.db.updateContact = strict(g.deps.db.updateContact); g.deps.db.insertContact = strict(g.deps.db.insertContact);
    g.rows['919810000030'] = { phone: '919810000030', first_source: 'fair:2026-10-20', consent_marketing: true };
    await c.handleStop('919810000030');
    const r1 = g.rows['919810000030'];
    ok(r1.consent_marketing === false && r1.consent_text === 'STOP' && r1.consent_at === new Date(START).toISOString() && !('consent_reminder' in r1), 'no column (' + msg.slice(0, 20) + '…): STOP is saved without consent_reminder (' + JSON.stringify(r1) + ')');
    ok(g.sent[0] && g.sent[0].text === "Done, I won't send you these messages. You can still message us here any time.", 'and confirmed, never "didn\'t go through"');
    await c.handleStop('919810000031');
    ok(g.rows['919810000031'] && g.rows['919810000031'].consent_marketing === false && g.rows['919810000031'].first_source === 'stop' && /won't send/.test(g.sent[1].text), 'a STOP from a new number is kept too');
  }
  c.setDeps(f.deps);

  // ── inbound time: never throws, never creates a contact ──
  f = fakes(START); c.setDeps(f.deps);
  await c.touchInbound('919800000099');
  ok(Object.keys(f.rows).length === 0, 'touchInbound on an unknown phone inserts nothing');
  f.rows['919800000098'] = { phone: '919800000098', first_source: 'x' };
  await c.touchInbound('919800000098');
  ok(f.rows['919800000098'].last_inbound_at === new Date(START).toISOString(), 'touchInbound stamps an existing contact with now');
  f.deps.db.touchInbound = async () => { throw new Error('db down'); };
  let tThrew = false; try { await c.touchInbound('919800000098'); } catch (e) { tThrew = true; }
  ok(!tThrew, 'touchInbound never throws');

  // ── coversReminders ──
  ok(c.coversReminders({ consent_marketing: true, consent_reminder: true }) === true, 'coversReminders: both true');
  ok(c.coversReminders({ consent_marketing: true, consent_reminder: false }) === false && c.coversReminders({ consent_marketing: false, consent_reminder: true }) === false && c.coversReminders(null) === false && c.coversReminders({ consent_marketing: true }) === false, 'coversReminders: false unless both are true');

  // ── notify (waitlist outside the delivery area) ──
  ok(c.signupSource('NOTIFY - Jaipur') === 'notify' && c.signupSource('notify') === 'notify' && c.signupSource('notify me later') === null, 'notify is a keyword');
  f = fakes(START); c.setDeps(f.deps);
  await c.handleSignup('919800000010', 'Meera', 'notify', 'NOTIFY - Jaipur');
  row = f.rows['919800000010'];
  ok(row && row.first_source === 'waitlist:jaipur:2026-10-25' && row.last_source === 'waitlist:jaipur:2026-10-25' && !('consent_marketing' in row) && !('consent_reminder' in row), 'NOTIFY - Jaipur saves the waitlist source and never sets consent (' + JSON.stringify(row) + ')');
  ok(f.sent[0].kind === 'text' && f.sent[0].text === 'Noted. I\'ll message you once when we deliver to Jaipur, and nothing else.', 'C8 reply names the city as typed, capitalised');
  await c.handleSignup('919800000011', 'Ravi', 'notify', 'notify - navi mumbai');
  ok(f.rows['919800000011'].first_source === 'waitlist:navi mumbai:2026-10-25' && /deliver to Navi mumbai,/.test(f.sent[1].text), 'a lower-case city is capitalised in the reply');
  await c.handleSignup('919800000012', 'Sam', 'notify', 'NOTIFY');
  ok(f.rows['919800000012'].first_source === 'waitlist:unknown:2026-10-25' && /deliver to your city,/.test(f.sent[2].text), 'no city: source waitlist:unknown, reply says your city');
  f.rows['919800000013'] = { phone: '919800000013', first_source: 'fair:2026-10-20', consent_marketing: true };
  await c.handleSignup('919800000013', 'Old', 'notify', 'NOTIFY - Pune');
  ok(f.rows['919800000013'].first_source === 'fair:2026-10-20' && f.rows['919800000013'].last_source === 'waitlist:pune:2026-10-25' && f.rows['919800000013'].consent_marketing === true, 'an existing contact keeps first source and consent');

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
  ok(/case 'optin2_yes':\s*return contacts\.handleOptIn\(to, true\);/.test(h) && /case 'optin2_no':\s*return contacts\.handleOptIn\(to, false\);/.test(h), 'routeInteractive: the C2 buttons record the C2 question');
  ok(/case 'optin_yes':\s*return contacts\.handleOptIn\(to, true, 'v1'\);/.test(h) && /case 'optin_no':\s*return contacts\.handleOptIn\(to, false, 'v1'\);/.test(h), 'routeInteractive: the old buttons still work and record the v1 question');
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
