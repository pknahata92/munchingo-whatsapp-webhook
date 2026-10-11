'use strict';
// Stock-up tiers and the "one discount per order" rule, against a stand-in database and coupon checker.
//   node scripts/offers-test.js
const path = require('path');
process.env.SUPABASE_URL = 'x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
let TIERS = [], COUPON = null;
const stub = (rel, exp) => { const f = require.resolve(path.join(__dirname, '..', rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };
const dbStub = { listSpendTiers: async () => TIERS };
stub('utils/database.js', dbStub);
stub('utils/coupons.js', { validateCoupon: async (code, ctx) => (COUPON ? COUPON(code, ctx) : { ok: false, error: 'That code is not valid.' }) });
const offers = require('../utils/offers');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const it = (slug, quantity, item_price) => ({ slug, quantity, item_price });
const LADDER = [
  { id: 1, min_singles: 1500, discount: 100, active: true },
  { id: 2, min_singles: 2000, discount: 200, active: true },
  { id: 3, min_singles: 3000, discount: 350, active: true },
];
const run = async (items, extra) => { offers.invalidate(); return offers.priceCart({ items, couponCode: null, customerPhone: null, subscribe: false, subscriptionPct: 8, ...extra }); };

(async () => {
  TIERS = LADDER;
  let r = await run([it('atta-original', 5, 300)]);
  ok(r.realTotal === 1500 && r.singles === 1500 && r.discount.kind === 'tier' && r.discount.amount === 100 && r.finalTotal === 1400, '₹1,500 of singles gets ₹100 off');
  ok(r.next && r.next.need === 500 && r.next.off === 200, 'nudge: ₹500 more to save ₹200');
  ok(/1,500/.test(r.discount.label), 'default label names the threshold');

  r = await run([it('full-range-set', 1, 999), it('atta-original', 2, 300)]);
  ok(r.singles === 600 && r.discount === null && r.finalTotal === 1599 && r.next.need === 900, 'gift sets never count towards a tier');

  r = await run([it('atta-original', 7, 300), it('atta-kesari', 3, 350)]);
  ok(r.discount.amount === 350 && r.next === null, '₹3,150 of singles gets the top tier and no further nudge');

  TIERS = [LADDER[0], LADDER[1], { ...LADDER[2], ends_at: '2020-01-01T00:00:00Z' }];
  r = await run([it('atta-original', 10, 300)]);
  ok(r.discount.amount === 200, 'an ended tier is ignored');
  TIERS = [LADDER[0], { ...LADDER[1], active: false }];
  r = await run([it('atta-original', 7, 300)]);
  ok(r.discount.amount === 100, 'a paused tier is ignored');
  TIERS = [{ ...LADDER[0], starts_at: '2099-01-01T00:00:00Z' }];
  r = await run([it('atta-original', 5, 300)]);
  ok(r.discount === null && r.tiers.length === 0, 'a tier that has not started is ignored');
  TIERS = [{ id: 9, min_singles: 100, discount: 5000, active: true }];
  r = await run([it('atta-original', 3, 300)]);
  ok(r.discount.amount === 900 && r.finalTotal === 0, 'a tier never takes more than the single boxes');

  TIERS = LADDER;
  COUPON = () => ({ ok: true, coupon: { code: 'BIG' }, discountAmount: 300, finalTotal: 1700 });
  r = await run([it('atta-original', 5, 300)], { couponCode: 'big' });
  ok(r.discount.kind === 'coupon' && r.discount.amount === 300 && r.discount.code === 'BIG' && r.discount.beat.kind === 'tier', 'a bigger code beats the tier');
  COUPON = () => ({ ok: true, coupon: { code: 'SMALL' }, discountAmount: 74, finalTotal: 1426 });
  r = await run([it('atta-original', 5, 300)], { couponCode: 'small' });
  ok(r.discount.kind === 'tier' && r.discount.amount === 100 && r.discount.beat.kind === 'coupon', 'a bigger tier beats the code');
  COUPON = () => ({ ok: true, coupon: { code: 'SAME' }, discountAmount: 100, finalTotal: 1400 });
  r = await run([it('atta-original', 5, 300)], { couponCode: 'same' });
  ok(r.discount.kind === 'tier', 'a tie goes to the tier (no code use burned)');
  COUPON = null;
  r = await run([it('atta-original', 5, 300)], { couponCode: 'nope' });
  ok(r.couponError === 'That code is not valid.' && r.discount.kind === 'tier', 'a bad code reports its error and the tier still applies');
  COUPON = () => ({ ok: true, coupon: { code: 'X' }, discountAmount: 500, finalTotal: 1000 });
  r = await run([it('atta-original', 5, 300)], { couponCode: 'x', subscribe: true });
  ok(r.discount.kind === 'subscription' && r.discount.amount === 120 && r.finalTotal === 1380, 'Subscribe & Save stands alone (8%)');
  COUPON = null;

  TIERS = []; r = await run([it('atta-original', 5, 300)]);
  ok(r.discount === null && r.next === null && r.finalTotal === 1500, 'no tiers: plain total');
  dbStub.listSpendTiers = async () => { throw new Error('relation "spend_tiers" does not exist'); };
  r = await run([it('atta-original', 5, 300)]);
  ok(r.discount === null && r.finalTotal === 1500, 'missing table (migration not run) means no tiers, no crash');

  console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
