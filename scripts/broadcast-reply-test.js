'use strict';
// Replies to a broadcast (8 Nov 2026, Prashant: "forward replies to me", with the sender's name and number).
// For 3 days after someone was sent a broadcast, what they write back goes to Prashant (WhatsApp + email) and the bot
// stays quiet. STOP still opts them out. The text is passed on, never stored.
//   node scripts/broadcast-reply-test.js
process.env.SUPABASE_URL = 'x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
// utils/mailer.js builds its Resend client on require; a fake key, never a real one (nothing is sent here).
process.env.RESEND_API_KEY = 'x';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const r = require('../utils/broadcastReplies');
const HOUR = 3_600_000, NOW = Date.parse('2026-11-08T12:00:00Z');
const OWNER = '919999900000', ASHA = '919000000001';

function world({ sends = [], waFails = false, mailFails = false, pendingOrder = null, suggestionWait = null } = {}) {
  const wa = [], mail = [];
  r.setDeps({
    db: { listRecentMarketingSends: async (last10, sinceIso) => sends.filter((s) => s.phone.endsWith(last10) && s.sent_at >= sinceIso),
          getRecentPendingOrder: async () => pendingOrder, getSuggestionWait: async () => suggestionWait },
    wa: { sendText: async (to, text) => { if (waFails) throw new Error('131047 re-engagement'); wa.push({ to, text }); } },
    mail: { sendBroadcastReplyAlert: async (a) => { if (mailFails) throw new Error('resend down'); mail.push(a); } },
    now: () => NOW, ownerPhone: () => OWNER,
  });
  return { wa, mail };
}
const S = (phone, hoursAgo, status = 'sent', template = 'munchingo_diwali_2026') => ({ phone, status, template, sent_at: new Date(NOW - hoursAgo * HOUR).toISOString() });

(async () => {
  // a reply within 3 days of a delivered broadcast goes to Prashant, with name and number, and the bot stays quiet
  let w = world({ sends: [S(ASHA, 5)] });
  let res = await r.maybeForward({ from: ASHA, name: 'Asha Rao', type: 'text', text: 'Happy Diwali to you too!' });
  ok(res === true, 'a reply after a broadcast is forwarded (bot stays quiet)');
  ok(w.wa.length === 1 && w.wa[0].to === OWNER, 'forwarded to the owner on WhatsApp');
  const msg = (w.wa[0] || {}).text || '';
  ok(msg.includes('Asha Rao'), 'the forward shows the sender name');
  ok(msg.includes('+919000000001'), 'the forward shows the sender number');
  ok(msg.includes('Happy Diwali to you too!'), 'the forward shows what they wrote');
  ok(msg.includes('https://wa.me/919000000001'), 'the forward has a one-tap link to reply');
  ok(msg.includes('munchingo_diwali_2026'), 'the forward says which broadcast they are answering');
  ok(w.mail.length === 1 && w.mail[0].phone === ASHA && w.mail[0].name === 'Asha Rao' && w.mail[0].text === 'Happy Diwali to you too!', 'the same reply is emailed with name, number and text');

  // no name on their WhatsApp profile: still clear
  w = world({ sends: [S(ASHA, 5)] });
  await r.maybeForward({ from: ASHA, name: '', type: 'text', text: 'thanks' });
  ok(/No name/.test(w.wa[0].text) && w.wa[0].text.includes('+919000000001'), 'a sender with no profile name shows "No name" and the number');

  // not on a broadcast, or too long ago, or the broadcast failed: the bot answers as usual
  w = world({ sends: [] });
  ok(await r.maybeForward({ from: ASHA, name: 'Asha', type: 'text', text: 'hi' }) === false && w.wa.length === 0, 'someone never broadcast to gets the normal bot');
  w = world({ sends: [S(ASHA, 73)] });
  ok(await r.maybeForward({ from: ASHA, name: 'Asha', type: 'text', text: 'hi' }) === false, 'a reply more than 3 days after the broadcast gets the normal bot');
  w = world({ sends: [S(ASHA, 5, 'failed')] });
  ok(await r.maybeForward({ from: ASHA, name: 'Asha', type: 'text', text: 'hi' }) === false, 'someone whose broadcast failed (never received it) gets the normal bot');

  // STOP always opts out through the bot, never forwarded
  w = world({ sends: [S(ASHA, 5)] });
  ok(await r.maybeForward({ from: ASHA, name: 'Asha', type: 'text', text: 'STOP' }) === false && w.wa.length === 0, 'STOP is not forwarded, so the opt-out still works');

  // Prashant's own messages to the bot are never forwarded to himself
  w = world({ sends: [S(OWNER, 5)] });
  ok(await r.maybeForward({ from: OWNER, name: 'Prashant', type: 'text', text: 'hi' }) === false && w.wa.length === 0, 'the owner talking to the bot is not forwarded');

  // a photo or voice note: forwarded as a note, with name and number
  w = world({ sends: [S(ASHA, 5)] });
  ok(await r.maybeForward({ from: ASHA, name: 'Asha Rao', type: 'image', text: 'our diya' }) === true, 'a photo reply is forwarded too');
  ok(/photo/i.test(w.wa[0].text) && w.wa[0].text.includes('our diya') && w.wa[0].text.includes('Asha Rao') && w.wa[0].text.includes('+919000000001'), 'the photo forward names the sender, the number and the caption');

  // WhatsApp to the owner fails (no open 24-hour window): the email still goes, still forwarded
  w = world({ sends: [S(ASHA, 5)], waFails: true });
  ok(await r.maybeForward({ from: ASHA, name: 'Asha', type: 'text', text: 'lovely' }) === true && w.mail.length === 1, 'WhatsApp failing still emails the reply');
  // both fail: let the bot answer rather than leave them unanswered and unseen
  w = world({ sends: [S(ASHA, 5)], waFails: true, mailFails: true });
  ok(await r.maybeForward({ from: ASHA, name: 'Asha', type: 'text', text: 'lovely' }) === false, 'if neither WhatsApp nor email reaches Prashant, the bot answers as usual');

  // the number match ignores the country-code form (contacts may be stored as 10 digits)
  w = world({ sends: [S('9000000001', 5)] });
  ok(await r.maybeForward({ from: ASHA, name: 'Asha', type: 'text', text: 'hi there' }) === true, 'matches a send logged with a 10-digit number');

  // someone in the middle of a bot conversation keeps the bot: their address or suggestion must not be forwarded
  w = world({ sends: [S(ASHA, 5)], pendingOrder: { order_id: 'MNG-TEST-0001', status: 'pending_address' } });
  ok(await r.maybeForward({ from: ASHA, name: 'Asha', type: 'text', text: 'Flat 12, Sector 15, Faridabad 121007' }) === false && w.wa.length === 0, 'a customer typing their address for an order keeps the bot');
  w = world({ sends: [S(ASHA, 5)], suggestionWait: { asked_at: new Date(NOW).toISOString() } });
  ok(await r.maybeForward({ from: ASHA, name: 'Asha', type: 'text', text: 'make a bigger box' }) === false && w.wa.length === 0, 'a customer answering the suggestion question keeps the bot');

  // wiring: the real database, mailer and webhook have what the module needs
  ok(typeof require('../utils/database').listRecentMarketingSends === 'function', 'database has listRecentMarketingSends');
  ok(typeof require('../utils/mailer').sendBroadcastReplyAlert === 'function', 'mailer has sendBroadcastReplyAlert');
  const server = require('fs').readFileSync(require('path').join(__dirname, '../server.js'), 'utf8');
  ok(/broadcastReplies'\)\.maybeForward/.test(server), 'the webhook asks broadcastReplies before the bot answers');

  console.log(`broadcast-reply-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
