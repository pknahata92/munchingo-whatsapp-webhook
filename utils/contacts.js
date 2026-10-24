'use strict';
// Contact capture (25 Oct 2026). A buyer at an event scans the counter QR; WhatsApp opens with "FAIR" typed and they send
// it. We keep their number (WhatsApp gives it to us) and WhatsApp name, ask ONCE for marketing consent with two buttons,
// and store the answer with its time and the exact question. Nothing is assumed from the scan itself. STOP always
// withdraws consent. Marketing sends must only go to consent_marketing = true (table: contacts_migration.sql).

const CONSENT_QUESTION = 'Thanks for stopping by Munchingo! 🍪\n\nCan we send you new Flavors, launches and offers on WhatsApp? A few messages a month at most. Reply STOP any time to stop.';
const BUTTONS = [{ id: 'optin_yes', title: 'Yes, keep me posted' }, { id: 'optin_no', title: 'No thanks' }];
const REPLY = {
  yes: "Done, you're on the list. 🙏 Want more now? Tap below to order on WhatsApp, or visit munchingo.com.",
  no: "No problem, we won't send offers. Enjoy the cookies! 🍪",
  already: "You're already on the list, thank you! 🙏 Tap below to order on WhatsApp, or visit munchingo.com.",
  stop: "Done, we won't send you offers. You can still message us here any time.",
  failed: "Sorry, that didn't go through on our side. Please try again in a minute.",
};
// After Yes / No / already-joined the chat leads straight into ordering (routeInteractive: btn_products -> product list).
const SHOP_BUTTON = [{ id: 'btn_products', title: '🛒 Browse Products' }];
// Keyword typed in the QR's pre-filled message -> where the contact came from. Add a keyword per place (parcel card, carton...).
const KEYWORDS = { fair: 'fair', join: 'join' };   // fair: stall counter card; join: lnk.bio button (poster + coupon-card QR)

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

async function handleSignup(phone, name, keyword) {
  const { wa, now } = D();
  const source = (KEYWORDS[String(keyword || '').trim().toLowerCase()] || 'fair') + ':' + istDay(now());
  const { old } = await save(phone, { name: name || null, last_source: source }, source);
  if (old && old.consent_marketing === true) return wa.sendButtons(phone, REPLY.already, SHOP_BUTTON);
  return wa.sendButtons(phone, CONSENT_QUESTION, BUTTONS);
}

async function handleOptIn(phone, yes) {
  const { wa, now } = D();
  const r = await save(phone, { consent_marketing: !!yes, consent_at: new Date(now()).toISOString(), consent_text: CONSENT_QUESTION }, 'button');
  if (!r.ok) return wa.sendText(phone, REPLY.failed);   // never confirm an answer we did not record
  return wa.sendButtons(phone, yes ? REPLY.yes : REPLY.no, SHOP_BUTTON);
}

async function handleStop(phone) {
  const { wa, now } = D();
  const r = await save(phone, { consent_marketing: false, consent_at: new Date(now()).toISOString(), consent_text: 'STOP' }, 'stop');
  if (!r.ok) return wa.sendText(phone, REPLY.failed);
  return wa.sendText(phone, REPLY.stop);
}

module.exports = { SHOP_BUTTON, signupSource, isStop, handleSignup, handleOptIn, handleStop, setDeps, CONSENT_QUESTION, BUTTONS, KEYWORDS };
