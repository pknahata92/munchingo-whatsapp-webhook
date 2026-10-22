'use strict';
// Review requests: signed link, flavours per order, submission checks, who is due, sending, and the public form API.
//   node scripts/reviews-test.js
process.env.REVIEW_LINK_SECRET = 'test-secret';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

(async () => {
  const r = require('../utils/reviews');

  // ── Task 2: signed link ──
  const t = r.signToken('MNG-AB12-2210');
  ok(r.readToken(t) === 'MNG-AB12-2210', 'a signed link reads back as its order');
  const flip = t.slice(0, -2) + (t.slice(-2, -1) === 'A' ? 'B' : 'A') + t.slice(-1);
  ok(r.readToken(flip) === null, 'changing one character breaks the link');
  const other = r.signToken('MNG-ZZ99-0101');
  ok(r.readToken(other) !== 'MNG-AB12-2210', "another order's link never reads as this order");
  ok(r.readToken('') === null && r.readToken('nonsense') === null && r.readToken(null) === null, 'junk links read as nothing');
  { const keep = process.env.REVIEW_LINK_SECRET; delete process.env.REVIEW_LINK_SECRET; let threw = false; try { r.signToken('X'); } catch (e) { threw = true; } ok(threw, 'signing without REVIEW_LINK_SECRET throws'); process.env.REVIEW_LINK_SECRET = keep; }

  // ── Task 2: flavours per order (gift sets opened up) ──
  const slugs = (o) => r.flavoursFor(o).map((f) => f.slug).join(',');
  ok(slugs({ items: [{ slug: 'trio-gift-set-kesari-lite-sugar-original', quantity: 1 }] }) === 'atta-original,atta-kesari,atta-lite-sugar', 'a Trio becomes its three flavours, in the fixed order (' + slugs({ items: [{ slug: 'trio-gift-set-kesari-lite-sugar-original', quantity: 1 }] }) + ')');
  ok(slugs({ items: [{ slug: 'full-range-set', quantity: 1 }] }) === 'atta-original,atta-kesari,atta-lite-sugar,atta-ajwain', 'a Full Range set becomes all four flavours');
  ok(slugs({ items: [{ slug: 'atta-original', quantity: 2 }] }) === 'atta-original', 'two boxes of one flavour is one row');
  ok(r.flavoursFor({ items: [{ slug: 'atta-lite-sugar', quantity: 1 }] })[0].name === 'Atta Sugar-Lite', 'rows carry the product name');

  // ── Task 2: submission checks ──
  const order = { order_id: 'MNG-AB12-2210', customer_name: 'Riya Kapoor', customer_phone: '919810000001', items: [{ slug: 'trio-gift-set-kesari-lite-sugar-original', quantity: 1 }], delivery_address: { raw: 'Flat 2, Bandra, Mumbai, Maharashtra - 400050', city: 'Mumbai', state: 'Maharashtra' } };
  const good = { ratings: { 'atta-original': 5, 'atta-kesari': 4, 'atta-lite-sugar': 3 }, comment: 'Lovely', showAs: 'name', consent: true };
  let v = r.validateSubmission(order, good);
  ok(v.ok && v.row.order_id === 'MNG-AB12-2210' && v.row.ratings['atta-kesari'] === 4 && v.row.display_name === 'Riya' && v.row.city === 'Mumbai' && v.row.consent_publish === true && v.row.customer_phone === '919810000001', 'a complete review is accepted with first name and city (' + JSON.stringify(v.row || v) + ')');
  v = r.validateSubmission(order, { ...good, ratings: { 'atta-original': 5, 'atta-kesari': 4 } });
  ok(!v.ok && v.status === 400 && /Please rate every flavor/.test(v.error), 'a missing flavour is refused');
  v = r.validateSubmission(order, { ...good, ratings: { ...good.ratings, 'atta-ajwain': 5 } });
  ok(!v.ok && v.status === 400, 'a flavour not in the order is refused');
  for (const bad of [0, 6, 4.5, '5', null]) { v = r.validateSubmission(order, { ...good, ratings: { ...good.ratings, 'atta-original': bad } }); ok(!v.ok && v.status === 400, 'rating ' + JSON.stringify(bad) + ' is refused'); }
  v = r.validateSubmission(order, { ...good, comment: 'x'.repeat(501) });
  ok(!v.ok && v.status === 400, 'a comment over 500 characters is refused');
  v = r.validateSubmission(order, { ...good, comment: '  ' + 'y'.repeat(500) + '  ' });
  ok(v.ok && v.row.comment.length === 500, 'the limit counts after trimming');
  v = r.validateSubmission(order, { ...good, showAs: 'anonymous' });
  ok(v.ok && v.row.display_name === 'Anonymous buyer' && v.row.city === '', 'anonymous hides name and city');
  v = r.validateSubmission(order, { ...good, consent: false });
  ok(v.ok && v.row.consent_publish === false, 'no tick means no consent to publish');
  v = r.validateSubmission(order, { ...good, comment: '<b>hi</b>' });
  ok(v.ok && v.row.comment === '<b>hi</b>', 'the comment is stored as typed (escaping happens wherever it is shown)');
  ok(r.cityOf({ delivery_address: { raw: 'House 4, Sector 9, Gurugram, Haryana - 122001' } }) === 'Gurugram', 'city from the address text when there is no city field');
  ok(r.firstName({ customer_name: '  aarav  mehta ' }) === 'Aarav', 'first name, trimmed and capitalised');

  console.log(`reviews-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
