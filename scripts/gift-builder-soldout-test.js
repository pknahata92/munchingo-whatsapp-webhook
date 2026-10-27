'use strict';
// The gift builder on the home page when Flavors are sold out: tiles say so, a message explains it, Full Range and Trio say when
// they are unavailable, and a link points to the singles in stock. Back in stock, all of it disappears.   node scripts/gift-builder-soldout-test.js
const fs = require('fs'), path = require('path');
let JSDOM, ResourceLoader;
try { ({ JSDOM, ResourceLoader } = require('jsdom')); } catch (e) { console.log('jsdom is not installed: run  npm install --no-save jsdom@24'); process.exit(1); }
const SITE = process.env.SITE_DIR || path.resolve(__dirname, '../../../munchingo-website');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
class Local extends ResourceLoader { fetch(url) { const u = new URL(url); if (u.hostname !== 'localhost') return Promise.resolve(Buffer.from('')); const f = path.join(SITE, decodeURIComponent(u.pathname)); return Promise.resolve(fs.existsSync(f) ? fs.readFileSync(f) : Buffer.from('')); } }
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

async function open(soldOut) {
  const dom = new JSDOM(fs.readFileSync(path.join(SITE, 'index.html'), 'utf8'), {
    url: 'http://localhost/index.html', runScripts: 'dangerously', resources: new Local(), pretendToBeVisual: true,
    beforeParse(w) { w.localStorage.setItem('munchingo_soldout', JSON.stringify(soldOut)); w.fetch = (u) => Promise.resolve({ ok: true, status: 200, json: async () => (/stock/.test(u) ? { ok: true, soldOut } : { ok: true, prices: {} }) }); w.scrollTo = () => {}; w.SVGElement.prototype.getComputedTextLength = () => 100; w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} })); },
  });
  await wait(900);
  return dom;
}
(async () => {
  let dom = await open(['atta-kesari', 'atta-lite-sugar']); let d = dom.window.document, w = dom.window;
  const tile = (v) => d.querySelector(`.gb-fl[data-f="${v}"]`);
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  ok(d.querySelector('.gb-fl'), 'the builder is on the page');
  ['Kesari', 'Lite-sugar'].forEach((v) => { const t = tile(v); ok(t && !t.querySelector('.gb-so').hidden && /Sold out/.test(text(t.querySelector('.gb-so'))) && /Back soon/.test(text(t.querySelector('.gb-so'))) && t.disabled, v + ': tile says Sold out, Back soon, and cannot be picked'); });
  ['Original', 'Ajwain'].forEach((v) => { const t = tile(v); ok(t && t.querySelector('.gb-so').hidden && !t.disabled, v + ': in-stock tile is normal'); });
  const msg = d.querySelector('[data-gb-stock]');
  ok(!msg.hidden && /Kesari and Sugar-Lite are sold out for now/.test(text(msg)) && /Original and Ajwain are available/.test(text(msg)), 'a message names what is out and what is available: ' + text(msg));
  ok(/A Trio needs 3 different flavors/.test(text(msg)), 'the message says why the Trio cannot be completed');
  ok(/Trio unavailable today/.test(text(d.querySelector('[data-gb="cta"]'))) && d.querySelector('[data-gb="cta"]').disabled, 'Trio button says unavailable today');
  ok(!d.querySelector('[data-gb="singles"]').hidden && /single boxes/.test(text(d.querySelector('[data-gb="singles"]'))) && d.querySelector('[data-gb="singles"]').getAttribute('href') === 'index.html#range', 'a link points to the single boxes in stock');
  click(d.querySelector('.gb-opt[data-size="4"]')); await wait(100);
  ok(/Full Range returns soon/.test(text(d.querySelector('[data-gb="cta"]'))) && /Back soon/.test(text(d.querySelector('.gb-opt[data-size="4"] small'))), 'Full Range: option says back soon and the button says it returns soon');
  ok(/The Full Range needs all four|both are unavailable/.test(text(msg)), 'Full Range message explains');
  dom.window.close();

  // one Flavor out: a Trio is still possible from the other three
  dom = await open(['atta-kesari']); d = dom.window.document; w = dom.window;
  ok(/Kesari is sold out for now/.test(text(d.querySelector('[data-gb-stock]'))) && !/unavailable/.test(text(d.querySelector('[data-gb="cta"]'))), 'one out: Trio still buildable from the other three');
  dom.window.close();

  // everything in stock: nothing extra is shown
  dom = await open([]); d = dom.window.document;
  ok(d.querySelector('[data-gb-stock]').hidden && [...d.querySelectorAll('.gb-so')].every((e) => e.hidden) && d.querySelector('[data-gb="singles"]').hidden, 'in stock: no message, no badges, no singles link');
  dom.window.close();
  console.log(`gift-builder-soldout-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
