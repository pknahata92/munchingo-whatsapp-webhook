'use strict';
// Replies to a broadcast (8 Nov 2026, Prashant: "forward replies to me", with the sender's name and number).
// For REPLY_WINDOW_MS after someone was sent a broadcast (marketing_sends status 'sent'), whatever they write back goes
// to Prashant on WhatsApp (OWNER_PHONE) and by email (NOTIFY_EMAIL), and the bot stays quiet, so a "Happy Diwali to you
// too" never gets the shop menu. STOP still goes to the bot (opt-out). The owner's own messages are never forwarded.
// The text is passed on and never stored (Prashant, 8 Nov: no replies saved).
// WhatsApp to the owner only arrives if he messaged the Munchingo number in the last 24 hours (Meta's rule); the email
// always goes. If neither reaches him, the bot answers as usual so nobody is left unanswered and unseen.
// Tests: scripts/broadcast-reply-test.js

const REPLY_WINDOW_MS = 3 * 86_400_000;
const isStop = (text) => /^\s*(stop|unsubscribe)\s*[.!]?\s*$/i.test(String(text || ''));
const MEDIA = { image: 'a photo', video: 'a video', audio: 'a voice note', document: 'a document', sticker: 'a sticker' };

let deps = null;
function setDeps(d) { deps = d; } // tests only
function D() {
  if (deps) return deps;
  return {
    db: require('./database'), wa: require('./whatsapp'), mail: require('./mailer'), now: () => Date.now(),
    ownerPhone: () => String(process.env.OWNER_PHONE || '').replace(/\D/g, ''),
  };
}
const digits = (p) => String(p || '').replace(/\D/g, '');

/** { from, name, type, text } -> true if forwarded to Prashant (the bot must stay quiet), false if the bot should answer. */
async function maybeForward({ from, name, type, text }) {
  const { db, wa, mail, now, ownerPhone } = D();
  const phone = digits(from);
  if (!phone || phone.length < 10) return false;
  const owner = ownerPhone();
  if (owner && phone.slice(-10) === owner.slice(-10)) return false;
  if (type === 'text' && isStop(text)) return false;
  if (type !== 'text' && !MEDIA[type]) return false;

  let sends;
  try { sends = await db.listRecentMarketingSends(phone.slice(-10), new Date(now() - REPLY_WINDOW_MS).toISOString()); }
  catch (e) { console.error('[REPLY] could not check broadcasts:', e.message); return false; }
  const last = (sends || []).filter((s) => s.status === 'sent').sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)))[0];
  if (!last) return false;

  // In the middle of a bot conversation (typing an order address, answering the suggestion question): the bot keeps it.
  try {
    if (await db.getRecentPendingOrder(phone)) return false;
    if (await db.getSuggestionWait(phone)) return false;
  } catch (e) { console.error('[REPLY] could not check open bot conversations:', e.message); return false; }

  const who = String(name || '').trim() || 'No name';
  const body = type === 'text' ? String(text || '') : `[sent ${MEDIA[type]}${text ? `: "${text}"` : ''}; it cannot be shown here]`;
  const msg = `💬 *Reply to your broadcast*\n\n` +
    `From: ${who}\n` +
    `Number: +${phone}\n` +
    `Broadcast: ${last.template}\n\n` +
    `${type === 'text' ? `"${body}"` : body}\n\n` +
    `Reply to them: https://wa.me/${phone}`;

  let reached = false;
  if (owner) {
    try { await wa.sendText(owner, msg); reached = true; }
    catch (e) { console.error('[REPLY] WhatsApp to owner failed (no open 24 h window?):', e.message); }
  }
  try { await mail.sendBroadcastReplyAlert({ phone, name: who, template: last.template, text: body }); reached = true; }
  catch (e) { console.error('[REPLY] email to owner failed:', e.message); }

  console.log(`[REPLY] broadcast reply from ${phone} ${reached ? 'forwarded to owner' : 'NOT forwarded, bot answers'}`);
  return reached;
}

module.exports = { maybeForward, setDeps, REPLY_WINDOW_MS };
