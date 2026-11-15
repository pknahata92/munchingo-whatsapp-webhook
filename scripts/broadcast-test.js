'use strict';
// Broadcasts (8 Nov 2026): one approved marketing template to everyone who said yes (contacts.consent_marketing = true).
//   node scripts/broadcast-test.js
const fs = require('fs'), path = require('path');
process.env.SUPABASE_URL = 'x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const b = require('../utils/broadcast');
const DAY = 86_400_000, NOW = Date.parse('2026-11-08T12:00:00Z');

// packingNext: the inventory's answer (J7 lots mode); orders: every paid order (the newest says where a contact lives);
// reorder(ms): what utils/reorders.js would read for the J6-wins rule.
function world({ contacts, sends = [], failFor = [], at = NOW, packingNext = null, orders = [], reorder = null }) {
  const sent = [], logged = [], markedFailed = [];
  b.setDeps({
    db: {
      listMarketingContacts: async () => contacts.filter((c) => c.consent_marketing === true),
      listMarketingSends: async () => sends.slice(),
      insertMarketingSend: async (row) => { logged.push(row); sends.push({ ...row, sent_at: new Date(at).toISOString() }); },
      markMarketingSendFailed: async (waId, error) => { markedFailed.push({ waId, error }); const r = sends.find((x) => x.wa_message_id === waId); if (r) { r.status = 'failed'; r.error = error; } },
      listPaidOrderAddresses: async () => orders.slice(),
    },
    wa: {
      sendTemplateWithHeader: async (to, name, lang, header, params) => { if (failFor.includes(to)) throw new Error('bad number'); sent.push({ to, name, lang, header, params }); return { messages: [{ id: to === '919999900000' ? 'wamid' : 'wamid-' + to }] }; },
      sendTemplateWithButtons: async (to, name, lang, params, o = {}) => { if (failFor.includes(to)) throw new Error('bad number'); sent.push({ to, name, lang, params, header: o.header, quickReplies: o.quickReplies, urlIndex: o.urlIndex, urlSuffix: o.urlSuffix }); return { messages: [{ id: 'wamid-' + to }] }; },
    },
    now: () => at, wait: async () => {}, ownerPhone: () => '919999900000',
    packingNext: async () => { if (!packingNext) throw new Error('this test has no stock'); return packingNext(); },
    reorderInput: async (ms) => (reorder ? reorder(ms) : { orders: [], contacts: [], sends: [], eventsByOrder: {}, subscriptionPhones: [], stallOrders: [], inStock: new Set(), nowMs: ms }),
  });
  return { sent, logged, sends, markedFailed };
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

  // delivery results: WhatsApp accepts a message, then reports delivered / failed (with a code) a few seconds later
  w = world({ contacts: [C('919000000001', 'Asha')] });
  b.resetStatuses();
  r = await b.run({ template: T, mode: 'test', image: 'https://munchingo.com/x.jpg' });
  b.noteStatus({ id: 'wamid', status: 'failed', recipient_id: '919999900000', errors: [{ code: 131049, title: 'This message was not delivered to maintain healthy ecosystem engagement.' }] });
  b.noteStatus({ id: 'other-message', status: 'failed', recipient_id: '919000000009', errors: [{ code: 1 }] });
  r = await b.run({ template: T, mode: 'dry' });
  ok(r.recent && r.recent.length === 1 && r.recent[0].status === 'failed' && r.recent[0].code === 131049 && /ecosystem/.test(r.recent[0].reason), 'a failed delivery of a broadcast message shows its code and reason on the next run (got ' + JSON.stringify(r.recent) + ')');
  ok(!JSON.stringify(r).match(/91999990000|91900000000/), 'delivery results never include phone numbers');
  b.noteStatus({ id: 'wamid', status: 'delivered', recipient_id: '919999900000' });
  r = await b.run({ template: T, mode: 'dry' });
  ok(r.recent.some((x) => x.status === 'delivered'), 'a delivered status is shown too');

  // a send Meta accepts but then drops (131049) is marked failed, so it can be retried and does not count against the cap
  w = world({ contacts: [C('919000000001', 'Asha'), C('919000000002', 'Ravi')] });
  r = await b.run({ template: T, mode: 'send', image: 'https://munchingo.com/x.jpg', expect: 3 });
  ok(w.logged.every((l) => l.wa_message_id), 'each logged send keeps the WhatsApp message id');
  b.noteStatus({ id: 'wamid-919000000001', status: 'failed', errors: [{ code: 131049, title: 'healthy ecosystem' }] });
  await new Promise((z) => setTimeout(z, 10));
  ok(w.markedFailed.length === 1 && w.markedFailed[0].waId === 'wamid-919000000001' && /131049/.test(w.markedFailed[0].error), 'a failed delivery marks its log row failed with the code');
  r = await b.run({ template: T, mode: 'dry' });
  ok(r.to_send === 0 && r.cooling_off === 1 && r.already_sent === 2, 'the dropped person is held for 48 hours (Meta: wait at least 24), the two delivered count as sent (got ' + JSON.stringify({ t: r.to_send, c: r.cooling_off, a: r.already_sent }) + ')');
  b.noteStatus({ id: 'wamid-919000000002', status: 'delivered' });
  await new Promise((z) => setTimeout(z, 10));
  ok(w.markedFailed.length === 1, 'a delivered status changes nothing in the log');

  // Meta: do not resend to someone who got 131049 for at least 24 hours (resending sooner deepens the block). We wait 48.
  const f = (h, code) => ({ phone: '919000000001', template: T, status: 'failed', error: code + ' healthy ecosystem', sent_at: new Date(NOW - h * 3_600_000).toISOString() });
  w = world({ contacts: [C('919000000001', 'Asha')], sends: [f(3, '131049')] });
  r = await b.run({ template: T, mode: 'dry' });
  ok(r.to_send === 1 && r.cooling_off === 1, 'a 131049 failure 3 hours ago is held back (only the owner left) (got ' + JSON.stringify(r) + ')');
  w = world({ contacts: [C('919000000001', 'Asha')], sends: [f(49, '131049')] });
  r = await b.run({ template: T, mode: 'dry' });
  ok(r.to_send === 2 && !r.cooling_off, 'after 48 hours it can be sent again');
  w = world({ contacts: [C('919000000001', 'Asha')], sends: [f(3, '131026')] });
  r = await b.run({ template: T, mode: 'dry' });
  ok(r.to_send === 2, 'other failures are not held back');
  w = world({ contacts: [C('919000000001', 'Asha')], sends: [{ ...f(3, '131049'), template: 'another_template' }] });
  r = await b.run({ template: T, mode: 'dry' });
  ok(r.to_send === 1 && r.cooling_off === 1, 'the cooling-off applies to any marketing template, not just the same one');

  // exclude: tomorrow's send skips the buyers Prashant messaged by hand today
  w = world({ contacts: [C('919000000001', 'Asha', true, 'stall:2026-11-01'), C('919000000002', 'Ravi', true, 'join:2026-10-25'), C('919000000003', 'Neha', true, 'fair:2026-10-25'), { phone: '919000000004', name: 'Om', consent_marketing: true, first_source: 'join:2026-10-25', last_source: 'stall:2026-11-06' }] });
  r = await b.run({ template: T, mode: 'dry', exclude: 'stall,fair' });
  ok(r.to_send === 2, 'exclude=stall,fair leaves the sign-up who never bought plus the owner, and drops a sign-up who later bought at a stall (got ' + r.to_send + ')');
  ok(!(await b.run({ template: T, mode: 'dry', exclude: 'x; drop' })).ok, 'an exclude list with odd characters is refused');

  // quiet hours (15 Nov 2026): no marketing send 21:00-09:00 IST; dry and test may run any time
  w = world({ contacts: [C('919000000001', 'Asha')], at: Date.parse('2026-11-20T16:00:00Z') });   // 21:30 IST
  r = await b.run({ template: T, mode: 'send', expect: 2 });
  ok(JSON.stringify(r) === JSON.stringify({ ok: false, error: 'Quiet hours (21:00-09:00 IST): send after 9 AM.' }) && w.sent.length === 0, 'send at 21:30 IST is refused and sends nothing (got ' + JSON.stringify(r) + ')');
  r = await b.run({ template: T, mode: 'dry' });
  ok(r.ok, 'dry runs in quiet hours');
  r = await b.run({ template: T, mode: 'test' });
  ok(r.ok && w.sent.length === 1, 'test runs in quiet hours');

  // campaign: logged on every row; same template with a new campaign is allowed again
  w = world({ contacts: [C('919000000001', 'Asha')] });
  r = await b.run({ template: T, mode: 'send', campaign: 'batch_261120', expect: 2 });
  ok(r.ok && w.logged.length === 2 && w.logged.every((l) => l.campaign === 'batch_261120'), 'every logged row carries the campaign');
  r = await b.run({ template: T, mode: 'dry', campaign: 'batch_261120' });
  ok(r.to_send === 0 && r.already_sent === 2, 'same template + campaign: nobody twice');
  r = await b.run({ template: T, mode: 'dry', campaign: 'batch_261127' });
  ok(r.to_send === 2 && r.already_sent === 0, 'same template, new campaign: allowed');
  w = world({ contacts: [C('919000000001', 'Asha')] });
  await b.run({ template: T, mode: 'send', expect: 2 });
  ok(w.logged.every((l) => l.campaign === null), 'no campaign logs null (legacy)');
  ok(!(await b.run({ template: T, mode: 'dry', campaign: 'Bad Campaign!' })).ok, 'a campaign with odd characters is refused');

  // the owner is the live check: three sends in 30 days never drop him, an earlier send of the same template does
  w = world({ contacts: [], sends: ['a', 'b', 'c'].map((t, i) => ({ phone: '919999900000', template: t, campaign: null, status: 'sent', sent_at: new Date(NOW - (i + 1) * DAY).toISOString() })) });
  r = await b.run({ template: T, mode: 'dry' });
  ok(r.to_send === 1 && r.over_cap === 0, 'the owner over the cap is still sent to (got ' + JSON.stringify({ t: r.to_send, o: r.over_cap }) + ')');
  w = world({ contacts: [], sends: [{ phone: '919999900000', template: T, campaign: null, status: 'sent', sent_at: new Date(NOW - DAY).toISOString() }] });
  r = await b.run({ template: T, mode: 'dry' });
  ok(r.to_send === 0 && r.already_sent === 1, 'the owner is still skipped when already sent');

  // owner with two 131049 failures: held during the 48 h cool-off, sent once both are older than 48 h
  const oF = (h) => ({ phone: '919999900000', template: T, campaign: null, status: 'failed', error: '131049 x', sent_at: new Date(NOW - h * 3_600_000).toISOString() });
  w = world({ contacts: [], sends: [oF(30), oF(10)] });
  r = await b.run({ template: T, mode: 'dry' });
  ok(r.to_send === 0 && r.cooling_off === 1 && r.blocked_twice === 0, 'owner with two failures inside 48 h is cooling_off (got ' + JSON.stringify({ t: r.to_send, c: r.cooling_off, b: r.blocked_twice }) + ')');
  w = world({ contacts: [], sends: [oF(100), oF(80)] });
  r = await b.run({ template: T, mode: 'dry' });
  ok(r.to_send === 1 && r.blocked_twice === 0, 'owner whose two failures are older than 48 h is still sent to');

  // retry at most once after 131049: two failures for the same template + campaign block the person
  const h131 = (h) => ({ phone: '919000000001', template: T, campaign: null, status: 'failed', error: '131049 x', sent_at: new Date(NOW - h * 3_600_000).toISOString() });
  w = world({ contacts: [C('919000000001', 'Asha')], sends: [h131(100), h131(80)] });
  r = await b.run({ template: T, mode: 'dry' });
  ok(r.blocked_twice === 1 && r.to_send === 1 && r.cooling_off === 0, 'blocked_twice has its own count (got ' + JSON.stringify(r) + ')');

  // ── R35 (pre-review ruling, spec §6.4): every broadcast goes to one segment only, all consented NCR contacts ──
  // Any template and mode: a contact whose newest paid order went outside deliveryArea is left out, and so is anyone who complained
  // in the last 30 days. No paid order: kept as before (no pincode invented), counted as no_paid_order. The owner is exempt.
  {
    delete process.env.DELIVERY_NATIONWIDE;
    const iso = (ms) => new Date(ms).toISOString();
    const ord = (phone, pin, daysAgo) => ({ order_id: 'MNG-R35-' + phone.slice(-4) + '-' + daysAgo, customer_phone: phone, status: 'paid', created_at: iso(NOW - daysAgo * DAY), delivery_address: { raw: 'Somewhere - ' + pin, pincode: pin } });
    const contacts = [C('919000000001', 'Asha'), C('919000000002', 'Ravi'), { ...C('919000000003', 'Neha'), last_complaint_at: iso(NOW - 10 * DAY) }, C('919000000004', 'Om'), { ...C('919000000005', 'Ira'), last_complaint_at: iso(NOW - 31 * DAY) },
      { ...C('919999900000', 'Prashant Nahata'), last_complaint_at: iso(NOW - DAY) }];
    const orders = [ord('919000000002', '302001', 5), ord('919000000004', '110017', 3), ord('919000000005', '122001', 8), ord('919999900000', '302001', 2)];
    w = world({ contacts, orders });
    r = await b.run({ template: T, mode: 'dry', video: V });
    ok(r.ok && r.to_send === 4 && r.outside_area === 1 && r.complaint === 1, 'R35: a non-J7 dry run leaves out the 302001 contact and the recent complainer; the owner, Asha, Om and Ira (complaint 31 days ago) stay (got ' + JSON.stringify(r) + ')');
    ok(r.no_paid_order === 1, 'R35: the dry run counts contacts with no paid order (kept, area unknown): Asha (got ' + JSON.stringify(r.no_paid_order) + ')');
    ok(!JSON.stringify(r).match(/9190000000|919999900000/), 'R35: counts only, no phone numbers');
    r = await b.run({ template: T, mode: 'send', video: V, expect: 4 });
    ok(r.ok && r.sent === 4 && !w.sent.some((s) => s.to === '919000000002' || s.to === '919000000003'), 'R35 send: nothing goes to the 302001 contact or the recent complainer');
    ok((w.sent[0] || {}).to === '919999900000', 'R35: the owner (his own last order to 302001, a complaint yesterday) is still the live check');
    w = world({ contacts, orders });
    r = await b.run({ template: T, mode: 'test', video: V });
    ok(r.ok && r.sent === 1 && w.sent.length === 1 && (w.sent[0] || {}).to === '919999900000', 'R35: the owner test send is unaffected');
    process.env.DELIVERY_NATIONWIDE = '1';
    r = await b.run({ template: T, mode: 'dry', video: V });
    ok(r.to_send === 5 && r.outside_area === 0 && r.complaint === 1, 'R35: DELIVERY_NATIONWIDE=1 opens the area again; the complaint rule stays (got ' + JSON.stringify(r) + ')');
    delete process.env.DELIVERY_NATIONWIDE;
    r = await b.run({ template: T, mode: 'dry', video: V, sources: 'join' });
    ok(r.to_send === 4 && r.outside_area === 1, 'R35: the segment holds with a sources filter too');
  }

  // ── J7 fresh-batch alert (growth A7, 16 Nov 2026): sent only once the new lot is the one packing ──
  {
    const { makeInventory } = require('../utils/inventory');
    const { memStore } = require('./inventory-memstore');
    delete process.env.DELIVERY_NATIONWIDE; delete process.env.JOURNEY_J6_ENABLED;
    const FB = 'munchingo_fresh_batch', PIC = 'https://munchingo.com/media/batch-261120.jpg', NEW = 'MNGO-261120-01,MNGA-261120-01';
    const AT = Date.parse('2026-11-21T06:00:00Z');   // 11:30 IST, 21 Nov
    const iso = (ms) => new Date(ms).toISOString();
    const SHOP = (c) => 'shop?utm_source=whatsapp&utm_medium=broadcast&utm_campaign=' + c;
    const ALL4 = new Set(['atta-original', 'atta-kesari', 'atta-ajwain', 'atta-lite-sugar']);
    const st = memStore('2026-10-16T00:00:00.000Z'); const inv = makeInventory(st, { now: () => AT });
    const lot = async (slug, code, bake, bb, qty) => { await st.insertLots([{ item_slug: slug, lot_code: code, status: 'released', bake_date: bake, best_before: bb }]); await st.insert([{ item_slug: slug, qty, type: 'RECEIVE', lot_code: code, best_before: bb }]); };
    await lot('atta-original', 'MNGO-261105-01', '2026-11-05', '2027-02-03', 3);
    await lot('atta-original', 'MNGO-261120-01', '2026-11-20', '2027-02-18', 40);
    await lot('atta-ajwain', 'MNGA-261120-01', '2026-11-20', '2027-02-18', 30);
    await lot('atta-kesari', 'MNGK-261118-01', '2026-11-18', '2027-02-16', 20);
    const packingNext = () => (typeof inv.packingNext === 'function' ? inv.packingNext() : Promise.resolve({}));
    const W = (o = {}) => world({ at: AT, packingNext, contacts: [C('919000000001', 'Asha Rao')], ...o });

    // the batch ticket picture is required on every send (ruling R13)
    w = W();
    r = await b.run({ template: FB, lots: NEW, mode: 'dry' });
    ok(JSON.stringify(r) === JSON.stringify({ ok: false, error: 'A fresh-batch alert needs the batch ticket picture (image=https://…).' }), 'J7: no picture, refused (got ' + JSON.stringify(r) + ')');
    r = await b.run({ template: FB, lots: NEW, mode: 'dry', video: V });
    ok(!r.ok && /picture/.test(r.error || ''), 'J7: a video instead of the picture is refused (got ' + JSON.stringify(r) + ')');

    // refused in every mode while the old Original lot still has boxes
    const WAIT = 'MNGO-261120-01 is not the lot being packed for Atta Original yet (packing takes MNGO-261105-01).';
    for (const mode of ['dry', 'test', 'send']) {
      r = await b.run({ template: FB, lots: NEW, image: PIC, mode, expect: 2 });
      ok(JSON.stringify(r) === JSON.stringify({ ok: false, error: WAIT }), `J7 ${mode}: refused while the old lot still has boxes (got ` + JSON.stringify(r) + ')');
    }
    ok(w.sent.length === 0 && w.logged.length === 0, 'J7: nothing sent or logged while refused');

    // the last 3 old boxes are packed: the new lot is the one packing
    await st.insert([{ item_slug: 'atta-original', qty: -3, type: 'SALE', lot_code: 'MNGO-261105-01', best_before: '2027-02-03', ref: 'MNG-OLD-1@' + iso(AT) }]);
    r = await b.run({ template: FB, lots: NEW, image: PIC, mode: 'dry' });
    ok(r.ok && r.mode === 'dry' && r.to_send === 2 && r.campaign === 'batch_261120', 'J7 dry: allowed once the new lot is packing, campaign batch_261120 (got ' + JSON.stringify(r) + ')');
    ok(r.baked === '20 November' && r.flavours === 'Atta Original and Atta Ajwain', 'J7 dry: shows the date and Flavors the message will carry (got ' + JSON.stringify(r) + ')');
    ok(w.sent.length === 0 && w.logged.length === 0, 'J7 dry: sends and logs nothing');
    ok(!JSON.stringify(r).match(/9190000000|919999900000/), 'J7 dry: no phone numbers in the result');

    // test: only the owner, with the real words, the picture and both buttons
    r = await b.run({ template: FB, lots: NEW, image: PIC, mode: 'test' });
    const t = w.sent[0] || {};
    ok(r.ok && r.sent === 1 && w.sent.length === 1 && t.to === '919999900000' && t.name === FB, 'J7 test: only the owner (got ' + JSON.stringify(r) + ')');
    ok(JSON.stringify(t.params) === JSON.stringify(['Prashant', '20 November', 'Atta Original and Atta Ajwain']), 'J7 test: the owner gets the real words (got ' + JSON.stringify(t.params) + ')');
    ok(JSON.stringify([t.header, t.quickReplies, t.urlIndex, t.urlSuffix]) === JSON.stringify([{ type: 'image', link: PIC }, ['j7_remind'], 1, SHOP('batch_261120')]), 'J7: picture header, quick reply j7_remind at index 0, shop link at index 1 with the batch utm (got ' + JSON.stringify(t) + ')');

    // send: params, campaign logged, nobody twice
    w = W();
    r = await b.run({ template: FB, lots: NEW, image: PIC, mode: 'send', expect: 2 });
    const asha = w.sent.find((s) => s.to === '919000000001') || {};
    ok(r.ok && r.sent === 2 && w.sent[0].to === '919999900000', 'J7 send: the owner first, then Asha (got ' + JSON.stringify(r) + ')');
    ok(JSON.stringify(asha.params) === JSON.stringify(['Asha', '20 November', 'Atta Original and Atta Ajwain']), 'J7 send: params are first name, bake date, Flavors (got ' + JSON.stringify(asha.params) + ')');
    ok(asha.urlSuffix === SHOP('batch_261120') && JSON.stringify(asha.quickReplies) === '["j7_remind"]', 'J7 send: every message has both buttons');
    ok(w.logged.length === 2 && w.logged.every((l) => l.template === FB && l.campaign === 'batch_261120' && l.status === 'sent' && l.wa_message_id), 'J7 send: logged with campaign batch_261120 (got ' + JSON.stringify(w.logged) + ')');
    r = await b.run({ template: FB, lots: NEW, image: PIC, mode: 'dry' });
    ok(r.to_send === 0 && r.already_sent === 2, 'J7: a re-run of the same batch sends nobody twice');

    // campaign can be named by hand; three Flavors read "A, B and C" in pack order whatever order they are typed in
    w = W();
    r = await b.run({ template: FB, lots: NEW, image: PIC, mode: 'test', campaign: 'batch_261120_ncr' });
    ok(r.ok && w.sent[0].urlSuffix === SHOP('batch_261120_ncr'), 'J7: a campaign given by hand is used in the link (got ' + JSON.stringify(w.sent[0]) + ')');
    r = await b.run({ template: FB, lots: 'MNGL-261120-01,' + NEW, image: PIC, mode: 'dry' });
    ok(!r.ok && r.error === 'MNGL-261120-01 is not the lot being packed for Atta Sugar-Lite yet (no Atta Sugar-Lite lot can be packed now).', 'J7: a Flavor with no lot packing is refused by name (got ' + JSON.stringify(r) + ')');
    await lot('atta-lite-sugar', 'MNGL-261120-01', '2026-11-20', '2027-02-18', 25);
    w = W();
    r = await b.run({ template: FB, lots: 'MNGL-261120-01, mnga-261120-01,MNGO-261120-01', image: PIC, mode: 'test' });
    ok(r.ok && JSON.stringify(w.sent[0].params) === JSON.stringify(['Prashant', '20 November', 'Atta Original, Atta Ajwain and Atta Sugar-Lite']), 'J7: three Flavors in pack order, typed codes trimmed and matched in any case (got ' + JSON.stringify(r) + ' ' + JSON.stringify(w.sent[0]) + ')');

    // one bake date per alert; unknown codes, a fresh batch without lots, lots on another template: refused
    r = await b.run({ template: FB, lots: 'MNGO-261120-01,MNGK-261118-01', image: PIC, mode: 'dry' });
    ok(!r.ok && r.error === 'These lots were baked on different days (18 November, 20 November): send one alert per bake date.', 'J7: lots with two bake dates are refused (got ' + JSON.stringify(r) + ')');
    r = await b.run({ template: FB, lots: 'NOPE-1', image: PIC, mode: 'dry' });
    ok(!r.ok && r.error === 'NOPE-1 is not a lot being packed (codes look like MNGO-261120-01).', 'J7: an unknown code is refused (got ' + JSON.stringify(r) + ')');
    r = await b.run({ template: FB, lots: 'MNGO-261120-01; drop', image: PIC, mode: 'dry' });
    ok(!r.ok && /lots must be/.test(r.error || ''), 'J7: lots with odd characters are refused');
    r = await b.run({ template: FB, image: PIC, mode: 'dry' });
    ok(!r.ok && r.error === 'A fresh-batch alert needs lots=<the new lot codes>, e.g. MNGO-261120-01,MNGA-261120-01.', 'J7: munchingo_fresh_batch without lots is refused (got ' + JSON.stringify(r) + ')');
    r = await b.run({ template: T, lots: NEW, image: PIC, mode: 'dry' });
    ok(!r.ok && r.error === 'lots= is only for the fresh-batch template (munchingo_fresh_batch).', 'J7: lots on another template is refused (got ' + JSON.stringify(r) + ')');

    // area: the newest paid order decides; no order yet stays in ("Delivering in Delhi NCR for now")
    const ord = (phone, pin, daysAgo, extra = {}) => ({ order_id: 'MNG-' + phone.slice(-4) + '-' + daysAgo, customer_phone: phone, status: 'paid', created_at: iso(AT - daysAgo * DAY), delivery_address: { raw: 'Somewhere - ' + pin, pincode: pin }, ...extra });
    const areaContacts = [C('919000000001', 'Asha'), C('919000000002', 'Ravi'), C('919000000003', 'Neha'), C('919000000004', 'Om'), C('919000000005', 'Ira')];
    const areaOrders = [
      ord('919000000002', '302001', 5),                                     // Ravi: Jaipur, newest
      ord('919000000003', '302001', 40), ord('919000000003', '110017', 3),  // Neha: Jaipur once, Delhi since
      ord('919000000004', '', 2, { delivery_address: { raw: 'Flat 2, Sector 15, Noida 201301' } }),   // Om: the pincode only in the typed address
      ord('919000000005', '110017', 9), ord('919000000005', '302001', 1, { order_id: 'MNG-TEST-0001' }),   // Ira: a test order is not where she lives
    ];
    w = W({ contacts: areaContacts, orders: areaOrders });
    r = await b.run({ template: FB, lots: NEW, image: PIC, mode: 'dry' });
    ok(r.ok && r.to_send === 5 && r.outside_area === 1, 'J7: Ravi, whose last paid order went to 302001, is left out; the owner, Asha (no order), Neha, Om and Ira stay (got ' + JSON.stringify(r) + ')');
    r = await b.run({ template: FB, lots: NEW, image: PIC, mode: 'send', expect: 5 });
    ok(r.ok && w.sent.length === 5 && !w.sent.some((s) => s.to === '919000000002'), 'J7 send: nothing goes to Ravi');
    process.env.DELIVERY_NATIONWIDE = '1';
    w = W({ contacts: areaContacts, orders: areaOrders });
    r = await b.run({ template: FB, lots: NEW, image: PIC, mode: 'dry' });
    ok(r.to_send === 6 && r.outside_area === 0, 'J7: with DELIVERY_NATIONWIDE=1 Ravi is in the area again (got ' + JSON.stringify(r) + ')');
    delete process.env.DELIVERY_NATIONWIDE;

    // "Something wasn't right" in the last 30 days: no batch alert
    w = W({ contacts: [{ ...C('919000000001', 'Asha'), last_complaint_at: iso(AT - 10 * DAY) }, { ...C('919000000002', 'Ravi'), last_complaint_at: iso(AT - 31 * DAY) }] });
    r = await b.run({ template: FB, lots: NEW, image: PIC, mode: 'dry' });
    ok(r.to_send === 2 && r.complaint === 1, 'J7: a complaint 10 days ago is left out, one 31 days ago is not (got ' + JSON.stringify(r) + ')');

    // J6 wins the last slot: two sends in 30 days and a J6 due within 7 days -> saved_for_reorder
    const NEHA = '919000000003', RAVI = '919000000002', ASHA = '919000000001', OM = '919000000004';
    const rc = (phone, name) => ({ ...C(phone, name, true, 'checkout:2026-10-20'), consent_reminder: true, last_complaint_at: null, last_inbound_at: null });
    const two = (phone, n = 2) => [5, 10].slice(0, n).map((d, i) => ({ phone, template: 'other_' + i, campaign: null, status: 'sent', error: null, sent_at: iso(AT - d * DAY) }));
    const j6Order = (phone, deliveredDaysAgo) => ({ order_id: 'MNG-J6-' + phone.slice(-4), customer_phone: phone, customer_name: 'X', status: 'paid', coupon_code: null, created_at: iso(AT - (deliveredDaysAgo + 4) * DAY), delivered_at: iso(AT - deliveredDaysAgo * DAY), items: [{ slug: 'atta-original', name: 'Atta Original', quantity: 2 }], delivery_address: { raw: 'B-2, Model Town, Delhi - 110009', pincode: '110009' } });
    const j6Contacts = [rc(NEHA, 'Neha'), rc(ASHA, 'Asha'), rc(RAVI, 'Ravi'), rc(OM, 'Om')];
    const j6Orders = [j6Order(NEHA, 18), j6Order(RAVI, 18), j6Order(OM, 49)];   // due in 3 days (2 boxes: day 21); Om: due now, too late by next week
    const j6Sends = () => [...two(NEHA), ...two(ASHA), ...two(RAVI, 1), ...two(OM)];
    const j6World = () => { const sends = j6Sends(); return W({ contacts: j6Contacts, orders: j6Orders, sends, reorder: (ms) => ({ orders: j6Orders, contacts: j6Contacts, sends, eventsByOrder: {}, subscriptionPhones: [], stallOrders: [], inStock: ALL4, nowMs: ms }) }); };
    process.env.JOURNEY_J6_ENABLED = '1';
    w = j6World();
    r = await b.run({ template: FB, lots: NEW, image: PIC, mode: 'dry' });
    ok(r.ok && r.saved_for_reorder === 2 && r.to_send === 3, 'J7: Neha (2 sends, J6 due in 3 days) and Om (2 sends, J6 due today) are saved for the reorder; Asha (2 sends, no J6) and Ravi (1 send, room for both) go, with the owner (got ' + JSON.stringify(r) + ')');
    r = await b.run({ template: FB, lots: NEW, image: PIC, mode: 'send', expect: 3 });
    ok(r.ok && !w.sent.some((s) => s.to === NEHA || s.to === OM) && w.sent.some((s) => s.to === ASHA) && w.sent.some((s) => s.to === RAVI), 'J7 send: nothing goes to the two saved for their reorder');
    // R34: a J6 due today is saved too, even when its window has closed by next week (dueReorders at now as well as now + 7 days)
    { const sends = two(OM); w = W({ contacts: [rc(OM, 'Om')], orders: [j6Order(OM, 49)], sends, reorder: (ms) => ({ orders: [j6Order(OM, 49)], contacts: [rc(OM, 'Om')], sends, eventsByOrder: {}, subscriptionPhones: [], stallOrders: [], inStock: ALL4, nowMs: ms }) }); }
    r = await b.run({ template: FB, lots: NEW, image: PIC, mode: 'dry' });
    ok(r.ok && r.saved_for_reorder === 1 && r.to_send === 1, 'R34 due today: a contact with one slot left whose J6 is due today (too late by next week) is saved_for_reorder (got ' + JSON.stringify(r) + ')');
    delete process.env.JOURNEY_J6_ENABLED;
    w = j6World();
    r = await b.run({ template: FB, lots: NEW, image: PIC, mode: 'dry' });
    ok(r.ok && r.saved_for_reorder === 0 && r.to_send === 5, 'J7: with J6 switched off no slot is saved for a reminder that will not go (got ' + JSON.stringify(r) + ')');
    r = await b.run({ template: FB, lots: NEW, image: PIC, mode: 'send', expect: 5 });
    ok(r.ok && w.sent.some((s) => s.to === NEHA) && w.sent.some((s) => s.to === OM), 'R34 flag off: contacts with one slot left and a J6 due get the J7 (JOURNEY_J6_ENABLED unset)');
  }

  // wiring
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(/\/internal\/broadcast/.test(srv) && /utils\/broadcast/.test(srv), 'server exposes /internal/broadcast');
  ok(/noteStatus/.test(srv) && /s\.errors/.test(srv), 'the webhook passes delivery statuses (with their errors) to broadcast.noteStatus and logs the error');
  const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'broadcast.yml'), 'utf8');
  ok(/workflow_dispatch/.test(wf) && !/schedule/.test(wf) && /DIGEST_SECRET/.test(wf), 'the workflow only runs by hand and uses the secret');
  const wa = require('../utils/whatsapp');
  ok(typeof wa.sendTemplateWithHeader === 'function', 'whatsapp.js can send a template with a media header');
  const db = fs.readFileSync(path.join(__dirname, '..', 'utils', 'database.js'), 'utf8');
  ok(/listMarketingContacts/.test(db) && /insertMarketingSend/.test(db) && /listMarketingSends/.test(db), 'database helpers exist');
  ok(/async function listPaidOrderAddresses[\s\S]{0,400}\.range\(/.test(db) && /listPaidOrderAddresses,/.test(db), 'database: every paid order\'s address, paged past the 1000-row cap, is exported');
  ok(/lots:\s*q\.lots\s*\|\|\s*''/.test(srv) && /campaign:\s*q\.campaign\s*\|\|\s*''/.test(srv), 'the server passes lots= and campaign= through to the broadcast');
  ok(/\n\s+lots:\n\s+description:/.test(wf) && /\n\s+campaign:\n\s+description:/.test(wf), 'the workflow has lots and campaign inputs');
  ok(/LOTS: \$\{\{ inputs\.lots \}\}/.test(wf) && /CAMPAIGN: \$\{\{ inputs\.campaign \}\}/.test(wf) && /"lots=\$LOTS"/.test(wf) && /"campaign=\$CAMPAIGN"/.test(wf), 'the workflow sends lots and campaign to /internal/broadcast');

  console.log(`broadcast-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
