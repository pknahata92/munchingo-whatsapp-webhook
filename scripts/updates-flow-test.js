'use strict';
// End to end on the practice copy:  node scripts/admin-dev.js   (one terminal, wait ~8 s)   node scripts/updates-flow-test.js
// Delhivery order: packed -> shipment created -> customer NOT told "shipped" -> courier collects -> told once -> delivered -> marked delivered, told once.
const fs = require('fs');
const B = 'http://localhost:8430';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const call = async (p, tok, body) => { const r = await fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body || {}) }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
const get = async (p, tok) => { const r = await fetch(B + p, { headers: { Authorization: 'Bearer ' + tok } }); return r.json(); };
(async () => {
  await call('/admin/api/login', null, { email: 'owner@example.com' });
  await new Promise((r) => setTimeout(r, 300));
  const code = fs.readFileSync('/tmp/admin-dev-code-owner.txt', 'utf8');
  const tok = (await call('/admin/api/verify', null, { email: 'owner@example.com', code })).j.token;
  const id = 'MNG-BBBB-1010';
  const events = async () => (await get(`/admin/api/orders/${id}`, tok)).order.events.map((e) => e.event);
  const count = async (n) => (await events()).filter((e) => e === n).length;

  ok((await call(`/admin/api/orders/${id}/advance`, tok, { to: 'packed' })).j.ok, 'packed');
  ok(await count('packed_email') === 1 && await count('packed_wa') === 1, 'packed: email + WhatsApp recorded once');
  const made = await call(`/admin/api/orders/${id}/delhivery-shipment`, tok, {});
  ok(made.j.ok && made.j.deferred === true && made.j.emailed === false, 'shipment created, shipped notice deferred');
  ok(await count('shipped_email') === 0 && await count('shipped_wa') === 0, 'NOT told shipped while the parcel is still with us');

  await call('/dev/track', null, { status: 'Manifested' });
  let sw = await call('/dev/sweep'); ok(sw.j.waiting >= 1 && await count('shipped_email') === 0, 'courier has not collected: still nothing sent');
  await call('/dev/track', null, { status: 'In Transit' });
  await call('/dev/sweep'); await call('/dev/sweep');
  ok(await count('shipped_email') === 1 && await count('shipped_wa') === 1, 'courier collected: told once, not repeated');
  await call('/dev/track', null, { status: 'Delivered' });
  await call('/dev/sweep'); await call('/dev/sweep');
  const d = await get(`/admin/api/orders/${id}`, tok);
  ok(d.order.state === 'delivered', 'marked delivered from Delhivery tracking, state: ' + d.order.state);
  ok(await count('delivered_email') === 1 && await count('delivered_wa') === 1, 'delivered: told once');

  console.log(`updates-flow: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
