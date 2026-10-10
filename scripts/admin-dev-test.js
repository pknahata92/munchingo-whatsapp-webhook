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

  // team: disable staff -> immediately locked out
  ok((await call('/team', o.token, { email: 'staff@example.com', role: 'staff', active: false })).j.ok, 'owner disables staff');
  ok((await call('/orders', s.token)).s === 401, 'disabled staff locked out at once');
  ok((await call('/team', o.token, { email: 'owner@example.com', role: 'staff' })).s === 409, 'cannot demote env owner');
  ok((await call('/team', o.token, { email: 'staff@example.com', role: 'staff', active: true })).j.ok, 're-enable staff');
  ok((await call('/orders', s.token)).s === 200, 're-enabled staff back in');
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
