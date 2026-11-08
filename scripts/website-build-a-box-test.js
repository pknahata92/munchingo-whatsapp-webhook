'use strict';
// Build-a-Box (9 Nov 2026): Full Range first and selected; Trio priced per mix; the panel compares with the SAME singles' web
// prices (never MRP); a filled Trio offers a step-up to the Full Range; gift boxes ship free; Trio JSON-LD is an AggregateOffer.
//   SITE_DIR=../munchingo-website-box-pricing node scripts/website-build-a-box-test.js
const fs = require('fs'), path = require('path');
let JSDOM, ResourceLoader;
try { ({ JSDOM, ResourceLoader } = require('jsdom')); } catch (e) { console.log('jsdom is not installed: run  npm install --no-save jsdom@24'); process.exit(1); }
const SITE = process.env.SITE_DIR || path.resolve(__dirname, '../../../munchingo-website');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
class Local extends ResourceLoader { fetch(url) { const u = new URL(url); if (u.hostname !== 'localhost') return Promise.resolve(Buffer.from('')); const f = path.join(SITE, decodeURIComponent(u.pathname)); return Promise.resolve(fs.existsSync(f) ? fs.readFileSync(f) : Buffer.from('')); } }
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

async function open(soldOut = [], book = null) {
  const dom = new JSDOM(fs.readFileSync(path.join(SITE, 'build-a-box.html'), 'utf8'), {
    url: 'http://localhost/build-a-box.html', runScripts: 'dangerously', resources: new Local(), pretendToBeVisual: true,
    beforeParse(w) { w.localStorage.setItem('munchingo_soldout', JSON.stringify(soldOut)); if (book) w.localStorage.setItem('munchingo_prices', JSON.stringify(book)); w.fetch = (u) => Promise.resolve({ ok: true, status: 200, json: async () => (/stock/.test(u) ? { ok: true, soldOut } : { ok: true, prices: {} }) }); w.scrollTo = () => {}; w.SVGElement.prototype.getComputedTextLength = () => 100; w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} })); },
  });
  await wait(900);
  return dom;
}
(async () => {
  const dom = await open(); const w = dom.window, d = w.document;
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const tile = (v) => d.querySelector(`.gb-fl[data-f="${v}"]`);
  const g = (n) => d.querySelector(`[data-gb="${n}"]`);
  const panel = () => text(d.querySelector('.gb-panel'));
  const visible = (el) => !!el && !el.hidden && el.style.display !== 'none';
  const cartLines = () => JSON.parse(w.localStorage.getItem('munchingo_cart') || '[]');

  // ---- on load ----
  const opts = [...d.querySelectorAll('.gb-opt')];
  ok(opts.length === 2 && opts[0].getAttribute('data-size') === '4', 'Full Range is the first option');
  ok(opts[0].getAttribute('aria-checked') === 'true' && opts[1].getAttribute('aria-checked') === 'false', 'Full Range is selected on load');
  ['Try all four', 'One of each · 1kg', 'BEST VALUE'].forEach((s) => ok(text(opts[0]).includes(s), 'Full Range option says "' + s + '": ' + text(opts[0])));
  ['Pick any 3', 'from ₹749', 'PICK & MIX'].forEach((s) => ok(text(opts[1]).includes(s), 'Trio option says "' + s + '": ' + text(opts[1])));

  // ---- Full Range ----
  ok(text(g('tot')) === '₹999', 'Full Range total 999, got ' + text(g('tot')));
  ok(panel().includes('Same boxes as singles ₹1,146'), 'Full Range: same boxes as singles ₹1,146');
  ok(panel().includes('You save ₹147'), 'Full Range: you save ₹147');
  ok(panel().includes('Gift boxes ship free'), 'Full Range: gift boxes ship free');
  ok(!visible(g('stepup')), 'Full Range: no step-up');
  ok(!/MRP/i.test(panel()) && !d.querySelector('.gb-panel s, .gb-panel del, [data-gb="mrp"]'), 'no MRP row or crossed-out price in the panel');
  ok(!/promo/i.test(d.querySelector('.gb-panel').innerHTML), 'no promo element in the panel');

  // ---- Trio O+A+K ----
  click(opts[1]); await wait(50);
  ok(opts[1].getAttribute('aria-checked') === 'true', 'Trio selects');
  ['Original', 'Ajwain', 'Kesari'].forEach((v) => click(tile(v))); await wait(50);
  ok(text(g('tot')) === '₹749', 'Trio O+A+K total 749, got ' + text(g('tot')));
  ok(panel().includes('Same boxes as singles ₹817') && panel().includes('You save ₹68'), 'Trio O+A+K: singles ₹817, save ₹68: ' + panel());
  ok(panel().includes('Gift boxes ship free'), 'Trio: gift boxes ship free');
  ok(visible(g('stepup')) && text(g('stepup')).includes('Add the 4th Flavor for ₹250 more'), 'Trio O+A+K: step-up ₹250 more: ' + text(g('stepup')));
  ok(!/MRP/i.test(panel()), 'Trio: no MRP');

  // add to bag: canonical slug at the shown price
  click(g('cta')); await wait(50);
  let lines = cartLines();
  ok(lines.length === 1 && lines[0].slug === 'trio-gift-set-ajwain-kesari-original' && lines[0].price === 749, 'cart has the canonical Trio slug at 749: ' + JSON.stringify(lines));

  // ---- Trio K+SL+O ----
  click(tile('Ajwain')); click(tile('Lite-sugar')); await wait(50);
  ok(text(g('tot')) === '₹809', 'Trio K+SL+O total 809, got ' + text(g('tot')));
  ok(text(g('stepup')).includes('Add the 4th Flavor for ₹190 more'), 'Trio K+SL+O: step-up ₹190 more: ' + text(g('stepup')));
  ok(panel().includes('Same boxes as singles ₹887') && panel().includes('You save ₹78'), 'Trio K+SL+O compare 887 / 78: ' + panel());

  click(g('cta')); await wait(50);
  lines = cartLines();
  ok(lines.some((l) => l.slug === 'trio-gift-set-kesari-lite-sugar-original' && l.price === 809), 'bag gets the K+SL+O Trio at 809: ' + JSON.stringify(lines));

  // step-up button
  click(d.querySelector('[data-gb="makefull"]')); await wait(50);
  
  ok(opts[0].getAttribute('aria-checked') === 'true' && text(g('tot')) === '₹999' && !visible(g('stepup')), 'Make it the Full Range switches to the Full Range, all four picked');
  ok(d.querySelectorAll('.gb-slot.full').length === 4, 'all four slots filled');
  click(g('cta')); await wait(50);
  lines = cartLines();
  ok(lines.some((l) => l.slug === 'full-range-set' && l.price === 999), 'Full Range added at 999: ' + JSON.stringify(lines));

  // step-up button wording (a filled Trio)
  click(opts[1]); await wait(50); ['Original', 'Ajwain', 'Kesari'].forEach((v) => click(tile(v))); await wait(50);
  ok(text(d.querySelector('[data-gb="makefull"]')) === 'Make it the Full Range', 'step-up button says Make it the Full Range');
  // partial Trio: no step-up, no comparison
  click(tile('Kesari')); await wait(50);
  ok(!visible(g('stepup')), 'unfilled Trio: no step-up');
  ok(g('tot').parentNode.style.display === 'none' && text(g('tot')) === '', 'unfilled Trio: total row hidden, no dash');

  // ---- JSON-LD ----
  const ld = JSON.parse([...d.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent).find((t) => /trio-gift-set/.test(t)));
  const prod = (sku) => ld['@graph'].find((n) => n.sku === sku);
  const t = prod('trio-gift-set').offers, f = prod('full-range-set').offers;
  ok(t['@type'] === 'AggregateOffer' && t.lowPrice === '749' && t.highPrice === '809' && t.priceCurrency === 'INR', 'Trio JSON-LD AggregateOffer 749-809: ' + JSON.stringify(t));
  ok(/schema.org\/(In|Out)Stock/.test(t.availability) && !('price' in t), 'Trio JSON-LD keeps availability, no flat price');
  ok(f.price === '999' && /schema.org\/InStock/.test(f.availability), 'Full Range JSON-LD price 999');
  dom.window.close();

  // ---- the panel uses LIVE web prices: Kesari at 319 ----
  const BOOK = { 'atta-original': { price: 259, mrp: 300 }, 'atta-ajwain': { price: 259, mrp: 300 }, 'atta-kesari': { price: 319, mrp: 350 }, 'atta-lite-sugar': { price: 329, mrp: 350 } };
  const d3 = await open([], BOOK); const w3 = d3.window, doc3 = w3.document;
  const c3 = (el) => el.dispatchEvent(new w3.MouseEvent('click', { bubbles: true, cancelable: true }));
  const p3 = () => text(doc3.querySelector('.gb-panel'));
  c3(doc3.querySelector('.gb-opt[data-size="3"]')); await wait(50);
  ['Original', 'Kesari', 'Lite-sugar'].forEach((v) => c3(doc3.querySelector(`.gb-fl[data-f="${v}"]`))); await wait(50);
  const box = Math.floor((907 * 0.92 + 1) / 10) * 10 - 1;
  ok(box === 829, 'rule arithmetic gives 829');
  ok(p3().includes('Same boxes as singles ₹907') && p3().includes('You save ₹78') && text(doc3.querySelector('[data-gb="tot"]')) === '₹' + box, 'Kesari 319: O+K+SL singles 907, total 829, save 78: ' + p3());
  const fr = Math.floor((1166 * 0.875 + 1) / 10) * 10 - 1;
  ok(text(doc3.querySelector('[data-gb="stepuptext"]')) === 'Add the 4th Flavor for ₹' + (fr - box) + ' more', 'Kesari 319: step-up follows the live Full Range price: ' + text(doc3.querySelector('[data-gb="stepuptext"]')));
  c3(doc3.querySelector('[data-gb="cta"]')); await wait(50);
  ok(JSON.parse(w3.localStorage.getItem('munchingo_cart') || '[]').some((l) => l.slug === 'trio-gift-set-kesari-lite-sugar-original' && l.price === 829), 'bag gets the Trio at the live 829');
  d3.window.close();

  // ---- O+A+SL with the default book ----
  const d4 = await open(); const w4 = d4.window, doc4 = w4.document;
  const c4 = (el) => el.dispatchEvent(new w4.MouseEvent('click', { bubbles: true, cancelable: true }));
  c4(doc4.querySelector('.gb-opt[data-size="3"]')); await wait(50);
  ['Original', 'Ajwain', 'Lite-sugar'].forEach((v) => c4(doc4.querySelector(`.gb-fl[data-f="${v}"]`))); await wait(50);
  ok(text(doc4.querySelector('[data-gb="tot"]')) === '₹779' && text(doc4.querySelector('[data-gb="stepuptext"]')) === 'Add the 4th Flavor for ₹220 more', 'O+A+SL: 779, step-up ₹220 more');
  d4.window.close();

  // ---- opens on the Trio when the Full Range cannot be bought ----
  for (const [out, why] of [[['atta-lite-sugar'], 'Sugar-Lite sold out'], [['full-range-set'], 'only full-range-set sold out']]) {
    const dd = await open(out); const dc = dd.window.document;
    ok(dc.querySelector('.gb-opt[data-size="3"]').getAttribute('aria-checked') === 'true' && dc.querySelector('.gb-opt[data-size="4"]').getAttribute('aria-checked') === 'false', why + ': opens with the Trio selected');
    ok(!/Full Range returns soon/.test(text(dc.querySelector('[data-gb="cta"]'))), why + ': button is not "Full Range returns soon"');
    dd.window.close();
  }

  // ---- Full Range sold out: step-up hidden for a filled Trio ----
  const d2 = await open(['atta-lite-sugar']); const w2 = d2.window, doc2 = w2.document;
  const c2 = (el) => el.dispatchEvent(new w2.MouseEvent('click', { bubbles: true, cancelable: true }));
  c2(doc2.querySelector('.gb-opt[data-size="3"]')); await wait(50);
  ['Original', 'Ajwain', 'Kesari'].forEach((v) => c2(doc2.querySelector(`.gb-fl[data-f="${v}"]`))); await wait(50);
  const su = doc2.querySelector('[data-gb="stepup"]');
  ok(!su || su.hidden || su.style.display === 'none', 'Full Range unavailable: step-up hidden');
  d2.window.close();

  console.log(`website-build-a-box-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
