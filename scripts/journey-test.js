'use strict';
// J4 (growth journey, 16 Nov 2026): a buyer taps a button on the day-4 check-in and the bot answers inside the 24-hour window the
// tap opens. Loved it -> the consent ask, or the reorder cart for a consented buyer; Not quite -> one question, the answer saved
// and emailed; Something wasn't right -> apology, Prashant alerted, the next message (photo too) forwarded to him. Only the
// order's own buyer gets an answer; the first tap per order is claimed; a later tap gets a short thanks and no second link.
//   node scripts/journey-test.js
const fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const show = (x) => JSON.stringify(x);

// The approved words, verbatim (spec §11 and table C-W in global-constraints.md), as one line each.
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
  c15: 'Thank you. Your next Set is ready to build whenever you want it.',
};
// EXACTLY what the buyer is sent: the same words with WhatsApp line breaks (ruling R15). Every send below is compared to these.
const S = {
  ask: "Glad to hear it.\nYou've unlocked the good stuff.\n\nMay I message you when a fresh batch leaves Bikaner, when a new Flavor lands, or a few weeks after an order, when your box is probably running low?\n\nAt most 3 a month. Reply STOP any time and it stops.",
  r1: "Glad to hear it.\nYou've unlocked the good stuff.",
  consented: (f) => `Thank you.\nYour usual is ready in one tap whenever you want it, with one ${f} added to try.`,
  usual: 'Thank you.\nYour usual is ready in one tap whenever you want it.',   // §11 consented, try clause removed (accepted subset)
  notQuite: 'Thanks for being honest.\nWhat would have made it right for you?\n\nOne line is enough. I read every reply.',
  wrong: "I'm sorry.\nTell me what happened, and send a photo if a box arrived broken.\n\nI'll make it right, and I'll reply myself.",
  c3: "Done.\nA few weeks after each order, I'll send one nudge when your box is probably running low.\n\nReply STOP any time.",
  c7: "Done, you're on the list.",
  c9: 'One more thing: may I also send one nudge when your box is probably running low?',
  c10: 'No problem.\nThank you for telling me how it went.',
  c11: "Thank you.\nIt's with me now, and I'll reply myself.",
  c12: 'Thank you.\nI read every one myself.',
  c13: 'No problem.\nThank you for telling me how it went.',
  c15: 'Thank you.\nYour next Set is ready to build whenever you want it.',
  failed: "Sorry, that didn't go through on our side. Please try again in a minute.",
};
const reflow = (s) => s.replace(/\n+/g, ' ');   // only to prove S is W with line breaks; never used on a sent message
const ASHA = '919810000001', OTHER = '919810000002', OWNER = '919999900000', OID = 'MNG-AAAA-1111';
const START = Date.parse('2026-11-16T06:00:00Z');   // 11:30 IST, 16 Nov
const DAY = 86400000;
const LINK = 'https://munchingo.com/cart?add=atta-original:2,atta-kesari&utm_source=whatsapp&utm_medium=journey&utm_campaign=j4_reorder';
const CART = S.consented('Atta Kesari') + '\n\n' + LINK;   // the whole consented message
const FLAVOR_NAMES = /Original|Kesari|Ajwain|Sugar-Lite/;
const VID = 'https://cdn.example.com/unlock.mp4';

const journey = require('../utils/journey');
const contacts = require('../utils/contacts');
const suggestions = require('../utils/suggestions');

let seq = 0;
const wamid = () => ({ messages: [{ id: 'wamid.T' + (++seq) }] });
function world({ contact, orders, inStock, owner = OWNER, lang = 'en' } = {}) {
  let t = START;
  const media = {}, rows = {}, waits = {}, events = [], sent = [], mails = [], saved = [], calls = [], pending = {};
  if (contact) rows[ASHA] = { phone: ASHA, first_source: 'fair:2026-10-01', ...contact };
  const ords = orders || [{ order_id: OID, customer_phone: ASHA, customer_name: 'Asha Rao', status: 'paid', created_at: '2026-11-08T05:00:00Z', delivered_at: '2026-11-12T05:00:00Z', items: [{ slug: 'atta-original', name: 'Atta Original', quantity: 2 }], delivery_address: { raw: 'B-2, Model Town, Delhi, Delhi - 110009', pincode: '110009' } }];
  const log = (n) => calls.push(n);
  const db = {
    getOrder: async (id) => { log('getOrder'); return ords.find((o) => o.order_id === id) || null; },
    getRecentOrders: async (phone, n = 3) => { log('getRecentOrders'); return ords.filter((o) => o.customer_phone === phone).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, n); },
    getRecentPendingOrder: async (phone) => { log('getRecentPendingOrder'); return pending[phone] || null; },
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
    sendText: async (to, text) => { const r = wamid(); sent.push({ to, kind: 'text', text, id: r.messages[0].id }); return r; },
    sendButtons: async (to, body, buttons, opts) => { const r = wamid(); sent.push({ to, kind: 'buttons', text: body, buttons, header: opts && opts.header, id: r.messages[0].id }); return r; },
    sendVideo: async (to, link, caption) => { const r = wamid(); sent.push({ to, kind: 'video', link, caption, id: r.messages[0].id }); return r; },
    downloadMedia: async (id) => { calls.push('download:' + id); if (media.fail) throw new Error('graph down'); return media.result || { buffer: Buffer.from('JPEGBYTES'), mimeType: 'image/jpeg' }; },
    uploadMedia: async (buf, mime, name) => { calls.push('upload'); if (media.failUpload) throw new Error('window closed'); return 'MEDIA-OUT-1'; },
    sendImageById: async (to, id, caption) => { if (media.failSend) throw new Error('131047'); const r = wamid(); sent.push({ to, kind: 'imageById', mediaId: id, caption, id: r.messages[0].id }); return r; },
  };
  const mail = {
    sendComplaintAlert: async (x) => { mails.push({ kind: 'complaint', ...x }); },
    sendComplaintPhoto: async (x) => { if (media.failMail) throw new Error('mail down'); mails.push({ kind: 'complaintPhoto', ...x }); },
    sendCheckinFeedbackAlert: async (x) => { mails.push({ kind: 'feedback', ...x }); },
  };
  const now = () => t;
  journey.setDeps({ db, wa, mail, now, ownerPhone: () => owner, inStock: async () => new Set(inStock || ['atta-original', 'atta-kesari', 'atta-ajwain', 'atta-lite-sugar']), lang: async () => lang });
  contacts.setDeps({ db, wa, now });
  suggestions.setDeps({ db, wa, mail, now });
  return { media, rows, waits, events, sent, mails, saved, calls, ords, pending, db, wa, mail, tick: (ms) => { t += ms; }, toBuyer: () => sent.filter((s) => s.to === ASHA), toOwner: () => sent.filter((s) => s.to === OWNER) };
}
const only = (b, m) => ok(b.length === 1, m + ' (one message: ' + show(b) + ')');

(async () => {
  delete process.env.JOURNEY_UNLOCK_VIDEO_URL;
  delete process.env.DELIVERY_NATIONWIDE;

  // ── the words: S is the approved words with line breaks, and the module sends S ──
  for (const k of ['ask', 'r1', 'notQuite', 'wrong', 'c3', 'c7', 'c9', 'c10', 'c11', 'c12', 'c13', 'c15']) ok(reflow(S[k]) === W[k], `${k}: the words are the approved words`);
  ok(reflow(S.consented('Atta Kesari')) === W.consented('Atta Kesari'), 'consented: the approved words');
  ok(reflow(S.usual) === W.consented('X').replace(', with one X added to try.', '.'), 'usual: the consented words without the try clause (accepted subset)');
  ok(Object.keys(journey.REPLIES).join() === 'en', 'one REPLIES map, English only for now (Hindi is data later)');
  const titles = [...journey.BUTTONS.consent, ...journey.BUTTONS.reminder];
  ok(titles.every((b) => b.title.length <= 20), 'every button title fits WhatsApp\'s 20 characters');
  ok(show(journey.BUTTONS.consent) === show([{ id: 'j4_yes', title: 'Yes, keep me posted' }, { id: 'j4_no', title: 'No thanks' }]), 'consent buttons j4_yes / j4_no');
  ok(show(journey.BUTTONS.reminder) === show([{ id: 'j4_remind_yes', title: 'Yes, remind me' }, { id: 'j4_remind_no', title: 'No thanks' }]), 'reminder buttons j4_remind_yes / j4_remind_no');

  // ── any other id is not ours ──
  let w = world();
  for (const id of ['btn_products', 'optin_yes', 'j3:bogus:' + OID, 'j3:loved:', 'j4_maybe', '', null]) ok(await journey.handleTap(ASHA, id, 'Asha') === false, 'not a journey id: ' + id);
  ok(w.sent.length === 0 && w.calls.every((c) => c === 'getWait'), 'unknown ids send nothing and only look for a check-in wait to drop (' + show(w.calls) + ')');

  // ── Review Focus 2: someone else's order reveals nothing ──
  w = world();
  ok(await journey.handleTap(OTHER, 'j3:loved:' + OID, 'Ravi') === false, 'a tap on an order from another phone returns false (the normal menu answers)');
  ok(await journey.handleTap(OTHER, 'j3:wrong:' + OID, 'Ravi') === false, 'also for Something wasn\'t right');
  ok(await journey.handleTap(ASHA, 'j3:loved:MNG-ZZZZ-9999', 'Asha') === false, 'an order that does not exist returns false');
  ok(w.sent.length === 0 && w.mails.length === 0, 'nothing is sent to anyone');
  ok(!w.sent.concat(w.mails).some((s) => show(s).includes(OID) || FLAVOR_NAMES.test(show(s))), 'no order id and no Flavor name leaves the bot');
  ok(w.events.length === 0 && Object.keys(w.waits).length === 0 && Object.keys(w.rows).length === 0, 'and nothing is claimed, waited on or saved');
  w = world({ orders: [{ order_id: OID, customer_phone: '9810000001', status: 'paid', created_at: '2026-11-08T05:00:00Z', items: [{ slug: 'atta-original', quantity: 2 }], delivery_address: { pincode: '110009' } }] });
  ok(await journey.handleTap(ASHA, 'j3:meh:' + OID, 'Asha') === true, 'the same number stored without 91 is still the buyer (last 10 digits)');

  // ── Loved it from a buyer who has not consented: the ask, with buttons, no link ──
  w = world();
  ok(await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha') === true, 'Loved it is handled');
  let b = w.toBuyer();
  only(b, 'not consented');
  ok(b[0].kind === 'buttons' && b[0].text === S.ask && b[0].header === undefined, 'the §11 consent ask, exactly, no header without the video env');
  ok(show(b[0].buttons) === show(journey.BUTTONS.consent), 'with Yes, keep me posted / No thanks');
  ok(!w.sent.some((s) => /cart\?|shop\?|build-a-box/.test(s.text || '')), 'no link before consent');
  ok(w.events.length === 1 && w.events[0].event === 'journey_tap' && w.events[0].order_id === OID && w.events[0].meta.kind === 'loved', 'the first tap is claimed as journey_tap { kind: loved }');

  // ── Yes: consent saved word for word, then C7, then the cart ──
  ok(await journey.handleTap(ASHA, 'j4_yes', 'Asha') === true, 'j4_yes is handled');
  const c = w.rows[ASHA];
  ok(c && c.consent_marketing === true && c.consent_reminder === true, 'Yes saves marketing AND reminder consent');
  ok(c.consent_text === S.ask, 'consent_text is exactly the question that was sent');
  ok(c.consent_at === new Date(START).toISOString() && c.first_source === 'journey:2026-11-16' && c.last_source === 'journey:2026-11-16', 'with its time and source journey:<IST day> (' + show(c) + ')');
  b = w.toBuyer().slice(1);
  ok(b.length === 2 && b[0].text === S.c7, 'C7 first, exactly');
  ok(b[1].kind === 'text' && b[1].text === CART, 'then exactly the consented words + the cart (Original x2 + Kesari to try, utm j4_reorder): ' + show(b[1] && b[1].text));

  // ── Review Focus 1: a second Loved it sends no second link; Something wasn't right after Loved it still reaches Prashant ──
  const before = w.sent.length;
  ok(await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha') === true, 'a second Loved it is handled');
  b = w.sent.slice(before);
  ok(b.length === 1 && b[0].text === S.c10, 'it gets exactly C10, and no second link');
  ok(await journey.handleTap(ASHA, 'j3:meh:' + OID, 'Asha') === true && w.sent[w.sent.length - 1].text === S.c10 && !w.waits[ASHA], 'a later Not quite also gets C10, no question');
  const n0 = w.sent.length;
  ok(await journey.handleTap(ASHA, 'j3:wrong:' + OID, 'Asha') === true, 'Something wasn\'t right after Loved it is handled');
  const ownerMsg = w.toOwner().map((s) => s.text).join('\n');
  ok(ownerMsg.includes(OID) && ownerMsg.includes('Asha') && ownerMsg.includes('+' + ASHA) && ownerMsg.includes('https://wa.me/' + ASHA), 'Prashant gets a WhatsApp alert with the order, name, number and wa.me link (' + ownerMsg + ')');
  ok(w.mails.some((m) => m.kind === 'complaint' && m.customerPhone === ASHA && m.orderId === OID), 'and a "Something wasn\'t right" email');
  ok(w.sent.slice(n0).filter((s) => s.to === ASHA).map((s) => s.text).join('|') === S.wrong, 'the buyer gets exactly the §11 apology');
  ok(w.waits[ASHA] && w.waits[ASHA].kind === 'complaint' && w.waits[ASHA].order_id === OID, 'a complaint wait is set for that order');
  ok(w.events.some((e) => e.event === 'journey_complaint' && e.order_id === OID), 'the order timeline logs journey_complaint');
  ok(w.rows[ASHA].last_complaint_at === new Date(START).toISOString(), 'the contact gets last_complaint_at (no marketing for 30 days)');

  // ── Review Focus 4: the next message, a photo, goes to Prashant and onto the order timeline ──
  const o0 = w.toOwner().length, m0 = w.mails.length;
  ok(await journey.captureReply(ASHA, 'Asha', 'image', '') === true, 'a photo after Something wasn\'t right is captured');
  const fwd = w.toOwner().slice(o0).map((s) => s.text).join('\n');
  ok(fwd.includes('[sent a photo]') && fwd.includes(OID) && fwd.includes('https://wa.me/' + ASHA), 'forwarded to Prashant with [sent a photo], the order id and the wa.me link (' + fwd + ')');
  ok(w.mails.slice(m0).some((m) => m.kind === 'complaint' && String(m.message).includes('[sent a photo]') && m.orderId === OID), 'and emailed');
  ok(w.events.some((e) => e.event === 'journey_complaint_followup' && e.order_id === OID && e.meta.media === 'image'), 'kept on the order timeline as journey_complaint_followup { media }');
  ok(w.toBuyer().pop().text === S.c11, 'the buyer is thanked with exactly C11');
  ok(!w.waits[ASHA], 'the wait is cleared');
  ok(await journey.captureReply(ASHA, 'Asha', 'text', 'hi') === false, 'the message after that goes to the bot as usual');


  // ── A5c: the photo itself reaches Prashant (WhatsApp image with the order id, and an email attachment) ──
  {
    const setup = async (o) => { const x = world(o); await journey.handleTap(ASHA, 'j3:wrong:' + OID, 'Asha'); return x; };
    w = await setup();
    const bn = w.toBuyer().length, mc = w.mails.length;
    ok(await journey.captureReply(ASHA, 'Asha', 'image', 'crushed', 'MEDIA-IN-1') === true, 'A5c: a photo with a media id is captured');
    ok(w.calls.includes('download:MEDIA-IN-1'), 'A5c: the image is downloaded by its id');
    const img = w.toOwner().find((s) => s.kind === 'imageById');
    ok(img && img.mediaId === 'MEDIA-OUT-1' && img.caption === OID, 'A5c: the photo is sent to OWNER_PHONE by media id with the order id as caption (' + show(img) + ')');
    const em = w.mails.slice(mc).find((m) => m.kind === 'complaintPhoto');
    ok(em && em.orderId === OID && Buffer.isBuffer(em.buffer) && em.mimeType === 'image/jpeg', 'A5c: the owner email carries the image attachment');
    ok(w.toBuyer().slice(bn).length === 1 && w.toBuyer().pop().text === S.c11, 'A5c: the buyer reply is still exactly C11, once');
    ok(w.mails.slice(mc).some((m) => m.kind === 'complaint' && String(m.message).includes('[sent a photo]')), 'A5c: today\'s text note still goes first');
    ok(w.events.some((e) => e.event === 'journey_complaint_followup' && e.meta.media === 'image'), 'A5c: timeline record unchanged');
    ok(!w.events.some((e) => JSON.stringify(e).includes('JPEGBYTES')), 'A5c: image bytes never stored on the timeline');

    w = await setup(); w.media.fail = true;
    ok(await journey.captureReply(ASHA, 'Asha', 'image', '', 'M1') === true, 'A5c: failed download still captured');
    ok(!w.toOwner().some((s) => s.kind === 'imageById') && !w.mails.some((m) => m.kind === 'complaintPhoto'), 'A5c: failed download sends no image or attachment');
    ok(w.toOwner().some((s) => s.text && s.text.includes('[sent a photo]')) && w.mails.some((m) => m.kind === 'complaint' && String(m.message).includes('[sent a photo]')), 'A5c: failed download falls back to the text note (WhatsApp and email)');
    ok(w.toBuyer().pop().text === S.c11, 'A5c: and the buyer still gets C11');

    w = await setup(); w.wa.downloadMedia = () => { throw new TypeError('sync boom'); };
    ok(await journey.captureReply(ASHA, 'Asha', 'image', '', 'M1') === true && w.toBuyer().pop().text === S.c11, 'A5c: even a synchronous throw inside the forward never reaches captureReply');

    w = await setup(); w.media.failSend = true; w.media.failMail = true;
    ok(await journey.captureReply(ASHA, 'Asha', 'image', '', 'M1') === true && w.toBuyer().pop().text === S.c11, 'A5c: WhatsApp image and photo email both failing never break the reply');

    w = await setup(); w.media.failSend = true;
    await journey.captureReply(ASHA, 'Asha', 'image', '', 'M1');
    ok(w.mails.some((m) => m.kind === 'complaintPhoto'), 'A5c: email attachment goes even when the WhatsApp image is rejected');

    w = await setup(); w.media.result = { buffer: Buffer.from('x'), mimeType: 'application/pdf' };
    await journey.captureReply(ASHA, 'Asha', 'image', '', 'M1');
    ok(!w.toOwner().some((s) => s.kind === 'imageById') && !w.mails.some((m) => m.kind === 'complaintPhoto'), 'A5c: a non-image mime type is not forwarded');

    for (const t of ['video', 'document', 'audio', 'sticker']) {
      w = await setup();
      await journey.captureReply(ASHA, 'Asha', t, '', 'M1');
      ok(!w.calls.some((c) => c.startsWith('download')) && w.toOwner().some((s) => s.text && s.text.includes('[sent ')), 'A5c: ' + t + ' keeps today\'s text note, no download');
    }
    w = await setup(); w.mail.sendComplaintAlert = async () => { throw new Error('mail down'); };
    await journey.captureReply(ASHA, 'Asha', 'image', '', 'M1');
    ok(w.toBuyer().length === 2 && w.toBuyer()[1].text === S.failed, 'A5c: owner email down: no C11, the try-again line instead (A8 fix 4): ' + show(w.toBuyer().map((x) => x.text)));
    w = await setup({ owner: '' });
    await journey.captureReply(ASHA, 'Asha', 'image', '', 'M1');
    ok(!w.sent.some((s) => s.kind === 'imageById') && w.mails.some((m) => m.kind === 'complaintPhoto'), 'A5c: no OWNER_PHONE: no WhatsApp image, email attachment still goes');
    const srv2 = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    ok(/captureReply\(from, contactName, type, replyText, message\[type\]\?\.id\)/.test(srv2), 'A5c: server.js passes the media id to captureReply');
  }

  // ── a complaint follow-up that reached nobody is never confirmed, and is still kept ──
  w = world({ owner: '' });
  await journey.handleTap(ASHA, 'j3:wrong:' + OID, 'Asha');
  w.mail.sendComplaintAlert = async () => { throw new Error('mail down'); };
  const nb = w.toBuyer().length;
  ok(await journey.captureReply(ASHA, 'Asha', 'text', 'The box was crushed') === true, 'captured even when Prashant cannot be reached');
  ok(w.toBuyer().length === nb + 1 && w.toBuyer().pop().text === S.failed, 'no C11: "It\'s with me now" is never sent when it reached nobody; the buyer gets exactly the try-again line (A8 fix 4)');
  ok(w.events.some((e) => e.event === 'journey_complaint_followup' && e.meta.text === 'The box was crushed'), 'the text is on the order timeline');
  ok(w.waits[ASHA] && w.waits[ASHA].kind === 'complaint' && w.waits[ASHA].order_id === OID && w.waits[ASHA].asked_at === new Date(START).toISOString(), 'the wait is restored as it was (same order, same 24 h from the tap): ' + show(w.waits[ASHA]));
  w.mail.sendComplaintAlert = async (x) => { w.mails.push({ kind: 'complaint', ...x }); };   // email is back: the buyer tries again
  ok(await journey.captureReply(ASHA, 'Asha', 'text', 'The box was crushed') === true && w.toBuyer().pop().text === S.c11, 'their retry is captured and now gets C11');
  ok(w.mails.some((m) => m.kind === 'complaint' && m.message === 'The box was crushed') && !w.waits[ASHA], 'Prashant has the email and the wait is cleared');
  w = world();
  await journey.handleTap(ASHA, 'j3:wrong:' + OID, 'Asha');
  w.mail.sendComplaintAlert = async () => { throw new Error('mail down'); };
  const nb2 = w.toBuyer().length, ow2 = w.toOwner().length;
  ok(await journey.captureReply(ASHA, 'Asha', 'text', 'Lid was open') === true && w.toOwner().length === ow2 + 1, 'email down: the WhatsApp alert to Prashant still goes (R22)');
  ok(w.toBuyer().length === nb2 + 1 && w.toBuyer().pop().text === S.failed, 'but WhatsApp alone does not count as reached: no C11 (Meta can accept and then drop it), the try-again line instead');
  ok(w.waits[ASHA] && w.waits[ASHA].kind === 'complaint' && w.waits[ASHA].order_id === OID, 'and the wait is restored for the retry');
  ok(w.events.some((e) => e.event === 'journey_complaint_followup' && e.meta.text === 'Lid was open'), 'and the follow-up is on the order timeline');
  w = world();
  await journey.handleTap(ASHA, 'j3:wrong:' + OID, 'Asha');
  await journey.captureReply(ASHA, 'Asha', 'text', 'x'.repeat(1500));
  const fu = w.events.find((e) => e.event === 'journey_complaint_followup');
  ok(fu && fu.meta.text.length === 1000, 'the timeline keeps at most 1,000 characters');
  w = world({ owner: '' });
  await journey.handleTap(ASHA, 'j3:wrong:' + OID, 'Asha');
  ok(w.toOwner().length === 0 && w.mails.some((m) => m.kind === 'complaint'), 'no OWNER_PHONE: the email still goes');
  await journey.captureReply(ASHA, 'Asha', 'text', 'crushed');
  ok(w.toBuyer().pop().text === S.c11, 'email alone reaching Prashant is enough for C11');

  // ── a typed complaint is quoted; STOP, reactions and other waits are left alone; 24 h ──
  w = world({ contact: { consent_marketing: true } });
  await journey.handleTap(ASHA, 'j3:wrong:' + OID, 'Asha');
  ok(await journey.captureReply(ASHA, 'Asha', 'text', 'STOP') === false && w.waits[ASHA], 'STOP is never taken as the complaint; the wait stays');
  ok(await journey.captureReply(ASHA, 'Asha', 'reaction', '') === false && w.waits[ASHA], 'a reaction is not an answer');
  ok(await journey.captureReply(ASHA, 'Asha', 'text', 'The box was crushed') === true, 'typed complaint captured');
  ok(w.toOwner().pop().text.includes('"The box was crushed"'), 'the text is quoted to Prashant');
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

  // ── an order in progress, other buttons and "Share a suggestion" never lose the buyer's message ──
  w = world();
  await journey.handleTap(ASHA, 'j3:wrong:' + OID, 'Asha');
  w.pending[ASHA] = { order_id: 'MNG-WAPP-0001', status: 'pending_address' };
  const o2 = w.toOwner().length;
  ok(await journey.captureReply(ASHA, 'Asha', 'text', 'Flat 12, Sector 15, Delhi 110017') === false, 'a buyer typing an address for an order in progress keeps the bot');
  ok(w.waits[ASHA] && w.waits[ASHA].kind === 'complaint' && w.toOwner().length === o2, 'and the complaint wait stays, nothing forwarded');
  delete w.pending[ASHA];
  ok(await journey.captureReply(ASHA, 'Asha', 'text', 'Box was crushed') === true, 'once the order is done the next message is the complaint again');
  for (const k of ['wrong', 'meh']) {
    w = world();
    await journey.handleTap(ASHA, `j3:${k}:${OID}`, 'Asha');
    ok(await journey.handleTap(ASHA, 'btn_products', 'Asha') === false, `another button after ${k} is not ours`);
    ok(!w.waits[ASHA], `and it drops the ${k} wait, so the next message goes to the bot`);
  }
  w = world();
  await w.db.setSuggestionWait(ASHA, new Date(START).toISOString());
  await journey.handleTap(ASHA, 'btn_faq', 'Asha');
  ok(w.waits[ASHA] && w.waits[ASHA].kind === 'suggestion', 'another button leaves a suggestion wait alone');
  w = world();
  await journey.handleTap(ASHA, 'j3:wrong:' + OID, 'Asha');
  await suggestions.ask(ASHA);
  ok(w.waits[ASHA].kind === 'complaint' && w.toBuyer().pop().text === suggestions.ASK, '"Share a suggestion" still asks, but leaves the open complaint wait');
  ok(await journey.captureReply(ASHA, 'Asha', 'text', 'The box was crushed') === true && w.toOwner().pop().text.includes('"The box was crushed"'), 'so the next message still reaches Prashant as the complaint');

  // ── Not quite for me: one question, the answer saved as feedback and emailed (no suggestion promise) ──
  w = world();
  ok(await journey.handleTap(ASHA, 'j3:meh:' + OID, 'Asha') === true && w.toBuyer()[0].text === S.notQuite, 'Not quite gets exactly the §11 question');
  ok(w.waits[ASHA] && w.waits[ASHA].kind === 'not_quite' && w.waits[ASHA].order_id === OID, 'a not_quite wait is set');
  ok(w.toOwner().length === 0 && w.mails.length === 0, 'nobody is alerted yet');
  ok(await journey.captureReply(ASHA, 'Asha', 'text', 'Too sweet for me') === true, 'the answer is captured');
  ok(w.saved.length === 1 && w.saved[0].kind === 'feedback' && w.saved[0].text === '[check-in ' + OID + '] Too sweet for me', 'saved as feedback with the check-in order (' + show(w.saved) + ')');
  ok(w.mails.length === 1 && w.mails[0].kind === 'feedback' && w.mails[0].text === '[check-in ' + OID + '] Too sweet for me' && w.mails[0].orderId === OID, 'emailed to Prashant as plain feedback');
  ok(w.toBuyer().pop().text === S.c12 && !w.waits[ASHA], 'thanked with exactly C12, wait cleared');
  w = world();
  await journey.handleTap(ASHA, 'j3:meh:' + OID, 'Asha');
  await journey.captureReply(ASHA, 'Asha', 'video', 'see');
  ok(w.saved[0].text === '[check-in ' + OID + '] [sent a video] "see"', 'media in a not-quite answer is noted (' + (w.saved[0] && w.saved[0].text) + ')');

  // ── Loved it from a consented buyer ──
  w = world({ contact: { consent_marketing: true, consent_reminder: false } });
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  b = w.toBuyer();
  ok(b.length === 2 && b[0].kind === 'text' && b[0].text === CART, 'consented, no reminder yes: exactly the cart message first');
  ok(b[1].kind === 'buttons' && b[1].text === S.c9 && show(b[1].buttons) === show(journey.BUTTONS.reminder), 'then exactly C9 with Yes, remind me / No thanks');
  w = world({ contact: { consent_marketing: true, consent_reminder: true } });
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  b = w.toBuyer();
  ok(b.length === 1 && b[0].text === CART, 'covers reminders: exactly the cart message, utm_campaign=j4_reorder');
  w = world({ contact: { consent_marketing: true, consent_reminder: true }, orders: [{ order_id: OID, customer_phone: ASHA, status: 'paid', created_at: '2026-11-08T05:00:00Z', items: [{ slug: 'atta-original', quantity: 2 }, { slug: 'atta-kesari', quantity: 1 }, { slug: 'atta-ajwain', quantity: 1 }, { slug: 'atta-lite-sugar', quantity: 1 }], delivery_address: { pincode: '110009' } }] });
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  b = w.toBuyer();
  ok(b.length === 1 && b[0].text === S.usual + '\n\nhttps://munchingo.com/cart?add=atta-original:2,atta-kesari:1,atta-ajwain:1,atta-lite-sugar:1&utm_source=whatsapp&utm_medium=journey&utm_campaign=j4_reorder', 'everything tried: exactly the usual words and the last order again: ' + show(b));
  w = world({ contact: { consent_marketing: true, consent_reminder: true }, orders: [{ order_id: OID, customer_phone: ASHA, status: 'paid', created_at: '2026-11-08T05:00:00Z', items: [{ slug: 'full-range-set', quantity: 1 }], delivery_address: { pincode: '110009' } }] });
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  b = w.toBuyer();
  ok(b.length === 1 && b[0].text === S.c15 + '\n\nhttps://munchingo.com/build-a-box?utm_source=whatsapp&utm_medium=journey&utm_campaign=j4_reorder', 'a Set last time: exactly C15 and Build a box (R20, R23): ' + show(b));
  w = world({ orders: [{ order_id: OID, customer_phone: ASHA, status: 'paid', created_at: '2026-11-08T05:00:00Z', items: [{ slug: 'trio-gift-set-kesari-lite-sugar-original', quantity: 1 }], delivery_address: { pincode: '110009' } }] });
  await journey.handleTap(ASHA, 'j4_yes', 'Asha');
  b = w.toBuyer();
  ok(b.length === 2 && b[0].text === S.c7 && b[1].text === S.c15 + '\n\nhttps://munchingo.com/build-a-box?utm_source=whatsapp&utm_medium=journey&utm_campaign=j4_reorder', 'Yes after a Trio: C7, then exactly C15 and Build a box: ' + show(b));
  w = world({ contact: { consent_marketing: true, consent_reminder: true }, inStock: [] });
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  b = w.toBuyer();
  ok(b.length === 1 && b[0].text === S.r1, 'nothing in stock: exactly the R1 thanks, no link');
  w = world({ contact: { consent_marketing: true, consent_reminder: false }, orders: [{ order_id: OID, customer_phone: ASHA, status: 'paid', created_at: '2026-11-08T05:00:00Z', items: [{ slug: 'atta-original', quantity: 2 }], delivery_address: { raw: 'A-1, Civil Lines, Jaipur, Rajasthan - 302006' } }] });
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  b = w.toBuyer();
  ok(b.length === 1 && b[0].text === S.r1, 'last order outside Delhi NCR: no reorder link and no reminder ask, only the R1 thanks');
  w = world({ contact: { consent_marketing: true, consent_reminder: true }, lang: 'hi' });
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  ok(w.toBuyer()[0].text === CART, 'a Hindi chooser gets English until Hindi words are approved');

  // ── Loved it after STOP (ever), or a No within 90 days (J4 No thanks or any consent No, R19): R1 only ──
  const lovedTo = async (contact) => { const x = world({ contact }); await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha'); return x.toBuyer(); };
  b = await lovedTo({ consent_marketing: false, consent_reminder: false, consent_text: 'STOP', consent_at: new Date(START - 200 * DAY).toISOString() });
  ok(b.length === 1 && b[0].kind === 'text' && b[0].text === S.r1, 'STOP 200 days ago: exactly R1, never asked again');
  b = await lovedTo({ consent_marketing: false, journey_declined_at: new Date(START - 10 * DAY).toISOString() });
  ok(b.length === 1 && b[0].text === S.r1, 'J4 No thanks 10 days ago: R1');
  b = await lovedTo({ consent_marketing: false, journey_declined_at: new Date(START - 100 * DAY).toISOString() });
  ok(b.length === 1 && b[0].text === S.ask, 'J4 No thanks 100 days ago: asked again');
  b = await lovedTo({ consent_marketing: false, consent_at: new Date(START - 10 * DAY).toISOString(), consent_text: contacts.CONSENT_QUESTION });
  ok(b.length === 1 && b[0].text === S.r1, 'a JOIN / FAIR No thanks 10 days ago counts as a No (R19): R1');
  b = await lovedTo({ consent_marketing: false, consent_at: new Date(START - 100 * DAY).toISOString(), consent_text: contacts.CONSENT_QUESTION });
  ok(b.length === 1 && b[0].text === S.ask, 'a JOIN / FAIR No thanks 100 days ago: asked again');

  // ── No thanks, the reminder buttons, Remind me to reorder ──
  w = world();
  ok(await journey.handleTap(ASHA, 'j4_no', 'Asha') === true && w.toBuyer()[0].text === S.c13, 'j4_no gets exactly C13');
  ok(w.rows[ASHA] && w.rows[ASHA].journey_declined_at === new Date(START).toISOString() && w.rows[ASHA].consent_marketing !== true && w.rows[ASHA].first_source === 'journey:2026-11-16', 'and the No is stored (journey_declined_at), with no consent');
  const OLD_AT = '2026-10-01T00:00:00.000Z';
  w = world({ contact: { consent_marketing: true, consent_reminder: false, consent_text: 'v1', consent_at: OLD_AT } });
  ok(await journey.handleTap(ASHA, 'j4_remind_yes', 'Asha') === true, 'j4_remind_yes is handled');
  const REM = (text) => `Reminder yes, ${new Date(START).toISOString()}: ${text}`;   // A8 fix 3: the reminder yes is added to the record
  ok(w.rows[ASHA].consent_reminder === true && w.rows[ASHA].consent_text === 'v1\n\n' + REM(S.c9 + ' | Yes, remind me') && w.rows[ASHA].consent_marketing === true, 'reminder consent added to the kept marketing consent text, with C9 + " | Yes, remind me" and its time (got ' + show(w.rows[ASHA].consent_text) + ')');
  ok(w.rows[ASHA].consent_at === OLD_AT, 'consent_at is not overwritten (R6-fix)');
  only(w.toBuyer(), 'j4_remind_yes reply');
  ok(w.toBuyer()[0].text === S.c3, 'j4_remind_yes replies exactly C3 (R18)');
  { const before = w.rows[ASHA].consent_text; await journey.handleTap(ASHA, 'j4_remind_yes', 'Asha');
    ok(w.rows[ASHA].consent_text === before, 'a second tap does not add the same reminder yes twice'); }
  w = world({ contact: { consent_marketing: true, consent_reminder: false, consent_text: 'v1', consent_at: OLD_AT } });
  ok(await journey.handleTap(ASHA, 'j4_remind_no', 'Asha') === true && w.rows[ASHA].consent_reminder === false && w.rows[ASHA].consent_text === 'v1' && w.rows[ASHA].consent_at === OLD_AT, 'j4_remind_no: handled, nothing changed');
  ok(w.toBuyer().length === 1 && w.toBuyer()[0].text === S.c13, 'j4_remind_no replies exactly C13 (R18)');
  w = world({ contact: { consent_marketing: false, consent_text: 'STOP' } });
  ok(await journey.handleTap(ASHA, 'j4_remind_yes', 'Asha') === false && w.rows[ASHA].consent_reminder === undefined && w.sent.length === 0, 'j4_remind_yes without marketing consent changes nothing');
  w = world({ contact: { consent_marketing: true, consent_reminder: false, consent_at: OLD_AT, consent_text: contacts.CONSENT_QUESTION } });
  ok(await journey.handleTap(ASHA, 'j7_remind', 'Asha') === true, 'j7_remind is handled for a consented contact');
  ok(w.rows[ASHA].consent_reminder === true && w.rows[ASHA].consent_text === contacts.CONSENT_QUESTION + '\n\n' + REM('j7_remind: Remind me to reorder') && w.rows[ASHA].consent_at === OLD_AT, 'it keeps the marketing consent text and adds the reminder yes with its own text, consent_at untouched (got ' + show(w.rows[ASHA].consent_text) + ')');
  { const x = world({ contact: { consent_marketing: true, consent_reminder: false, consent_at: OLD_AT } });
    await journey.handleTap(ASHA, 'j7_remind', 'Asha');
    ok(x.rows[ASHA].consent_text === REM('j7_remind: Remind me to reorder'), 'no earlier text: the reminder yes alone (got ' + show(x.rows[ASHA].consent_text) + ')'); w = x; w.sent.length = 0; await journey.handleTap(ASHA, 'j7_remind', 'Asha'); }
  ok(w.toBuyer().length === 1 && w.toBuyer()[0].text === S.c3, 'and replies exactly C3');
  for (const contact of [undefined, { consent_marketing: false }]) {
    w = world({ contact });
    ok(await journey.handleTap(ASHA, 'j7_remind', 'Asha') === false && w.sent.length === 0 && (!w.rows[ASHA] || w.rows[ASHA].consent_reminder === undefined), 'j7_remind without marketing consent: false, nothing saved (' + show(contact) + ')');
  }

  // ── a consent that could not be saved is never confirmed ──
  w = world();
  w.db.insertContact = async () => { throw new Error('db down'); };
  await journey.handleTap(ASHA, 'j4_yes', 'Asha');
  ok(w.toBuyer().length === 1 && w.toBuyer()[0].text === S.failed, 'a Yes that failed to save: exactly the try-again line, no C7, no link');

  // ── the unlock video rides IN the first Loved it reply (R17), never otherwise ──
  process.env.JOURNEY_UNLOCK_VIDEO_URL = VID;
  const HDR = show({ type: 'video', link: VID });
  w = world();
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  b = w.toBuyer();
  only(b, 'video, not consented');
  ok(b[0].kind === 'buttons' && show(b[0].header) === HDR && b[0].text === S.ask && show(b[0].buttons) === show(journey.BUTTONS.consent), 'not consented: ONE button message, the clip as its header, the ask as its body');
  w = world({ contact: { consent_marketing: true, consent_reminder: false } });
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  b = w.toBuyer();
  only(b, 'video, consented without reminder');
  ok(b[0].kind === 'buttons' && show(b[0].header) === HDR && b[0].text === CART + '\n\n' + S.c9 && show(b[0].buttons) === show(journey.BUTTONS.reminder), 'consented, no reminder: ONE button message, clip header, the cart words + C9 as the body: ' + show(b[0]));
  w = world({ contact: { consent_marketing: true, consent_reminder: true } });
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  b = w.toBuyer();
  only(b, 'video, covers reminders');
  ok(b[0].kind === 'video' && b[0].link === VID && b[0].caption === CART, 'covers reminders: the clip with the cart message as its caption');
  w = world({ contact: { consent_marketing: false, consent_text: 'STOP' } });
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  b = w.toBuyer();
  only(b, 'video, STOP');
  ok(b[0].kind === 'video' && b[0].link === VID && b[0].caption === S.r1, 'R1: the clip with exactly the R1 words as its caption');
  // a failed clip falls back to the plain messages, exactly as without the video
  w = world();
  w.wa.sendButtons = async (to, body, buttons, opts) => { if (opts && opts.header) throw new Error('media fetch failed'); w.sent.push({ to, kind: 'buttons', text: body, buttons }); };
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  b = w.toBuyer();
  ok(b.length === 1 && b[0].kind === 'buttons' && b[0].text === S.ask && b[0].header === undefined, 'header refused: the plain consent ask');
  w = world({ contact: { consent_marketing: true, consent_reminder: false } });
  w.wa.sendButtons = async (to, body, buttons, opts) => { if (opts && opts.header) throw new Error('media fetch failed'); w.sent.push({ to, kind: 'buttons', text: body, buttons }); };
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  b = w.toBuyer();
  ok(b.length === 2 && b[0].text === CART && b[1].text === S.c9, 'header refused, consented: the cart message, then C9, as without the video');
  w = world({ contact: { consent_marketing: true, consent_reminder: true } });
  w.wa.sendVideo = async () => { throw new Error('media fetch failed'); };
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  b = w.toBuyer();
  ok(b.length === 1 && b[0].kind === 'text' && b[0].text === CART, 'video refused: the plain cart message');
  // never on a repeat, Not quite, Something wasn't right or Yes
  w = world();
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  const v0 = w.sent.length;
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  ok(!w.sent.slice(v0).some((s) => s.kind === 'video' || s.header), 'a repeat Loved it gets no video');
  for (const k of ['meh', 'wrong']) {
    w = world();
    await journey.handleTap(ASHA, `j3:${k}:${OID}`, 'Asha');
    await journey.captureReply(ASHA, 'Asha', 'text', 'answer');
    ok(!w.sent.some((s) => s.kind === 'video' || s.header), `${k} never sends a video`);
  }
  w = world();
  await journey.handleTap(ASHA, 'j4_yes', 'Asha');
  ok(!w.sent.some((s) => s.kind === 'video' || s.header), 'Yes, keep me posted gets no second video');
  // R21: Meta reports a failed clip later (status webhook); the plain words follow once, never twice
  w = world();
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  const hdrId = w.toBuyer()[0].id;
  ok(await journey.noteStatus({ id: hdrId, status: 'delivered', recipient_id: ASHA }) === false && w.toBuyer().length === 1, 'a delivered status does nothing');
  w = world();
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  const hdrId2 = w.toBuyer()[0].id;
  ok(await journey.noteStatus({ id: 'wamid.unknown', status: 'failed' }) === false && w.toBuyer().length === 1, 'a failed status for a message that is not ours does nothing');
  ok(await journey.noteStatus({ id: hdrId2, status: 'sent' }) === false && w.toBuyer().length === 1, 'a sent status does nothing');
  ok(await journey.noteStatus({ id: hdrId2, status: 'failed', recipient_id: ASHA, errors: [{ code: 131053 }] }) === true, 'a failed clip-header reply is resent');
  b = w.toBuyer().slice(1);
  ok(b.length === 1 && b[0].kind === 'buttons' && b[0].header === undefined && b[0].text === S.ask && show(b[0].buttons) === show(journey.BUTTONS.consent), 'as exactly the plain consent ask with its buttons, no header: ' + show(b));
  ok(await journey.noteStatus({ id: hdrId2, status: 'failed' }) === false && w.toBuyer().length === 2, 'a second failed status for the same reply does not resend');
  w = world({ contact: { consent_marketing: true, consent_reminder: true } });
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  ok(await journey.noteStatus({ id: w.toBuyer()[0].id, status: 'failed' }) === true, 'a failed clip-with-caption reply is resent');
  b = w.toBuyer().slice(1);
  ok(b.length === 1 && b[0].kind === 'text' && b[0].text === CART, 'as exactly the plain cart message: ' + show(b));
  w = world({ contact: { consent_marketing: true, consent_reminder: false } });
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  await journey.noteStatus({ id: w.toBuyer()[0].id, status: 'failed' });
  b = w.toBuyer().slice(1);
  ok(b.length === 2 && b[0].kind === 'text' && b[0].text === CART && b[1].kind === 'buttons' && b[1].text === S.c9 && b[1].header === undefined && show(b[1].buttons) === show(journey.BUTTONS.reminder), 'consented: exactly what the no-clip path sends, the cart then C9 with its buttons');
  w = world();
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  const oldId = w.toBuyer()[0].id;
  w.tick(25 * 3600000);
  ok(await journey.noteStatus({ id: oldId, status: 'failed' }) === false && w.toBuyer().length === 1, 'kept 24 h only: a failure reported later resends nothing');
  w = world();
  w.wa.sendButtons = async (to, body, buttons, opts) => { if (opts && opts.header) throw new Error('bad media'); return w.wa.sendText(to, body); };
  const clipsBefore = journey._clipCount();
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  ok(journey._clipCount() === clipsBefore && w.toBuyer().length === 1 && w.toBuyer()[0].text === S.ask, 'a clip refused at once is not remembered (the plain words already went)');
  ok(await journey.noteStatus(undefined) === false && await journey.noteStatus({}) === false, 'noteStatus never throws on odd input');
  {
    w = world();
    for (let i = 0; i < 510; i++) journey._rememberClip('wamid.cap' + i, { to: ASHA, plain: [{ text: 'x' }] });
    ok(journey._clipCount() === 500, 'at most 500 remembered (' + journey._clipCount() + ')');
    ok(await journey.noteStatus({ id: 'wamid.cap0', status: 'failed' }) === false && await journey.noteStatus({ id: 'wamid.cap509', status: 'failed' }) === true, 'the oldest is dropped first');
  }
  process.env.JOURNEY_UNLOCK_VIDEO_URL = '   ';
  w = world();
  await journey.handleTap(ASHA, 'j3:loved:' + OID, 'Asha');
  ok(w.toBuyer().length === 1 && w.toBuyer()[0].header === undefined && w.toBuyer()[0].text === S.ask, 'a blank JOURNEY_UNLOCK_VIDEO_URL: exactly as without the video');
  delete process.env.JOURNEY_UNLOCK_VIDEO_URL;

  // ── whatsapp.js: sendVideo, and sendButtons with a media header (no live call) ──
  {
    const wa = require('../utils/whatsapp'), axios = require('axios'), realPost = axios.post;
    let body = null;
    axios.post = async (url, payload) => { body = payload; return { data: { messages: [{ id: 'x' }] } }; };
    await wa.sendVideo(ASHA, VID);
    ok(body && body.type === 'video' && body.to === ASHA && body.video.link === VID && body.video.caption === undefined && body.messaging_product === 'whatsapp', 'sendVideo posts a video message by link (' + show(body) + ')');
    await wa.sendVideo(ASHA, VID, 'hi');
    ok(body.video.caption === 'hi', 'sendVideo passes a caption when given');
    await wa.sendButtons(ASHA, 'Body', [{ id: 'a', title: 'A' }], { header: { type: 'video', link: VID } });
    ok(show(body.interactive.header) === show({ type: 'video', video: { link: VID } }) && body.interactive.body.text === 'Body' && body.interactive.action.buttons[0].reply.id === 'a', 'sendButtons with opts.header puts the clip in the button message header (' + show(body.interactive) + ')');
    await wa.sendButtons(ASHA, 'Body', [{ id: 'a', title: 'A' }]);
    ok(!('header' in body.interactive), 'sendButtons without opts is unchanged (no header)');
    axios.post = realPost;
  }

  // ── mailer.js: the two check-in emails (resend stubbed, nothing sent) ──
  {
    const root = path.join(__dirname, '..');
    const resendPath = require.resolve('resend', { paths: [path.join(root, 'utils')] });
    const mailerPath = require.resolve(path.join(root, 'utils/mailer.js'));
    const keep = { resend: require.cache[resendPath], mailer: require.cache[mailerPath], to: process.env.NOTIFY_EMAIL };
    const emails = [];
    require.cache[resendPath] = { id: resendPath, filename: resendPath, loaded: true, exports: { Resend: class { constructor() { this.emails = { send: async (p) => { emails.push(p); return { error: null }; } }; } } } };
    delete require.cache[mailerPath]; process.env.NOTIFY_EMAIL = 'owner@example.test';
    const mailer = require(mailerPath);
    await mailer.sendComplaintAlert({ customerPhone: ASHA, customerName: 'Asha <b>', orderId: OID, message: 'The box was "crushed"' });
    const e = emails[0] || {};
    ok(e.subject === "Something wasn't right: " + OID, 'complaint email subject: ' + show(e.subject));
    ok(String(e.html).includes('Something wasn&#39;t right: ' + OID) && !/wants a human/i.test(String(e.subject) + e.html), 'complaint email heading names the order, not "Customer wants a human"');
    ok(String(e.html).includes('Asha &lt;b&gt;') && String(e.html).includes('The box was &quot;crushed&quot;') && String(e.html).includes('https://wa.me/' + ASHA) && show(e.to) === show(['owner@example.test']), 'escaped, with the wa.me link, to NOTIFY_EMAIL');
    await mailer.sendCheckinFeedbackAlert({ phone: ASHA, name: 'Asha', orderId: OID, text: '[check-in ' + OID + '] Too sweet & dry' });
    const g = emails[1] || {};
    ok(g.subject === 'Not quite for me: ' + OID && String(g.html).includes('Too sweet &amp; dry'), 'not-quite email: subject names the order, text escaped');
    ok(!/taste it first|free/i.test(String(g.html)), 'not-quite email carries no "taste it first, free" promise');
    if (keep.resend) require.cache[resendPath] = keep.resend; else delete require.cache[resendPath];
    if (keep.mailer) require.cache[mailerPath] = keep.mailer; else delete require.cache[mailerPath];
    if (keep.to === undefined) delete process.env.NOTIFY_EMAIL; else process.env.NOTIFY_EMAIL = keep.to;
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
  const loop = srv.slice(srv.indexOf('for (const s of statuses)'), srv.indexOf('for (const s of statuses)') + 900);
  ok(/broadcast'\)\.noteStatus\(s\)/.test(loop) && /try \{ await require\('\.\/utils\/journey'\)\.noteStatus\(s\); \} catch/.test(loop), 'server.js: each status also goes to journey.noteStatus, in its own try/catch');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'growth_journey_migration.sql'), 'utf8').toLowerCase();
  ok(/create unique index if not exists order_events_journey_tap_once on order_events \(order_id, event\) where event = 'journey_tap'/.test(sql), 'the migration makes journey_tap once per order (claimOrderEvent needs a unique index to return false)');

  console.log(`journey-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log(`journey-test: ${pass} passed, ${fail} failed`); process.exit(1); });
