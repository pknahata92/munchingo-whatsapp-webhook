'use strict';
// Runs against the practice copy:  node scripts/admin-dev.js   (in one terminal)   node scripts/admin-dev-test.js   (in another)
const fs = require('fs');
const B = 'http://localhost:8430/admin/api';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const call = async (p, tok, body, method) => { const r = await fetch(B + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
async function login(email) {
  await call('/login', null, { email });
  await new Promise((r) => setTimeout(r, 200));
  const code = fs.readFileSync('/tmp/admin-dev-code-' + email.split('@')[0] + '.txt', 'utf8');
  const v = await call('/verify', null, { email, code });
  return v.j;
}
(async () => {
  const o = await login('owner@example.com'), s = await login('staff@example.com');
  ok(o.role === 'owner' && s.role === 'staff', 'roles at login');
  const bad = await call('/login', null, { email: 'nobody@example.com' }); ok(bad.j.ok, 'login answer does not leak');
  const nv = await call('/verify', null, { email: 'nobody@example.com', code: '000000' }); ok(nv.s === 401, 'unknown email cannot verify');

  // staff: allowed
  ok((await call('/orders', s.token)).s === 200, 'staff lists orders');
  const A = 'MNG-AAAA-1010';
  ok((await call(`/orders/${A}/advance`, s.token, { to: 'shipped', carrier: 'Delhivery', awb: '1' })).s === 409, 'staff cannot skip paid->shipped');
  ok((await call(`/orders/${A}/advance`, s.token, { to: 'packed' })).j.ok, 'staff packs');
  ok((await call(`/orders/${A}/advance`, s.token, { to: 'packed' })).s === 409, 'cannot pack twice');
  ok((await call(`/orders/${A}/advance`, s.token, { to: 'shipped', carrier: 'Delhivery', awb: 'AWB1' })).j.ok, 'staff ships');
  ok((await call(`/orders/${A}/advance`, s.token, { to: 'delivered' })).j.ok, 'staff delivers');
  ok((await call(`/orders/${A}/advance`, s.token, { to: 'shipped' })).s === 409, 'staff cannot go backwards');
  ok((await call(`/orders/${A}/note`, s.token, { note: 'hi' })).j.ok, 'staff note');

  // staff: forbidden (403)
  for (const [p, b] of [[`/orders/${A}/refund`, {}], [`/orders/${A}/cancel`, {}], [`/orders/${A}/resend-invoice`, {}], [`/orders/${A}/undo`, {}], ['/stock', { slug: 'atta-kesari', available: false }], ['/team', { email: 'x@y.com', role: 'owner' }]])
    ok((await call(p, s.token, b)).s === 403, 'staff 403 on ' + p);
  ok((await call('/stock', s.token)).s === 403, 'staff 403 on GET /stock');
  ok((await call('/team', s.token)).s === 403, 'staff 403 on GET /team');

  ok((await call(`/orders/${A}/issue-invoice`, s.token, {})).s === 403, 'staff 403 on issue-invoice');
  ok((await call(`/orders/${A}/issue-invoice`, o.token, {})).s === 409, 'issue-invoice refuses when an invoice exists');
  ok((await call(`/orders/MNG-FFFF-1010/advance`, o.token, { to: 'packed' })).j.ok && (await call(`/orders/MNG-FFFF-1010/advance`, o.token, { to: 'shipped', awb: '  ' })).s === 400, 'shipping needs a tracking number');

  ok((await call('/orders/MNG-GGGG-1008/address', s.token, { address: 'x' })).s === 400, 'short address rejected');
  ok((await call('/orders/MNG-GGGG-1008/address', s.token, { address: '12 New Street, Faridabad, Haryana - 121007' })).j.ok, 'staff fixes an address before shipping');
  const gg = await call('/orders/MNG-GGGG-1008', s.token); ok(gg.j.order.address.startsWith('12 New') && gg.j.order.events.some((e) => e.event === 'address_changed' && e.meta.from), 'old address kept in timeline');
  ok((await call('/orders/MNG-CCCC-1009/address', s.token, { address: '12 New Street, Faridabad, Haryana - 121007' })).s === 409, 'address locked once shipped');
  ok((await call('/me', s.token)).j.dispatchFrom, 'dispatch date exposed');

  // prices
  ok((await call('/prices', s.token)).s === 403, 'staff 403 on GET /prices');
  ok((await call('/prices', s.token, { slug: 'atta-original', price: 1 })).s === 403, 'staff 403 on POST /prices');
  const prl = await call('/prices', o.token); ok(prl.j.rows.length === 6 && prl.j.rows[0].price === 300, 'owner reads 6 prices');
  ok((await call('/prices', o.token, { slug: 'atta-original', price: 20, mrp: 300 })).s === 400, 'price below 50 rejected');
  ok((await call('/prices', o.token, { slug: 'atta-original', price: 400, mrp: 300 })).s === 400, 'MRP below price rejected');
  ok((await call('/prices', o.token, { slug: 'nope', price: 300 })).s === 400, 'unknown product rejected');
  ok((await call('/prices', o.token, { slug: 'atta-original', price: 280, mrp: 300 })).j.ok, 'owner changes a price');
  ok((await call('/prices', o.token)).j.rows[0].price === 280, 'new price reads back');
  await call('/prices', o.token, { slug: 'atta-original', price: 300, mrp: 300 });

  // no / bad token
  ok((await call('/orders', null)).s === 401, 'no token 401');
  ok((await call('/orders', s.token + 'x')).s === 401, 'tampered token 401');

  // owner: undo one step, then timeline
  const u = await call(`/orders/${A}/undo`, o.token, {}); ok(u.j.ok && u.j.state === 'shipped', 'owner undo delivered -> shipped');
  const d = await call(`/orders/${A}`, o.token); ok(d.j.order.state === 'shipped' && d.j.order.events.length >= 5, 'timeline recorded: ' + d.j.order.events.length);
  ok(d.j.order.events.every((e) => e.by), 'every event has an actor');

  // refund warning on shipped
  const r1 = await call(`/orders/${A}/refund`, o.token, { reasonCode: 'other' }); ok(r1.s === 409 && r1.j.needsConfirm, 'refund of shipped order needs confirmation');
  ok((await call(`/orders/${A}/refund`, o.token, { reasonCode: 'other', confirmShipped: true, actor: { email: 'forged' } })).j.ok, 'refund with confirmation works');

  // bulk pack
  const bp = await call('/orders/bulk-pack', s.token, { ids: ['MNG-BBBB-1010', 'MNG-DDDD-1009', 'MNG-CCCC-1009', 'nope'] });
  ok(bp.j.packed === 1 && bp.j.results.length === 4, 'bulk pack: only the valid one packs (' + JSON.stringify(bp.j.results.map((r) => r.ok)) + ')');
  const pl = await call('/picklist', s.token, { ids: ['MNG-BBBB-1010'] }); ok(pl.j.flavours['Atta Original'] === 2, 'picklist totals');

  // stock
  ok((await call('/stock', o.token, { slug: 'atta-kesari', available: false })).j.ok, 'owner toggles stock');
  ok((await call('/stock', o.token)).j.stock.find((x) => x.slug === 'atta-kesari').available === false, 'stock reads back');
  const cat = require('../utils/catalog'); // separate process: just checks the module loads
  ok(typeof cat.isAvailable === 'function', 'catalog loads');
  await call('/stock', o.token, { slug: 'atta-kesari', available: true });

  // gift: the label/ship-to uses the recipient, the buyer is kept
  const gl = (await call('/orders', o.token)).j; const g = (gl.orders || gl.rows || []).find((x) => x.id === 'MNG-GGGG-1010');
  ok(g && g.gift_for === true && g.ship_name === 'Anita Rao' && g.ship_phone === '919820012345' && /Customer/.test(g.name), 'gift order exposes recipient as ship-to, buyer kept');
  const plain = (gl.orders || gl.rows || []).find((x) => x.id === 'MNG-AAAA-1010'); ok(plain && plain.gift_for === false && plain.ship_name === plain.name, 'normal order ships to the buyer');

  // unpaid orders: payment link can be sent by staff too
  const U = 'MNG-UUUU-1011', payLink = (id, tok, b) => call(`/orders/${id}/payment-link`, tok, b || {});
  const pr1 = await payLink(U, s.token); ok(pr1.j.ok && pr1.j.url === 'https://rzp.io/rzp/FRESH' && pr1.j.regenerated === false && !!pr1.j.validUntilText, 'staff gets the existing link for a recent unpaid order');
  const pr2 = await payLink(U, s.token, { email: true }); ok(pr2.j.ok && pr2.j.emailed === true, 'staff can email the link');
  const pr3 = await payLink('MNG-NOEM-1011', s.token, { email: true }); ok(pr3.s === 409, 'email refused when the customer gave no email');
  const pr4 = await payLink('MNG-DDDD-1009', s.token); ok(pr4.j.ok && pr4.j.regenerated === true && /NEWR$/.test(pr4.j.url), 'a link older than 20h is replaced by a fresh one');
  const pr5 = await payLink(U, o.token, { fresh: true }); ok(pr5.j.ok && pr5.j.regenerated === true, 'fresh=true always makes a new link');
  const pr6 = await payLink(A, o.token); ok(pr6.s === 409, 'a paid order has no payment link to send');
  const pev = (await call(`/orders/${U}`, o.token)).j.order.events.map((e) => e.event); ok(pev.includes('payment_link_emailed') && pev.includes('payment_link_regenerated'), 'link actions are written to the timeline');
  const pul = (await call('/orders', s.token)).j.orders.find((x) => x.id === U); ok(pul && pul.state === 'unpaid' && /rzp\.io/.test(pul.pay_url), 'unpaid order exposes its link to the admin');
  ok(!(await call('/orders', s.token)).j.orders.find((x) => x.id === 'MNG-AAAA-1010').pay_url, 'paid orders do not expose a payment link');

  const pw1 = await payLink(U, s.token, { whatsapp: true }); ok(pw1.j.ok && pw1.j.whatsapped === true, 'staff can send the link on WhatsApp from the Munchingo number');
  const pw2 = await payLink('MNG-WAFA-1011', s.token, { whatsapp: true }); ok(pw2.s === 502 && /Munchingo number/.test(pw2.j.error) && /Email/.test(pw2.j.error), 'a failed WhatsApp send gives a clear message and an alternative');
  const pev2 = (await call(`/orders/${U}`, o.token)).j.order.events.map((e) => e.event); ok(pev2.includes('payment_link_whatsapped'), 'WhatsApp send is written to the timeline');
  const pw3 = await payLink('MNG-AAAA-1010', s.token, { whatsapp: true }); ok(pw3.s === 409, 'no WhatsApp reminder for a paid order');

  const pwh = await payLink(U, s.token, { whatsapp: true, lang: 'hi' }); ok(pwh.j.ok && pwh.j.whatsappLang === 'hi' && !!pwh.j.validUntilTextHi, 'Hindi can be chosen per send');
  const pwa = await payLink(U, s.token, { whatsapp: true }); ok(pwa.j.ok && pwa.j.whatsappLang === 'auto', 'no language chosen = the customer\'s saved language (default English)');
  const det = (await call(`/orders/${U}`, o.token)).j.order; ok(!!det.link_until && new Date(det.link_until) > new Date() && (det.lang === 'en' || det.lang === 'hi'), 'unpaid order detail carries link expiry and saved language');
  const detOld = (await call('/orders/MNG-WAFA-1011', o.token)).j.order; ok(!!detOld.link_until, 'link expiry present on every unpaid order');
  const detPaid = (await call(`/orders/${A}`, o.token)).j.order; ok(!detPaid.link_until, 'paid orders have no link expiry');

  // team: disable staff -> immediately locked out
  ok((await call('/team', o.token, { email: 'staff@example.com', role: 'staff', active: false })).j.ok, 'owner disables staff');
  ok((await call('/orders', s.token)).s === 401, 'disabled staff locked out at once');
  ok((await call('/team', o.token, { email: 'owner@example.com', role: 'staff' })).s === 409, 'cannot demote env owner');
  ok((await call('/team', o.token, { email: 'staff@example.com', role: 'staff', active: true })).j.ok, 're-enable staff');
  ok((await call('/orders', s.token)).s === 200, 're-enabled staff back in');
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
