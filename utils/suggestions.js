'use strict';
// Suggestions on WhatsApp (28 Oct 2026). "💡 Share a suggestion" in More Info, or typing suggest / suggestion / idea, asks one
// question; the customer's next message within 30 minutes is saved as the suggestion (tables: suggestions_migration.sql), the
// owner is emailed, and the customer is thanked with Prashant's promise: if we make your idea, you taste it first, free (kept by
// marking it Done in Admin > More > Suggestions). The older feedback form's answers are saved here too, as kind 'feedback'.
// A failed save is never thanked as received.
const ASK = "💡 What should we make, change or fix? New Flavors, packaging, delivery, anything.\n\nType it in one message and it comes straight to us.";
const THANKS = "🙏 Thank you, it goes straight to Prashant. We read every one.\n\nIf we make your idea, you'll taste it first, free. 🍪";
const FAILED = "Sorry, that didn't go through on our side. Please send it again in a minute.";
const WAIT_MS = 30 * 60000;
const MAX_LEN = 1000;

let deps = null;
function setDeps(d) { deps = d; } // tests only
function D() {
  if (deps) return deps;
  return { db: require('./database'), wa: require('./whatsapp'), mail: require('./mailer'), now: () => Date.now() };
}

const WORDS = '(?:suggest|suggestion|suggestions|idea|ideas|i have (?:a|an) (?:suggestion|idea))';
/** The whole message is a request to leave a suggestion ("suggest", "I have an idea!"). */
const isAsk = (text) => new RegExp(`^\\s*${WORDS}\\s*[.!?]*\\s*$`, 'i').test(String(text || ''));
/** "Suggestion: make a chocolate one" -> "make a chocolate one"; null when nothing follows. */
function inlineSuggestion(text) {
  const m = String(text || '').match(new RegExp(`^\\s*${WORDS}\\s*[:\\-–—]\\s*([\\s\\S]+)$`, 'i'));
  return m && m[1].trim() ? m[1].trim() : null;
}

async function ask(phone) {
  const { db, wa, now } = D();
  try { await db.setSuggestionWait(phone, new Date(now()).toISOString()); } catch (e) { console.error('[SUGGEST] could not remember the wait for', phone, e.message); }
  return wa.sendText(phone, ASK);
}

async function store({ phone, name, kind, text, rating }) {
  const { db } = D();
  let orderId = null;
  try { const [o] = await db.getRecentOrders(phone, 1); orderId = o ? o.order_id : null; } catch (e) { /* the suggestion matters more than the order link */ }
  return db.insertSuggestion({ phone, name: name || null, kind, text: text ? String(text).trim().slice(0, MAX_LEN) : null, rating: rating == null ? null : String(rating), order_id: orderId });
}

/** Save a suggestion, email the owner, thank the customer. Never throws. */
async function saveSuggestion(phone, name, text) {
  const { wa, mail } = D();
  let row;
  try { row = await store({ phone, name, kind: 'suggestion', text }); }
  catch (e) { console.error('[SUGGEST] save failed for', phone, e.message); return wa.sendText(phone, FAILED); }
  try { await mail.sendSuggestionAlert(row); } catch (e) { console.error('[SUGGEST] owner email failed:', e.message); }
  return wa.sendText(phone, THANKS);
}

/** If this number was asked within 30 minutes, take this message as the suggestion. Returns true when it did. */
async function capture(phone, name, text) {
  const { db, now } = D();
  let wait = null;
  try { wait = await db.getSuggestionWait(phone); } catch (e) { console.error('[SUGGEST] could not read the wait for', phone, e.message); return false; }
  if (!wait) return false;
  try { await db.clearSuggestionWait(phone); } catch (e) { console.error('[SUGGEST] could not clear the wait for', phone, e.message); }
  if (now() - Date.parse(wait.asked_at) > WAIT_MS) return false;
  await saveSuggestion(phone, name, text);
  return true;
}

/** The older feedback form (rating + comments): saved as kind 'feedback'. Never throws. */
async function recordFeedback(phone, name, rating, comments) {
  try { await store({ phone, name, kind: 'feedback', text: comments || null, rating }); }
  catch (e) { console.error('[SUGGEST] feedback save failed for', phone, e.message); }
}

module.exports = { ASK, THANKS, FAILED, isAsk, inlineSuggestion, ask, capture, saveSuggestion, recordFeedback, setDeps };
