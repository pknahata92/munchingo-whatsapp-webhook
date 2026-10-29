'use strict';
// Home page: the pre-Diwali gift-set note (and its disappearance on 9 Nov), and the Pack of 2 picker.
//   node scripts/website-promo-pack2-test.js
const fs = require('fs'), path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');
const SITE = process.env.SITE_DIR || path.resolve(__dirname, '../../../munchingo-website');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
class Local extends ResourceLoader { fetch(url) { const u = new URL(url); if (u.hostname !== 'localhost') return Promise.resolve(Buffer.from('')); const f = path.join(SITE, decodeURIComponent(u.pathname)); return Promise.resolve(fs.existsSync(f) ? fs.readFileSync(f) : Buffer.from('')); } }
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const BOOK = { 'atta-original': { price: 259, mrp: 300 }, 'atta-ajwain': { price: 259, mrp: 300 }, 'atta-kesari': { price: 299, mrp: 350 }, 'atta-lite-sugar': { price: 299, mrp: 350 },
  'trio-gift-set': { price: 799, mrp: null, promo: { label: 'Promotional brand offer until Diwali', until: '2026-11-08', next: 949, nextFrom: '2026-11-09' } },
  'full-range-set': { price: 999, mrp: null, promo: { label: 'Promotional brand offer until Diwali', until: '2026-11-08', next: 1199, nextFrom: '2026-11-09' } } };

async function open({ book, soldOut = [], nowIso, page = 'index.html' }) {
  const dom = new JSDOM(fs.readFileSync(path.join(SITE, page), 'utf8'), {
    url: 'http://localhost/' + page, runScripts: 'dangerously', resources: new Local(), pretendToBeVisual: true,
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
  // before Diwali, live list with promo
  let dom = await open({ book: BOOK, soldOut: ['atta-kesari', 'atta-lite-sugar'], nowIso: '2026-10-28T10:00:00+05:30' });
  let d = dom.window.document, w = dom.window;
  // Prashant, 29 Oct: sets show a short "Promotional brand pricing" tag and the 9 Nov price struck through, no other text.
  const note = d.querySelector('.door-card [data-promo-for="full-range-set"]');
  ok(note && !note.hidden && text(note) === 'Promotional brand pricing', 'home: set tag reads only "Promotional brand pricing": ' + text(note));
  ok(text(d.querySelector('[data-price-for="trio-gift-set"]')) === '₹799', 'home: Trio still shows ₹799 today');
  const was = (root, slug) => root.querySelector('.door-card [data-was-for="' + slug + '"], [data-was-for="' + slug + '"]');
  ok(was(d, 'trio-gift-set') && was(d, 'trio-gift-set').tagName === 'S' && !was(d, 'trio-gift-set').hidden && /₹949/.test(text(was(d, 'trio-gift-set'))), 'home: Trio shows ₹949 struck through');
  ok(was(d, 'full-range-set') && !was(d, 'full-range-set').hidden && /₹1,199/.test(text(was(d, 'full-range-set'))), 'home: Full Range shows ₹1,199 struck through');
  ok(!/from 9 Nov|Early-grab/.test(d.body.textContent.replace(/<s[^]*?<\/s>/g, '').replace(/Price from 9 Nov/g, '')), 'home: no "from 9 Nov" / "Early-grab" sentence left');
  ok(!d.querySelector('[data-gb-left]') && d.querySelector('.door-card[href="build-a-box.html"]'), 'home: builder moved off; gift-box doorway links to Build a box');
  { const b2 = await open({ book: BOOK, soldOut: [], nowIso: '2026-10-28T10:00:00+05:30', page: 'build-a-box.html' }); const bd = b2.window.document;
    const gbPromo = bd.querySelector('[data-gb="promo"]');
    ok(gbPromo && !gbPromo.hidden && text(gbPromo) === 'Promotional brand pricing', 'Build a box: builder tag reads only "Promotional brand pricing"');
    ok(!bd.querySelector('[data-promo-sets]'), 'Build a box: the long promo sentence is gone');
    ok(!was(bd, 'trio-gift-set').hidden && /₹949/.test(text(was(bd, 'trio-gift-set'))) && /₹1,199/.test(text(was(bd, 'full-range-set'))), 'Build a box intro: ₹949 and ₹1,199 struck through');
    b2.window.close(); }
  { const k = await open({ book: BOOK, soldOut: [], nowIso: '2026-10-28T10:00:00+05:30', page: 'atta-kesari.html' }); const kd = k.window.document;
    ok(!kd.querySelector('[data-promo-sets]') && !/Early-grab/.test(kd.body.textContent), 'product page: no long promo sentence');
    const bundle = kd.querySelector('.v2-bundle');
    ok(!/1,300/.test(text(bundle)) && /₹949/.test(text(bundle.querySelector('[data-was-for="trio-gift-set"]'))) && /₹1,199/.test(text(bundle.querySelector('[data-was-for="full-range-set"]'))), 'product page: set line strikes ₹949 / ₹1,199 like home and shop, no MRP ₹1,300');
    ok(/₹1,199/.test(text(kd.querySelector('.v2-giftlink [data-was-for="full-range-set"]'))), 'product page: gifting link strikes ₹1,199 too');
    k.window.close(); }

  // Pack of 2
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

  // 9 Nov: live list has the new prices and no promo
  const after = JSON.parse(JSON.stringify(BOOK)); after['trio-gift-set'] = { price: 949, mrp: null }; after['full-range-set'] = { price: 1199, mrp: null };
  dom = await open({ book: after, nowIso: '2026-11-09T09:00:00+05:30' }); d = dom.window.document;
  ok([...d.querySelectorAll('[data-promo-for]')].every((e) => e.hidden), '9 Nov: promo notes gone');
  ok([...d.querySelectorAll('[data-was-for]')].every((e) => e.hidden), '9 Nov: no struck price once ₹949 / ₹1,199 apply');
  ok(text(d.querySelector('[data-price-for="trio-gift-set"]')) === '₹949' && text(d.querySelector('[data-price-for="full-range-set"]')) === '₹1,199', '9 Nov: new set prices shown');
  dom.window.close();

  // 9 Nov with no stored list (backend asleep): the fallback already knows the new prices and shows no promo
  dom = await open({ book: null, nowIso: '2026-11-09T09:00:00+05:30' }); d = dom.window.document;
  ok(dom.window.MunchingoPrices.price('trio-gift-set', 799) === 949 && dom.window.MunchingoPrices.price('full-range-set', 999) === 1199 && !dom.window.MunchingoPrices.promo('trio-gift-set'), '9 Nov, no live list: fallback prices are the new ones');
  dom.window.close();
  // before Diwali with no stored list: the fallback shows the promo note
  dom = await open({ book: null, nowIso: '2026-10-28T09:00:00+05:30' }); d = dom.window.document;
  ok(!d.querySelector('[data-promo-for="trio-gift-set"]').hidden, 'before Diwali, no live list: promo note still shown from the fallback');
  ok(!d.querySelector('[data-was-for="trio-gift-set"]').hidden && /₹949/.test(text(d.querySelector('[data-was-for="trio-gift-set"]'))), 'before Diwali, no live list: ₹949 struck from the fallback');
  dom.window.close();
  { const c = await open({ book: BOOK, soldOut: [], nowIso: '2026-10-28T10:00:00+05:30', page: 'corporate-gifting.html' }); const cd = c.window.document;
    ok(/₹949/.test(text(cd.querySelector('[data-was-for="trio-gift-set"]'))) && /₹1,199/.test(text(cd.querySelector('[data-was-for="full-range-set"]'))), 'corporate page: set prices struck the same way');
    c.window.close(); }
  for (const f of ['atta-original.html', 'atta-ajwain.html', 'atta-kesari.html', 'atta-lite-sugar.html']) ok(!/MRP ₹1,300/.test(fs.readFileSync(path.join(SITE, f), 'utf8')), f + ': no MRP ₹1,300 line');
  console.log(`website-promo-pack2-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
