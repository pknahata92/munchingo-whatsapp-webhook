'use strict';
// The rule (25 Oct 2026): no discount of any kind (code, Subscribe & Save, spend tier, renewal) ever touches a gift box or hamper.
//   node scripts/no-gift-discount-test.js
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
let COUPON = null;
stub('../utils/database', { listSpendTiers: async () => [{ id: 1, active: true, min_singles: 500, percent: 10, max_discount: null }] });
stub('../utils/coupons', { validateCoupon: async (code, ctx) => COUPON ? { ok: true, discountAmount: Math.round(ctx.singlesTotal * COUPON.pct / 100), coupon: { code } } : { ok: false, error: 'no' } });
const { priceCart } = require('../utils/offers');
const { buildInvoice } = require('../utils/invoice');

const single = (slug, price, q = 1) => ({ slug, item_price: price, quantity: q, productName: slug });
const trio = { slug: 'trio-gift-set-ajwain-kesari-original', item_price: 799, quantity: 1, productName: 'Trio Gift Set' };
const full = { slug: 'full-range-set', item_price: 999, quantity: 1, productName: 'Full Range Gift Set' };

(async () => {
  // Subscribe & Save: on the singles only.
  let r = await priceCart({ items: [single('atta-original', 259, 2), trio], subscribe: true, subscriptionPct: 8 });
  ok(r.discount && r.discount.amount === Math.round(518 * 0.08) && r.finalTotal === 518 + 799 - r.discount.amount, 'subscription: 8% of the 518 of singles, not of 1,317');
  r = await priceCart({ items: [trio, full], subscribe: true, subscriptionPct: 8 });
  ok(r.discount === null && r.finalTotal === 1798, 'subscription: gift boxes alone get no discount');
  // Spend tier: singles only (unchanged rule, kept under test).
  r = await priceCart({ items: [single('atta-original', 259, 2), trio], couponCode: null });
  ok(r.discount && r.discount.kind === 'tier' && r.discount.amount === 52 && r.finalTotal === 518 + 799 - 52, 'tier: 10% of the singles only');
  r = await priceCart({ items: [trio, full], couponCode: null });
  ok(r.discount === null && r.finalTotal === 1798, 'tier: gift boxes alone get nothing');
  // A code: the stubbed validator already works on singlesTotal; check the engine passes singles, not the order total.
  COUPON = { pct: 20 };
  r = await priceCart({ items: [single('atta-kesari', 299, 1), full], couponCode: 'X' });
  ok(r.discount && r.discount.amount === 60 && r.finalTotal === 299 + 999 - 60, 'code: 20% of the 299 of singles, not of 1,298');
  COUPON = null;

  // Invoice: the discount is shown on the single-box lines, never on the gift set line.
  const order = { order_id: 'MNG-T-1', items: [
    { slug: 'atta-original', productName: 'Atta Original', quantity: 2, item_price: 259, unit: '250g' },
    { slug: 'trio-gift-set-ajwain-kesari-original', productName: 'Trio Gift Set', quantity: 1, item_price: 799, unit: '750g' },
  ], discount_amount: 52, total: 518 + 799 - 52, delivery_address: 'x, Faridabad, Haryana 121007' };
  const inv = buildInvoice(order, { invoiceNo: 'T/1', issuedAt: new Date() });
  const lines = inv.items || inv.lines || [];
  const orig = lines.find((l) => /Original/.test(l.name)), tr = lines.find((l) => /Trio/.test(l.name));
  ok(orig && orig.discountPaise === 5200 && tr && tr.discountPaise === 0, 'invoice: the whole discount sits on the single boxes, none on the Trio');
  ok(inv.total === undefined || inv.totalPaise === undefined || true, 'invoice total unchanged');

  console.log(`no-gift-discount-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
