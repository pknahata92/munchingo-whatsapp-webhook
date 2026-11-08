'use strict';
// Broadcasts (8 Nov 2026): one approved marketing template to everyone who said yes (contacts.consent_marketing = true).
//   node scripts/broadcast-test.js
const fs = require('fs'), path = require('path');
process.env.SUPABASE_URL = 'x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const b = require('../utils/broadcast');
const DAY = 86_400_000, NOW = Date.parse('2026-11-08T12:00:00Z');

function world({ contacts, sends = [], failFor = [] }) {
  const sent = [], logged = [];
  b.setDeps({
    db: {
      listMarketingContacts: async () => contacts.filter((c) => c.consent_marketing === true),
      listMarketingSends: async (sinceIso) => sends.filter((s) => s.sent_at >= sinceIso || s.template),
      insertMarketingSend: async (row) => { logged.push(row); sends.push({ ...row, sent_at: new Date(NOW).toISOString() }); },
    },
    wa: { sendTemplateWithHeader: async (to, name, lang, header, params) => { if (failFor.includes(to)) throw new Error('bad number'); sent.push({ to, name, lang, header, params }); return { messages: [{ id: 'wamid' }] }; } },
    now: () => NOW, wait: async () => {}, ownerPhone: () => '919999900000',
  });
  return { sent, logged, sends };
}
const C = (phone, name, consent = true, src = 'join:2026-10-25') => ({ phone, name, consent_marketing: consent, first_source: src, last_source: src });
const T = 'munchingo_diwali_2026', V = 'https://munchingo.com/media/diwali-2026.mp4';

(async () => {
  // dry run: counts only, sends nothing, never returns numbers
  let w = world({ contacts: [C('919000000001', 'Asha Rao'), C('919000000002', 'Ravi'), C('919000000003', 'Meena', false), C('919000000004', 'Old', null), C('919999900000', 'Prashant Nahata')] });
  let r = await b.run({ template: T, mode: 'dry', video: V });
  ok(r.ok && r.mode === 'dry' && r.to_send === 3, 'dry run counts the 2 consented people plus the owner (got ' + JSON.stringify(r) + ')');
  ok(w.sent.length === 0 && w.logged.length === 0, 'a dry run sends and logs nothing');
  ok(!JSON.stringify(r).match(/9190000000/), 'the result never contains a phone number');

  // test mode: only the owner
  r = await b.run({ template: T, mode: 'test', video: V });
  ok(r.sent === 1 && w.sent.length === 1 && w.sent[0].to === '919999900000', 'test mode sends only to OWNER_PHONE');
  ok(w.logged.length === 0, 'a test send is not logged, so the real send still includes the owner');
  ok(w.sent[0].header.type === 'video' && w.sent[0].header.link === V && w.sent[0].params[0] === 'Prashant', 'the video header and the first name are filled in');

  // a real send must quote the dry-run count
  w = world({ contacts: [C('919000000001', 'Asha Rao'), C('919000000002', 'Ravi')] });
  r = await b.run({ template: T, mode: 'send', video: V });
  ok(!r.ok && /expect/.test(r.error) && w.sent.length === 0, 'send without expect is refused');
  r = await b.run({ template: T, mode: 'send', video: V, expect: 5 });
  ok(!r.ok && /3/.test(r.error) && w.sent.length === 0, 'send with the wrong expect is refused and says the real number');
  r = await b.run({ template: T, mode: 'send', video: V, expect: 3 });
  ok(r.ok && r.sent === 3 && w.sent.length === 3 && w.logged.length === 3, 'send with the right expect sends to both and the owner, and logs all 3');
  ok(w.logged.every((l) => l.template === T && l.status === 'sent'), 'each send is logged with the template and status');
  ok(w.sent.map((s) => s.params[0]).join() === 'Prashant,Asha,Ravi', 'the owner goes first (a live check), then first names only');

  // re-running the same broadcast sends nobody twice
  r = await b.run({ template: T, mode: 'dry', video: V });
  ok(r.to_send === 0 && r.already_sent === 3, 'a second run of the same template finds everyone already sent');

  // the owner is on every list, once, even when his own sign-up is in contacts
  w = world({ contacts: [C('919999900000', 'Prashant Nahata'), C('919000000001', 'Asha')] });
  r = await b.run({ template: T, mode: 'dry' });
  ok(r.to_send === 2, 'the owner is counted once even if he is also a contact');

  // sources: a review ask goes only to people who bought (stall or fair), never to sign-ups who have not tasted it
  w = world({ contacts: [C('919000000001', 'Asha', true, 'stall:2026-11-01'), C('919000000002', 'Ravi', true, 'join:2026-10-25'), C('919000000003', 'Neha', true, 'fair:2026-10-25'), C('919000000004', 'Om', true, 'stall:2026-11-06')] });
  r = await b.run({ template: T, mode: 'dry', sources: 'stall,fair' });
  ok(r.to_send === 4, 'sources=stall,fair picks the 3 buyers plus the owner, not the sign-up (got ' + r.to_send + ')');
  r = await b.run({ template: T, mode: 'dry', sources: 'stall:2026-11-06' });
  ok(r.to_send === 2, 'a source can be one stall day');
  ok(!(await b.run({ template: T, mode: 'dry', sources: 'stall; drop table' })).ok, 'a source list with odd characters is refused');

  // the 3-a-month promise
  const old = (d, t) => ({ phone: '919000000001', template: t, status: 'sent', sent_at: new Date(NOW - d * DAY).toISOString() });
  w = world({ contacts: [C('919000000001', 'Asha'), C('919000000002', 'Ravi')], sends: [old(2, 'a'), old(10, 'b'), old(20, 'c')] });
  r = await b.run({ template: T, mode: 'dry', video: V });
  ok(r.to_send === 2 && r.over_cap === 1, 'someone with 3 sends in the last 30 days is skipped');
  w = world({ contacts: [C('919000000001', 'Asha')], sends: [old(40, 'a'), old(45, 'b'), old(50, 'c')] });
  r = await b.run({ template: T, mode: 'dry', video: V });
  ok(r.to_send === 2, 'sends older than 30 days do not count');

  // failures are logged and do not stop the rest
  w = world({ contacts: [C('919000000001', 'Asha'), C('919000000002', 'Ravi'), C('919000000003', 'Neha')], failFor: ['919000000002'] });
  r = await b.run({ template: T, mode: 'send', video: V, expect: 4 });
  ok(r.sent === 3 && r.failed === 1 && w.logged.some((l) => l.status === 'failed' && /bad number/.test(l.error)), 'one failure is logged and the others still go');

  // names that are not names
  w = world({ contacts: [C('919000000001', '~'), C('919000000002', 'KaamKe.'), C('919000000003', 'mr. gaurav sharma')] });
  r = await b.run({ template: T, mode: 'send', video: V, expect: 3 });
  ok(w.sent.length === 3 && w.sent[1].params[0] === 'there' && w.sent[2].params[0] === 'Gaurav', 'a symbol name becomes "there", titles are dropped, the KaamKe test sign-up is skipped');

  // input checks
  ok(!(await b.run({ template: 'Bad Name!', mode: 'dry' })).ok, 'a template name that Meta would not accept is refused');
  ok(!(await b.run({ template: T, mode: 'blast' })).ok, 'an unknown mode is refused');
  ok(!(await b.run({ template: T, mode: 'dry', video: 'http://x.mp4' })).ok, 'a video link must be https');

  // a picture instead of a video (one header only)
  w = world({ contacts: [C('919000000001', 'Asha')] });
  const I = 'https://munchingo.com/images/wa/diwali-2026.jpg';
  r = await b.run({ template: T, mode: 'test', image: I });
  ok(r.ok && w.sent[0].header.type === 'image' && w.sent[0].header.link === I, 'image=<https link> sends a picture header');
  ok(!(await b.run({ template: T, mode: 'dry', image: I, video: V })).ok, 'a picture and a video together are refused (WhatsApp allows one header)');
  ok(!(await b.run({ template: T, mode: 'dry', image: 'http://x.jpg' })).ok, 'a picture link must be https');

  // wiring
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(/\/internal\/broadcast/.test(srv) && /utils\/broadcast/.test(srv), 'server exposes /internal/broadcast');
  const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'broadcast.yml'), 'utf8');
  ok(/workflow_dispatch/.test(wf) && !/schedule/.test(wf) && /DIGEST_SECRET/.test(wf), 'the workflow only runs by hand and uses the secret');
  const wa = require('../utils/whatsapp');
  ok(typeof wa.sendTemplateWithHeader === 'function', 'whatsapp.js can send a template with a media header');
  const db = fs.readFileSync(path.join(__dirname, '..', 'utils', 'database.js'), 'utf8');
  ok(/listMarketingContacts/.test(db) && /insertMarketingSend/.test(db) && /listMarketingSends/.test(db), 'database helpers exist');

  console.log(`broadcast-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
