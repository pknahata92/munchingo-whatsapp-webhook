'use strict';
// Box pricing, pages and wording: set cards, retired promo gone, Subscribe & Save wording, terms clause, stale copy.
//   SITE_DIR=<website> node scripts/website-box-cards-test.js
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const SITE = process.env.SITE_DIR || path.resolve(__dirname, '../../../munchingo-website');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const read = (f) => fs.readFileSync(path.join(SITE, f), 'utf8');
const doc = (f) => new JSDOM(read(f)).window.document;
const text = (el) => (el ? norm(el.textContent) : '');
const pages = fs.readdirSync(SITE).filter((f) => f.endsWith('.html'));
const jsFiles = fs.readdirSync(path.join(SITE, 'js')).filter((f) => f.endsWith('.js')).map((f) => 'js/' + f);

// Set cards: index and shop
for (const f of ['index.html', 'shop.html']) {
  const d = doc(f);
  const cards = [...d.querySelectorAll('a[href="build-a-box.html"]')];
  const trio = cards.find((a) => /The Trio/.test(a.textContent) && a.querySelector('[data-price-for="trio-gift-set"]'));
  const full = cards.find((a) => /The Full Range/.test(a.textContent) && a.querySelector('[data-price-for="full-range-set"]'));
  ok(trio && /from ₹749/.test(text(trio.querySelector('.set-price'))), f + ': Trio shows from ₹749: ' + text(trio && trio.querySelector('.set-price')));
  ok(full && text(full.querySelector('.set-price')) === '₹999', f + ': Full Range shows ₹999: ' + text(full && full.querySelector('.set-price')));
}
// Corporate gifting cards
{
  const t = text(doc('corporate-gifting.html').body);
  ok(t.includes('from ₹749 online for a single set'), 'corporate: from ₹749 online for a single set');
  ok(t.includes('₹999 online'), 'corporate: ₹999 online');
}
// Retired promo elements gone everywhere
for (const f of pages.concat(jsFiles)) {
  const s = read(f);
  ok(!/data-was-for|data-promo-for|data-promo-sets/.test(s), f + ': no data-was-for / data-promo-for / data-promo-sets');
}
// Subscribe & Save and terms
ok(read('checkout.html').includes('Subscribe &amp; Save 5% on single boxes (not gift boxes)'), 'checkout: Subscribe & Save 5% wording');
ok(!/Subscribe &amp; Save 8%/.test(read('checkout.html')), 'checkout: no 8%');
ok(norm(read('terms.html')).includes('Shipping is free on orders of ₹777 or more and on any order with a gift box, and ₹49 on smaller orders.'), 'terms: shipping clause');
// Top bar still says Free shipping from ₹777
for (const f of ['index.html', 'shop.html', 'corporate-gifting.html', 'terms.html']) ok(read(f).includes('Free shipping from ₹777'), f + ': top bar Free shipping from ₹777');
// Stale copy
for (const f of pages.concat(jsFiles)) {
  const s = read(f);
  ok(!/gift-boxed/i.test(s), f + ': no "gift-boxed"');
  ok(!/25 boxes|start at 25|from 25 /i.test(s), f + ': no 25-box bulk minimum');
  if (f !== 'stall.html') ok(!s.includes('₹799'), f + ': no ₹799');
}
for (const f of ['atta-original.html', 'atta-ajwain.html', 'atta-kesari.html', 'atta-lite-sugar.html']) ok(text(doc(f).querySelector('.v2-bundle')).includes('Mix any 3 boxes from ₹749') && !/for ₹749/.test(text(doc(f).querySelector('.v2-bundle'))), f + ': bundle line says Mix any 3 boxes from ₹749');
for (const f of ['atta-original.html', 'atta-ajwain.html', 'atta-kesari.html', 'atta-lite-sugar.html'])
  ok(read(f).includes('(the Trio is from ₹749)'), f + ': (the Trio is from ₹749)');
ok(read('maida-free-cookies-guide.html').includes('gift sets</a> start at ₹749'), 'maida guide: gift sets start at ₹749');
for (const f of ['corporate-gifting.html', 'contact.html']) ok(/20 boxes/.test(read(f)), f + ': says 20 boxes');
ok(/from 20 boxes/.test(read('js/cart.js')), 'cart.js search index says from 20 boxes');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
