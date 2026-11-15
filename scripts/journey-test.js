'use strict';
// J4 (growth journey, 16 Nov 2026): a buyer taps a button on the day-4 check-in and the bot answers inside the 24-hour window the
// tap opens. Loved it -> the consent ask, or the reorder cart for a consented buyer; Not quite -> one question, the answer saved
// and emailed; Something wasn't right -> apology, Prashant alerted, the next message (photo too) forwarded to him. Only the
// order's own buyer gets an answer; the first tap per order is claimed; a later tap gets a short thanks and no second link.
//   node scripts/journey-test.js
const fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// The approved words, verbatim (spec §11 and table C-W in global-constraints.md).
const W = {
  ask: "Glad to hear it. You've unlocked the good stuff. May I message you when a fresh batch leaves Bikaner, when a new Flavor lands, or a few weeks after an order, when your box is probably running low? At most 3 a month. Reply STOP any time and it stops.",
  r1: "Glad to hear it. You've unlocked the good stuff.",
  consented: (f) => `Thank you. Your usual is ready in one tap whenever you want it, with one ${f} added to try.`,
  notQuite: 'Thanks for being honest. What would have made it right for you? One line is enough. I read every reply.',
  wrong: "I'm sorry. Tell me what happened, and send a photo if a box arrived broken. I'll make it right, and I'll reply myself.",
  c3: "Done. A few weeks after each order, I'll send one nudge when your box is probably running low. Reply STOP any time.",
  c7: "Done, you're on the list.",
  c9: 'One more thing: may I also send one nudge when your box is probably running low?',
  c10: 'No problem. Thank you for telling me how it went.',
  c11: "Thank you. It's with me now, and I'll reply myself.",
  c12: 'Thank you. I read every one myself.',
  c13: 'No problem. Thank you for telling me how it went.',
};
const ASHA = '919810000001', OTHER = '919810000002', OWNER = '919999900000', OID = 'MNG-AAAA-1111';
const START = Date.parse('2026-11-16T06:00:00Z');   // 11:30 IST, 16 Nov
const DAY = 86400000;
const LINK = 'https://munchingo.com/cart?add=atta-original:2,atta-kesari&utm_source=whatsapp&utm_medium=journey&utm_campaign=j4_reorder';
const FLAVOR_NAMES = /Original|Kesari|Ajwain|Sugar-Lite/;

const journey = require('../utils/journey');
const contacts = require('../utils/contacts');
const suggestions = require('../utils/suggestions');

function world({ contact, orders, inStock, owner = OWNER, lang = 'en' } = {}) {
  let t = START;
  const rows = {}, waits = {}, events = [], sent = [], mails = [], saved = [], calls = [];
  if (contact) rows[ASHA] = { phone: ASHA, first_source: 'fair:2026-10-01', ...contact };
  const ords = orders || [{ order_id: OID, customer_phone: ASHA, customer_name: 'Asha Rao', status: 'paid', created_at: '2026-11-08T05:00:00Z', delivered_at: '2026-11-12T05:00:00Z', items: [{ slug: 'atta-original', name: 'Atta Original', quantity: 2 }], delivery_address: { raw: 'B-2, Model Town, Delhi, Delhi - 110009', pincode: '110009' } }];
  const log = (n) => calls.push(n);
  const db = {
    getOrder: async (id) => { log('getOrder'); return ords.find((o) => o.order_id === id) || null; },
    getRecentOrders: async (phone, n = 3) => { log('getRecentOrders'); return ords.filter((o) => o.customer_phone === phone).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, n); },
    // Like Postgres with the unique indexes: one review ask / reminder / journey tap per order.
    claimOrderEvent: async (ev) => { log('claim'); if (['review_requested', 'review_reminded', 'journey_tap'].includes(ev.event) && events.some((e) => e.order_id === ev.order_id && e.event === ev.event)) return false; events.push(ev); return true; },
    logOrderEvent: async (ev) => { log('logOrderEvent'); events.push(ev); },
    getContact: async (phone) => { log('getContact'); return rows[phone] ? { ...rows[phone] } : null; },
    insertContact: async (row) => { log('insertContact'); if (rows[row.phone]) throw new Error('duplicate key'); if (!row.first_source) throw new Error('null first_source'); rows[row.phone] = { ...row }; return rows[row.phone]; },
    updateContact: async (phone, fields) => { log('updateContact'); if (!rows[phone]) return null; rows[phone] = { ...rows[phone], ...fields }; return rows[phone]; },
    setSuggestionWait: async (phone, at, kind = 'suggestion', orderId = null) => { log('setWait'); waits[phone] = { phone, asked_at: at, kind, order_id: orderId }; },
    getSuggestionWait: async (phone) => { log('getWait'); return waits[phone] ? { ...waits[phone] } : null; },
    clearSuggestionWait: async (phone) => { log('clearWait'); delete waits[phone]; },
    insertSuggestion: async (row) => { log('insertSuggestion'); const r = { id: saved.length + 1, ...row }; saved.push(r); return r; },
  };
  const wa = {
    sendText: async (to, text) => { sent.push({ to, kind: 'text', text }); },
    sendButtons: async (to, body, buttons) => { sent.push({ to, kind: 'buttons', text: body, buttons }); },
    sendVideo: async (to, link, caption) => { sent.push({ to, kind: 'video', link, caption }); },
  };
  const mail = {
    sendHumanHandoffAlert: async (x) => { mails.push({ kind: 'handoff', ...x }); },
    sendSuggestionAlert: async (x) => { mails.push({ kind: 'suggestion', ...x }); },
  };
  const now = () => t;
  journey.setDeps({ db, wa, mail, now, ownerPhone: () => owner, inStock: async () => new Set(inStock || ['atta-original', 'atta-kesari', 'atta-ajwain', 'atta-lite-sugar']), lang: async () => lang });
  contacts.setDeps({ db, wa, now });
  suggestions.setDeps({ db, wa, mail, now });
  return { rows, waits, events, sent, mails, saved, calls, ords, db, wa, tick: (ms) => { t += ms; }, toBuyer: () => sent.filter((s) => s.to === ASHA), toOwner: () => sent.filter((s) => s.to === OWNER) };
}

(async () => {
  delete process.env.JOURNEY_UNLOCK_VIDEO_URL;
  const R = journey.REPLIES.en;

  // ── the words are the approved words (line breaks allowed, never other words) ──
  ok(flat(R.askConsent) === W.ask, 'J4 consent ask = §11 "Loved it (not consented)"');
  ok(flat(R.lovedNoAsk) === W.r1, 'R1: the first two sentences of the §11 text');
  ok(flat(R.usualWithTry('Atta Kesari')) === W.consented('Atta Kesari'), '§11 "Loved it (consented)"');
  ok(flat(R.notQuite) === W.notQuite && flat(R.wrong) === W.wrong, '§11 Not quite / Something wasn\'t right');
  ok(flat(R.remindDone) === W.c3 && flat(R.onList) === W.c7 && flat(R.askReminder) === W.c9 && flat(R.alreadyAnswered) === W.c10, 'C3, C7, C9, C10');
  ok(flat(R.complaintThanks) === W.c11 && flat(R.notQuiteThanks) === W.c12 && flat(R.declined) === W.c13, 'C11, C12, C13');
  ok(/\n/.test(R.askConsent) && /\n/.test(R.lovedNoAsk) && /\n/.test(R.wrong), 'multi-sentence replies are broken into WhatsApp lines');
  ok(Object.keys(journey.REPLIES).join() === 'en', 'one REPLIES map, English only for now (Hindi is data later)');
  const titles = [...journey.BUTTONS.consent, ...journey.BUTTONS.reminder];
  ok(titles.every((b) => b.title.length <= 20), 'every button title fits WhatsApp\'s 20 characters');
  ok(JSON.stringify(journey.BUTTONS.consent) === JSON.stringify([{ id: 'j4_yes', title: 'Yes, keep me posted' }, { id: 'j4_no', title: 'No thanks' }]), 'consent buttons j4_yes / j4_no');
  ok(JSON.stringify(journey.BUTTONS.reminder) === JSON.stringify([{ id: 'j4_remind_yes', title: 'Yes, remind me' }, { id: 'j4_remind_no', title: 'No thanks' }]), 'reminder buttons j4_remind_yes / j4_remind_no');

  // ── any other id is not ours, and costs no database call ──
  let w = world();
  for (const id of ['btn_products', 'optin_yes', 'j3:bogus:' + OID, 'j3:loved:', 'j4_maybe', '', null]) ok(await journey.handleTap(ASHA, id, 'Asha') === false, 'not a journey id: ' + id);
  ok(w.calls.length === 0 && w.sent.length === 0, 'unknown ids touch nothing');

  // ── Review Focus 2: someone else's order reveals nothing ──
  w = world();
  ok(await journey.handleTap(OTHER, 'j3:loved:' + OID, 'Ravi') === false, 'a tap on an order from another phone returns false (the normal menu answers)');
  ok(await journey.handleTap(OTHER, 'j3:wrong:' + OID, 'Ravi') === false, 'also for Something wasn\'t right');
  ok(await journey.handleTap(ASHA, 'j3:loved:MNG-ZZZZ-9999', 'Asha') === false, 'an order that does not exist returns false');
  ok(w.sent.length === 0 && w.mails.length === 0, 'nothing is sent to anyone');
  ok(!w.sent.concat(w.mails).some((s) => JSON.stringify(s).includes(OID) || FLAVOR_NAMES.test(JSON.stringify(s))), 'no order id and no Flavor name leaves the bot');
  ok(w.events.length === 0 && Object.keys(w.waits).length === 0 && Object.keys(w.rows).length === 0, 'and nothing is claimed, waited on or saved');
  w = world({ orders: [{ order_id: OID, customer_phone: '9810000001', status: 'paid', created_at: '2026-11-08T05:00:00Z', items: [{ slug: 'atta-original', quantity: 2 }], delivery_address: { pincode: '110009' } }] });
  ok(await journey.handleTap(ASHA, 'j3:meh:' + OID, 'Asha') === true, 'the same number stored without 91 is still the buyer (last 10 digits)');

  // ── Loved it from a buyer who has not consented: the ask, with buttons, no link ──
  w = world();
  ok(await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha') === true, 'Loved it is handled');
  let b = w.toBuyer();
  ok(b.length === 1 && b[0].kind === 'buttons' && b[0].text === R.askConsent, 'the §11 consent ask is sent (' + JSON.stringify(b) + ')');
  ok(JSON.stringify(b[0].buttons) === JSON.stringify(journey.BUTTONS.consent), 'with Yes, keep me posted / No thanks');
  ok(!w.sent.some((s) => /cart\?|shop\?/.test(s.text || '')), 'no link before consent');
  ok(w.events.length === 1 && w.events[0].event === 'journey_tap' && w.events[0].order_id === OID && w.events[0].meta.kind === 'loved', 'the first tap is claimed as journey_tap { kind: loved }');

  // ── Yes: consent saved word for word, then C7, then the cart ──
  ok(await journey.handleTap(ASHA, 'j4_yes', 'Asha') === true, 'j4_yes is handled');
  const c = w.rows[ASHA];
  ok(c && c.consent_marketing === true && c.consent_reminder === true, 'Yes saves marketing AND reminder consent');
  ok(c.consent_text === R.askConsent, 'consent_text is the exact question that was sent');
  ok(c.consent_at === new Date(START).toISOString() && c.first_source === 'journey:2026-11-16' && c.last_source === 'journey:2026-11-16', 'with its time and source journey:<IST day> (' + JSON.stringify(c) + ')');
  b = w.toBuyer().slice(1);
  ok(b.length === 2 && flat(b[0].text) === W.c7, 'C7 first');
  ok(b[1].kind === 'text' && b[1].text.includes(LINK), 'then the reorder cart: Original x2 + Kesari to try, utm j4_reorder (' + (b[1] && b[1].text) + ')');
  ok(flat(b[1].text).startsWith(W.consented('Atta Kesari')), 'with the §11 consented words naming the try Flavor');

  // ── Review Focus 1: a second Loved it sends no second link; Something wasn't right after Loved it still reaches Prashant ──
  const before = w.sent.length;
  ok(await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha') === true, 'a second Loved it is handled');
  b = w.sent.slice(before);
  ok(b.length === 1 && flat(b[0].text) === W.c10, 'it gets C10 only');
  ok(!b.some((s) => /cart\?/.test(s.text || '')), 'and no second link');
  ok(await journey.handleTap(ASHA, 'j3:meh:' + OID, 'Asha') === true && flat(w.sent[w.sent.length - 1].text) === W.c10 && !w.waits[ASHA], 'a later Not quite also gets C10, no question');
  const n0 = w.sent.length;
  ok(await journey.handleTap(ASHA, 'j3:wrong:' + OID, 'Asha') === true, 'Something wasn\'t right after Loved it is handled');
  const ownerMsg = w.toOwner().map((s) => s.text).join('\n');
  ok(ownerMsg.includes(OID) && ownerMsg.includes('Asha') && ownerMsg.includes('+' + ASHA) && ownerMsg.includes('https://wa.me/' + ASHA), 'Prashant gets a WhatsApp alert with the order, name, number and wa.me link (' + ownerMsg + ')');
  ok(w.mails.some((m) => m.kind === 'handoff' && m.customerPhone === ASHA && String(m.orderLine).includes(OID)), 'and an email alert');
  ok(w.sent.slice(n0).some((s) => s.to === ASHA && flat(s.text) === W.wrong), 'the buyer gets the §11 apology');
  ok(w.waits[ASHA] && w.waits[ASHA].kind === 'complaint' && w.waits[ASHA].order_id === OID, 'a complaint wait is set for that order');
  ok(w.events.some((e) => e.event === 'journey_complaint' && e.order_id === OID), 'the order timeline logs journey_complaint');
  ok(w.rows[ASHA].last_complaint_at === new Date(START).toISOString(), 'the contact gets last_complaint_at (no marketing for 30 days)');

  // ── Review Focus 4: the next message, a photo, goes to Prashant ──
  const o0 = w.toOwner().length, m0 = w.mails.length;
  ok(await journey.captureReply(ASHA, 'Asha', 'image', '') === true, 'a photo after Something wasn\'t right is captured');
  const fwd = w.toOwner().slice(o0).map((s) => s.text).join('\n');
  ok(fwd.includes('[sent a photo]') && fwd.includes(OID) && fwd.includes('https://wa.me/' + ASHA), 'forwarded to Prashant with [sent a photo], the order id and the wa.me link (' + fwd + ')');
  ok(w.mails.slice(m0).some((m) => m.kind === 'handoff' && String(m.message).includes('[sent a photo]') && String(m.orderLine).includes(OID)), 'and emailed');
  ok(flat(w.toBuyer().pop().text) === W.c11, 'the buyer is thanked with C11');
  ok(!w.waits[ASHA], 'the wait is cleared');
  ok(await journey.captureReply(ASHA, 'Asha', 'text', 'hi') === false, 'the message after that goes to the bot as usual');

  // ── a typed complaint is quoted; STOP and other waits are left alone; 24 h ──
  w = world({ contact: { consent_marketing: true } });
  await journey.handleTap(ASHA, 'j3:wrong:' + OID, 'Asha');
  ok(await journey.captureReply(ASHA, 'Asha', 'text', 'STOP') === false && w.waits[ASHA], 'STOP is never taken as the complaint; the wait stays');
  ok(await journey.captureReply(ASHA, 'Asha', 'reaction', '') === false && w.waits[ASHA], 'a reaction is not an answer');
  ok(await journey.captureReply(ASHA, 'Asha', 'text', 'The box was crushed') === true, 'typed complaint captured');
  ok(w.toOwner().pop().text.includes('"The box was crushed"'), 'the text is quoted to Prashant');
  ok(!w.sent.some((s) => s.kind === 'video'), 'Something wasn\'t right never carries a video');
  w = world();
  await journey.handleTap(ASHA, 'j3:wrong:' + OID, 'Asha');
  ok(Object.keys(w.rows).length === 0, 'Something wasn\'t right never creates a contact (last_complaint_at is update only)');
  w.tick(25 * 3600000);
  const o1 = w.toOwner().length;
  ok(await journey.captureReply(ASHA, 'Asha', 'text', 'where is my refund') === false, 'after 24 h the next message is not taken');
  ok(!w.waits[ASHA] && w.toOwner().length === o1, 'the stale wait is cleared and nothing is forwarded');
  w = world();
  await w.db.setSuggestionWait(ASHA, new Date(START).toISOString());
  ok(await journey.captureReply(ASHA, 'Asha', 'text', 'make a jaggery one') === false && w.waits[ASHA], 'a suggestion wait belongs to suggestions.js: not taken, left in place');
  w = world({ owner: '' });
  await journey.handleTap(ASHA, 'j3:wrong:' + OID, 'Asha');
  ok(w.toOwner().length === 0 && w.mails.some((m) => m.kind === 'handoff'), 'no OWNER_PHONE: the email still goes');

  // ── Not quite for me: one question, the answer saved as feedback and emailed ──
  w = world();
  ok(await journey.handleTap(ASHA, 'j3:meh:' + OID, 'Asha') === true && flat(w.toBuyer()[0].text) === W.notQuite, 'Not quite gets the §11 question');
  ok(w.waits[ASHA] && w.waits[ASHA].kind === 'not_quite' && w.waits[ASHA].order_id === OID, 'a not_quite wait is set');
  ok(w.toOwner().length === 0 && w.mails.length === 0, 'nobody is alerted yet');
  ok(await journey.captureReply(ASHA, 'Asha', 'text', 'Too sweet for me') === true, 'the answer is captured');
  ok(w.saved.length === 1 && w.saved[0].kind === 'feedback' && w.saved[0].text === '[check-in ' + OID + '] Too sweet for me', 'saved as feedback with the check-in order (' + JSON.stringify(w.saved) + ')');
  ok(w.mails.some((m) => m.kind === 'suggestion' && m.text === '[check-in ' + OID + '] Too sweet for me' && m.order_id === OID), 'and emailed to Prashant');
  ok(flat(w.toBuyer().pop().text) === W.c12 && !w.waits[ASHA], 'thanked with C12, wait cleared');
  w = world();
  await journey.handleTap(ASHA, 'j3:meh:' + OID, 'Asha');
  await journey.captureReply(ASHA, 'Asha', 'video', 'see');
  ok(w.saved[0].text === '[check-in ' + OID + '] [sent a video] "see"', 'media in a not-quite answer is noted (' + (w.saved[0] && w.saved[0].text) + ')');
  ok(!w.sent.some((s) => s.kind === 'video'), 'Not quite never carries a video');

  // ── Loved it from a consented buyer ──
  w = world({ contact: { consent_marketing: true, consent_reminder: false } });
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  b = w.toBuyer();
  ok(b.length === 2 && b[0].kind === 'text' && b[0].text.includes(LINK) && flat(b[0].text).startsWith(W.consented('Atta Kesari')), 'consented, no reminder yes: the cart first');
  ok(b[1].kind === 'buttons' && flat(b[1].text) === W.c9 && JSON.stringify(b[1].buttons) === JSON.stringify(journey.BUTTONS.reminder), 'then C9 with Yes, remind me / No thanks');
  w = world({ contact: { consent_marketing: true, consent_reminder: true } });
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  b = w.toBuyer();
  ok(b.length === 1 && b[0].text.includes(LINK), 'covers reminders: the cart only, utm_campaign=j4_reorder');
  w = world({ contact: { consent_marketing: true, consent_reminder: true }, orders: [{ order_id: OID, customer_phone: ASHA, status: 'paid', created_at: '2026-11-08T05:00:00Z', items: [{ slug: 'full-range-set', quantity: 1 }], delivery_address: { pincode: '110009' } }] });
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  b = w.toBuyer();
  ok(b.length === 1 && flat(b[0].text).startsWith('Thank you. Your usual is ready in one tap whenever you want it.') && !/added to try/.test(b[0].text) && b[0].text.includes('cart?add=atta-original:1,atta-kesari:1,atta-ajwain:1,atta-lite-sugar:1&'), 'everything tried: the usual again, without the try words');
  w = world({ contact: { consent_marketing: true, consent_reminder: true }, inStock: [] });
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  b = w.toBuyer();
  ok(b.length === 1 && flat(b[0].text) === W.r1 && !/https?:/.test(b[0].text), 'nothing in stock: thanks only (R1 words), no link');
  w = world({ contact: { consent_marketing: true, consent_reminder: false }, orders: [{ order_id: OID, customer_phone: ASHA, status: 'paid', created_at: '2026-11-08T05:00:00Z', items: [{ slug: 'atta-original', quantity: 2 }], delivery_address: { raw: 'A-1, Civil Lines, Jaipur, Rajasthan - 302006' } }] });
  delete process.env.DELIVERY_NATIONWIDE;
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  b = w.toBuyer();
  ok(b.length === 1 && flat(b[0].text) === W.r1, 'last order outside Delhi NCR: no reorder link and no reminder ask, only the thanks');
  w = world({ contact: { consent_marketing: true, consent_reminder: true }, lang: 'hi' });
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  ok(flat(w.toBuyer()[0].text).startsWith(W.consented('Atta Kesari')), 'a Hindi chooser gets English until Hindi words are approved');

  // ── Loved it after STOP, or after No thanks within 90 days: R1 only ──
  w = world({ contact: { consent_marketing: false, consent_reminder: false, consent_text: 'STOP', consent_at: '2026-11-01T00:00:00Z' } });
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  b = w.toBuyer();
  ok(b.length === 1 && b[0].kind === 'text' && b[0].text === R.lovedNoAsk, 'after STOP: exactly "Glad to hear it. You\'ve unlocked the good stuff." (R1)');
  w = world({ contact: { consent_marketing: false, journey_declined_at: new Date(START - 10 * DAY).toISOString() } });
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  ok(w.toBuyer().length === 1 && w.toBuyer()[0].text === R.lovedNoAsk, 'declined 10 days ago: R1, not asked again');
  w = world({ contact: { consent_marketing: false, journey_declined_at: new Date(START - 100 * DAY).toISOString() } });
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  ok(w.toBuyer().length === 1 && w.toBuyer()[0].text === R.askConsent, 'declined 100 days ago: asked again');

  // ── No thanks, the reminder buttons, Remind me to reorder ──
  w = world();
  ok(await journey.handleTap(ASHA, 'j4_no', 'Asha') === true && flat(w.toBuyer()[0].text) === W.c13, 'j4_no gets C13');
  ok(w.rows[ASHA] && w.rows[ASHA].journey_declined_at === new Date(START).toISOString() && w.rows[ASHA].consent_marketing !== true && w.rows[ASHA].first_source === 'journey:2026-11-16', 'and the No is stored (journey_declined_at), with no consent');
  w = world({ contact: { consent_marketing: true, consent_reminder: false, consent_text: 'v1' } });
  ok(await journey.handleTap(ASHA, 'j4_remind_yes', 'Asha') === true, 'j4_remind_yes is handled');
  ok(w.rows[ASHA].consent_reminder === true && w.rows[ASHA].consent_text === R.askReminder + ' | Yes, remind me' && w.rows[ASHA].consent_marketing === true, 'reminder consent saved with C9 + " | Yes, remind me"');
  ok(w.sent.length === 0, 'j4_remind_yes sends nothing (table: no reply)');
  w = world({ contact: { consent_marketing: true, consent_reminder: false, consent_text: 'v1' } });
  ok(await journey.handleTap(ASHA, 'j4_remind_no', 'Asha') === true && w.sent.length === 0 && w.rows[ASHA].consent_reminder === false && w.rows[ASHA].consent_text === 'v1', 'j4_remind_no: handled, nothing sent, nothing changed');
  w = world({ contact: { consent_marketing: false, consent_text: 'STOP' } });
  ok(await journey.handleTap(ASHA, 'j4_remind_yes', 'Asha') === false && w.rows[ASHA].consent_reminder === undefined, 'j4_remind_yes without marketing consent changes nothing');
  w = world({ contact: { consent_marketing: true, consent_reminder: false } });
  ok(await journey.handleTap(ASHA, 'j7_remind', 'Asha') === true, 'j7_remind is handled for a consented contact');
  ok(w.rows[ASHA].consent_reminder === true && w.rows[ASHA].consent_text === 'j7_remind: Remind me to reorder', 'it saves reminder consent with its own text');
  ok(w.toBuyer().length === 1 && flat(w.toBuyer()[0].text) === W.c3, 'and replies C3');
  for (const contact of [undefined, { consent_marketing: false }]) {
    w = world({ contact });
    ok(await journey.handleTap(ASHA, 'j7_remind', 'Asha') === false && w.sent.length === 0 && (!w.rows[ASHA] || w.rows[ASHA].consent_reminder === undefined), 'j7_remind without marketing consent: false, nothing saved (' + JSON.stringify(contact) + ')');
  }

  // ── a consent that could not be saved is never confirmed ──
  w = world();
  w.db.insertContact = async () => { throw new Error('db down'); };
  await journey.handleTap(ASHA, 'j4_yes', 'Asha');
  ok(w.toBuyer().length === 1 && /didn't go through/.test(w.toBuyer()[0].text) && !w.sent.some((s) => /on the list|cart\?/.test(s.text || '')), 'a Yes that failed to save: the try-again line, no C7, no link');

  // ── the unlock video (owner, 16 Nov): before every first Loved it reply, never otherwise ──
  const VID = 'https://cdn.example.com/unlock.mp4';
  const firstLovedCases = [
    ['not consented', {}],
    ['consented, no reminder', { contact: { consent_marketing: true, consent_reminder: false } }],
    ['covers reminders', { contact: { consent_marketing: true, consent_reminder: true } }],
    ['STOP (R1)', { contact: { consent_marketing: false, consent_text: 'STOP' } }],
  ];
  process.env.JOURNEY_UNLOCK_VIDEO_URL = VID;
  for (const [label, opts] of firstLovedCases) {
    w = world(opts);
    await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
    b = w.toBuyer();
    ok(b.length >= 2 && b[0].kind === 'video' && b[0].link === VID && !b[0].caption, 'video first, no caption: ' + label);
    ok(b[1].kind !== 'video' && b.slice(1).every((s) => s.kind !== 'video'), 'then the words, exactly as without the video: ' + label);
  }
  w = world();
  w.wa.sendVideo = async () => { throw new Error('media fetch failed'); };
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  ok(w.toBuyer().length === 1 && w.toBuyer()[0].text === R.askConsent, 'a video that fails to send never blocks the reply');
  w = world();
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  const v0 = w.sent.length;
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  ok(!w.sent.slice(v0).some((s) => s.kind === 'video'), 'a repeat Loved it gets no video');
  for (const k of ['meh', 'wrong']) {
    w = world();
    await journey.handleTap(ASHA, `j3:${k}:${OID}`, 'Asha');
    ok(!w.sent.some((s) => s.kind === 'video'), `${k} never sends a video`);
  }
  w = world();
  await journey.handleTap(ASHA, 'j4_yes', 'Asha');
  ok(!w.sent.some((s) => s.kind === 'video'), 'Yes, keep me posted gets no second video');
  process.env.JOURNEY_UNLOCK_VIDEO_URL = '   ';
  w = world();
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  ok(w.toBuyer().length === 1 && w.toBuyer()[0].kind === 'buttons', 'a blank JOURNEY_UNLOCK_VIDEO_URL: only the words');
  delete process.env.JOURNEY_UNLOCK_VIDEO_URL;
  w = world();
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  ok(w.toBuyer().length === 1 && w.toBuyer()[0].kind === 'buttons', 'JOURNEY_UNLOCK_VIDEO_URL unset: only the words');

  // ── whatsapp.js sendVideo: same shape as sendImage, no live call ──
  {
    const wa = require('../utils/whatsapp'), axios = require('axios'), realPost = axios.post;
    let body = null;
    axios.post = async (url, payload) => { body = payload; return { data: { messages: [{ id: 'x' }] } }; };
    await wa.sendVideo(ASHA, VID);
    ok(body && body.type === 'video' && body.to === ASHA && body.video.link === VID && body.video.caption === undefined && body.messaging_product === 'whatsapp', 'sendVideo posts a video message by link (' + JSON.stringify(body) + ')');
    await wa.sendVideo(ASHA, VID, 'hi');
    ok(body.video.caption === 'hi', 'sendVideo passes a caption when given');
    axios.post = realPost;
  }

  // ── wiring ──
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const iTouch = srv.indexOf("contacts').touchInbound"), iCap = srv.indexOf("journey').captureReply"), iFwd = srv.indexOf("broadcastReplies').maybeForward"), iSwitch = srv.indexOf('switch (type)');
  ok(iTouch > 0 && iCap > iTouch && iCap < iFwd && iFwd < iSwitch, 'server.js: touchInbound, then the check-in capture, then the broadcast-reply forward, then the bot');
  const capLine = srv.slice(iCap - 200, iCap + 200);
  ok(/replyText/.test(capLine) && /return;/.test(capLine), 'the capture gets text or a media caption and stops the bot when it took the message');
  const h = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'messageHandler.js'), 'utf8');
  const rt = h.slice(h.indexOf('async function routeText('));
  const jStop = rt.indexOf('contacts.isStop('), jCap = rt.indexOf('journey.captureReply('), jSug = rt.indexOf('suggestions.capture(');
  ok(jStop > 0 && jCap > jStop && jCap < jSug, 'routeText: STOP, then a check-in answer, then a suggestion');
  const ri = h.slice(h.indexOf('async function routeInteractive('));
  ok(ri.indexOf('journey.handleTap(') > 0 && ri.indexOf('journey.handleTap(') < ri.indexOf('switch (buttonId)'), 'routeInteractive: journey taps before the switch (whose default is the welcome)');
  ok(/require\('\.\.\/utils\/journey'\)/.test(h), 'messageHandler loads utils/journey');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'growth_journey_migration.sql'), 'utf8').toLowerCase();
  ok(/create unique index if not exists order_events_journey_tap_once on order_events \(order_id, event\) where event = 'journey_tap'/.test(sql), 'the migration makes journey_tap once per order (claimOrderEvent needs a unique index to return false)');

  console.log(`journey-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log(`journey-test: ${pass} passed, ${fail} failed`); process.exit(1); });
