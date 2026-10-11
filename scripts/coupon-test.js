'use strict';
// Checks the checkout-side rules for coupons made in the admin (phone lock, start date, cap, scope, limits) against a stand-in database.
//   node scripts/coupon-test.js
const path = require('path');
process.env.SUPABASE_URL = 'x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
let COUPON = null, REDEEMED = 0;
let PRIOR_PAID = false;
const chain = (table) => {
  const q = { _t: table, _n: 0 };
  const api = {
    select: () => api, eq: () => { q._n++; return api; }, not: () => api, limit: () => api,
    maybeSingle: async () => ({ data: q._t === 'coupons' ? COUPON : null, error: null }),
    then: (res) => res(q._t === 'orders' ? { data: PRIOR_PAID ? [{ order_id: 'MNG-OLD' }] : [], error: null } : { count: REDEEMED, error: null }),
  };
  return api;
};
const f = require.resolve('@supabase/supabase-js', { paths: [path.join(__dirname, '..')] });
require.cache[f] = { id: f, filename: f, loaded: true, exports: { createClient: () => ({ from: chain }) } };
const { validateCoupon } = require('../utils/coupons');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const base = { code: 'T', type: 'percent', value: 15, max_discount_amount: 150, min_order_value: 700, scope_slug: 'trio-gift-set', max_uses: 5, uses_count: 0, max_uses_per_customer: 1, expires_at: '2099-01-01T00:00:00Z', active: true };
const ctx = (extra) => ({ cartSlugs: ['trio-gift-set-ajwain-kesari-original'], realTotal: 739, customerPhone: '919810012345', ...extra });
(async () => {
  COUPON = { ...base }; let r = await validateCoupon('t', ctx()); ok(r.ok && r.discountAmount === 111 && r.finalTotal === 628, '15% of 739 = 111');
  COUPON = { ...base, value: 50 }; r = await validateCoupon('t', ctx({ realTotal: 1999, cartSlugs: ['trio-gift-set-a'] })); ok(r.ok && r.discountAmount === 150, 'cap of 150 binds');
  COUPON = { ...base, min_order_value: 800 }; r = await validateCoupon('t', ctx()); ok(!r.ok && /minimum order/.test(r.error), 'minimum order enforced');
  COUPON = { ...base }; r = await validateCoupon('t', ctx({ cartSlugs: ['atta-original'] })); ok(!r.ok && /only applies/.test(r.error), 'scope enforced (Trio only)');
  COUPON = { ...base, uses_count: 5 }; r = await validateCoupon('t', ctx()); ok(!r.ok && /usage limit/.test(r.error), 'total cap enforced');
  COUPON = { ...base }; REDEEMED = 1; r = await validateCoupon('t', ctx()); ok(!r.ok && /already used/.test(r.error), 'per-customer cap enforced'); REDEEMED = 0;
  COUPON = { ...base, active: false }; r = await validateCoupon('t', ctx()); ok(!r.ok, 'paused code refused');
  COUPON = { ...base, expires_at: '2020-01-01T00:00:00Z' }; r = await validateCoupon('t', ctx()); ok(!r.ok && /expired/.test(r.error), 'expired code refused');
  COUPON = { ...base, starts_at: '2099-01-01T00:00:00Z' }; r = await validateCoupon('t', ctx()); ok(!r.ok && /not active yet/.test(r.error), 'start date enforced');
  COUPON = { ...base, starts_at: '2020-01-01T00:00:00Z' }; r = await validateCoupon('t', ctx()); ok(r.ok, 'a start date in the past is fine');
  COUPON = { ...base, allowed_phone: '919810012345' }; r = await validateCoupon('t', ctx()); ok(r.ok, 'phone lock: the right customer can use it');
  r = await validateCoupon('t', ctx({ customerPhone: '919999999999' })); ok(!r.ok && /specific customer/.test(r.error), 'phone lock: someone else is refused');
  r = await validateCoupon('t', ctx({ customerPhone: null })); ok(!r.ok && /mobile number first/.test(r.error), 'phone lock: asks for the number when it is missing');
  COUPON = { ...base }; delete COUPON.starts_at; delete COUPON.allowed_phone; r = await validateCoupon('t', ctx()); ok(r.ok, 'rows without the new columns behave as before');
  COUPON = { ...base, type: 'flat', value: 100, max_discount_amount: null, scope_slug: null, min_order_value: 0 }; r = await validateCoupon('T', ctx({ realTotal: 80 })); ok(r.ok && r.discountAmount === 80 && r.finalTotal === 0, 'a discount can never exceed the order');
  // 'singles-only' = not applicable on gift sets
  const SO = { ...base, scope_slug: 'singles-only', min_order_value: 0, max_discount_amount: null, value: 10 };
  COUPON = { ...SO }; r = await validateCoupon('t', ctx({ cartSlugs: ['atta-original', 'trio-gift-set-ajwain-kesari-lite-sugar'], realTotal: 1039, singlesTotal: 300 })); ok(r.ok && r.discountAmount === 30 && r.finalTotal === 1009, 'singles-only: 10% of the 300 of singles, not of 1,039');
  COUPON = { ...SO }; r = await validateCoupon('t', ctx({ cartSlugs: ['trio-gift-set-ajwain-kesari-original'], realTotal: 739, singlesTotal: 0 })); ok(!r.ok && /does not apply to gift sets/.test(r.error), 'singles-only: an order of only gift sets is refused with a clear message');
  COUPON = { ...SO }; r = await validateCoupon('t', ctx({ cartSlugs: ['atta-original', 'atta-kesari', 'atta-ajwain'], realTotal: 950, singlesTotal: 950 })); ok(r.ok && r.discountAmount === 95, 'singles-only: an all-singles order gets the full discount');
  COUPON = { ...SO, min_order_value: 800 }; r = await validateCoupon('t', ctx({ cartSlugs: ['atta-original', 'full-range-set'], realTotal: 1299, singlesTotal: 300 })); ok(!r.ok && /of single boxes/.test(r.error), 'singles-only: the minimum counts single boxes only');
  COUPON = { ...SO, type: 'flat', value: 100 }; r = await validateCoupon('t', ctx({ cartSlugs: ['atta-original', 'full-range-set'], realTotal: 1299, singlesTotal: 60 })); ok(r.ok && r.discountAmount === 60, 'singles-only: a flat discount never exceeds the singles in the order');
  COUPON = { ...base, first_order_only: true }; PRIOR_PAID = false; r = await validateCoupon('t', ctx()); ok(r.ok, 'first-order code: a new customer can use it');
  PRIOR_PAID = true; r = await validateCoupon('t', ctx()); ok(!r.ok && /first order/.test(r.error), 'first-order code: a returning customer is refused'); PRIOR_PAID = false;
  r = await validateCoupon('t', ctx({ customerPhone: null })); ok(!r.ok && /mobile number first/.test(r.error), 'first-order code: asks for the number when it is missing');
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
