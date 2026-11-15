'use strict';
// J4 (growth journey, 16 Nov 2026): what the bot says when a buyer taps a button on the day-4 check-in (J3), and what happens to
// their next message. Spec: docs/superpowers/specs/2026-11-15-growth-system-design.md §6.1; words: §11 and table C-W. A tap
// opens Meta's 24-hour window, so every reply here is free-form and uses no marketing slot.
//   Loved it        -> not consented: the consent question (Yes / No thanks), no link. Consented: the reorder cart, then the
//                      reminder question (C9) if they have not said yes to the running-low nudge. STOP ever, or a No within
//                      90 days (J4 No thanks or any consent No): thanks only (rulings R1, R19). With JOURNEY_UNLOCK_VIDEO_URL
//                      set, the "unlock" clip rides in that first reply (R17); if Meta later fails to fetch it, the plain
//                      words follow once (noteStatus, R21). A Set last time: C15 and Build a box (R20, R23).
//   Not quite       -> one question; their next message within 24 h is saved as feedback and emailed to Prashant.
//   Something wrong -> apology and a photo ask; Prashant is alerted now, and their next message within 24 h (a photo too) is
//                      forwarded to him on WhatsApp and by email and kept on the order timeline. The contact gets
//                      last_complaint_at (no J6 for 30 days).
// Only the order's own buyer (last 10 digits) gets an answer: anyone else gets the normal menu and learns nothing. The first
// tap per order is claimed on the order timeline (journey_tap, unique per order); a later tap gets C10 and no second link,
// except Something wasn't right, which always reaches Prashant.
//   Tests: scripts/journey-test.js
const contacts = require('./contacts');
const suggestions = require('./suggestions');
const deliveryArea = require('./deliveryArea');
const { normPhone, FLAVOURS } = require('./reviews');
const { cartLink, SLUGS } = require('./reorderCart');

const SITE = 'https://munchingo.com/';
const DAY = 86_400_000;
const WAIT_KINDS = suggestions.JOURNEY_KINDS;      // 'complaint', 'not_quite' (they share the suggestion_waits row)
const WAIT_MS = suggestions.JOURNEY_WAIT_MS;       // a check-in answer is taken within 24 h of the tap
const DECLINE_MS = 90 * DAY;                        // a No: not asked again for 90 days
const MEDIA = { image: 'a photo', video: 'a video', audio: 'a voice note', document: 'a document', sticker: 'a sticker' };
const PAID = ['paid', 'shipped', 'delivered'];
const NAME = Object.fromEntries(FLAVOURS);   // 'atta-kesari' -> 'Atta Kesari'
const MAX_LEN = 1000;

// Every word a buyer sees, by language. Only English is approved so far; a Hindi copy is a new key here, not new code.
// The words are Prashant's, verbatim (§11 / C-W); only WhatsApp line breaks are added between sentences (ruling R15).
const REPLIES = {
  en: {
    // §11 J4, Loved it (not consented). Stored word for word as consent_text when they tap Yes.
    askConsent: "Glad to hear it.\nYou've unlocked the good stuff.\n\nMay I message you when a fresh batch leaves Bikaner, when a new Flavor lands, or a few weeks after an order, when your box is probably running low?\n\nAt most 3 a month. Reply STOP any time and it stops.",
    lovedNoAsk: "Glad to hear it.\nYou've unlocked the good stuff.",   // R1: the first two §11 sentences (STOP, a recent No, or nothing to link)
    usualWithTry: (flavor) => `Thank you.\nYour usual is ready in one tap whenever you want it, with one ${flavor} added to try.`,   // §11 consented
    usual: 'Thank you.\nYour usual is ready in one tap whenever you want it.',   // §11 consented without the try clause (accepted subset)
    setReady: 'Thank you.\nYour next Set is ready to build whenever you want it.',   // C15: the last order was a Set (link: Build a box)
    askReminder: 'One more thing: may I also send one nudge when your box is probably running low?',   // C9
    alreadyAnswered: 'No problem.\nThank you for telling me how it went.',   // C10
    notQuite: 'Thanks for being honest.\nWhat would have made it right for you?\n\nOne line is enough. I read every reply.',   // §11
    wrong: "I'm sorry.\nTell me what happened, and send a photo if a box arrived broken.\n\nI'll make it right, and I'll reply myself.",   // §11
    onList: "Done, you're on the list.",   // C7
    declined: 'No problem.\nThank you for telling me how it went.',   // C13
    remindDone: "Done.\nA few weeks after each order, I'll send one nudge when your box is probably running low.\n\nReply STOP any time.",   // C3
    complaintThanks: "Thank you.\nIt's with me now, and I'll reply myself.",   // C11
    notQuiteThanks: 'Thank you.\nI read every one myself.',   // C12
    failed: "Sorry, that didn't go through on our side. Please try again in a minute.",   // as contacts.js: an unsaved choice is never confirmed
  },
};
const BUTTONS = {
  consent: [{ id: 'j4_yes', title: 'Yes, keep me posted' }, { id: 'j4_no', title: 'No thanks' }],
  reminder: [{ id: 'j4_remind_yes', title: 'Yes, remind me' }, { id: 'j4_remind_no', title: 'No thanks' }],
};
const J7_REMIND_TEXT = 'j7_remind: Remind me to reorder';   // the batch alert's quick reply (ruling R10)
const TAP = /^j3:(loved|meh|wrong):([A-Za-z0-9-]{1,40})$/;  // the check-in template's quick-reply payloads (utils/reviews.js)
const BUTTON_IDS = new Set(['j4_yes', 'j4_no', 'j4_remind_yes', 'j4_remind_no', 'j7_remind']);

let deps = null;
function setDeps(d) { deps = d; } // tests only
function D() {
  if (deps) return deps;
  return {
    db: require('./database'), wa: require('./whatsapp'), mail: require('./mailer'), now: () => Date.now(),
    ownerPhone: () => String(process.env.OWNER_PHONE || '').replace(/\D/g, ''),
    inStock: async () => {   // the same sold-out list the shop uses (paused by hand or nothing left in the stock ledger)
      const stock = require('./stock');
      try { await stock.ensureFresh(); } catch (e) { console.error('[JOURNEY] stock refresh failed, using the last known list:', e.message); }
      const catalog = require('./catalog');
      return new Set(SLUGS.filter((s) => catalog.isAvailable(s)));
    },
    lang: (phone) => require('./langPrefs').getStoredLang(phone),
  };
}

const digits = (p) => String(p || '').replace(/\D/g, '');
const istDay = (ms) => new Date(ms + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const last10 = (p) => normPhone(p).slice(-10);
const ownsOrder = (phone, order) => !!order && last10(order.customer_phone).length === 10 && last10(order.customer_phone) === last10(phone);
const within = (at, nowMs, ms) => !!at && nowMs - Date.parse(at) < ms;
const stopped = (c) => !!c && c.consent_marketing !== true && c.consent_text === 'STOP';   // STOP ever: never asked again
// A No within 90 days: J4 No thanks, or any consent No with its time (a JOIN / FAIR No thanks, ruling R19).
const saidNoRecently = (c, nowMs) => !!c && (within(c.journey_declined_at, nowMs, DECLINE_MS) || (c.consent_marketing === false && within(c.consent_at, nowMs, DECLINE_MS)));

async function words(phone) {
  try { return REPLIES[await D().lang(phone)] || REPLIES.en; } catch (e) { return REPLIES.en; }
}
// Each send stands alone: one failed message never stops the next step (the alert to Prashant above all). True when sent.
async function send(label, fn) {
  try { await fn(); return true; } catch (e) { console.error(`[JOURNEY] ${label} failed:`, e.message); return false; }
}

/** That phone's paid orders, newest first (the tapped order if the lookup finds none; getRecentOrders never throws). */
async function paidOrders(phone, tapped) {
  const list = ((await D().db.getRecentOrders(normPhone(phone), 20)) || []).filter((o) => PAID.includes(o.status));
  return list.length ? list : tapped ? [tapped] : [];
}

/** The §11 consented words with the link, or null when no honest link exists: the last order went outside the delivery area
 *  (no reorder push outside Delhi NCR), or nothing from it is in stock ("your usual" would not be true). A Set last time
 *  links to Build a box (R20). */
async function reorderMessage(R, orders) {
  const newest = orders[0];
  const a = (newest && newest.delivery_address) || {};
  if (!newest || !deliveryArea.inArea(a.pincode || deliveryArea.pinIn(a.raw || ''))) return null;
  let inStock;
  try { inStock = await D().inStock(); } catch (e) { console.error('[JOURNEY] could not read stock:', e.message); return null; }
  const c = cartLink({ orders, inStock, campaign: 'j4_reorder', medium: 'journey' });
  if (!c.favSlug) return null;
  const line = c.path.startsWith('build-a-box') ? R.setReady : c.trySlug ? R.usualWithTry(NAME[c.trySlug]) : R.usual;
  return `${line}\n\n${SITE}${c.path}`;
}

// Replies that carry the clip, by wamid: Meta reports a clip it cannot fetch later, as a 'failed' status, so the plain words
// must follow then (R21). In memory only (a restart forgets), at most CLIP_CAP, each for 24 h. wamid -> { to, plain, at }.
const CLIP_CAP = 500, CLIP_TTL_MS = DAY;
const clipSends = new Map();
function rememberClip(wamid, { to, plain }) {
  if (!wamid) return;
  const nowMs = D().now();
  for (const [id, e] of clipSends) { if (nowMs - e.at > CLIP_TTL_MS) clipSends.delete(id); else break; }   // oldest first
  clipSends.set(wamid, { to, plain, at: nowMs });
  while (clipSends.size > CLIP_CAP) clipSends.delete(clipSends.keys().next().value);
}
/** Exactly what goes when there is no clip: each part as plain text, or text with its buttons. */
async function sendPlain(phone, parts) {
  const { wa } = D();
  for (const p of parts) await send('loved reply', () => (p.buttons ? wa.sendButtons(phone, p.text, p.buttons) : wa.sendText(phone, p.text)));
}

/** The first Loved it reply. parts: [{ text, buttons? }] (only the last may have buttons). Meta does not keep separate
 *  messages in order, so the "unlock" clip rides IN the reply (R17): with buttons, one button message with the clip as its
 *  header and all the words as its body; without, the clip with the words as its caption. No JOURNEY_UNLOCK_VIDEO_URL, or
 *  the clip is refused: the plain messages, exactly as without the video. */
async function replyLoved(phone, parts) {
  const { wa } = D();
  const url = require('./journeyMedia').unlockVideo();
  if (url) {
    const body = parts.map((p) => p.text).join('\n\n');
    const buttons = parts[parts.length - 1].buttons;
    try {
      const res = await (buttons ? wa.sendButtons(phone, body, buttons, { header: { type: 'video', link: url } }) : wa.sendVideo(phone, url, body));
      rememberClip(res && res.messages && res.messages[0] && res.messages[0].id, { to: phone, plain: parts });
      return;
    } catch (e) { console.error('[JOURNEY] unlock clip refused, sending the plain words:', e.message); }
  }
  await sendPlain(phone, parts);
}

/** Every WhatsApp status (server.js): a clip reply Meta failed to deliver (it could not fetch the video) is followed ONCE by the
 *  plain words. True when it resent. Never throws. */
async function noteStatus(s) {
  try {
    const entry = s && s.id ? clipSends.get(s.id) : null;
    if (!entry) return false;
    if (s.status === 'delivered' || s.status === 'read') { clipSends.delete(s.id); return false; }   // the clip went through
    if (s.status !== 'failed') return false;
    clipSends.delete(s.id);   // once only
    if (D().now() - entry.at > CLIP_TTL_MS) return false;
    const err = s.errors && s.errors[0];
    console.error(`[JOURNEY] clip reply ${s.id} to ${entry.to} failed${err ? ` (${err.code})` : ''}; sending the plain words`);
    await sendPlain(entry.to, entry.plain);
    return true;
  } catch (e) {
    console.error('[JOURNEY] noteStatus failed:', e.message);
    return false;
  }
}

/** Something wasn't right, to Prashant: WhatsApp (if OWNER_PHONE is set) as an extra, and email. True only when the EMAIL was
 *  accepted: Meta can accept a WhatsApp to the owner and drop it outside his 24 h window (R22). Internal words. */
async function tellOwner({ phone, name, orderId, headline, body, emailMessage }) {
  const { wa, mail, ownerPhone } = D();
  const p = digits(phone), owner = ownerPhone();
  const msg = `${headline}\n\nOrder: ${orderId}\nCustomer: ${String(name || '').trim() || 'Unknown'}\nWhatsApp: +${p}\n\n${body}\n\nReply directly on WhatsApp: https://wa.me/${p}`;
  if (owner) await send('owner WhatsApp', () => wa.sendText(owner, msg));
  else console.warn('[JOURNEY] OWNER_PHONE not set — owner not notified via WhatsApp');
  return send('owner email', () => mail.sendComplaintAlert({ customerPhone: p, customerName: name, orderId, message: emailMessage }));
}

async function loved(phone, order, R) {
  const { db, now } = D();
  let c = null;
  try { c = await db.getContact(phone); }
  catch (e) { console.error('[JOURNEY] could not read the contact:', e.message); return replyLoved(phone, [{ text: R.lovedNoAsk }]); }   // unsure of consent: ask nothing, link nothing
  if (c && c.consent_marketing === true) {
    const msg = await reorderMessage(R, await paidOrders(phone, order));
    if (!msg) return replyLoved(phone, [{ text: R.lovedNoAsk }]);
    const parts = [{ text: msg }];
    if (!contacts.coversReminders(c)) parts.push({ text: R.askReminder, buttons: BUTTONS.reminder });
    return replyLoved(phone, parts);
  }
  if (stopped(c) || saidNoRecently(c, now())) return replyLoved(phone, [{ text: R.lovedNoAsk }]);
  return replyLoved(phone, [{ text: R.askConsent, buttons: BUTTONS.consent }]);
}

async function notQuite(phone, order, R) {
  const { db, wa, now } = D();
  try { await db.setSuggestionWait(phone, new Date(now()).toISOString(), 'not_quite', order.order_id); } catch (e) { console.error('[JOURNEY] could not remember the not-quite wait:', e.message); }
  await send('not-quite question', () => wa.sendText(phone, R.notQuite));
}

async function somethingWrong(phone, name, order, R) {
  const { db, wa, now } = D();
  const at = new Date(now()).toISOString();
  try { await db.setSuggestionWait(phone, at, 'complaint', order.order_id); } catch (e) { console.error('[JOURNEY] could not remember the complaint wait:', e.message); }
  await send('apology', () => wa.sendText(phone, R.wrong));
  const reached = await tellOwner({
    phone, name: name || order.customer_name, orderId: order.order_id,
    headline: "⚠️ *Check-in: Something wasn't right*",
    body: 'They were asked what happened and for a photo. Their next message within 24 h comes to you here and by email.',
    emailMessage: `Tapped "Something wasn't right" on the check-in. Their next message within 24 h is forwarded to you.`,
  });
  if (!reached) console.error(`[JOURNEY] Something wasn't right on ${order.order_id}: the owner email failed; it is on the order timeline (journey_complaint)`);
  try { await db.logOrderEvent({ actor_name: 'Customer', order_id: order.order_id, event: 'journey_complaint', meta: {} }); } catch (e) { console.error('[JOURNEY] could not log the complaint:', e.message); }
  try { await db.updateContact(phone, { last_complaint_at: at }); } catch (e) { console.error('[JOURNEY] could not mark the complaint on the contact:', e.message); }   // update only: never creates a contact
}

/** j4_yes / j4_no / j4_remind_yes / j4_remind_no / j7_remind. */
async function answerButton(phone, id, name) {
  const { db, wa, now } = D();
  const R = await words(phone);
  if (id === 'j4_remind_no') { await send('C13', () => wa.sendText(phone, R.declined)); return true; }   // no change (R18)
  const at = new Date(now()).toISOString();
  const source = 'journey:' + istDay(now());
  const who = name ? { name } : {};
  const failed = () => send('try-again line', () => wa.sendText(phone, R.failed));
  if (id === 'j4_yes') {
    const r = await contacts.save(phone, { ...who, consent_marketing: true, consent_reminder: true, consent_at: at, consent_text: R.askConsent, last_source: source }, source);
    if (!r.ok) { await failed(); return true; }   // never confirm a yes we did not record
    await send('C7', () => wa.sendText(phone, R.onList));
    const msg = await reorderMessage(R, await paidOrders(phone, null));
    if (msg) await send('reorder link', () => wa.sendText(phone, msg));
    return true;
  }
  if (id === 'j4_no') {
    const r = await contacts.save(phone, { ...who, journey_declined_at: at }, source);
    if (!r.ok) { await failed(); return true; }
    await send('C13', () => wa.sendText(phone, R.declined));
    return true;
  }
  // j4_remind_yes and j7_remind add the reminder yes to an existing marketing yes; anyone else gets the normal menu.
  let c = null;
  try { c = await db.getContact(phone); } catch (e) { console.error('[JOURNEY] could not read the contact:', e.message); }
  if (!c || c.consent_marketing !== true) return false;
  const text = id === 'j7_remind' ? J7_REMIND_TEXT : `${R.askReminder} | Yes, remind me`;
  const r = await contacts.save(phone, { consent_reminder: true, consent_text: text }, source);   // consent_at stays the marketing yes (R6-fix)
  if (!r.ok) { await failed(); return true; }
  await send('C3', () => wa.sendText(phone, R.remindDone));   // both: C3 (R18)
  return true;
}

/** Any other button means the buyer moved on: an open check-in wait must not swallow what they type next. */
async function dropCheckinWait(phone) {
  const { db } = D();
  try {
    const wait = await db.getSuggestionWait(phone);
    if (wait && WAIT_KINDS.includes(wait.kind)) await db.clearSuggestionWait(phone);
  } catch (e) { console.error('[JOURNEY] could not drop the check-in wait:', e.message); }
}

/** A button tap. True when it was a journey button and has been answered; false lets the normal menu answer. */
async function handleTap(phone, payloadId, name) {
  const id = String(payloadId || '');
  const m = id.match(TAP);
  if (!m) {
    if (BUTTON_IDS.has(id)) return answerButton(phone, id, name);
    await dropCheckinWait(phone);
    return false;
  }
  const [, kind, orderId] = m;
  const { db, wa } = D();
  let order = null;
  try { order = await db.getOrder(orderId); } catch (e) { console.error('[JOURNEY] could not read the order:', e.message); }
  if (!ownsOrder(phone, order)) return false;   // not theirs, or no such order: the normal menu, and nothing about the order
  const R = await words(phone);
  let first = true;
  try { first = await db.claimOrderEvent({ actor_name: 'Customer', order_id: orderId, event: 'journey_tap', meta: { kind } }); }
  catch (e) { console.error('[JOURNEY] could not record the tap, answering it as the first:', e.message); }
  if (kind === 'wrong') await somethingWrong(phone, name, order, R);   // every time: a problem always reaches Prashant
  else if (!first) await send('repeat tap', () => wa.sendText(phone, R.alreadyAnswered));
  else if (kind === 'loved') await loved(phone, order, R);
  else await notQuite(phone, order, R);
  return true;
}

/** The buyer's next message after Something wasn't right / Not quite (within 24 h). True when it was taken. Never throws. */
async function captureReply(phone, name, type, text) {
  try {
    const { db, wa, mail, now } = D();
    if (type !== 'text' && !MEDIA[type]) return false;
    if (type === 'text' && contacts.isStop(text)) return false;   // STOP always reaches the bot (opt-out)
    let wait;
    try { wait = await db.getSuggestionWait(phone); } catch (e) { console.error('[JOURNEY] could not read the wait:', e.message); return false; }
    if (!wait || !WAIT_KINDS.includes(wait.kind)) return false;   // none, or a suggestion wait (utils/suggestions.js)
    if (!within(wait.asked_at, now(), WAIT_MS)) {   // stale: cleared, so it no longer holds broadcast replies back
      try { await db.clearSuggestionWait(phone); } catch (e) { console.error('[JOURNEY] could not clear the wait:', e.message); }
      return false;
    }
    // In the middle of a bot order (typing the delivery address): the bot keeps the message, the wait stays (as broadcastReplies.js).
    try { if (await db.getRecentPendingOrder(digits(phone))) return false; }
    catch (e) { console.error('[JOURNEY] could not check for an order in progress:', e.message); return false; }
    try { await db.clearSuggestionWait(phone); } catch (e) { console.error('[JOURNEY] could not clear the wait:', e.message); }
    const R = await words(phone);
    const orderId = wait.order_id || 'unknown order';
    const t = String(text || '').trim().slice(0, MAX_LEN);
    const media = MEDIA[type] ? `[sent ${MEDIA[type]}]${t ? ` "${t}"` : ''}` : null;
    if (wait.kind === 'complaint') {
      // Always on the order timeline first, so the follow-up is never lost even if neither alert reaches Prashant.
      if (wait.order_id) {
        try { await db.logOrderEvent({ actor_name: 'Customer', order_id: wait.order_id, event: 'journey_complaint_followup', meta: media ? { media: type, ...(t ? { text: t } : {}) } : { text: t } }); }
        catch (e) { console.error('[JOURNEY] could not keep the complaint follow-up on the timeline:', e.message); }
      }
      const reached = await tellOwner({
        phone, name, orderId,
        headline: "📩 *Check-in reply: Something wasn't right*",
        body: media ? `${media}\nIt cannot be shown here: ask them to send it to you on WhatsApp if you need to see it.` : `"${t}"`,
        emailMessage: media || t,
      });
      if (reached) await send('C11', () => wa.sendText(phone, R.complaintThanks));
      else console.error(`[JOURNEY] complaint follow-up on ${orderId}: the owner email failed; no C11 sent, it is on the order timeline`);
    } else {
      const line = `[check-in ${orderId}] ${media || t}`;
      await suggestions.recordFeedback(phone, name, null, line);   // never throws; saved as kind 'feedback' (ruling R12)
      await send('owner email', () => mail.sendCheckinFeedbackAlert({ phone: digits(phone), name, orderId, text: line }));
      await send('C12', () => wa.sendText(phone, R.notQuiteThanks));
    }
    return true;
  } catch (e) {
    console.error('[JOURNEY] captureReply failed:', e.message);
    return false;
  }
}

module.exports = { handleTap, captureReply, noteStatus, REPLIES, BUTTONS, J7_REMIND_TEXT, setDeps, _rememberClip: rememberClip, _clipCount: () => clipSends.size };
