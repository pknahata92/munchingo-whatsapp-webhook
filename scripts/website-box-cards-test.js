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
ok(read('checkout.html').includes('Subscribe &amp; Save 5% on single boxes (not sets)'), 'checkout: Subscribe & Save 5% wording');
ok(!/Subscribe &amp; Save 8%/.test(read('checkout.html')), 'checkout: no 8%');
ok(norm(read('terms.html')).includes('Shipping is free on orders of ₹777 or more and on any order with a Trio or Full Range Set, and ₹49 on smaller orders.'), 'terms: shipping clause');
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
ok(read('maida-free-cookies-guide.html').includes('our <a href="build-a-box.html">sets</a> start at ₹749'), 'maida guide: our sets start at ₹749');
for (const f of ['corporate-gifting.html', 'contact.html']) ok(/20 boxes/.test(read(f)), f + ': says 20 boxes');
ok(/from 20 boxes/.test(read('js/cart.js')), 'cart.js search index says from 20 boxes');


// ---- Final wave, 9 Nov 2026 (Prashant): top bar, note example, Trio Set / Full Range Set, Flavors capitalised ----
const topBar = pages.filter((f) => read(f).includes('<span>Start with any two Flavors</span>'));
ok(topBar.length >= 16, 'the top bar is on ' + topBar.length + ' pages');
for (const f of topBar) {
  const s = read(f);
  ok((s.match(/<span>Trio and Full Range ship free<\/span>/g) || []).length === 1 && (s.match(/<span aria-hidden="true">Trio and Full Range ship free<\/span>/g) || []).length === 1, f + ': top bar says Trio and Full Range ship free (visible span and aria-hidden duplicate)');
}
for (const f of pages.concat(jsFiles, ['data/products.js'])) ok(!/Diwali/.test(read(f)), f + ': no Diwali');
ok(read('cart.html').includes('placeholder="e.g. Happy birthday, love Priya"') && read('checkout.html').includes('placeholder="e.g. Happy birthday, love Priya"') && read('js/gift-builder.js').includes('placeholder="e.g. Happy birthday, love Priya"'), 'note example: e.g. Happy birthday, love Priya (cart, checkout, builder)');
ok(/<label for="cart-gift-note">Add a note <span>\(optional\)<\/span><\/label>/.test(read('cart.html')), 'cart: Add a note (optional)');
ok(read('checkout.html').includes('id="ck-gift-toggle">🎁 Add a note</button>') && read('checkout.html').includes('<label for="ck-gift-note">Note</label>'), 'checkout: Add a note / Note');
// set names and "gift" wording
// code comments, and the regexes that rename old saved bag lines, may still name the old sets; nothing a visitor reads does
const noComments = (f, s) => (f.endsWith('.js') ? s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1') : s.replace(/<!--[\s\S]*?-->/g, ''));
for (const f of pages.concat(jsFiles, ['data/products.js'])) {
  const s = noComments(f, read(f));
  ok(!/Trio Gift Set|Full Range Gift Set/i.test(s.replace(/\/\^?Trio Gift Set[^/]*\/|\/\^?Full Range Gift Set[^/]*\//g, '')), f + ': no "Trio Gift Set" / "Full Range Gift Set"');
  ok(!/Gift boxes ship free/i.test(s), f + ': no "Gift boxes ship free"');
}
// "gift" dropped from the last set mentions (9 Nov 2026)
for (const f of ['404.html', 'shop.html', 'build-a-box.html', 'terms.html']) {
  const s = noComments(f, read(f));
  ok(!/gift box|gift set|Gift box/i.test(s), f + ': no "gift box" / "gift set" / "Gift box"');
}
ok(read('404.html').includes('or build a box.') && read('build-a-box.html').includes('Build a Munchingo box: ') && read('build-a-box.html').includes('with a note."'), 'meta wording: build a box / with a note');
ok(read('shop.html').includes('and two sets.') && (read('shop.html').match(/<span class="v2-tag">Set<\/span>/g) || []).length === 2, 'shop: two sets, tag "Set" x2');
ok((read('corporate-gifting.html').match(/the Trio and Full Range Sets on our /g) || []).length === 2, 'corporate: FAQ (JSON-LD and visible) names the Trio and Full Range Sets');
ok(read('checkout.html').includes('/Trio or Full Range Sets/i.test(data.error'), 'checkout: coupon-error matcher uses the new wording');
for (const f of ['atta-original.html', 'atta-ajwain.html', 'atta-kesari.html', 'atta-lite-sugar.html']) ok(!read(f).includes('🪔') && /<span>Gifting\? \w+(-\w+)? is in every <b>Full Range Set<\/b>/.test(read(f)), f + ': no diya on the gifting link');
{
  const d = doc('index.html');
  ok(text(d.querySelector('#gifts .eyebrow')) === 'Trio and Full Range', 'home eyebrow: Trio and Full Range');
  ok(text(d.querySelector('.v2-hero-gift')) === 'Build a box ↗', 'home hero link: Build a box ↗');
  ok(d.querySelector('.v2-front img').getAttribute('alt') === 'All four Munchingo atta cookie boxes with a bowl of cookies', 'home hero alt: with a bowl of cookies');
  ok([...doc('404.html').querySelectorAll('.v2-ctas a')].some((a) => text(a) === 'Build a box ↗'), '404 hero link: Build a box ↗');
  const b = doc('build-a-box.html');
  ok(b.title === 'Build a Box: Trio and Full Range Sets | Munchingo', 'build-a-box <title>');
  ok(b.querySelector('meta[property="og:title"]').content === 'Cookie box: any 3 or all 4 Flavors | Munchingo', 'build-a-box og:title');
  ok(b.querySelector('meta[name="twitter:title"]').content === 'Build a Box: Trio and Full Range Sets | Munchingo', 'build-a-box twitter:title follows the new <title>');
  const shopLd = JSON.parse(doc('shop.html').querySelector('script[type="application/ld+json"]').textContent);
  ok(JSON.stringify(shopLd).includes('"name":"Trio Set"') && JSON.stringify(shopLd).includes('"name":"Full Range Set"'), 'shop JSON-LD: Trio Set / Full Range Set');
}
for (const f of ['atta-original.html', 'atta-ajwain.html', 'atta-kesari.html', 'atta-lite-sugar.html']) {
  const s = read(f);
  ok(s.includes('in every <b>Full Range Set</b>') && s.includes('A set works too (the Trio is from ₹749).') && s.includes('Or build a set →'), f + ': Full Range Set / A set works too / Or build a set');
}
ok(read('our-story.html').includes('pick a <a href="index.html#gifts">set</a> for someone you grew up with'), 'our story: pick a set');
// Flavors: the search box on every page, and no lowercase or British "flavor(s)" in what a visitor reads
const searchPages = pages.filter((f) => /data-search-input/.test(read(f)));
ok(searchPages.length >= 18, 'search box on ' + searchPages.length + ' pages');
for (const f of searchPages) ok(read(f).includes('placeholder="Search Flavors, boxes, FAQs..."'), f + ': search placeholder says Flavors');
const visible = (f) => {
  const d = doc(f), parts = [];
  d.querySelectorAll('script[type="application/ld+json"]').forEach((e) => parts.push(e.textContent));
  d.querySelectorAll('script:not([type="application/ld+json"]),style,noscript').forEach((e) => e.remove());
  parts.push(d.body ? d.body.textContent : '');
  d.querySelectorAll('[placeholder],[alt],[aria-label],[title],meta[content]').forEach((e) => ['placeholder', 'alt', 'aria-label', 'title', 'content'].forEach((a) => e.getAttribute(a) && parts.push(e.getAttribute(a))));
  d.querySelectorAll('a[href]').forEach((a) => { try { parts.push(decodeURIComponent(a.getAttribute('href'))); } catch (e) { /* not encoded */ } });
  parts.push(d.title);
  return parts.join(' \n ');
};
for (const f of pages) {
  const v = visible(f), bad = v.match(/.{0,30}(\bflavou?rs?\b|\bFlavours?\b).{0,20}/g);
  ok(!bad, f + ': Flavor(s) capitalised in visitor text' + (bad ? ': ' + bad.slice(0, 3).join(' | ') : ''));
}
ok(read('data/products.js').includes('Every other Flavor builds on this one.') && (read('data/products.js').match(/our other Flavors/g) || []).length === 2, 'data/products.js descriptions: Flavor(s)');
ok(read('js/review.js').includes("'Rate each Flavor. Honest is more useful to us than nice.'"), 'review page: Rate each Flavor.');
ok(read('js/stall.js').includes("': which Flavors?'"), 'stall: which Flavors?');
// B2: retired promo CSS gone
ok(!/\.was-price|\.promo-note|Pre-Diwali gift set offer note/.test(read('css/style.css')), 'style.css: no .was-price / .promo-note / Pre-Diwali offer comment');
// B3: prices.js on the six pages that load the bag but did not re-price it, before cart.js
for (const f of ['about.html', 'contact.html', 'terms.html', 'privacy-policy.html', 'our-story.html', 'maida-free-cookies-guide.html']) {
  const s = read(f), pi = s.indexOf('<script src="js/prices.js?v=9"></script>'), ci = s.indexOf('<script src="js/cart.js?v=43"');
  ok(pi > 0 && ci > pi, f + ': prices.js v9 loads before cart.js');
}
// cache numbers: every page on one number per file
const versions = {};
for (const f of pages) for (const m of read(f).matchAll(/(?:src|href)="((?:js|css|data)\/[a-z0-9-]+\.(?:js|css))\?v=(\d+)"/g)) (versions[m[1]] = versions[m[1]] || new Set()).add(m[2]);
for (const [file, set] of Object.entries(versions)) ok(set.size === 1, file + ' is loaded at one version on every page: ' + [...set].join(','));
ok(versions['data/products.js'] && [...versions['data/products.js']][0] === '7', 'data/products.js is v7');
ok(versions['js/review.js'] && [...versions['js/review.js']][0] === '2', 'js/review.js is v2');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
