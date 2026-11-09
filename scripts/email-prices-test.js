'use strict';
// The email "browse" block reads each single-box price from the catalog at render time, so an admin price change reaches the email.
//   node scripts/email-prices-test.js
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
let LIVE = null;
const p = require.resolve('../utils/prices');
require.cache[p] = { id: p, filename: p, loaded: true, exports: { current: () => LIVE, ensureFresh: async () => {}, isOn: () => !!LIVE } };
const { customerConfirmationHtml, shippedHtml } = require('../utils/emailTemplates');
const order = { order_id: 'MNG-AB12-0911', customer_name: 'Riya Kapoor', total: 518, created_at: new Date().toISOString(), items: [{ slug: 'atta-original', productName: 'Atta Original', quantity: 2, item_price: 259 }] };
const html = () => customerConfirmationHtml({ order, invoice: null }) + '\n' + shippedHtml({ order, carrier: 'Delhivery', awb: '123', trackUrl: 'https://x.test' });
let h = html();
ok(h.includes('&#8377;259') && h.includes('&#8377;299') && h.includes('&#8377;329'), 'built-in prices appear in the browse block: ' + (h.match(/&#8377;\d+ &middot; 250g/g) || []).join(','));
LIVE = { 'atta-original': { price: 271, mrp: 300 }, 'atta-kesari': { price: 311, mrp: 350 }, 'atta-ajwain': { price: 277, mrp: 300 }, 'atta-lite-sugar': { price: 341, mrp: 350 } };
h = html();
const tiles = (h.match(/&#8377;\d+ &middot; 250g/g) || []).join(',');
ok(/&#8377;271 &middot; 250g/.test(h) && /&#8377;311 &middot; 250g/.test(h) && /&#8377;277 &middot; 250g/.test(h) && /&#8377;341 &middot; 250g/.test(h), 'a changed admin price reaches the email tiles: ' + tiles);
console.log(`email-prices-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
