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

  // ── coupons (owner only) ──
  const cp = (path, tok, body, method) => call('/coupons' + path, tok, body, method);
  ok((await cp('', s.token)).s === 403, 'staff cannot list coupons');
  ok((await cp('', s.token, { type: 'percent', value: 10 })).s === 403, 'staff cannot create coupons');
  const cl = (await cp('', o.token)).j; ok(cl.ok && cl.coupons.length === 2 && cl.scopes.length === 4, 'owner lists coupons with scopes');
  const f10 = cl.coupons.find((c) => c.code === 'FOUNDING10'); ok(f10 && f10.status === 'live' && f10.redeemed === 3 && f10.discountGiven === 264 && f10.customers === 3 && /10% off \(up to .100\)/.test(f10.benefit), 'usage stats and wording for FOUNDING10');
  ok(cl.coupons.find((c) => c.code === 'OLD5').status === 'expired', 'an old code shows as expired');
  const gen = (await cp('/generate?prefix=ig', o.token)).j; ok(gen.ok && /^IG-[A-HJ-NP-Z2-9]{5}$/.test(gen.code), 'generated code is readable: ' + gen.code);
  const c1 = await cp('', o.token, { code: 'friend-hera', type: 'percent', value: 15, maxDiscount: 150, minOrder: 700, scope: 'trio-gift-set', maxUses: 1, perCustomer: 1, expiresAt: '2030-01-31', note: 'apology for Hera', phone: '98100 12345' });
  ok(c1.j.ok && c1.j.coupon.code === 'FRIEND-HERA' && c1.j.coupon.phone === '919810012345' && c1.j.coupon.scope === 'trio-gift-set' && c1.j.coupon.maxUses === 1 && c1.j.coupon.status === 'live', 'owner creates a personal capped coupon');
  ok(/FRIEND-HERA/.test(c1.j.coupon.shareEn) && /15% off \(up to .150\)/.test(c1.j.coupon.shareEn) && /Trio/.test(c1.j.coupon.shareEn) && /just for you/.test(c1.j.coupon.shareEn), 'English share message carries code, cap, scope and personal line');
  ok(/FRIEND-HERA/.test(c1.j.coupon.shareHi) && /15%/.test(c1.j.coupon.shareHi) && /[\u0900-\u097F]/.test(c1.j.coupon.shareHi), 'Hindi share message exists');
  ok((await cp('', o.token, { code: 'FRIEND-HERA', type: 'flat', value: 50 })).s === 409, 'duplicate code refused');
  const c2 = await cp('', o.token, { type: 'flat', value: 100 }); ok(c2.j.ok && /^MUN-/.test(c2.j.coupon.code) && c2.j.coupon.perCustomer === 1 && c2.j.coupon.maxUses === null, 'empty code is generated; defaults: one use per customer, unlimited total');
  ok((await cp('', o.token, { code: 'BIG', type: 'percent', value: 90 })).s === 400, 'percent above 60 refused');
  ok((await cp('', o.token, { code: 'BIGFLAT', type: 'flat', value: 5000 })).s === 400, 'flat above 2000 refused');
  ok((await cp('', o.token, { code: 'NOVAL', type: 'flat' })).s === 400, 'discount required');
  ok((await cp('', o.token, { code: 'A', type: 'flat', value: 10 })).s === 400, 'code too short refused');
  ok((await cp('', o.token, { code: 'BADPHONE', type: 'flat', value: 10, phone: '12345' })).s === 400, 'bad phone refused');
  ok((await cp('', o.token, { code: 'PASTDATE', type: 'flat', value: 10, expiresAt: '2020-01-01' })).s === 400, 'expiry in the past refused');
  ok((await cp('', o.token, { code: 'BACKWARDS', type: 'flat', value: 10, startsAt: '2030-02-01', expiresAt: '2030-01-01' })).s === 400, 'start after expiry refused');
  ok((await cp('', o.token, { code: 'BADSCOPE', type: 'flat', value: 10, scope: 'atta-original' })).s === 400, 'unsupported scope refused');
  const so = await cp('', o.token, { code: 'NOSETS10', type: 'percent', value: 10, scope: 'singles-only', expiresAt: '2030-01-31' });
  ok(so.j.ok && so.j.coupon.scope === 'singles-only' && so.j.coupon.conditions.includes('not on gift sets') && /not gift sets/.test(so.j.coupon.shareEn) && /गिफ़्ट सेट/.test(so.j.coupon.shareHi), 'a code can exclude gift sets; wording appears in the card and in both share messages');
  ok((await cp('/NOSETS10/delete', o.token, {})).j.ok, 'cleanup of the gift-set test code');
  const pz = await cp('/FRIEND-HERA', o.token, { active: false }); ok(pz.j.ok && pz.j.coupon.status === 'paused', 'pause');
  const rz = await cp('/FRIEND-HERA', o.token, { active: true, expiresAt: '2031-06-30', maxUses: 5, note: 'now for 5 people' }); ok(rz.j.ok && rz.j.coupon.status === 'live' && rz.j.coupon.maxUses === 5 && /2031/.test(rz.j.coupon.expiresAt) && rz.j.coupon.note === 'now for 5 people', 'resume + extend + edit limits and note');
  ok((await cp('/FRIEND-HERA', o.token, { value: 99 })).s === 400, 'editing the discount is also range-checked');
  ok((await cp('/NOPE', o.token, { active: false })).s === 404, 'unknown code on update');
  ok((await cp('/FOUNDING10/delete', o.token, {})).s === 409, 'a used code cannot be deleted');
  ok((await cp('/FRIEND-HERA/delete', o.token, {})).j.ok && !(await cp('', o.token)).j.coupons.some((c) => c.code === 'FRIEND-HERA'), 'an unused code can be deleted');
  await fetch('http://localhost:8430/dev/couponcols', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ready: false }) });
  ok((await cp('', o.token, { code: 'WITHNOTE', type: 'flat', value: 10, note: 'x' })).s === 409, 'notes need the migration: clear message when it has not run');
  ok((await cp('', o.token, { code: 'PLAIN', type: 'flat', value: 10 })).j.ok, 'plain codes still work without the migration');
  ok(!(await cp('', o.token)).j.ready, 'list reports the migration as missing');
  await fetch('http://localhost:8430/dev/couponcols', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ready: true }) });

  // ── stock-up tiers (owner only) ──
  const op = (p, tok, body) => call('/offers' + p, tok, body);
  ok((await op('', s.token)).s === 403, 'staff cannot see tiers');
  const tl = (await op('', o.token)).j; ok(tl.ok && tl.ready && tl.tiers.length === 1 && tl.tiers[0].min === 1500 && tl.tiers[0].off === 100 && tl.tiers[0].status === 'live', 'owner lists tiers');
  const t2 = await op('', o.token, { min: 2000, off: 200, endsAt: '2031-12-31' }); ok(t2.j.ok && t2.j.tier.min === 2000 && /2031/.test(t2.j.tier.endsAt), 'owner adds a tier with an end date');
  ok(!(await op('', o.token, { min: 1000, off: 400 })).j.ok, 'a tier above 20% of its spend is refused');
  ok(!(await op('', o.token, { min: 2000, off: 150 })).j.ok, 'two tiers at the same spend are refused');
  const tp = await op('/' + t2.j.tier.id, o.token, { active: false }); ok(tp.j.ok && tp.j.tier.status === 'paused', 'pause a tier');
  ok((await op('/' + t2.j.tier.id + '/delete', o.token, {})).j.ok && (await op('', o.token)).j.tiers.length === 1, 'delete a tier');
  const pt = await op('', o.token, { min: 1500, percent: 10, cap: 300 }); ok(!pt.j.ok && /already a tier/.test(pt.j.error), 'a percentage tier at an existing spend is refused');
  const pt2 = await op('', o.token, { min: 2500, percent: 10, cap: 300 }); ok(pt2.j.ok && pt2.j.tier.pct === 10 && pt2.j.tier.cap === 300 && pt2.j.tier.off === null, 'owner adds a percentage tier (10% up to 300)');
  ok(!(await op('', o.token, { min: 2600, percent: 50, cap: 300 })).j.ok, 'a percentage above 20 is refused');
  ok(!(await op('', o.token, { min: 2700, percent: 10 })).j.ok, 'a percentage tier needs a cap');
  ok((await op('/' + pt2.j.tier.id, o.token, { cap: 250 })).j.tier.cap === 250, 'change the cap');
  ok(!(await op('/' + pt2.j.tier.id, o.token, { off: 100 })).j.ok, 'a percentage tier has no flat amount to change');
  ok((await op('/' + pt2.j.tier.id + '/delete', o.token, {})).j.ok, 'delete the percentage tier');
  // new customers only + sales per code
  const nc = await cp('', o.token, { type: 'flat', value: 100, minOrder: 900, firstOrderOnly: true, expiresAt: '2031-01-31' });
  ok(nc.j.ok && nc.j.coupon.firstOrderOnly === true && nc.j.coupon.conditions.includes('new customers only') && /first order/.test(nc.j.coupon.shareEn), 'a code can be for new customers only');
  const f10b = (await cp('', o.token)).j.coupons.find((c) => c.code === 'FOUNDING10'); ok(f10b.orders > 0 && f10b.sales > 0 && f10b.avgOrder > 0, 'each code shows orders, sales and average order');

  // team: disable staff -> immediately locked out
  ok((await call('/team', o.token, { email: 'staff@example.com', role: 'staff', active: false })).j.ok, 'owner disables staff');
  ok((await call('/orders', s.token)).s === 401, 'disabled staff locked out at once');
  ok((await call('/team', o.token, { email: 'owner@example.com', role: 'staff' })).s === 409, 'cannot demote env owner');
  ok((await call('/team', o.token, { email: 'staff@example.com', role: 'staff', active: true })).j.ok, 're-enable staff');
  ok((await call('/orders', s.token)).s === 200, 're-enabled staff back in');
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
