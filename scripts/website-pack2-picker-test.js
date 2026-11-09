'use strict';
// Home page: the Pack of 2 picker (#pack2).
//   SITE_DIR=<website> node scripts/website-pack2-picker-test.js
const fs = require('fs'), path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');
const SITE = process.env.SITE_DIR || path.resolve(__dirname, '../../../munchingo-website');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
class Local extends ResourceLoader { fetch(url) { const u = new URL(url); if (u.hostname !== 'localhost') return Promise.resolve(Buffer.from('')); const f = path.join(SITE, decodeURIComponent(u.pathname)); return Promise.resolve(fs.existsSync(f) ? fs.readFileSync(f) : Buffer.from('')); } }
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const BOOK = { 'atta-original': { price: 259, mrp: 300 }, 'atta-ajwain': { price: 259, mrp: 300 }, 'atta-kesari': { price: 299, mrp: 350 }, 'atta-lite-sugar': { price: 329, mrp: 350 } };

async function open({ book, soldOut = [], nowIso }) {
  const dom = new JSDOM(fs.readFileSync(path.join(SITE, 'index.html'), 'utf8'), {
    url: 'http://localhost/index.html', runScripts: 'dangerously', resources: new Local(), pretendToBeVisual: true,
    beforeParse(w) {
      if (book) w.localStorage.setItem('munchingo_prices', JSON.stringify(book));
      w.localStorage.setItem('munchingo_soldout', JSON.stringify(soldOut));
      const RealDate = w.Date, fixed = RealDate.parse(nowIso);
      w.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } };
      w.fetch = () => Promise.resolve({ ok: true, json: async () => ({}) }); w.scrollTo = () => {};
      w.SVGElement.prototype.getComputedTextLength = () => 100;
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} }));
    },
  });
  await wait(900);
  return dom;
}
(async () => {
  let dom = await open({ book: BOOK, soldOut: ['atta-kesari', 'atta-lite-sugar'], nowIso: '2026-11-10T10:00:00+05:30' });
  let d = dom.window.document, w = dom.window;
  const p2 = d.getElementById('pack2');
  ok(p2 && p2.querySelectorAll('[data-p2]').length === 4, 'Pack of 2 picker shows the four Flavors');
  const tile = (s) => p2.querySelector(`[data-p2="${s}"]`);
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  ok(tile('atta-kesari').disabled && !tile('atta-kesari').querySelector('.p2-out').hidden, 'sold-out Flavor is marked and cannot be picked');
  const add = p2.querySelector('[data-p2-add]');
  ok(add.disabled && /Pick 2 more/.test(text(add)), 'button waits for two picks');
  click(tile('atta-original')); click(tile('atta-ajwain'));
  ok(!add.disabled && /₹518/.test(text(add)) && /Save ₹82/.test(text(p2.querySelector('[data-p2-save]'))), 'two picks: total ₹518, saving ₹82 against the printed MRP');
  ok(/₹49 shipping/.test(text(p2.querySelector('.p2-ship'))) && /₹777/.test(text(p2.querySelector('.p2-ship'))), 'shipping line shown');
  click(add);
  const bag = w.MunchingoCart.getCart();
  ok(bag.length === 2 && w.MunchingoCart.cartBoxes() === 2 && w.MunchingoCart.cartShipping() === 49 && w.MunchingoCart.boxesShort() === 0, 'adds both boxes: bag meets the minimum, ₹49 shipping');
  ok(!p2.querySelector('[data-p2-bag]').hidden, 'then offers View your bag');
  w.localStorage.removeItem('munchingo_cart_v1'); w.localStorage.clear();
  click(tile('atta-original')); click(tile('atta-original'));
  ok(!add.disabled && /₹518/.test(text(add)), 'the same Flavor twice is allowed');
  dom.window.close();
  console.log(`website-pack2-picker-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
