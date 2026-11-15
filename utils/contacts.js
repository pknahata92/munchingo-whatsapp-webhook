'use strict';
// Contact capture (25 Oct 2026). A buyer at an event scans the counter QR; WhatsApp opens with "FAIR" typed and they send
// it. We keep their number (WhatsApp gives it to us) and WhatsApp name, ask ONCE for marketing consent with two buttons,
// and store the answer with its time and the exact question. Nothing is assumed from the scan itself. STOP always
// withdraws consent. Marketing sends must only go to consent_marketing = true (table: contacts_migration.sql).

// C2 (approved by Prashant): the question asked today. Only a yes to THIS wording sets consent_reminder. Its buttons carry their own
// ids (optin2_*), so a tap on a question sent before C2 went live is recorded against the words that person actually saw.
const CONSENT_QUESTION = 'Thanks for stopping by Munchingo! 🍪\n\nMay I message you when a fresh batch leaves Bikaner, when a new Flavor lands, or a few weeks after an order, when your box is probably running low? At most 3 a month. Reply STOP any time and it stops.';
const BUTTONS = [{ id: 'optin2_yes', title: 'Yes, keep me posted' }, { id: 'optin2_no', title: 'No thanks' }];
// v1, the question asked before C2 (buttons optin_yes / optin_no, still in old chats): it never named the reorder nudge.
const CONSENT_QUESTION_V1 = 'Thanks for stopping by Munchingo! 🍪\n\nCan we send you new Flavors, launches and offers on WhatsApp? A few messages a month at most. Reply STOP any time to stop.';
const REPLY = {
  yes: "Done, you're on the list. 🙏 Want more now? Tap below to order on WhatsApp, or visit munchingo.com.",
  no: "No problem, I won't send these. Enjoy them. 🍪",
  already: "You're already on the list, thank you! 🙏 Tap below to order on WhatsApp, or visit munchingo.com.",
  stop: "Done, I won't send you these messages. You can still message us here any time.",
  waitlist: (city) => `Noted. I'll message you once when we deliver to ${city}, and nothing else.`,
  failed: "Sorry, that didn't go through on our side. Please try again in a minute.",
};
// After Yes / No / already-joined the chat leads straight into ordering (routeInteractive: btn_products -> product list).
const SHOP_BUTTON = [{ id: 'btn_products', title: '🛒 Browse Products' }];
// Keyword typed in the QR's pre-filled message -> where the contact came from. Add a keyword per place (parcel card, carton...).
const KEYWORDS = { fair: 'fair', join: 'join', notify: 'notify' };   // fair: stall counter card; join: lnk.bio button (poster + coupon-card QR)

let deps = null;
function setDeps(d) { deps = d; } // tests only
function D() {
  if (deps) return deps;
  return { db: require('./database'), wa: require('./whatsapp'), now: () => Date.now() };
}

/** The source keyword if this message is a sign-up ("FAIR", or "FAIR - I bought ..."), else null. */
function signupSource(text) {
  const m = String(text || '').trim().toLowerCase().match(/^([a-z]+)\b/);
  if (!m || !KEYWORDS[m[1]]) return null;
  const rest = String(text).trim().slice(m[1].length);
  if (rest && !/^\s*[-–—:,.!]/.test(rest)) return null;   // "fairly good" or "fair price?" is not a sign-up
  return KEYWORDS[m[1]];
}
const isStop = (text) => /^\s*(stop|unsubscribe)\s*[.!]?\s*$/i.test(String(text || ''));
const istDay = (ms) => new Date(ms + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

// New contact: insert with first_source. Existing contact: plain update of the given fields only (an upsert without
// first_source fails Postgres' NOT NULL check before the conflict is resolved). Returns { ok, old }.
async function save(phone, fields, firstSource) {
  const { db, now } = D();
  const at = new Date(now()).toISOString();
  try {
    const old = await db.getContact(phone);
    if (old) await db.updateContact(phone, { ...fields, updated_at: at });
    else await db.insertContact({ phone, ...fields, first_source: firstSource, updated_at: at });
    return { ok: true, old };
  } catch (e) {
    console.error('[CONTACTS] save failed for', phone, e.message);
    return { ok: false, old: undefined };
  }
}

/** "NOTIFY - Jaipur": a buyer outside the delivery area asks to hear when we arrive. Never sets consent. */
async function handleWaitlist(phone, name, text) {
  const { wa, now } = D();
  const raw = String(text || '').trim().replace(/^notify\b/i, '').replace(/^\s*[-–—:,.!]+/, '').replace(/[\s.!]+$/, '').replace(/\s+/g, ' ').replace(/:/g, '').trim().slice(0, 40);
  const city = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'your city';
  const source = 'waitlist:' + (raw ? raw.toLowerCase() : 'unknown') + ':' + istDay(now());
  const r = await save(phone, { name: name || null, last_source: source }, source);
  if (!r.ok) return wa.sendText(phone, REPLY.failed);
  return wa.sendText(phone, REPLY.waitlist(city));
}

/** Stamp the time of the contact's latest message. Never throws, never creates a contact (the db call updates existing rows only). */
async function touchInbound(phone) {
  try {
    const { db, now } = D();
    await db.touchInbound(phone, new Date(now()).toISOString());
  } catch (e) {
    console.error('[CONTACTS] touchInbound failed:', e.message);
  }
}

/** True only when the contact said yes to the wording that names the reorder nudge. */
const coversReminders = (c) => !!c && c.consent_marketing === true && c.consent_reminder === true;

async function handleSignup(phone, name, keyword, text) {
  const { wa, now } = D();
  if (String(keyword || '').trim().toLowerCase() === 'notify') return handleWaitlist(phone, name, text);
  const source = (KEYWORDS[String(keyword || '').trim().toLowerCase()] || 'fair') + ':' + istDay(now());
  const { old } = await save(phone, { name: name || null, last_source: source }, source);
  if (old && old.consent_marketing === true) return wa.sendButtons(phone, REPLY.already, SHOP_BUTTON);
  return wa.sendButtons(phone, CONSENT_QUESTION, BUTTONS);
}

/** A tap on the consent question. version 'v1': the old question (optin_yes / optin_no), recorded with its own words and no
 *  reminder consent; a v1 Yes never lowers a reminder yes the contact already gave, so their record is then left as it is. */
async function handleOptIn(phone, yes, version = 'v2') {
  const { db, wa, now } = D();
  const at = new Date(now()).toISOString();
  let fields = { consent_marketing: !!yes, consent_reminder: !!yes, consent_at: at, consent_text: CONSENT_QUESTION };
  if (version === 'v1') {
    fields = { consent_marketing: !!yes, consent_reminder: false, consent_at: at, consent_text: CONSENT_QUESTION_V1 };
    if (yes) {
      let old = null;
      try { old = await db.getContact(phone); } catch (e) { console.error('[CONTACTS] could not read the contact before a v1 yes:', e.message); }
      if (old && old.consent_marketing === true && old.consent_reminder === true) fields = {};   // already on the list, reminders too
    }
  }
  const r = await save(phone, fields, 'button');
  if (!r.ok) return wa.sendText(phone, REPLY.failed);   // never confirm an answer we did not record
  return wa.sendButtons(phone, yes ? REPLY.yes : REPLY.no, SHOP_BUTTON);
}

async function handleStop(phone) {
  const { wa, now } = D();
  const r = await save(phone, { consent_marketing: false, consent_reminder: false, consent_at: new Date(now()).toISOString(), consent_text: 'STOP' }, 'stop');
  if (!r.ok) return wa.sendText(phone, REPLY.failed);
  return wa.sendText(phone, REPLY.stop);
}

module.exports = { SHOP_BUTTON, signupSource, isStop, handleSignup, handleWaitlist, handleOptIn, handleStop, touchInbound, coversReminders, setDeps, CONSENT_QUESTION, CONSENT_QUESTION_V1, BUTTONS, KEYWORDS, save, D };
