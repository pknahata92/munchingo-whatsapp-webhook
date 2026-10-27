'use strict';
// Owner alerts on WhatsApp (27 Oct 2026): one message to OWNER_PHONE for every paid order, and one for an order left unpaid for an
// hour, unless the same customer paid another order within 3 hours (customers retry), it is a test order, or it is the owner.
// Approved template first; plain text if the template is not usable (that only arrives inside WhatsApp's 24-hour window).
// Each alert is recorded on the order timeline so it never repeats. Nothing here ever throws into the payment flow.
//   node scripts/owner-alerts-test.js
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const H = 3600000;

function fakes({ templateFails = false, textFails = false, orders = [] } = {}) {
  const sent = [], events = [];
  return {
    sent, events,
    deps: {
      now: () => Date.parse('2026-10-27T12:00:00Z'),
      wa: {
        sendTemplate: async (to, name, lang, params) => { if (templateFails) throw new Error('template not approved'); sent.push({ to, kind: 'template', name, lang, params }); },
        sendText: async (to, text) => { if (textFails) throw new Error('outside 24h window'); sent.push({ to, kind: 'text', text }); },
      },
      db: {
        listOrderEvents: async (id) => events.filter((e) => e.order_id === id),
        logOrderEvent: async (e) => { events.push(e); },
        listOrdersSince: async (since) => orders.filter((o) => o.created_at >= since),
      },
    },
  };
}
const order = (o) => ({ order_id: 'MNG-AAAA-2710', customer_name: 'Riya Kapoor', customer_phone: '919810000001', total: 799, status: 'paid', gift_note: '', delivery_address: { city: 'Mumbai' }, items: [{ slug: 'trio-gift-set-kesari-lite-sugar-original', productName: 'Trio Gift Set', quantity: 1 }], created_at: '2026-10-27T11:00:00Z', ...o });

(async () => {
  process.env.OWNER_PHONE = '919999987161';
  const a = require('../utils/ownerAlerts');

  // ── paid order ──
  let f = fakes(); a.setDeps(f.deps);
  let r = await a.paidAlert(order());
  let m = f.sent[0];
  ok(r.sent && f.sent.length === 1 && m.to === '919999987161' && m.kind === 'template' && m.name === a.TEMPLATE.paid, 'a paid order sends the owner template to OWNER_PHONE (' + JSON.stringify(m) + ')');
  ok(JSON.stringify(m.params) === JSON.stringify(['MNG-AAAA-2710', '799', 'Riya Kapoor', '3 boxes: Trio Gift Set ×1 · Mumbai']), 'it carries order, amount, name and what to pack (' + JSON.stringify(m.params) + ')');
  ok(f.events.some((e) => e.event === 'owner_paid_alert' && e.order_id === 'MNG-AAAA-2710'), 'the alert is recorded on the order');
  await a.paidAlert(order());
  ok(f.sent.length === 1, 'the same order never alerts twice');
  f = fakes(); a.setDeps(f.deps);
  await a.paidAlert(order({ order_id: 'MNG-GIFT-2710', gift_note: 'Happy Diwali', items: [{ slug: 'atta-kesari', productName: 'Atta Kesari', quantity: 2 }, { slug: 'atta-original', productName: 'Atta Original', quantity: 1 }] }));
  ok(f.sent[0].params[3] === '3 boxes: Atta Kesari ×2, Atta Original ×1 · Mumbai · GIFT', 'a gift order is marked GIFT (' + f.sent[0].params[3] + ')');

  // template not usable: plain text; both fail: recorded as failed, never throws
  f = fakes({ templateFails: true }); a.setDeps(f.deps);
  r = await a.paidAlert(order());
  ok(r.sent && f.sent[0].kind === 'text' && /New paid order MNG-AAAA-2710/.test(f.sent[0].text) && /₹799/.test(f.sent[0].text) && /Riya Kapoor/.test(f.sent[0].text), 'no usable template: the same alert goes as plain text (' + (f.sent[0] || {}).text + ')');
  f = fakes({ templateFails: true, textFails: true }); a.setDeps(f.deps);
  let threw = false; try { r = await a.paidAlert(order()); } catch (e) { threw = true; }
  ok(!threw && r.sent === false && f.events.some((e) => e.event === 'owner_alert_failed'), 'both channels failing never throws and is recorded');
  f = fakes({ templateFails: true, textFails: true }); a.setDeps(f.deps);
  await a.paidAlert(order()); await a.paidAlert(order());
  ok(f.events.filter((e) => e.event === 'owner_alert_failed').length === 2, 'a failed alert is tried again next time (not marked sent)');

  // no OWNER_PHONE: nothing sent, nothing breaks
  delete process.env.OWNER_PHONE; f = fakes(); a.setDeps(f.deps);
  r = await a.paidAlert(order());
  ok(r.sent === false && r.reason === 'no_owner_phone' && f.sent.length === 0, 'without OWNER_PHONE nothing is sent');
  process.env.OWNER_PHONE = '+91 99999 87161';

  // ── unpaid for an hour ──
  const now = Date.parse('2026-10-27T12:00:00Z');
  const at = (hAgo) => new Date(now - hAgo * H).toISOString();
  const orders = [
    order({ order_id: 'MNG-UNP1-2710', status: 'pending_payment', created_at: at(2), customer_phone: '919810000002', customer_name: 'Om' }),                 // alert
    order({ order_id: 'MNG-UNP2-2710', status: 'pending_payment', created_at: at(0.5), customer_phone: '919810000003' }),                                    // too new
    order({ order_id: 'MNG-RTRY-2710', status: 'pending_payment', created_at: at(3), customer_phone: '919810000004' }),                                      // retried and paid
    order({ order_id: 'MNG-PAID-2710', status: 'paid', created_at: at(2.9), customer_phone: '919810000004' }),
    order({ order_id: 'MNG-TEST-2710', status: 'pending_payment', created_at: at(2), customer_phone: '919810000005' }),                                      // test
    order({ order_id: 'MNG-MINE-2710', status: 'pending_payment', created_at: at(2), customer_phone: '919999987161' }),                                      // owner
    order({ order_id: 'MNG-OLD1-2710', status: 'pending_payment', created_at: at(30), customer_phone: '919810000006' }),                                     // over a day old
    order({ order_id: 'MNG-CANC-2710', status: 'cancelled', created_at: at(2), customer_phone: '919810000007' }),                                           // cancelled
  ];
  f = fakes({ orders }); a.setDeps(f.deps);
  let sw = await a.unpaidSweep();
  ok(f.sent.length === 1 && f.sent[0].name === a.TEMPLATE.unpaid && f.sent[0].params[0] === 'MNG-UNP1-2710', 'only the real abandoned order alerts (sent: ' + f.sent.map((s) => s.params && s.params[0]).join(',') + ')');
  ok(JSON.stringify(f.sent[0].params) === JSON.stringify(['MNG-UNP1-2710', 'Om', '799', '2 hours', '919810000002']), 'it says who, how much, how long and their WhatsApp (' + JSON.stringify(f.sent[0].params) + ')');
  ok(sw.alerted === 1 && sw.skipped === 4, 'the sweep reports what it did (too new, retried, test, owner; the day-old one is not even fetched) (' + JSON.stringify(sw) + ')');
  await a.unpaidSweep();
  ok(f.sent.length === 1, 'an unpaid order alerts once, not every sweep');
  f = fakes({ orders, templateFails: true }); a.setDeps(f.deps);
  await a.unpaidSweep();
  ok(f.sent[0].kind === 'text' && /MNG-UNP1-2710/.test(f.sent[0].text) && /waiting 2 hours/.test(f.sent[0].text) && /wa\.me\/919810000002/.test(f.sent[0].text), 'unpaid falls back to text with a tap-to-chat link (' + (f.sent[0] || {}).text + ')');
  const broken = fakes({ orders }); broken.deps.db.listOrdersSince = async () => { throw new Error('db down'); }; a.setDeps(broken.deps);
  threw = false; try { sw = await a.unpaidSweep(); } catch (e) { threw = true; }
  ok(!threw && sw.error, 'a database failure never throws out of the sweep');

  // ── wiring ──
  const fs = require('fs'), path = require('path');
  const flow = fs.readFileSync(path.join(__dirname, '..', 'utils', 'invoiceFlow.js'), 'utf8');
  ok(/ownerAlerts'\)\.paidAlert\(/.test(flow), 'the paid-order flow sends the owner alert');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(/ownerAlerts'\)\.start\(\)/.test(srv), 'the server starts the unpaid sweep');
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'database.js'), 'utf8');
  ok(/async function listOrdersSince\(/.test(dbSrc) && /\blistOrdersSince\b/.test((dbSrc.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/) || ['', ''])[1]), 'database.js defines and exports listOrdersSince');

  console.log(`owner-alerts-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log(`owner-alerts-test: ${pass} passed, ${fail} failed`); process.exit(1); });
