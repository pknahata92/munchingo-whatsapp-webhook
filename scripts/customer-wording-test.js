'use strict';
// Customer-facing wording after Diwali (Prashant, 9 Nov 2026): the sets are the "Trio Set" and the "Full Range Set" (no "gift"),
// and every Munchingo Flavor is written "Flavor" / "Flavors" (capital F, American spelling) in emails, WhatsApp texts and errors.
//   node scripts/customer-wording-test.js
const fs = require('fs'), path = require('path');
process.env.SUPABASE_URL = 'x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'x'; process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'x';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const stub = (rel, exp) => { const f = require.resolve(path.join(__dirname, '..', rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };
stub('utils/prices.js', { current: () => null, ensureFresh: async () => {}, isOn: () => false });
stub('utils/stock.js', { ensureFresh: async () => {}, soldOutSlugs: () => [], sellable: async () => ({}) });
stub('utils/database.js', {});
const src = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const plain = (html) => html.replace(/&#8377;/g, '₹').replace(/&middot;/g, '·').replace(/&rsquo;/g, '’').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const lowerFlavor = (t) => t.match(/.{0,30}(\bflavou?rs?\b|\bFlavours?\b).{0,20}/g);

const E = require('../utils/emailTemplates');
const order = { order_id: 'MNG-AB12-0911', customer_name: 'Riya Kapoor', total: 749, created_at: new Date().toISOString(), items: [{ slug: 'trio-gift-set-ajwain-kesari-original', productName: 'Trio Gift Set', quantity: 1, item_price: 749, unit: '750g, 3 Flavors' }] };

// review request emails (standard and founders): "rate each Flavor"
for (const founders of [false, true]) {
  const html = E.reviewRequestHtml({ order, url: 'https://munchingo.com/review?t=x', founders });
  ok(/rate each Flavor\b/.test(html), (founders ? 'founders' : 'standard') + ' review email: rate each Flavor');
  ok(!lowerFlavor(plain(html)), (founders ? 'founders' : 'standard') + ' review email: no lowercase flavor(s): ' + (lowerFlavor(plain(html)) || []).join(' | '));
}
ok(E.reviewRequestHtml({ order, url: 'u' }).includes('How were the cookies? Rate each Flavor in about 20 seconds.'), 'review email preheader: Rate each Flavor in about 20 seconds.');

// the order confirmation (which carries the set block): no "gift set" in the email's own words, no lowercase flavours.
// The item rows print the stored order name (catalog NAMES: "Trio Set" / "Full Range Set"; Zoho Books maps them to the old item keys).
const conf = plain(E.customerConfirmationHtml({ order: { ...order, items: [{ ...order.items[0], productName: 'Trio' }] }, invoice: null }));
ok(!/gift set/i.test(conf), 'confirmation email: no "gift set" wording: ' + (conf.match(/.{0,30}gift set.{0,20}/i) || [''])[0]);
ok(!lowerFlavor(conf), 'confirmation email: no lowercase flavor(s): ' + (lowerFlavor(conf) || []).join(' | '));
ok(conf.includes('Build a set ↗') || /Build a set/.test(conf), 'confirmation email: the set block button reads Build a set');

// review page errors
const R = require('../utils/reviews');
const rOrder = { order_id: 'MNG-AB12-0911', status: 'paid', customer_name: 'Riya', customer_phone: '919810000001', delivery_address: { city: 'Mumbai' }, items: [{ slug: 'atta-original', quantity: 1 }, { slug: 'atta-kesari', quantity: 1 }] };
let v = R.validateSubmission(rOrder, { ratings: { 'atta-original': 5 }, comment: '', showAs: 'name', consent: false });
ok(!v.ok && v.error === 'Please rate every Flavor.', 'review page: Please rate every Flavor. (' + v.error + ')');
v = R.validateSubmission(rOrder, { ratings: { 'atta-original': 5, 'atta-kesari': 4, 'atta-ajwain': 3 }, comment: '', showAs: 'name', consent: false });
ok(!v.ok && v.error === 'That Flavor is not in this order.', 'review page: That Flavor is not in this order. (' + v.error + ')');

// checkout's Trio error and the WhatsApp ingredients reply
ok(src('routes/checkout.js').includes("'A Trio Set holds 3 different Flavors. Please rebuild it from the set picker and try again.'"), 'checkout Trio error: A Trio Set holds 3 different Flavors … set picker');
ok(!/Trio Gift Set holds|different flavours/.test(src('routes/checkout.js')), 'checkout: old Trio error wording gone');
const mh = src('handlers/messageHandler.js');
ok(mh.includes('`Full ingredient list per Flavor:\\n`'), 'WhatsApp ingredients: Full ingredient list per Flavor:');
ok(mh.includes('`❌ Artificial colours or flavours\\n\\n`'), 'WhatsApp ingredients: generic "Artificial colours or flavours" (flavourings) stays');

// "gift" dropped from the last backend wording (9 Nov 2026): set names, coupon errors, invoice footer, email note heading, admin labels
const cat2 = require('../utils/catalog');
ok(cat2.nameForSlug('full-range-set') === 'Full Range Set' && cat2.nameForSlug('trio-gift-set-ajwain-kesari-original') === 'Trio Set', 'catalog names: Full Range Set / Trio Set');
const cp = src('utils/coupons.js');
ok(cp.includes("'This code does not apply to Trio or Full Range Sets or hampers.'") && cp.includes("'Offers do not apply to Trio or Full Range Sets or hampers. Add single boxes to use this code.'") && cp.includes('(Trio and Full Range Sets and hampers are not included).'), 'coupons: error wording says Trio or Full Range Sets');
ok(!/gift boxes/.test(cp.replace(/^\s*\/\/.*$/gm, '')), 'coupons: no "gift boxes" outside comments');
const inv = src('utils/invoice.js');
ok(inv.includes(`'Loved it? A Munchingo Trio or Full Range Set makes the best "just because". Visit ' + inv.seller.site + '/build-a-box'`) && !/gift set makes|\/#gifts/.test(inv), 'invoice footer: Trio or Full Range Set, links to /build-a-box');
const ac = src('utils/adminCoupons.js');
ok(ac.includes("'Orders that include a Trio Set'") && ac.includes("'Orders that include the Full Range Set'") && !/Gift Set'/.test(ac), 'admin coupon scope labels: Trio Set / Full Range Set');
const withNote = plain(E.customerConfirmationHtml({ order: { ...order, gift_note: 'Happy birthday' }, invoice: null }));
ok(withNote.includes('Your note') && !/Your gift note/.test(withNote), 'confirmation email: heading is "Your note"');

console.log(`customer-wording-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
