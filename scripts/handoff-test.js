'use strict';
// "Connect me to a person" detection, and the owner alert (WhatsApp + email) with the person's details.   node scripts/handoff-test.js
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const { wantsHuman } = require('../utils/handoff');

const yes = ['human', 'I want to talk to a human', 'talk to the owner', 'Can I speak to the owner please', 'connect me to an agent', 'agent', 'Owner', 'please connect me with owner',
  'I need a real person', 'live agent please', 'customer care number', 'support', 'call me', 'Please call me back', 'owner ka number', 'mujhe owner se baat karni hai', 'kisi se baat karni hai',
  'baat karwa do', 'insaan se baat karao', 'malik se baat karo', 'founder se baat', 'connect me to the manager', 'can someone call me', 'talk to someone from your team', 'I want to speak with Prashant',
  'मुझे मालिक से बात करनी है', 'एजेंट से बात करवाओ', 'ग्राहक सेवा', 'कॉल करो', 'transfer me to a representative'];
const no = ['hi', 'hello', 'order status', 'I want 2 boxes of Kesari', 'My address is 12 Manager Colony, Delhi', 'How much is the Trio?', 'send payment link', 'refund policy', 'Original', '4', 'agent colony near the market behind the temple road',
  'yes', 'thanks', 'where is my order', 'do you deliver to Pune', 'is it sugar free'];
for (const m of yes) ok(wantsHuman(m), 'should connect: ' + m);
for (const m of no) ok(!wantsHuman(m), 'should NOT connect: ' + m);

(async () => {
  const sent = [], mails = [];
  const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  stub('../utils/whatsapp', { sendText: async (to, text) => { sent.push({ to, text }); }, sendButtons: async () => {}, sendList: async () => {}, sendTemplate: async () => {} });
  stub('../utils/mailer', new Proxy({ sendHumanHandoffAlert: async (a) => { mails.push(a); } }, { get: (t, k) => t[k] || (async () => {}) }));
  stub('../utils/database', new Proxy({ getRecentOrders: async () => [{ order_id: 'MNG-TEST-1', status: 'paid', total: 607, created_at: '2026-10-25T10:00:00Z' }] }, { get: (t, k) => t[k] || (async () => null) }));
  process.env.OWNER_PHONE = '919999987161'; process.env.RESEND_API_KEY = 'x';
  const h = require('../handlers/messageHandler');
  await h.routeText('919876543210', 'can I talk to the owner please', 'Asha');
  const ownerMsg = sent.find((s) => s.to === '919999987161');
  ok(sent.some((s) => s.to === '919876543210' && /real person/i.test(s.text)), 'the customer gets the reassurance');
  ok(ownerMsg && /Asha/.test(ownerMsg.text) && /919876543210/.test(ownerMsg.text) && /talk to the owner/.test(ownerMsg.text) && /wa\.me\/919876543210/.test(ownerMsg.text), 'owner WhatsApp has name, number, message and a reply link');
  ok(ownerMsg && /MNG-TEST-1/.test(ownerMsg.text) && /607/.test(ownerMsg.text), 'owner WhatsApp shows the latest order');
  ok(mails.length === 1 && mails[0].customerPhone === '919876543210' && /MNG-TEST-1/.test(mails[0].orderLine || ''), 'owner email carries the details and the latest order');
  sent.length = 0; mails.length = 0;
  await h.routeText('919876543210', 'मुझे मालिक से बात करनी है', 'Asha');
  ok(mails.length === 1, 'Hindi request also alerts the owner');
  sent.length = 0; mails.length = 0;
  await h.routeText('919876543210', 'Manager Colony, Delhi', 'Asha');
  ok(mails.length === 0, 'an address containing Manager does not alert');
  console.log(`handoff-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
