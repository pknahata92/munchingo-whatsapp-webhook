'use strict';
// J4 (growth journey, 16 Nov 2026): what the bot says when a buyer taps a button on the day-4 check-in (J3), and what happens to
// their next message. Spec: docs/superpowers/specs/2026-11-15-growth-system-design.md §6.1; words: §11 and table C-W. A tap
// opens Meta's 24-hour window, so every reply here is free-form and uses no marketing slot.
//   Loved it        -> not consented: the consent question (Yes / No thanks), no link. Consented: the reorder cart, then the
//                      reminder question (C9) if they have not said yes to the running-low nudge. STOP, or No thanks within
//                      90 days: thanks only (ruling R1). The first Loved it reply opens with the "unlock" clip when
//                      JOURNEY_UNLOCK_VIDEO_URL is set (owner, 16 Nov).
//   Not quite       -> one question; their next message within 24 h is saved as feedback and emailed to Prashant.
//   Something wrong -> apology and a photo ask; Prashant is alerted now, and their next message within 24 h (a photo too) is
//                      forwarded to him on WhatsApp and by email. The contact gets last_complaint_at (no J6 for 30 days).
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
const WAIT_MS = DAY;                      // a check-in answer is taken within 24 h of the tap
const DECLINE_MS = 90 * DAY;              // No thanks: not asked again for 90 days
const WAIT_KINDS = ['complaint', 'not_quite'];
const MEDIA = { image: 'a photo', video: 'a video', audio: 'a voice note', document: 'a document', sticker: 'a sticker' };
const PAID = ['paid', 'shipped', 'delivered'];
const NAME = Object.fromEntries(FLAVOURS);   // 'atta-kesari' -> 'Atta Kesari'
const MAX_LEN = 1000;

// Every word a buyer sees, by language. Only English is approved so far; a Hindi copy is a new key here, not new code.
// The words are Prashant's, verbatim (§11 / C-W); only WhatsApp line breaks are added between sentences.
const REPLIES = {
  en: {
    // §11 J4, Loved it (not consented). Stored word for word as consent_text when they tap Yes.
    askConsent: "Glad to hear it.\nYou've unlocked the good stuff.\n\nMay I message you when a fresh batch leaves Bikaner, when a new Flavor lands, or a few weeks after an order, when your box is probably running low?\n\nAt most 3 a month. Reply STOP any time and it stops.",
    lovedNoAsk: "Glad to hear it.\nYou've unlocked the good stuff.",   // R1: the first two §11 sentences (STOP, declined, or nothing to link)
    usualWithTry: (flavor) => `Thank you.\nYour usual is ready in one tap whenever you want it, with one ${flavor} added to try.`,   // §11 consented
    usual: 'Thank you.\nYour usual is ready in one tap whenever you want it.',   // the same words when no untried Flavor is in stock
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
const stopped = (c) => !!c && c.consent_marketing !== true && c.consent_text === 'STOP';
const declinedRecently = (c, nowMs) => !!c && !!c.journey_declined_at && nowMs - Date.parse(c.journey_declined_at) < DECLINE_MS;

async function words(phone) {
  try { return REPLIES[await D().lang(phone)] || REPLIES.en; } catch (e) { return REPLIES.en; }
}
// Each send stands alone: one failed message never stops the next step (the alert to Prashant above all).
async function send(label, fn) {
  try { await fn(); return true; } catch (e) { console.error(`[JOURNEY] ${label} failed:`, e.message); return false; }
}

/** That phone's paid orders, newest first (the tapped order if the lookup finds none). */
async function paidOrders(phone, tapped) {
  let list = [];
  try { list = (await D().db.getRecentOrders(normPhone(phone), 20)) || []; } catch (e) { console.error('[JOURNEY] could not read orders:', e.message); }
  list = list.filter((o) => PAID.includes(o.status));
  return list.length ? list : tapped ? [tapped] : [];
}

/** The §11 consented words with the cart link, or null when no honest link exists: the last order went outside the delivery
 *  area (no reorder push outside Delhi NCR), or nothing from it is in stock ("your usual" would not be true). */
async function reorderMessage(R, orders) {
  const newest = orders[0];
  const a = (newest && newest.delivery_address) || {};
  if (!newest || !deliveryArea.inArea(a.pincode || deliveryArea.pinIn(a.raw || ''))) return null;
  let inStock;
  try { inStock = await D().inStock(); } catch (e) { console.error('[JOURNEY] could not read stock:', e.message); return null; }
  const c = cartLink({ orders, inStock, campaign: 'j4_reorder', medium: 'journey' });
  if (!c.favSlug) return null;
  return `${c.trySlug ? R.usualWithTry(NAME[c.trySlug]) : R.usual}\n\n${SITE}${c.path}`;
}

// The "unlock" clip before the first Loved it reply (owner, 16 Nov). Off until JOURNEY_UNLOCK_VIDEO_URL is set. No caption:
// the words follow in their own message. A video that fails never blocks them.
async function unlockVideo(phone) {
  const url = String(process.env.JOURNEY_UNLOCK_VIDEO_URL || '').trim();
  if (url) await send('unlock video', () => D().wa.sendVideo(phone, url));
}

/** Tell Prashant on WhatsApp (if OWNER_PHONE is set) and by email. Internal words, not customer-facing. */
async function tellOwner({ phone, name, orderId, headline, body, emailMessage }) {
  const { wa, mail, ownerPhone } = D();
  const p = digits(phone), owner = ownerPhone();
  const msg = `${headline}\n\nOrder: ${orderId}\nCustomer: ${String(name || '').trim() || 'Unknown'}\nWhatsApp: +${p}\n\n${body}\n\nReply directly on WhatsApp: https://wa.me/${p}`;
  if (owner) await send('owner WhatsApp', () => wa.sendText(owner, msg));
  else console.warn('[JOURNEY] OWNER_PHONE not set — owner not notified via WhatsApp');
  await send('owner email', () => mail.sendHumanHandoffAlert({ customerPhone: p, customerName: name, message: emailMessage, orderLine: orderId }));
}

async function loved(phone, order, R) {
  const { db, wa, now } = D();
  let c = null, known = true;
  try { c = await db.getContact(phone); } catch (e) { known = false; console.error('[JOURNEY] could not read the contact:', e.message); }
  await unlockVideo(phone);
  if (!known) return send('loved thanks', () => wa.sendText(phone, R.lovedNoAsk));   // unsure of their consent: ask nothing, link nothing
  if (c && c.consent_marketing === true) {
    const msg = await reorderMessage(R, await paidOrders(phone, order));
    if (!msg) return send('loved thanks', () => wa.sendText(phone, R.lovedNoAsk));
    await send('reorder link', () => wa.sendText(phone, msg));
    if (!contacts.coversReminders(c)) await send('reminder ask', () => wa.sendButtons(phone, R.askReminder, BUTTONS.reminder));
    return true;
  }
  if (stopped(c) || declinedRecently(c, now())) return send('loved thanks', () => wa.sendText(phone, R.lovedNoAsk));
  return send('consent ask', () => wa.sendButtons(phone, R.askConsent, BUTTONS.consent));
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
  await tellOwner({
    phone, name: name || order.customer_name, orderId: order.order_id,
    headline: "⚠️ *Check-in: Something wasn't right*",
    body: 'They were asked what happened and for a photo. Their next message within 24 h comes to you here and by email.',
    emailMessage: `Tapped "Something wasn't right" on the check-in for ${order.order_id}. Their next message within 24 h is forwarded to you.`,
  });
  try { await db.logOrderEvent({ actor_name: 'Customer', order_id: order.order_id, event: 'journey_complaint', meta: {} }); } catch (e) { console.error('[JOURNEY] could not log the complaint:', e.message); }
  try { await db.updateContact(phone, { last_complaint_at: at }); } catch (e) { console.error('[JOURNEY] could not mark the complaint on the contact:', e.message); }   // update only: never creates a contact
}

/** j4_yes / j4_no / j4_remind_yes / j4_remind_no / j7_remind. */
async function answerButton(phone, id, name) {
  const { db, wa, now } = D();
  if (id === 'j4_remind_no') return true;   // no change, no reply
  const R = await words(phone);
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
  const r = await contacts.save(phone, { consent_reminder: true, consent_at: at, consent_text: text }, source);
  if (!r.ok) { await failed(); return true; }
  if (id === 'j7_remind') await send('C3', () => wa.sendText(phone, R.remindDone));
  return true;   // j4_remind_yes: no reply (spec table)
}

/** A button tap. True when it was a journey button and has been answered; false lets the normal menu answer. */
async function handleTap(phone, payloadId, name) {
  const id = String(payloadId || '');
  const m = id.match(TAP);
  if (!m) return BUTTON_IDS.has(id) ? answerButton(phone, id, name) : false;
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
    try { await db.clearSuggestionWait(phone); } catch (e) { console.error('[JOURNEY] could not clear the wait:', e.message); }
    if (now() - Date.parse(wait.asked_at) >= WAIT_MS) return false;   // stale: cleared, so it no longer holds broadcast replies back
    const R = await words(phone);
    const orderId = wait.order_id || 'unknown order';
    const t = String(text || '').trim().slice(0, MAX_LEN);
    const media = MEDIA[type] ? `[sent ${MEDIA[type]}]${t ? ` "${t}"` : ''}` : null;
    if (wait.kind === 'complaint') {
      await tellOwner({
        phone, name, orderId,
        headline: "📩 *Check-in reply: Something wasn't right*",
        body: media ? `${media}\nIt cannot be shown here: ask them to send it to you on WhatsApp if you need to see it.` : `"${t}"`,
        emailMessage: media || t,
      });
      await send('C11', () => wa.sendText(phone, R.complaintThanks));
    } else {
      const line = `[check-in ${orderId}] ${media || t}`;
      await suggestions.recordFeedback(phone, name, null, line);   // never throws; saved as kind 'feedback' (ruling R12)
      await send('owner email', () => mail.sendSuggestionAlert({ phone: digits(phone), name, text: line, order_id: orderId }));
      await send('C12', () => wa.sendText(phone, R.notQuiteThanks));
    }
    return true;
  } catch (e) {
    console.error('[JOURNEY] captureReply failed:', e.message);
    return false;
  }
}

module.exports = { handleTap, captureReply, REPLIES, BUTTONS, J7_REMIND_TEXT, setDeps };
