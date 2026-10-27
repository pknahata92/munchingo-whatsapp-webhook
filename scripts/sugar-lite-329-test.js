'use strict';
// Sugar-Lite sells at Rs 329 (Prashant, 27 Oct 2026; MRP Rs 350 unchanged). The live price is the admin table; these are the
// built-in fallbacks and the static page text, which must agree with it.   node scripts/sugar-lite-329-test.js
const fs = require('fs'), path = require('path');
const SITE = process.env.SITE_DIR || path.resolve(__dirname, '../../../munchingo-website');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const read = (f) => fs.readFileSync(path.join(SITE, f), 'utf8');
const p = require.resolve('../utils/prices');
require.cache[p] = { id: p, filename: p, loaded: true, exports: { current: () => null, ensureFresh: async () => {}, isOn: () => false } };
const cat = require('../utils/catalog');
ok(cat.priceForSlug('atta-lite-sugar') === 329, 'backend fallback price is 329');
ok(cat.priceForSlug('atta-kesari') === 299 && cat.priceForSlug('atta-original') === 259, 'other Flavors unchanged');
ok(/'atta-lite-sugar'[^}]*price: 329/.test(fs.readFileSync(path.join(__dirname, '../utils/emailTemplates.js'), 'utf8')), 'email product grid shows 329');
const page = read('atta-lite-sugar.html');
ok(!/₹299|"price": "299"|'atta-lite-sugar', 299\)/.test(page) && /"price": "329"/.test(page) && /Add to bag · ₹329/.test(page), 'Sugar-Lite page: structured data, price box, button and fallback say 329');
ok(/'Lite-sugar': 329/.test(read('js/gift-builder.js')), 'gift builder fallback 329');
ok(/'atta-lite-sugar': \{[^}]*price: 329/.test(read('js/cart-link.js')), 'cart links fallback 329');
ok(/slug: 'atta-lite-sugar'[\s\S]*?price: 329, mrp: 350, save: 21/.test(read('data/products.js')), 'product data: 329, MRP 350, save 21');
const cart = read('js/cart.js');
ok(/livePrice\('atta-lite-sugar', 329\)/.test(cart) && /slug: 'atta-lite-sugar'[^}]*price: 329/.test(cart), 'cart fallbacks 329');
console.log(`sugar-lite-329-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
