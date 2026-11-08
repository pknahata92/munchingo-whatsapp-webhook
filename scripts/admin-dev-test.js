'use strict';
// Runs against the practice copy:  node scripts/admin-dev-test.js   (starts its own scripts/admin-dev.js with WhatsApp order notices
// OFF, the case this test checks, and stops it at the end; like admin-ui-test and updates-flow-test, it never relies on a server
// another test may have stopped or left in a different state)
const fs = require('fs'), path = require('path');
const { spawn, execSync } = require('child_process');
const PORT = Number(process.env.ADMIN_DEV_PORT) || 8430;
const CODE_BASE = PORT === 8430 ? '/tmp/admin-dev-code' : '/tmp/admin-dev-code-' + PORT;
const B = 'http://localhost:' + PORT + '/admin/api';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const call = async (p, tok, body, method) => { const r = await fetch(B + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
async function login(email) {
  await call('/login', null, { email });
  await new Promise((r) => setTimeout(r, 200));
  const code = fs.readFileSync(CODE_BASE + '-' + email.split('@')[0] + '.txt', 'utf8');
  const v = await call('/verify', null, { email, code });
  return v.j;
}
(async () => {
  try { if (PORT === 8430) execSync('pkill -f scripts/admin-dev.js', { stdio: 'ignore' }); await new Promise((r) => setTimeout(r, 400)); } catch (e) { /* none running */ }
  const env = { ...process.env }; delete env.SHIPPED_WA_ENABLED;
  const dev = spawn(process.execPath, [path.join(__dirname, 'admin-dev.js')], { stdio: 'ignore', env });
  const stop = () => { try { dev.kill(); } catch (e) { /* already gone */ } };
  process.on('exit', stop);
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://localhost:' + PORT + '/admin')).ok) break; } catch (e) { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)); }
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
  ok((await call('/orders/MNG-CCCC-1009/billing-state', s.token, { state: 'Rajasthan' })).s === 403, 'staff cannot set the buyer state');
  ok((await call('/orders/MNG-CCCC-1009/billing-state', o.token, { state: 'Nowhereland' })).s === 400, 'an unknown state is refused');
  ok((await call('/orders/MNG-CCCC-1009/billing-state', o.token, { state: 'rajasthan' })).j.state === 'Rajasthan', 'owner sets the buyer state on a shipped order');
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

  // owner button: WhatsApp update for the current step
  ok((await call('/orders/MNG-CCCC-1009/whatsapp-update', s.token, {})).s === 403, 'staff cannot use Send WhatsApp update');
  const wb = await call('/orders/MNG-DDDD-1009/whatsapp-update', o.token, {}); ok(wb.s === 409 && /packed, shipped or delivered/.test(wb.j.error || ''), 'the button refuses an order that is not packed, shipped or delivered');
  const wc = await call('/orders/MNG-CCCC-1009/whatsapp-update', o.token, {}); ok(wc.s === 409 && /switched off/.test(wc.j.error || ''), 'with WhatsApp updates off the owner is told how to switch them on');

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
  await fetch('http://localhost:' + PORT + '/dev/couponcols', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ready: false }) });
  ok((await cp('', o.token, { code: 'WITHNOTE', type: 'flat', value: 10, note: 'x' })).s === 409, 'notes need the migration: clear message when it has not run');
  ok((await cp('', o.token, { code: 'PLAIN', type: 'flat', value: 10 })).j.ok, 'plain codes still work without the migration');
  ok(!(await cp('', o.token)).j.ready, 'list reports the migration as missing');
  await fetch('http://localhost:' + PORT + '/dev/couponcols', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ready: true }) });

  // ── delivery methods on the ship step: hand, Porter, other courier ──
  for (const id of ['MNG-HAND-1012', 'MNG-PORT-1012', 'MNG-OTHR-1012']) await call(`/orders/${id}/advance`, s.token, { to: 'packed' });
  ok((await call('/orders/MNG-HAND-1012/advance', s.token, { to: 'shipped', method: 'hand' })).j.state === 'shipped', 'by hand ships with no tracking number');
  const hd = (await call('/orders/MNG-HAND-1012', s.token)).j.order; ok(hd.carrier === 'By hand' && hd.awb === '', 'by hand is recorded as the carrier');
  const pr = await call('/orders/MNG-PORT-1012/advance', s.token, { to: 'shipped', method: 'porter', awb: 'https://porter.in/track/abc123', deliverNow: true });
  ok(pr.j.ok && pr.j.state === 'delivered', 'Porter with a link, handed over now, ends as delivered');
  const pd = (await call('/orders/MNG-PORT-1012', s.token)).j.order; ok(pd.carrier === 'Porter' && /porter\.in/.test(pd.awb) && pd.state === 'delivered', 'Porter link is kept (longer than 40 characters is fine)');
  ok((await call('/orders/MNG-OTHR-1012/advance', s.token, { to: 'shipped', method: 'other', awb: 'D99' })).s === 400, 'other courier needs a name');
  ok((await call('/orders/MNG-OTHR-1012/advance', s.token, { to: 'shipped', method: 'other', carrier: 'DTDC' })).s === 400, 'other courier needs a tracking number');
  ok((await call('/orders/MNG-OTHR-1012/advance', s.token, { to: 'shipped', method: 'other', carrier: 'DTDC', awb: 'D99' })).j.ok, 'other courier with name and number ships');
  ok((await call('/orders/MNG-OTHR-1012', s.token)).j.order.carrier === 'DTDC', 'other courier name is kept');

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
  // reviews and founding tasters (owner only)
  for (const [p, body] of [['/reviews'], ['/reviews/1/publish', {}], ['/reviews/1/hide', { reason: 'abusive' }], ['/founding-tasters'], ['/founding-tasters', { rows: [] }], ['/orders/MNG-REVA-1001/known', { known: true }]]) {
    ok((await call(p, s.token, body)).s === 403, 'staff cannot use ' + p);
  }
  const rv = await call('/reviews', o.token);
  ok(rv.j.ok && rv.j.reviews.length >= 2 && rv.j.totals && 'asked' in rv.j.totals && 'received' in rv.j.totals && 'rate' in rv.j.totals, 'owner lists reviews with totals');
  ok((await call('/reviews/2/hide', o.token, { reason: 'low_rating' })).s === 400, 'a low rating is not a reason to hide');
  ok((await call('/reviews/2/hide', o.token, { reason: 'abusive' })).j.ok, 'hide with a fixed reason works');
  ok((await call('/reviews', o.token)).j.reviews.find((r) => r.id === 2).hidden_reason === 'abusive', 'the reason is recorded');
  ok((await call('/reviews/1/publish', o.token, {})).s === 409, 'a review without consent cannot be published');
  ok((await call('/reviews/2/publish', o.token, {})).j.ok && (await call('/reviews', o.token)).j.reviews.find((r) => r.id === 2).status === 'published', 'a consented review can be published (even after a hide)');
  const ft = await call('/founding-tasters', o.token);
  ok(ft.j.ok && ft.j.rows.some((r) => r.phone === '919810000777' && r.ticked), 'founding tasters: the 11-17 Oct buyers are listed, ticked');
  ok((await call('/orders/MNG-REVA-1001/known', o.token, { known: true })).j.ok, 'owner marks an order as known to us');
  // labels follow the owner's later changes (a review arrives before the owner marks the order)
  ok((await call('/reviews', o.token)).j.reviews.find((r) => r.id === 1).network === false, 'setup: review 1 not marked friend or family');
  ok((await call('/orders/MNG-REVB-1002/known', o.token, { known: true })).j.ok, 'owner marks the order known to us after the review came in');
  ok((await call('/reviews', o.token)).j.reviews.find((r) => r.id === 1).network === true, 'the review now carries the friend or family label');
  // a taster the owner removed stays removed
  ok((await call('/founding-tasters', o.token, { rows: [] })).j.ok, 'owner saves the list with nobody on it');
  const ft2 = await call('/founding-tasters', o.token);
  ok(ft2.j.rows.some((r) => r.phone === '919810000777' && r.ticked === false), 'after a save, a removed 11-17 Oct buyer is listed unticked, not re-added');
  ok((await call('/reviews', o.token)).j.reviews.find((r) => r.id === 1).founding_taster === false, 'and their review loses the founding taster label');

  // ── Meta and Google follow the admin (fake catalogues in admin-dev.js: both keys set, Google set up, all four in stock, both off) ──
  const devCh = async (b) => (await fetch('http://localhost:' + PORT + '/dev/channels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
  const chans = async (tok) => { const c = (await call('/channels', tok)).j.channels || {}; return { meta: c.meta || {}, google: c.google || {} }; };
  const setMode = (tok, b) => call('/channels/mode', tok, b);
  const sc = await call('/channels', s.token);
  ok(sc.s === 200 && sc.j.channels?.meta?.why === 'switched off' && sc.j.channels?.google?.why === 'switched off', 'staff read the channel lines: both switched off (' + JSON.stringify([sc.j.channels?.meta?.why, sc.j.channels?.google?.why]) + ')');
  ok((await setMode(s.token, { channel: 'meta', mode: 'test' })).s === 403, 'staff cannot switch a channel');
  ok((await call('/channels/check', s.token, {})).s === 403, 'staff cannot use Check now');
  ok((await call('/channels/setup-google', s.token, {})).s === 403, 'staff cannot set up Google');
  ok((await chans(s.token)).meta.mode === 'off', 'a refused staff switch changes nothing');
  const mt = await setMode(o.token, { channel: 'meta', mode: 'test' });
  const orig = mt.j.channels?.meta?.items?.['atta-original'];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  ok(mt.j.ok && mt.j.channels?.meta?.mode === 'test' && !!orig && !!orig.pushedAt && same(orig.pushed, orig.want) && same(orig.shown, orig.want), 'owner: Test with Original pushes Original (even when Meta already shows it), then reads it back (' + JSON.stringify(orig) + ')');
  ok(mt.j.channels?.meta?.why === 'matches' && mt.j.channels.meta.testPassed === true && !!mt.j.channels.meta.checkedAt && Array.isArray(mt.j.errors) && mt.j.errors.length === 0, 'and the line says matches, with the time it was checked; Switch on all four is offered (' + JSON.stringify([mt.j.channels?.meta?.why, mt.j.channels?.meta?.testPassed, mt.j.errors]) + ')');
  ok((await setMode(o.token, { channel: 'meta', mode: 'all' })).j.channels?.meta?.mode === 'all', 'owner switches Meta on for all four');
  const kesariPushed = async (want) => { const t0 = Date.now(); while (Date.now() - t0 < 6000) { const it = ((await chans(o.token)).meta.items || {})['atta-kesari']; if (it && it.pushed && it.pushed.availability === want) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };
  ok((await call('/inventory/pause', o.token, { slug: 'atta-kesari', paused: true })).j.ok && await kesariPushed('out of stock'), 'pausing Kesari reaches Meta within 6 s as out of stock');
  ok((await call('/inventory/pause', o.token, { slug: 'atta-kesari', paused: false })).j.ok && await kesariPushed('in stock'), 'resuming Kesari sends it back as in stock');
  const chk = await call('/channels/check', o.token, {});
  ok(chk.j.ok && chk.j.channels?.meta?.why === 'matches' && chk.j.channels?.google?.why === 'switched off', 'Check now reads Meta back: matches; Google stays off (' + JSON.stringify([chk.j.channels?.meta?.why, chk.j.channels?.google?.why]) + ')');
  ok(Array.isArray(chk.j.errors) && chk.j.errors.length === 0 && !('errors' in (chk.j.channels || {})), 'Check now answers with what failed (nothing), apart from the lines (' + JSON.stringify(chk.j.errors) + ')');
  for (const b of [{ channel: 'x', mode: 'all' }, { channel: 'meta', mode: 'on' }, { channel: '__proto__', mode: 'all' }, { channel: 'constructor', mode: 'test' }, {}]) {
    const r = await setMode(o.token, b); ok(r.s === 400 && r.j.error === 'Choose Meta or Google, and off, test or all.', 'a bad switch is refused with 400: ' + JSON.stringify(b) + ' -> ' + r.s + ' ' + r.j.error);
  }
  ok((await chans(o.token)).meta.mode === 'all', 'a refused switch leaves Meta as it was');
  const iv = await call('/inventory', s.token);
  ok(iv.j.ok && iv.j.items.length >= 4 && iv.j.channels?.meta?.mode === 'all' && iv.j.channels?.google?.why === 'switched off', 'the inventory carries the channel lines too, for staff as well');
  await setMode(o.token, { channel: 'meta', mode: 'off' });
  ok((await chans(o.token)).meta.why === 'switched off', 'owner switches Meta off');
  // a refused push shows at once, and the switch answer says what failed (practice: Meta refuses every push until told otherwise)
  await devCh({ failPush: { meta: 'Invalid OAuth access token' } });
  const tf = await setMode(o.token, { channel: 'meta', mode: 'test' });
  ok(tf.j.ok && tf.j.channels?.meta?.why === 'last try failed' && tf.j.channels.meta.error === 'Meta did not accept the change: Invalid OAuth access token' && tf.j.channels.meta.testPassed === false, 'a refused test push shows at once: ' + JSON.stringify([tf.j.channels?.meta?.why, tf.j.channels?.meta?.error, tf.j.channels?.meta?.testPassed]));
  ok(JSON.stringify(tf.j.errors) === '["Meta did not accept the change: Invalid OAuth access token"]', 'and the answer says what failed, in plain words: ' + JSON.stringify(tf.j.errors));
  await devCh({ failPush: { meta: null } });
  const tq = await setMode(o.token, { channel: 'meta', mode: 'test' });
  ok(tq.j.channels?.meta?.why === 'matches' && tq.j.channels.meta.testPassed === true && tq.j.errors?.length === 0, 'Test with Original again, once Meta takes it: matches, and Switch on all four is offered (' + JSON.stringify([tq.j.channels?.meta?.why, tq.j.errors]) + ')');
  await setMode(o.token, { channel: 'meta', mode: 'off' });
  // Set up Google (the fake answers like an account that is already linked)
  await devCh({ notSetUp: true });
  ok((await chans(o.token)).google.why === 'not set up', 'Google without its set-up reads: not set up');
  const su = await call('/channels/setup-google', o.token, {});
  ok(su.j.ok && su.j.steps?.length === 4 && Array.isArray(su.j.missing) && su.j.missing.length === 0 && su.j.channels?.google?.why === 'switched off', 'owner sets up Google: the steps come back and Google is now just switched off (' + JSON.stringify(su.j.steps) + ')');
  // set-up that misses an offer id says so and the status carries it; set up again once fixed, and the product starts syncing (I3, M4)
  await devCh({ setupMissing: ['MNG-LITE-250'] });
  const sm = await call('/channels/setup-google', o.token, {});
  ok(sm.j.ok && JSON.stringify(sm.j.missing) === '["MNG-LITE-250"]' && JSON.stringify(sm.j.channels?.google?.missing) === '["MNG-LITE-250"]' && /Found 3 of 4 products/.test((sm.j.steps || []).join(' ')), 'set-up that does not find an offer id reports it, and the status carries it (' + JSON.stringify([sm.j.missing, sm.j.channels?.google?.missing, sm.j.steps]) + ')');
  const gm = await setMode(o.token, { channel: 'google', mode: 'all' });
  ok((gm.j.channels?.google?.problems || []).some((p) => p.text === 'not found in Google: MNG-LITE-250'), 'with Google on, Sugar-Lite reads as not found (' + JSON.stringify(gm.j.channels?.google?.problems) + ')');
  await devCh({ setupMissing: [] });
  const sa = await call('/channels/setup-google', o.token, {});
  const lite = sa.j.channels?.google?.items?.['atta-lite-sugar'];
  ok(sa.j.ok && sa.j.missing?.length === 0 && sa.j.channels?.google?.missing?.length === 0 && !(sa.j.channels?.google?.problems || []).some((p) => /^not found/.test(p.text)) && !!(lite && lite.shown && lite.shown.availability), 'set up again once fixed: nothing missing, and Sugar-Lite is read straight away (' + JSON.stringify([sa.j.channels?.google?.problems, lite]) + ')');
  await setMode(o.token, { channel: 'google', mode: 'off' });
  // a problem: Google keeps showing Kesari out of stock while the admin says in stock
  await devCh({ stuck: { google: { 'atta-kesari': 'out of stock' } } });
  const ga = await setMode(o.token, { channel: 'google', mode: 'all' });
  ok(ga.j.ok && ga.j.channels?.google?.why === 'waiting for Google to update' && ga.j.channels?.google?.problems?.length === 0, 'a fresh difference is "waiting for Google to update", not yet a problem (' + ga.j.channels?.google?.why + ')');
  await devCh({ minutesLater: 31 });
  const gp = (await call('/channels/check', o.token, {})).j.channels?.google || {};   // read back: what took the push now matches
  ok(gp.why === 'problem' && gp.problems?.length === 1 && gp.problems[0].slug === 'atta-kesari' && /Kesari shows out of stock; the admin says in stock$/.test(gp.problems[0].text), 'over 30 minutes later it is a problem: ' + JSON.stringify(gp.problems));
  // a malformed saved row: the bad entry is dropped and the lines still show (T-a)
  await devCh({ reset: true }); await devCh({ broken: true });
  const ib = await call('/inventory', s.token);
  ok(ib.j.ok && ib.j.items.length >= 4 && ib.j.channels?.meta?.why === 'switched off' && !('atta-original' in (ib.j.channels?.meta?.items || {})), 'a malformed saved row no longer hides the lines: the bad entry is dropped (meta: ' + JSON.stringify(ib.j.channels && ib.j.channels.meta) + ')');
  // the channel status cannot be read at all: the stock screen still loads, and the channel route answers in plain words (T-d)
  await devCh({ reset: true }); await devCh({ statusFails: true });
  const ib2 = await call('/inventory', s.token);
  ok(ib2.j.ok && ib2.j.items.length >= 4 && ib2.j.channels === null, 'when the channel status cannot be read, the inventory still loads (channels: ' + JSON.stringify(ib2.j.channels) + ')');
  const gc = await call('/channels', s.token);
  ok(gc.s === 503 && gc.j.error === 'Could not read the Meta and Google status just now. Try again.', 'and GET channels answers 503 in plain words, not a raw error (' + gc.s + ' ' + gc.j.error + ')');
  await devCh({ reset: true });
  // a database hiccup while switching: the owner is told it failed, never that it worked (above all for Switch off)
  await setMode(o.token, { channel: 'meta', mode: 'test' });
  await devCh({ failSave: 1 });
  const fo = await setMode(o.token, { channel: 'meta', mode: 'off' });
  ok(fo.s === 503 && /^Could not switch Meta/.test(fo.j.error || '') && !fo.j.channels, 'a switch whose save failed answers 503 "Could not switch Meta…" (' + fo.s + ' ' + fo.j.error + ')');
  ok((await chans(o.token)).meta.mode === 'test', 'and Meta is still on test, as the line shows');
  ok((await setMode(o.token, { channel: 'meta', mode: 'off' })).j.channels?.meta?.mode === 'off', 'trying again once the database is back switches it off');
  await devCh({ reset: true });

  // ── Batch receiving, Task 6: Packed takes boxes only from lots that can still ship (spec 6.6). Kept last: earlier checks pack Kesari. ──
  // Kesari is made short the real way: the shippable Kesari is taken out, then a Kesari delivery is saved and NOT released (its lot is on hold).
  // Dates come from the real clock (bake today, best before 80 days ahead), so this works on any day.
  {
    const istToday = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const bbIn80 = new Date(Date.now() + 330 * 60000 + 80 * 86400000).toISOString().slice(0, 10);
    const kes = async () => (await call('/inventory', o.token)).j.items.find((i) => i.slug === 'atta-kesari');
    const k0 = await kes();
    if (k0.usable > 0) ok((await call('/inventory/take', o.token, { slug: 'atta-kesari', qty: k0.usable, type: 'SAMPLE', note: 'practice: no shippable Kesari left' })).j.ok, 'setup: the shippable Kesari is taken out (' + k0.usable + ')');
    ok((await kes()).usable === 0, 'setup: no usable Kesari left');
    const stamp = Date.now();
    const dn = await call('/stock/deliveries', s.token, { id: 'practice-t6-nobill-' + stamp, rows: [] });
    ok(dn.s === 400 && dn.j.error === 'Enter the bill number.', 'a refused delivery answers in plain words, not a server error (' + dn.s + ' ' + dn.j.error + ')');
    const dv = await call('/stock/deliveries', s.token, { id: 'practice-t6-' + stamp, billNo: 'T6-' + stamp, bakeDate: istToday, cartons: 1, invoiceRupees: 1000, freight: { porter: 100 }, rows: [{ slug: 'atta-kesari', invoiceBoxes: 10, counted: 10, rateRupees: 100 }] });
    const code = dv.j.lots && dv.j.lots[0] && dv.j.lots[0].code;
    ok(dv.s === 200 && dv.j.ok && /^MNGK-\d{6}-\d{2}$/.test(code || ''), 'staff save a Kesari delivery through the API (' + dv.s + ' ' + JSON.stringify(dv.j).slice(0, 200) + ')');
    const hk = ((await kes()).lots || []).find((l) => l.lot_code === code);
    ok(hk && hk.status === 'hold' && hk.qty === 10, 'packing reads the same stock as the delivery: 10 boxes on hold in ' + code + ' (' + JSON.stringify(hk) + ')');
    // staff packing a Kesari order is refused in plain words, even when they send an override; the order stays To pack
    const G = 'MNG-GGGG-1010';   // a Trio: Kesari, Sugar-Lite, Original
    const want = `Kesari: 1 box short. Lot ${code} is on hold (release it), or receive the delivery first.`;
    const r1 = await call(`/orders/${G}/advance`, s.token, { to: 'packed', override: 'staff cannot override' });
    ok(r1.s === 409 && /is on hold \(release it\)/.test(r1.j.error || '') && r1.j.error === want && Array.isArray(r1.j.stockShort) && r1.j.stockShort.length === 1 && r1.j.stockShort[0].slug === 'atta-kesari', 'staff packing a short Kesari order gets 409 with the reason: ' + r1.s + ' ' + r1.j.error);
    ok((await call(`/orders/${G}`, s.token)).j.order.state === 'topack', 'the refused order stays To pack');
    const r2 = await call(`/orders/${G}/advance`, o.token, { to: 'packed', override: ' ab ' });
    ok(r2.s === 409 && r2.j.error === want, 'the owner needs a note of at least 3 characters to override (' + r2.s + ')');
    const r3 = await call(`/orders/${G}/advance`, o.token, { to: 'packed', override: 'fair stock' });
    ok(r3.j.ok && r3.j.state === 'packed' && (await call(`/orders/${G}`, s.token)).j.order.state === 'packed', 'an owner override with the note "fair stock" packs it (' + JSON.stringify(r3.j) + ')');
    const nl = await call('/stock/needs-lot', s.token);
    ok(nl.s === 200 && Array.isArray(nl.j.lines) && nl.j.lines.some((l) => l.orderId === G && l.slug === 'atta-kesari' && l.boxes === 1), 'staff see the box packed without a lot (' + JSON.stringify(nl.j) + ')');
    const hist = (await call('/inventory/history?slug=atta-kesari&types=SALE&limit=5', o.token)).j.movements || [];
    ok(hist.some((m) => String(m.ref).startsWith(G + '@') && m.lot_code === null && m.note === 'Packed without a lot (owner): fair stock'), 'the lot-less sale carries the owner\'s note');
    // Assign lot (owner only)
    ok((await call(`/orders/${G}/assign-lot`, s.token, { slug: 'atta-kesari', lot: code })).s === 403, 'staff cannot assign a lot');
    const ah = await call(`/orders/${G}/assign-lot`, o.token, { slug: 'atta-kesari', lot: code });
    ok(ah.s === 409 && /on hold/.test(ah.j.error || ''), 'a held lot cannot be assigned: ' + ah.s + ' ' + ah.j.error);
    // Task 10: biscuits can no longer be received through /inventory/receive, so the setup is a delivery plus Release (staff may release)
    const d2 = await call('/stock/deliveries', s.token, { id: 'practice-t6b-' + stamp, billNo: 'T6B-' + stamp, bakeDate: istToday, cartons: 1, invoiceRupees: 200, freight: { porter: 10 }, rows: [{ slug: 'atta-kesari', invoiceBoxes: 2, counted: 2, rateRupees: 100 }] });
    const code2 = d2.j.lots && d2.j.lots[0] && d2.j.lots[0].code;
    const rl2 = await call(`/stock/lots/${encodeURIComponent(code2)}/release`, s.token, { slug: 'atta-kesari', tasted: true, weightG: 260 });
    ok(d2.j.ok && rl2.j.ok, 'setup: 2 Kesari arrive as a delivery and staff release the lot ' + code2 + ' (' + JSON.stringify([d2.s, rl2.s, rl2.j.error]) + ')');
    const ag = await call(`/orders/${G}/assign-lot`, o.token, { slug: 'atta-kesari', lot: code2 });
    ok(ag.j.ok && ag.j.moved === 1 && !(await call('/stock/needs-lot', s.token)).j.lines.some((l) => l.orderId === G && l.slug === 'atta-kesari'), 'the owner assigns a lot and the box leaves the list (' + JSON.stringify(ag.j) + ')');
    // bulk pack of 3 with 1 Kesari box left: the first Trio and the Original order pack, the second Trio is refused with the reason
    ok((await call('/orders/MNG-BBBB-1010/undo', o.token, {})).j.state === 'topack', 'setup: an Original order goes back to To pack');
    const bk = await call('/orders/bulk-pack', s.token, { ids: ['MNG-ISTA-1000', 'MNG-ISTB-1000', 'MNG-BBBB-1010'] });
    const no = (bk.j.results || []).filter((x) => !x.ok);
    ok(bk.j.packed === 2 && no.length === 1 && no[0].id === 'MNG-ISTB-1000' && /is on hold \(release it\)/.test(no[0].error || ''), 'bulk pack of 3 where 1 is short: packed 2, one ok:false with the reason (' + JSON.stringify(bk.j) + ')');
    // a technical failure never blocks packing, and it is raised for Needs attention (spec 6.6): the order gets a stock_unplanned event,
    // and needs-lot lists it under `unplanned` while that pack stands
    const devStock = (b) => fetch('http://localhost:' + PORT + '/dev/stock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    const I = 'MNG-ISTB-1000';
    const unplannedOf = async () => { const r = await call('/stock/needs-lot', s.token); return Array.isArray(r.j.unplanned) ? r.j.unplanned.filter((u) => u.orderId === I) : null; };
    const eventsOf = async () => ((await call(`/orders/${I}`, o.token)).j.order.events || []).filter((e) => e.event === 'stock_unplanned');
    ok(JSON.stringify(await unplannedOf()) === '[]', 'setup: nothing unplanned for ' + I);
    await devStock({ planFails: true });
    const kb = (await kes()).on_hand;
    const tf = await call(`/orders/${I}/advance`, s.token, { to: 'packed' });
    await devStock({ planFails: false });
    ok(tf.j.ok && tf.j.state === 'packed', 'when the packing plan cannot be worked out, the order still packs (' + tf.s + ' ' + JSON.stringify(tf.j) + ')');
    ok((await kes()).on_hand === kb - 1, 'and its Kesari box still comes off stock, as before lots');
    const e1 = await eventsOf(), u1 = await unplannedOf();
    ok(e1.length === 1 && /lots could not be checked/i.test((e1[0].meta || {}).reason || ''), 'the order gets a stock_unplanned event saying the lots could not be checked (' + JSON.stringify(e1) + ')');
    ok(u1 && u1.length === 1 && u1[0].reason === e1[0].meta.reason && !!u1[0].at, 'and needs-lot lists the pack under unplanned (' + JSON.stringify(u1) + ')');
    // undo drops it from the list; packing again with an override while the stock write fails raises it again, keeping the owner's note
    ok((await call(`/orders/${I}/undo`, o.token, {})).j.state === 'topack' && JSON.stringify(await unplannedOf()) === '[]', 'once the pack is undone it leaves the unplanned list');
    await devStock({ deductFails: true });
    const td = await call(`/orders/${I}/advance`, o.token, { to: 'packed', override: 'stall stock' });
    await devStock({ deductFails: false });
    ok(td.j.ok && td.j.state === 'packed', 'an owner override still packs when the stock write fails (' + td.s + ' ' + JSON.stringify(td.j) + ')');
    const u2 = await unplannedOf();
    ok(u2 && u2.length === 1 && /not taken off stock/i.test(u2[0].reason || '') && u2[0].note === 'stall stock', 'and it is listed as unplanned with the owner\'s note, since no lot-less line was written (' + JSON.stringify(u2) + ')');
    ok(!(await call('/stock/needs-lot', s.token)).j.lines.some((l) => l.orderId === I), 'the failed write left no lot-less line behind');
    // Task 12: each unplanned pack says why ('plan': the lots were not checked; 'write': the boxes were not taken off), and the owner
    // marks it checked (POST /orders/:id/stock-checked, owner only), which hides that pack until it is packed again
    ok(u1 && u1[0] && u1[0].kind === 'plan' && u2 && u2[0] && u2[0].kind === 'write', 'each unplanned pack says why: plan or write (' + JSON.stringify([u1 && u1[0] && u1[0].kind, u2 && u2[0] && u2[0].kind]) + ')');
    ok((await call(`/orders/${I}/stock-checked`, s.token, {})).s === 403, 'staff cannot mark a pack checked');
    ok((await call(`/orders/${I}/stock-checked`, s.token, { isOwner: true, role: 'owner' })).s === 403, 'a claimed isOwner or role changes nothing');
    const oc = await call(`/orders/${I}/stock-checked`, o.token, {});
    ok(oc.j.ok && JSON.stringify(await unplannedOf()) === '[]', 'the owner marks it checked and it leaves the unplanned list (' + oc.s + ' ' + JSON.stringify(oc.j) + ')');
    const ce = ((await call(`/orders/${I}`, o.token)).j.order.events || []).filter((e) => e.event === 'stock_unplanned_checked');
    ok(ce.length === 1 && ce[0].by === 'owner@example.com' && ce[0].meta && u2 && u2[0] && ce[0].meta.at === u2[0].at, 'the timeline records who checked it, for that pack (' + JSON.stringify(ce) + ')');
    const twice = await call(`/orders/${I}/stock-checked`, o.token, {});
    ok(twice.s === 409 && /no pack/i.test(twice.j.error || ''), 'marking it again is refused in plain words (' + twice.s + ' ' + twice.j.error + ')');
    ok((await call('/orders/MNG-NOPE-0000/stock-checked', o.token, {})).s === 404, 'an unknown order is a 404');
    // packed again after an undo, and again not checked: the old check does not hide the new pack
    ok((await call(`/orders/${I}/undo`, o.token, {})).j.state === 'topack', 'setup: the pack is undone');
    await devStock({ planFails: true });
    const tp = await call(`/orders/${I}/advance`, s.token, { to: 'packed' });
    await devStock({ planFails: false });
    const u3 = await unplannedOf();
    ok(tp.j.ok && u3 && u3.length === 1 && u3[0].kind === 'plan', 'the new pack is listed again (' + JSON.stringify(u3) + ')');
  }
  // Task 6b: packaging is a hand-kept list. Remove = archive, owner only; adding the same name brings it back.
  {
    const list = async () => (await call('/inventory', o.token)).j.items || [];
    const add = await call('/inventory/item', o.token, { name: 'Practice bubble wrap', kind: 'packaging', unit: 'rolls' });
    ok(add.j.ok && add.j.slug === 'practice-bubble-wrap', 'owner adds a packaging item (' + JSON.stringify(add.j) + ')');
    ok((await call('/inventory/item', s.token, { name: 'Staff tape', kind: 'packaging' })).s === 403, 'staff cannot add an item');
    const cnt = await call('/inventory/count', s.token, { slug: 'practice-bubble-wrap', counted: 9, note: 'first count' });
    ok(cnt.j.ok && cnt.j.onHand === 9, 'staff types a count for it');
    const it = (await list()).find((i) => i.slug === 'practice-bubble-wrap');
    ok(it && it.counted === true && it.on_hand === 9 && typeof it.last_counted === 'string', 'the list shows 9 and when it was counted');
    const rs = await call('/inventory/item/remove', s.token, { slug: 'practice-bubble-wrap' });
    ok(rs.s === 403 && !rs.j.ok, 'staff gets 403 on remove (' + rs.s + ')');
    ok((await list()).some((i) => i.slug === 'practice-bubble-wrap'), 'a refused remove changes nothing');
    const rb = await call('/inventory/item/remove', o.token, { slug: 'atta-kesari' });
    ok(rb.s === 400 && /Biscuits stay/.test(rb.j.error || ''), 'a biscuit cannot be removed (' + rb.s + ' ' + rb.j.error + ')');
    const ro = await call('/inventory/item/remove', o.token, { slug: 'practice-bubble-wrap' });
    ok(ro.j.ok && !(await list()).some((i) => i.slug === 'practice-bubble-wrap'), 'owner removes it and it leaves the list');
    ok((await call('/inventory/item/remove', o.token, { slug: 'practice-bubble-wrap' })).s === 404, 'removing it twice is refused');
    const back = await call('/inventory/item', o.token, { name: 'Practice bubble wrap', kind: 'packaging', unit: 'rolls' });
    const it2 = (await list()).find((i) => i.slug === 'practice-bubble-wrap');
    ok(back.j.ok && back.j.slug === 'practice-bubble-wrap' && it2 && it2.on_hand === 9, 'adding the name again brings it back with its count');
  }
  // fix round 1: re-add by name for the seeded items, and a typed count of 0 is recorded
  {
    const list = async () => (await call('/inventory', o.token)).j.items || [];
    ok((await call('/inventory/item/remove', o.token, { slug: 'mono-kesari' })).j.ok && !(await list()).some((i) => i.slug === 'mono-kesari'), 'owner removes the seeded Mono carton: Kesari');
    const dup = await call('/inventory/item', o.token, { name: 'Mono carton: Kesari', kind: 'packaging', unit: 'cartons' });
    const mk = (await list()).find((i) => i.slug === 'mono-kesari');
    ok(dup.j.ok && dup.j.slug === 'mono-kesari' && dup.j.restored === true && !!mk && !(await list()).some((i) => i.slug === 'mono-carton-kesari'), 'adding its name brings mono-kesari back, no look-alike item (' + JSON.stringify(dup.j) + ')');
    const again = await call('/inventory/item', o.token, { name: ' mono CARTON: kesari', kind: 'packaging' });
    ok(again.s === 409 && again.j.error === 'That item is already on the list.', 'an active item with that name is refused (' + again.s + ' ' + again.j.error + ')');
    const z = await call('/inventory/count', s.token, { slug: 'label-stamp', counted: 0 });
    const ls = (await list()).find((i) => i.slug === 'label-stamp');
    ok(z.j.ok && z.j.onHand === 0 && ls.counted === true && ls.on_hand === 0 && typeof ls.last_counted === 'string' && ls.status === 'ok', 'staff types 0 for labels: recorded as a count (' + JSON.stringify([ls.counted, ls.status]) + ')');
    await call('/inventory/level', o.token, { slug: 'label-stamp', lowLevel: 5 });
    ok((await list()).find((i) => i.slug === 'label-stamp').status === 'out', 'with a low level of 5 the counted 0 shows OUT');
  }

  // ── Batch receiving, Task 10: lot and delivery routes, private photos, biscuit receipts only through New delivery ──
  {
    const istToday = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const stamp = Date.now() + 7;
    const jpeg = (kb) => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]), Buffer.alloc(Math.round(kb * 1024), 7), Buffer.from([0xff, 0xd9])]).toString('base64');
    // product receipts are blocked, packaging works
    const BLOCK = 'Biscuits are received with Stock, New delivery, so every box gets its lot and the hold check.';
    const rb = await call('/inventory/receive', s.token, { slug: 'atta-original', received: 3, lot: 'X1', bestBefore: '2027-01-01' });
    ok(rb.s === 409 && rb.j.error === BLOCK, 'a biscuit receipt through the old route is refused in plain words (' + rb.s + ' ' + rb.j.error + ')');
    const rp = await call('/inventory/receive', s.token, { slug: 'mono-original', received: 5 });
    ok(rp.j.ok, 'a packaging receipt still works (' + rp.s + ' ' + rp.j.error + ')');
    // a delivery of two flavours (Original + Ajwain), bake today
    const dv = await call('/stock/deliveries', s.token, { id: 'practice-t10-' + stamp, billNo: 'T10-' + stamp, bakeDate: istToday, cartons: 2, invoiceRupees: 1700, freight: { porter: 100 }, rows: [{ slug: 'atta-original', invoiceBoxes: 10, counted: 10, rateRupees: 85 }, { slug: 'atta-ajwain', invoiceBoxes: 10, counted: 10, rateRupees: 85 }] });
    ok(dv.j.ok && dv.j.lots.length === 2, 'setup: a two-flavour delivery is saved (' + dv.s + ' ' + dv.j.error + ')');
    const lo = dv.j.lots.find((l) => l.slug === 'atta-original'), la = dv.j.lots.find((l) => l.slug === 'atta-ajwain');
    const enc = (c) => encodeURIComponent(c);
    // a line a delivery wrote cannot be corrected or cancelled one line at a time (that would skip the hold check)
    {
      const FROM = 'This line came from a delivery. Use Correct whole delivery or Fix lot.';
      const hl = ((await call('/inventory/history?slug=atta-ajwain&types=RECEIVE&limit=20', s.token)).j.movements || []).find((m) => m.lot_code === la.code);
      const before = (await call('/inventory', o.token)).j.items.find((i) => i.slug === 'atta-ajwain').on_hand;
      ok(!!hl && hl.delivery_id === 'practice-t10-' + stamp, 'setup: the history line of the new delivery carries its delivery_id');
      const rc = await call('/inventory/receive', s.token, { slug: 'atta-ajwain', received: 12, lot: la.code, bestBefore: hl.best_before, replaces: hl.id });
      ok(rc.s === 409 && rc.j.error === FROM, 'correcting a delivery line through receive+replaces is refused (' + rc.s + ' ' + rc.j.error + ')');
      const rv = await call('/inventory/reverse', o.token, { id: hl.id, reason: 'typo' });
      ok(rv.s === 409 && rv.j.error === FROM, 'cancelling a delivery line is refused, even for the owner (' + rv.s + ' ' + rv.j.error + ')');
      ok((await call('/inventory', o.token)).j.items.find((i) => i.slug === 'atta-ajwain').on_hand === before, 'and nothing was written');
    }
    // delivery page, prefill (registered before :id), lots list, lot page, search
    const pre = await call('/stock/deliveries/prefill', s.token);
    ok(pre.s === 200 && pre.j.ok && pre.j.rates && pre.j.rates['atta-original'] === 85 && pre.j.freight, 'prefill answers (not read as a delivery id): ' + pre.s + ' ' + JSON.stringify(pre.j).slice(0, 120));
    // Task 11: the review screen's preview (staff) gives codes, dates and warnings and writes nothing; a refusal is a 400 in plain words
    {
      const lotsBefore = (await call('/stock/lots', s.token)).j.lots.length;
      const pv = await call('/stock/deliveries/preview', s.token, { id: 'practice-t11-pv-' + stamp, billNo: 'T11PV-' + stamp, bakeDate: istToday, cartons: 1, invoiceRupees: 1, freight: { porter: 10 }, rows: [{ slug: 'atta-kesari', invoiceBoxes: 5, counted: 5, rateRupees: 100 }] });
      ok(pv.s === 200 && pv.j.ok && pv.j.preview === true && pv.j.lots.length === 1 && /^MNGK-\d{6}-\d{2}$/.test(pv.j.lots[0].code) && pv.j.lots[0].websiteStop && pv.j.warnings.some((w) => w.key === 'invoice_mismatch'), 'staff preview a delivery: code, dates and the warnings (' + pv.s + ' ' + JSON.stringify(pv.j).slice(0, 200) + ')');
      ok((await call('/stock/lots', s.token)).j.lots.length === lotsBefore && (await call('/stock/deliveries/practice-t11-pv-' + stamp, s.token)).s === 404, 'and nothing was saved');
      const pb = await call('/stock/deliveries/preview', s.token, { id: 'practice-t11-pv2-' + stamp, billNo: 'T10-' + stamp, bakeDate: istToday, rows: [{ slug: 'atta-kesari', invoiceBoxes: 5, counted: 5, rateRupees: 100 }] });
      ok(pb.s === 400 && /^Bill T10-\d+ part 1 is already saved/.test(pb.j.error || ''), 'a bill already saved is refused at preview (' + pb.s + ' ' + pb.j.error + ')');
      ok((await call('/stock/deliveries/preview', null, { id: 'x' })).s === 401, 'preview needs a session');
    }
    const dp = await call('/stock/deliveries/practice-t10-' + stamp, s.token);
    ok(dp.s === 200 && dp.j.delivery.billNo === 'T10-' + stamp && dp.j.delivery.status === 'received' && dp.j.lots.length === 2 && dp.j.lots[0].status === 'hold' && dp.j.lots[0].onHand === 10 && Array.isArray(dp.j.toRaise) && dp.j.canCorrect === true, 'staff read the delivery page: ' + JSON.stringify(dp.j).slice(0, 300));
    ok((await call('/stock/deliveries/nope-' + stamp, s.token)).s === 404, 'an unknown delivery is a 404');
    const ll = await call('/stock/lots', s.token);
    ok(ll.s === 200 && Array.isArray(ll.j.lots) && ll.j.lots.some((l) => l.code === lo.code), 'the lots list answers');
    const lp = await call(`/stock/lots/${enc(lo.code)}`, s.token);
    ok(lp.s === 200 && lp.j.lot.code === lo.code && lp.j.numbers.onHand === 10, 'the lot page answers');
    const sr = await call(`/stock/search?q=${enc(lo.code.toLowerCase())}`, s.token);
    ok(sr.s === 200 && sr.j.lot && sr.j.lot.code === lo.code, 'search finds the lot by code (' + JSON.stringify(sr.j) + ')');
    // a shared old code: two flavours under 15OCT26 -> 409 with choose; slug picks one
    const sh = await call('/stock/lots/15OCT26', s.token);
    ok(sh.s === 409 && Array.isArray(sh.j.choose) && sh.j.choose.length >= 2 && sh.j.choose[0].code === '15OCT26' && sh.j.choose[0].slug && sh.j.choose[0].name, 'a shared code answers 409 with the choose list (' + sh.s + ' ' + JSON.stringify(sh.j).slice(0, 200) + ')');
    const sh1 = await call('/stock/lots/15OCT26?slug=atta-kesari', s.token);
    ok(sh1.s === 200 && sh1.j.lot.slug === 'atta-kesari', 'with ?slug= the shared code opens that flavour');
    // Task 12: the practice admin mirrors the migration's backfill: lot 15OCT26 has a released row per flavour, the sticker code an alias
    const al = await call('/stock/search?q=' + enc('MNGK-261016-01'), s.token);
    ok(al.s === 200 && al.j.lot && al.j.lot.code === '15OCT26' && al.j.lot.slug === 'atta-kesari', 'search by the sticker code MNGK-261016-01 finds lot 15OCT26 of Kesari (' + JSON.stringify(al.j) + ')');
    const alp = await call('/stock/lots/' + enc('MNGK-261016-01'), s.token);
    ok(alp.s === 200 && alp.j.lot.code === '15OCT26' && alp.j.lot.status === 'released' && alp.j.lot.legacy === false && (alp.j.lot.aliases || []).includes('MNGK-261016-01') && alp.j.dates.bakeDate === '2026-10-15', 'its lot page: released, bake date from the code, the sticker code as an alias (' + JSON.stringify(alp.j.lot) + ')');
    // CSV
    const csvRes = await fetch(B + `/stock/lots/${enc(lo.code)}/buyers.csv`, { headers: { Authorization: 'Bearer ' + s.token } });
    const csvText = await csvRes.text();
    ok(csvRes.status === 200 && /^text\/csv; charset=utf-8/.test(csvRes.headers.get('content-type') || '') && csvRes.headers.get('content-disposition') === `attachment; filename="buyers-${lo.code}.csv"` && csvRes.headers.get('cache-control') === 'no-store' && csvText.split('\n')[0] === 'order_id,buyer_name,buyer_phone,city,recipient_name,recipient_phone,packed_on,boxes', 'buyers.csv: type, attachment name, no-store and the header line (' + csvRes.status + ' ' + csvRes.headers.get('content-type') + ' | ' + csvRes.headers.get('content-disposition') + ' | ' + csvText.split('\n')[0] + ')');
    const csvNo = await fetch(B + '/stock/lots/NOPE-1/buyers.csv', { headers: { Authorization: 'Bearer ' + s.token } });
    const csvNoJ = await csvNo.json();
    ok(csvNo.status === 404 && csvNoJ.ok === false && csvNoJ.error === 'No lot with that code.', 'buyers.csv for a missing lot is a JSON 404');
    ok((await fetch(B + `/stock/lots/${enc(lo.code)}/buyers.csv`)).status === 401, 'buyers.csv needs a session');
    // permissions: staff are refused on reject, hold, fix and expired; a claimed isOwner changes nothing
    for (const [p, b] of [[`/stock/lots/${enc(lo.code)}/reject`, { reason: 'bad' }], [`/stock/lots/${enc(lo.code)}/hold`, { reason: 'x', isOwner: true }], [`/stock/lots/${enc(lo.code)}/fix`, { newBakeDate: istToday, isOwner: true }], ['/stock/expired', { isOwner: true }]])
      ok((await call(p, s.token, b)).s === 403, 'staff 403 on ' + p.replace(lo.code, '<code>'));
    // staff release (needs the tick and a weight), then the owner can hold it and release it again
    ok((await call(`/stock/lots/${enc(lo.code)}/release`, s.token, { tasted: false, weightG: 260 })).s === 400, 'release without the taste tick is refused');
    const rel = await call(`/stock/lots/${enc(lo.code)}/release`, s.token, { tasted: true, weightG: 260 });
    ok(rel.j.ok && rel.j.lot.status === 'released' && rel.j.lot.released_by === 'staff@example.com', 'staff release a lot and the actor is recorded (' + rel.s + ' ' + JSON.stringify(rel.j).slice(0, 160) + ')');
    const br = await call(`/stock/lots/${enc(lo.code)}/broken`, s.token, { qty: 1, note: 'cartoning' });
    ok(br.j.ok, 'staff record a box broken while cartoning (' + br.s + ' ' + br.j.error + ')');
    const hd = await call(`/stock/lots/${enc(lo.code)}/hold`, o.token, { reason: 'second look' });
    ok(hd.j.ok && hd.j.lot.status === 'hold', 'the owner puts the released lot on hold');
    ok((await call(`/stock/lots/${enc(la.code)}/reject`, o.token, { reason: 'stale smell' })).j.ok, 'the owner rejects a lot still on hold');
    const fx = await call(`/stock/lots/${enc(lo.code)}/fix`, o.token, { newBakeDate: new Date(Date.now() + 330 * 60000 - 86400000).toISOString().slice(0, 10) });
    ok(fx.j.ok && fx.j.to && fx.j.to !== lo.code, 'the owner fixes the bake date and the lot gets a new code (' + fx.s + ' ' + JSON.stringify(fx.j).slice(0, 160) + ')');
    const ex = await call('/stock/expired', o.token, { slug: 'atta-original' });
    ok(ex.j.ok && Array.isArray(ex.j.lines), 'the owner can run Throw away expired (' + ex.s + ')');
    // correct a delivery: staff who saved it, within a day
    const cr = await call('/stock/deliveries/practice-t10-' + stamp + '/correct', s.token, { reason: 'x' });
    ok(cr.s === 409 && /Released lots|already been used|used/.test(cr.j.error || ''), 'correct is refused once a lot was released (' + cr.s + ' ' + cr.j.error + ')');
    const dp2 = await call('/stock/deliveries/practice-t10-' + stamp, s.token);
    ok(dp2.j.canCorrect === false, 'and the delivery page says canCorrect is false');
    const d3 = await call('/stock/deliveries', s.token, { id: 'practice-t10b-' + stamp, billNo: 'T10B-' + stamp, bakeDate: istToday, cartons: 1, invoiceRupees: 90, freight: { porter: 1 }, rows: [{ slug: 'atta-original', invoiceBoxes: 1, counted: 1, rateRupees: 90 }] });
    const c3 = await call('/stock/deliveries/practice-t10b-' + stamp + '/correct', s.token, { reason: 'typo' });
    ok(d3.j.ok && c3.j.ok && c3.j.prefill && c3.j.prefill.billNo === 'T10B-' + stamp, 'staff correct their own delivery while it is on hold (' + JSON.stringify(d3.j).slice(0, 200) + ' / ' + c3.s + ' ' + JSON.stringify(c3.j).slice(0, 120) + ')');
    // photos
    const PHOTO_TOO_BIG = 'The photo is too large. Take it again.';
    const small = await call('/stock/photo', s.token, { dataUrl: jpeg(2) });
    ok(small.s === 200 && /^\d{4}\/\d{2}\/[0-9a-f]{16}\.jpg$/.test(small.j.path || ''), 'a small JPEG is stored and returns a path (' + small.s + ' ' + JSON.stringify(small.j) + ')');
    const got = await call('/stock/photo?path=' + enc(small.j.path || 'x'), s.token);
    ok(got.s === 200 && /^data:image\/jpeg;base64,/.test(got.j.url || ''), 'GET returns a link for the stored photo');
    ok((await call('/stock/photo?path=' + enc('../../etc/passwd'), s.token)).s === 400, 'a path that is not one of ours is refused');
    const png = await call('/stock/photo', s.token, { dataUrl: 'data:image/png;base64,' + Buffer.from('x').toString('base64') });
    ok(png.s === 400 && png.j.error === 'Only a photo (JPEG) can be added.', 'a non-JPEG is refused: ' + png.j.error);
    const mid = await call('/stock/photo', s.token, { dataUrl: jpeg(760) });
    ok(mid.s === 400 && mid.j.error === PHOTO_TOO_BIG, 'a 760 KB photo is refused with our message (' + mid.s + ' ' + mid.j.error + ')');
    const big = await call('/stock/photo', s.token, { dataUrl: jpeg(900) });
    ok(big.s === 413 && big.j.ok === false && big.j.error === PHOTO_TOO_BIG, 'a 900 KB photo (413 from the body parser) reaches the user as the same message (' + big.s + ' ' + big.j.error + ')');
    const unauth = await call('/stock/photo', null, { dataUrl: jpeg(2) });
    ok(unauth.s === 401, 'photos need a session');
  }
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
