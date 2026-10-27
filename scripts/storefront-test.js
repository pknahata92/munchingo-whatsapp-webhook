'use strict';
// Storefront restructure (27 Oct 2026): menu on every page, Shop page, Build a box page, redirects, no broken links.
//   node scripts/storefront-test.js
const fs = require('fs'), path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');
const SITE = process.env.SITE_DIR || path.resolve(__dirname, '../../../munchingo-website');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
class Local extends ResourceLoader { fetch(url) { const u = new URL(url); if (u.hostname !== 'localhost') return Promise.resolve(Buffer.from('')); const f = path.join(SITE, decodeURIComponent(u.pathname)); return Promise.resolve(fs.existsSync(f) ? fs.readFileSync(f) : Buffer.from('')); } }
async function open(page) {
  const dom = new JSDOM(fs.readFileSync(path.join(SITE, page), 'utf8'), { url: 'http://localhost/' + page, runScripts: 'dangerously', resources: new Local(), pretendToBeVisual: true,
    beforeParse(w) { w.fetch = () => Promise.resolve({ ok: true, json: async () => ({}) }); w.scrollTo = () => {}; w.SVGElement.prototype.getComputedTextLength = () => 100; w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} })); } });
  await wait(800); return dom;
}
(async () => {
  const pages = fs.readdirSync(SITE).filter((f) => f.endsWith('.html') && !['our-story.html', 'stall.html', 'review.html'].includes(f));
  for (const f of pages) {
    const s = fs.readFileSync(path.join(SITE, f), 'utf8');
    if (!s.includes('<nav class="v2-header">')) continue;
    const nav = s.slice(s.indexOf('<nav class="v2-header">'), s.indexOf('</nav>', s.indexOf('<nav class="v2-header">')));
    ok(['shop.html', 'build-a-box.html', 'corporate-gifting.html', 'about.html'].every((h) => nav.includes(`href="${h}"`)) && nav.includes('class="v2-quick"'), f + ': menu has Shop, Build a box, Corporate gifting, Our story and the phone quick links');
    ok(!/index\.html#(range|gifts)|index\.html\?shop/.test(s), f + ': no old home-page anchor links');
  }
  const red = fs.readFileSync(path.join(SITE, '_redirects'), 'utf8');
  ok(/^\/gifting\s+\/build-a-box\s+301$/m.test(red) && /^\/gift-boxes\s+\/build-a-box\s+301$/m.test(red), 'redirects: /gifting and /gift-boxes go to /build-a-box');
  const sm = fs.readFileSync(path.join(SITE, 'sitemap.xml'), 'utf8');
  ok(sm.includes('https://munchingo.com/shop') && sm.includes('https://munchingo.com/build-a-box'), 'sitemap lists Shop and Build a box');

  let dom = await open('shop.html'); let d = dom.window.document, w = dom.window;
  ok(d.querySelectorAll('#range-cards .v2-card').length === 4 && d.querySelectorAll('.shop-set[href="build-a-box.html"]').length === 2, 'Shop: 4 singles plus the two gift boxes leading to Build a box');
  ok(d.getElementById('pack2') && d.querySelectorAll('#pack2 .p2-tile').length === 4, 'Shop: Pack of 2 picker present');
  ok(/canonical" href="https:\/\/munchingo.com\/shop"/.test(fs.readFileSync(path.join(SITE, 'shop.html'), 'utf8')) && /"ItemList"/.test(fs.readFileSync(path.join(SITE, 'shop.html'), 'utf8')), 'Shop: canonical and ItemList');
  d.querySelector('#range-cards .v2-add').dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); await wait(100);
  ok(w.MunchingoCart.cartCount() >= 1, 'Shop: Add to bag works');
  dom.window.close();
  dom = await open('build-a-box.html'); d = dom.window.document; w = dom.window;
  ok(d.querySelectorAll('.gb-fl').length === 4 && d.querySelector('[data-gb="cta"]'), 'Build a box: the builder is here');
  ['Original', 'Kesari', 'Ajwain'].forEach((v) => d.querySelector(`.gb-fl[data-f="${v}"]`).dispatchEvent(new w.MouseEvent('click', { bubbles: true })));
  await wait(50); d.querySelector('[data-gb="cta"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await wait(100);
  ok(w.MunchingoCart.getCart().some((i) => /^trio-gift-set-/.test(i.slug)), 'Build a box: a Trio goes into the bag');
  ok(/canonical" href="https:\/\/munchingo.com\/build-a-box"/.test(fs.readFileSync(path.join(SITE, 'build-a-box.html'), 'utf8')), 'Build a box: canonical');
  dom.window.close();
  dom = await open('index.html'); d = dom.window.document;
  ok(!d.querySelector('.v2-process') && !d.querySelector('.v2-statement') && d.getElementById('range') && d.getElementById('gifts'), 'Home: long sections removed, #range and #gifts anchors kept');
  ok([...d.querySelectorAll('.v2-hero a')].some((a) => a.getAttribute('href') === 'shop.html') && [...d.querySelectorAll('.v2-hero a')].some((a) => a.getAttribute('href') === 'build-a-box.html'), 'Home banner: Shop the range and Build a box');
  ok(!/delivered free/.test(d.body.textContent), 'Home: no stale "delivered free" claim');
  dom.window.close();
  console.log(`storefront-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
