'use strict';
// Suggestions on WhatsApp (28 Oct 2026). "💡 Share a suggestion" in More Info (or typing suggest / idea) asks one question;
// the customer's next message within 30 minutes is saved as the suggestion, the owner is emailed, and the customer is thanked
// with the promise: if we make your idea, you taste it first, free. The old feedback form's answers are saved too.
//   node scripts/suggestions-test.js
const fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const MIN = 60000;

function fakes(startMs) {
  let t = startMs; const waits = {}, rows = [], sent = [], mails = [];
  return {
    waits, rows, sent, mails, tick: (ms) => { t += ms; },
    deps: {
      now: () => t,
      db: {
        setSuggestionWait: async (phone, at) => { waits[phone] = at; },
        getSuggestionWait: async (phone) => (waits[phone] ? { phone, asked_at: waits[phone] } : null),
        clearSuggestionWait: async (phone) => { delete waits[phone]; },
        insertSuggestion: async (row) => { const r = { id: rows.length + 1, status: 'new', created_at: new Date(t).toISOString(), ...row }; rows.push(r); return r; },
        getRecentOrders: async (phone) => (phone === '919810000001' ? [{ order_id: 'MNG-AAAA-2710' }] : []),
      },
      wa: { sendText: async (to, text) => sent.push({ to, text }) },
      mail: { sendSuggestionAlert: async (row) => mails.push(row) },
    },
  };
}

(async () => {
  const s = require('../utils/suggestions');
  const START = Date.parse('2026-10-28T06:00:00Z');

  // ── which messages open it ──
  for (const w of ['suggest', 'Suggestion', 'IDEA', ' ideas ', 'I have a suggestion', 'i have an idea!']) ok(s.isAsk(w), 'opens on "' + w + '"');
  for (const w of ['great idea', 'no idea where my order is', 'suggest me a flavour for my mom', 'hi', '']) ok(!s.isAsk(w), 'does not open on "' + w + '"');
  ok(s.inlineSuggestion('Suggestion: make a chocolate one') === 'make a chocolate one' && s.inlineSuggestion('idea - smaller packs') === 'smaller packs' && s.inlineSuggestion('idea') === null, 'a suggestion typed in the same message is taken directly');

  // ── ask, then capture the next message ──
  let f = fakes(START); s.setDeps(f.deps);
  await s.ask('919810000001');
  ok(f.sent[0].text === s.ASK && /What should we make, change or fix\?/.test(s.ASK) && /Flavors/.test(s.ASK), 'the bot asks the agreed question');
  ok(f.waits['919810000001'] === new Date(START).toISOString(), 'it remembers it is waiting for this number');
  f.tick(5 * MIN);
  let took = await s.capture('919810000001', 'Riya Kapoor', '  Please make a jaggery one  ');
  ok(took === true && f.rows.length === 1, 'the next message is taken as the suggestion');
  const r = f.rows[0];
  ok(r.kind === 'suggestion' && r.phone === '919810000001' && r.name === 'Riya Kapoor' && r.text === 'Please make a jaggery one' && r.order_id === 'MNG-AAAA-2710', 'saved with name, number, text and latest order (' + JSON.stringify(r) + ')');
  ok(!f.waits['919810000001'], 'it stops waiting after one message');
  ok(f.sent[1].text === s.THANKS && /goes straight to Prashant/.test(s.THANKS) && /If we make your idea, you'll taste it first, free/.test(s.THANKS), 'thanks with the promise');
  ok(f.mails.length === 1 && f.mails[0].text === 'Please make a jaggery one', 'the owner is emailed');
  took = await s.capture('919810000001', 'Riya Kapoor', 'hi');
  ok(took === false && f.rows.length === 1, 'the message after that is handled normally');

  // ── 30 minutes, then it lets go ──
  f = fakes(START); s.setDeps(f.deps);
  await s.ask('919810000002'); f.tick(31 * MIN);
  took = await s.capture('919810000002', 'Om', 'where is my order');
  ok(took === false && f.rows.length === 0 && !f.waits['919810000002'], 'after 30 minutes the next message is NOT taken, and the wait is cleared');
  f = fakes(START); s.setDeps(f.deps);
  ok(await s.capture('919810000003', 'X', 'hello') === false && f.rows.length === 0, 'no wait, nothing taken');

  // ── inline, long text, failures ──
  f = fakes(START); s.setDeps(f.deps);
  await s.saveSuggestion('919810000004', 'Asha', 'x'.repeat(1500));
  ok(f.rows[0].text.length === 1000, 'a very long suggestion is kept to 1,000 characters');
  f = fakes(START); f.deps.db.insertSuggestion = async () => { throw new Error('db down'); }; s.setDeps(f.deps);
  let threw = false; try { await s.saveSuggestion('919810000005', 'Om', 'idea'); } catch (e) { threw = true; }
  ok(!threw && /didn't go through/.test(f.sent[0].text) && f.mails.length === 0, 'a save that fails is never thanked as received; the customer is asked to try again');
  f = fakes(START); f.deps.mail.sendSuggestionAlert = async () => { throw new Error('mail down'); }; s.setDeps(f.deps);
  threw = false; try { await s.saveSuggestion('919810000006', 'Om', 'idea'); } catch (e) { threw = true; }
  ok(!threw && f.rows.length === 1 && f.sent[0].text === s.THANKS, 'a failed email does not stop the save or the thanks');

  // ── the old feedback form is saved too ──
  f = fakes(START); s.setDeps(f.deps);
  await s.recordFeedback('919810000001', 'Riya', '4', 'Kesari too sweet');
  ok(f.rows[0].kind === 'feedback' && f.rows[0].rating === '4' && f.rows[0].text === 'Kesari too sweet', 'feedback form answers are saved as feedback with the rating');

  // ── wiring in the bot ──
  const h = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'messageHandler.js'), 'utf8');
  const rt = h.slice(h.indexOf('async function routeText('));
  const iStop = rt.indexOf('contacts.isStop('), iCap = rt.indexOf('suggestions.capture('), iAsk = rt.indexOf('suggestions.isAsk('), iHi = rt.indexOf('/^(hi|hello');
  ok(iStop > 0 && iCap > iStop && iAsk > 0 && iCap < iHi && iAsk < iHi, 'routeText: STOP first, then a waiting suggestion, then the suggest keyword, all before greetings');
  ok(/case 'faq_suggest':\s*return suggestions\.ask\(to\)/.test(h), 'the menu row opens it');
  ok(/suggestions\.recordFeedback\(/.test(h), 'the feedback form answers are saved');
  const faq = h.slice(h.indexOf('async function sendFAQ('), h.indexOf('async function sendFAQ(') + 2500);
  const rowIds = faq.match(/id: '[a-z_]+'/g) || [];
  ok(rowIds.length <= 10, 'More Info keeps to WhatsApp\'s 10-row limit (' + rowIds.length + ')');
  ok(/id: 'faq_suggest',\s*title: '[^']*suggestion[^']*'/.test(faq), 'More Info has the Share a suggestion row');
  ok(!/COD/.test(faq), 'the menu no longer promises cash on delivery');
  ok(/case 'faq_payment':/.test(h), 'an old menu with the payment row still answers');
  const oi = h.slice(h.indexOf('async function sendOrderInstructions('), h.indexOf('async function sendOrderInstructions(') + 1200);
  ok(/UPI/.test(oi) && /pre-paid/.test(oi), 'How do I order now says how to pay');

  // ── tables ──
  const sql = fs.readFileSync(path.join(__dirname, '..', 'suggestions_migration.sql'), 'utf8').replace(/\s+/g, ' ').toLowerCase();
  for (const col of ['create table if not exists suggestions', 'phone text not null', "kind text not null default 'suggestion'", "status text not null default 'new'", 'order_id text', 'rating text', 'created_at timestamptz not null default now()', 'create table if not exists suggestion_waits', 'asked_at timestamptz not null']) ok(sql.includes(col), 'migration has: ' + col);
  ok(/check \(status in \('new','planned','done','not_for_us'\)\)/.test(sql.replace(/\s*,\s*/g, ',')), 'status allows new, planned, done, not for us');
  ok(/alter table suggestions enable row level security/.test(sql) && /alter table suggestion_waits enable row level security/.test(sql), 'row level security on both tables');
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'database.js'), 'utf8');
  const ex = (dbSrc.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/) || ['', ''])[1];
  for (const fn of ['setSuggestionWait', 'getSuggestionWait', 'clearSuggestionWait', 'insertSuggestion', 'listSuggestions', 'setSuggestionStatus', 'getRecentOrders']) ok(new RegExp('\\b' + fn + '\\b').test(ex), 'database.js exports ' + fn);

  // ── the 8:00 summary ──
  const t = require('../utils/emailTemplates');
  const html = t.dailySummaryHtml({ dayLabel: 'Tue, 27 Oct 2026', orders: [], suggestions: [{ name: 'Riya <b>', kind: 'suggestion', text: 'Make a jaggery one & more' }, { name: 'Om', kind: 'feedback', rating: '4', text: 'Good' }] });
  ok(/2 suggestions? or feedback/i.test(html) && /Make a jaggery one &amp; more/.test(html) && /Riya &lt;b&gt;/.test(html), 'the daily summary lists yesterday\'s suggestions, escaped');
  ok(!/suggestion/i.test(t.dailySummaryHtml({ dayLabel: 'x', orders: [] })), 'no suggestions: no section');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(/listSuggestionsBetween\(/.test(srv) && /sendDailyDigestEmail\(\{[^}]*suggestions/.test(srv), 'the 8:00 job passes yesterday\'s suggestions to the summary');
  console.log(`suggestions-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log(`suggestions-test: ${pass} passed, ${fail} failed`); process.exit(1); });
