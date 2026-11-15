'use strict';
// Checkout WhatsApp opt-in (27 Oct 2026). The checkout page has ONE unticked box with CONSENT_TEXT. A tick rides on the
// order (delivery_address.marketing: the exact sentence and the time, no migration); when the payment succeeds the BUYER
// joins `contacts` with consent. Unticked changes nothing; a STOP sent after the tick wins; gift recipients never join.
const CONSENT_TEXTS = {
  v1: 'Send me new Flavors and offers on WhatsApp. A few messages a month. Reply STOP any time.',
  v2: 'Send me fresh batches, new Flavors and one nudge when my box is likely running low, on WhatsApp. At most 3 a month. Reply STOP any time.',   // DRAFT C4: names the reorder nudge
};
const CONSENT_TEXT = CONSENT_TEXTS.v1;   // kept so existing imports keep working

const istDay = (ms) => new Date(ms + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

/** Called at checkout: `true` stores the v1 text, 'v2' the v2 text; anything else counts as unticked. */
function attach(parts, marketing, now = Date.now()) {
  const text = marketing === true ? CONSENT_TEXTS.v1 : marketing === 'v2' ? CONSENT_TEXTS.v2 : null;
  if (text) parts.marketing = { text, at: new Date(now).toISOString() };
  return parts;
}

/** Called after payment_link.paid. Returns { joined, reason }. Never throws. */
async function onPaid(order) {
  try {
    const m = order && order.delivery_address && order.delivery_address.marketing;
    if (!order || order.status !== 'paid') return { joined: false, reason: 'not paid' };
    if (!m || (m.text !== CONSENT_TEXTS.v1 && m.text !== CONSENT_TEXTS.v2) || !m.at) return { joined: false, reason: 'not ticked' };
    const phone = String(order.customer_phone || '').replace(/\D/g, '');
    if (phone.length < 12) return { joined: false, reason: 'no valid buyer phone' };
    const contacts = require('./contacts');
    const old = await contacts.D().db.getContact(phone);
    if (old && old.consent_marketing === false && old.consent_at && Date.parse(old.consent_at) > Date.parse(m.at)) {
      return { joined: false, reason: 'STOP after the tick' };
    }
    const source = 'website:' + istDay(Date.parse(m.at));
    const r = await contacts.save(phone, { name: order.customer_name || null, consent_marketing: true, consent_reminder: m.text === CONSENT_TEXTS.v2, consent_at: m.at, consent_text: m.text, last_source: source }, source);
    return { joined: !!r.ok, reason: r.ok ? 'joined' : 'save failed' };
  } catch (e) {
    console.error('[OPTIN] could not record the checkout opt-in:', e.message);
    return { joined: false, reason: 'error' };
  }
}

module.exports = { CONSENT_TEXT, CONSENT_TEXTS, attach, onPaid };
