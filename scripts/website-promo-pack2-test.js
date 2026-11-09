'use strict';
// Gift-set prices on the site, and the home page's Pack of 2 picker.
// Today (from 9 Nov 2026): Trio ₹799, Full Range ₹999, no tag, no struck price (backend utils/giftPromo.js 5f6d8bd, Prashant
// 8 Nov 23:45 IST; website prices.js v8 d0e0038). The before-Diwali scenarios (28 Oct clock, a price list carrying a promo)
// are history: they keep the site's promo display (29 Oct: short tag + the 9 Nov price struck) covered while that code exists.
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
  'trio-gift-set': { price: 799, mrp: null, promo: { label: 'Early-grab price till Diwali', until: '2026-11-08', next: 949, nextFrom: '2026-11-09' } },
  'full-range-set': { price: 999, mrp: null, promo: { label: 'Early-grab price till Diwali', until: '2026-11-08', next: 1199, nextFrom: '2026-11-09' } } };

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

  // 9 Nov onward: the live list is what the backend serves today (sets stay ₹799 / ₹999, no promo)
  const after = JSON.parse(JSON.stringify(BOOK)); after['trio-gift-set'] = { price: 799, mrp: null }; after['full-range-set'] = { price: 999, mrp: null };
  dom = await open({ book: after, nowIso: '2026-11-09T09:00:00+05:30' }); d = dom.window.document;
  ok([...d.querySelectorAll('[data-promo-for]')].every((e) => e.hidden), '9 Nov: promo notes gone');
  ok([...d.querySelectorAll('[data-was-for]')].every((e) => e.hidden), '9 Nov: no struck price');
  ok(text(d.querySelector('[data-price-for="trio-gift-set"]')) === '₹799' && text(d.querySelector('[data-price-for="full-range-set"]')) === '₹999', '9 Nov: sets shown at ₹799 / ₹999');
  dom.window.close();
  // the gift builder (Build a box page since the restructure) after 9 Nov: the saving against the boxes' MRP
  const row = (dd, k) => dd.querySelector('[data-gb="' + k + '"]').parentNode;
  const shown = (el) => el.style.display !== 'none';
  async function builder(book) {
    const b = await open({ book, nowIso: '2026-11-09T09:00:00+05:30', page: 'build-a-box.html' }); const bw = b.window, bd = bw.document;
    Array.prototype.slice.call(bd.querySelectorAll('.gb-fl')).filter((x) => !x.disabled).slice(0, 3).forEach((x) => x.dispatchEvent(new bw.MouseEvent('click', { bubbles: true })));
    await wait(50);
    const trio = { mrp: shown(row(bd, 'mrp')), sv: shown(row(bd, 'sv')), save: text(bd.querySelector('[data-gb="sv"]')), promo: bd.querySelector('[data-gb="promo"]').hidden };
    bd.querySelector('.gb-opt[data-size="4"]').dispatchEvent(new bw.MouseEvent('click', { bubbles: true }));
    await wait(50);
    const full = { mrp: shown(row(bd, 'mrp')), sv: shown(row(bd, 'sv')), save: text(bd.querySelector('[data-gb="sv"]')), promo: bd.querySelector('[data-gb="promo"]').hidden };
    b.window.close(); return { trio, full };
  }
  let gb = await builder(after);
  ok(gb.trio.promo && gb.full.promo, 'Build a box, 9 Nov: no promo tag in the builder');
  ok(gb.trio.mrp && gb.trio.sv && gb.trio.save === 'Save ₹201', 'Build a box, 9 Nov: Trio at ₹799 (first three tiles: Original, Kesari, Sugar-Lite) saves ₹201 against ₹1,000 MRP: ' + gb.trio.save);
  ok(gb.full.mrp && gb.full.sv && gb.full.save === 'Save ₹301', 'Build a box, 9 Nov: Full Range at ₹999 saves ₹301 against the ₹1,300 MRP: ' + gb.full.save);
  // the small-saving rule: a set priced within 5% of the boxes' MRP shows no "You save ₹1" (rule check with a ₹949 Trio)
  const near = JSON.parse(JSON.stringify(after)); near['trio-gift-set'] = { price: 949, mrp: null }; near['full-range-set'] = { price: 1199, mrp: null };
  gb = await builder(near);
  ok(!gb.trio.mrp && !gb.trio.sv, 'Trio at ₹949: no "You save ₹1"; the MRP and saving rows are hidden (price within 5% of the cheapest boxes\' MRP)');
  ok(gb.full.mrp && gb.full.sv && gb.full.save === 'Save ₹101', 'Full Range at ₹1,199: saving vs ₹1,300 MRP still shown: ' + gb.full.save);

  // 9 Nov with no stored list (backend asleep): the fallback keeps ₹799 / ₹999 and shows no promo (prices.js v8)
  dom = await open({ book: null, nowIso: '2026-11-09T09:00:00+05:30' }); d = dom.window.document;
  ok(dom.window.MunchingoPrices.price('trio-gift-set', 799) === 799 && dom.window.MunchingoPrices.price('full-range-set', 999) === 999 && !dom.window.MunchingoPrices.promo('trio-gift-set') && !dom.window.MunchingoPrices.promo('full-range-set'), '9 Nov, no live list: fallback keeps ₹799 / ₹999, no promo');
  ok([...d.querySelectorAll('[data-promo-for]')].every((e) => e.hidden) && [...d.querySelectorAll('[data-was-for]')].every((e) => e.hidden), '9 Nov, no live list: no tag and no struck price on the page');
  dom.window.close();
  // (Removed: "before Diwali, no live list" checks. Since prices.js v8 the fallback's 9 Nov price equals today's, so on a
  //  clock before 9 Nov it would strike ₹799 against ₹799; that clock is in the past, and the case is reported, not tested.)
  { const c = await open({ book: BOOK, soldOut: [], nowIso: '2026-10-28T10:00:00+05:30', page: 'corporate-gifting.html' }); const cd = c.window.document;
    ok(/₹949/.test(text(cd.querySelector('[data-was-for="trio-gift-set"]'))) && /₹1,199/.test(text(cd.querySelector('[data-was-for="full-range-set"]'))), 'corporate page: set prices struck the same way');
    c.window.close(); }
  for (const f of ['atta-original.html', 'atta-ajwain.html', 'atta-kesari.html', 'atta-lite-sugar.html']) ok(!/MRP ₹1,300/.test(fs.readFileSync(path.join(SITE, f), 'utf8')), f + ': no MRP ₹1,300 line');
  console.log(`website-promo-pack2-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
