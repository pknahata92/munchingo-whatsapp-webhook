'use strict';
// The bag shows the box suggestion card again (Task 7b F8), with the approved wording only, and the sticky bar tip uses it too (F9).
//   SITE_DIR=../munchingo-website-box-pricing node scripts/website-cart-suggestion-test.js
const fs = require('fs'), path = require('path');
let JSDOM, ResourceLoader;
try { ({ JSDOM, ResourceLoader } = require('jsdom')); } catch (e) { console.log('jsdom is not installed: run  npm install --no-save jsdom@24'); process.exit(1); }
const SITE = process.env.SITE_DIR || path.resolve(__dirname, '../../../munchingo-website');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SINGLES = { 'atta-original': { price: 259, mrp: 300 }, 'atta-ajwain': { price: 259, mrp: 300 }, 'atta-kesari': { price: 299, mrp: 350 }, 'atta-lite-sugar': { price: 329, mrp: 350 } };
const RULE = { 3: 8, 4: 12.5 };
const line = (slug, price, qty = 1) => ({ slug, name: slug, price, unit: 'x', qty });
const O = line('atta-original', 259), A = line('atta-ajwain', 259), K = line('atta-kesari', 299), S = line('atta-lite-sugar', 329);
const TRIO = 'trio-gift-set-ajwain-kesari-original';

class Local extends ResourceLoader { fetch(url) { const u = new URL(url); if (u.hostname !== 'localhost') return Promise.resolve(Buffer.from('')); const f = path.join(SITE, decodeURIComponent(u.pathname)); return Promise.resolve(fs.existsSync(f) ? fs.readFileSync(f) : Buffer.from('')); } }
async function page(file, cart) {
  const dom = new JSDOM(fs.readFileSync(path.join(SITE, file), 'utf8'), {
    url: 'http://localhost/' + file, runScripts: 'dangerously', resources: new Local(), pretendToBeVisual: true,
    beforeParse(x) { x.localStorage.setItem('munchingo_prices', JSON.stringify(SINGLES)); x.localStorage.setItem('munchingo_box_rule', JSON.stringify(RULE)); x.localStorage.setItem('munchingo_cart', JSON.stringify(cart)); x.fetch = () => new Promise(() => {}); x.scrollTo = () => {}; x.matchMedia = x.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} })); },
  });
  await wait(700);
  return dom.window;
}
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
const slugs = (w) => JSON.parse(w.localStorage.getItem('munchingo_cart')).map((c) => c.slug).sort();

(async () => {
  // Original + Kesari + Ajwain singles
  let w = await page('cart.html', [O, K, A]); let d = w.document;
  let acc = d.querySelector('[data-aov-accept]'); const sg = w.MunchingoCart.suggestion();
  ok(!!acc && sg && sg.kind === 'trio', 'O+K+A: the card shows and the suggestion is a Trio');
  ok(acc && norm(acc.textContent) === 'Make it a Trio and save ₹' + sg.saved, 'O+K+A: button reads the approved line: ' + (acc && norm(acc.textContent)));
  ok(!!d.querySelector('.aov-actions') && !!d.querySelector('.aov-upgrade-btn[data-aov-accept]') && !!d.querySelector('.aov-keep-btn[data-aov-keep]'), 'O+K+A: aov-actions / aov-upgrade-btn / aov-keep-btn markup');
  ok(d.querySelector('[data-aov-keep]') && norm(d.querySelector('[data-aov-keep]').textContent) === 'Keep as singles', 'second button reads Keep as singles');
  const prog = norm(d.getElementById('cart-aov-progress').textContent);
  ok(!/separate boxes|Switch to/.test(prog), 'old long sentence and Switch to text stay gone: ' + prog);
  ok(/free|₹49|ships/i.test(prog) && /Shipping|ships free|Free shipping/.test(prog), 'shipping message still shows beside the card: ' + prog);
  if (acc) acc.click(); await wait(100);
  let s = slugs(w);
  ok(s.length === 1 && s[0] === TRIO, 'accepting leaves only the Trio set: ' + s.join(','));

  // Keep as singles
  w = await page('cart.html', [O, K, A]); d = w.document;
  if (d.querySelector('[data-aov-keep]')) d.querySelector('[data-aov-keep]').click(); await wait(100);
  ok(!d.querySelector('[data-aov-accept]') && !d.querySelector('[data-aov-keep]'), 'Keep as singles hides the card');
  ok(slugs(w).length === 3, 'Keep as singles keeps the three singles');

  // All four singles
  w = await page('cart.html', [O, A, K, S]); d = w.document;
  acc = d.querySelector('[data-aov-accept]'); const sg4 = w.MunchingoCart.suggestion();
  ok(!!acc && sg4 && acc && norm(acc.textContent) === 'Make it the Full Range and save ₹' + sg4.saved, 'four singles: Full Range line: ' + (acc && norm(acc.textContent)));

  // Gift box only
  w = await page('cart.html', [line(TRIO, 749)]); d = w.document;
  ok(!d.querySelector('[data-aov-accept]') && !d.querySelector('[data-aov-keep]'), 'a bag with only a gift box shows no card');

  // Two singles
  w = await page('cart.html', [O, K]); d = w.document;
  ok(!d.querySelector('[data-aov-accept]'), 'two singles show no card');

  // Checkout shows it too
  w = await page('checkout.html', [O, K, A]); d = w.document;
  ok(!!d.querySelector('[data-aov-accept]'), 'checkout shows the card too');

  // R3: Indian number format in the bag and the checkout summary
  w = await page('cart.html', [O, A, K, S]); d = w.document;
  ok(norm(d.getElementById('cart-items').textContent) === '₹1,146' && norm(d.getElementById('cart-total').textContent) === '₹1,146', 'cart.html: four singles total ₹1,146: ' + norm(d.getElementById('cart-total').textContent));
  w = await page('checkout.html', [O, A, K, S]); d = w.document;
  ok(/₹1,146/.test(norm(d.body.textContent)) && !/₹1146/.test(norm(d.body.textContent)), 'checkout.html: summary shows ₹1,146');
  w = await page('cart.html', [O, K]); ok(norm(w.document.getElementById('cart-total').textContent) === '₹' + (259 + 299 + 49), 'cart.html: ₹558 + shipping stays plain under 1,000');
  // R1 / R2 CSS
  const css = fs.readFileSync(path.join(SITE, 'css/style.css'), 'utf8');
  ok(/\.aov-actions \.aov-upgrade-btn,\.aov-actions \.aov-keep-btn\{[^}]*min-height:44px[^}]*border-radius:999px[^}]*font:600 14px/.test(css) && /\.aov-actions\{display:flex;gap:8px/.test(css), 'R1: matched pill buttons, 44px, 8px gap');
  ok(/@media \(max-width:480px\)\{\.aov-actions\{flex-direction:column/.test(css), 'R1: stacked full width at 480px');
  ok(/\.gb-fl\.gb-out \.gb-plus\{display:none!important\}/.test(css) && !/\.gb-fl\.gb-out\{padding-bottom/.test(css), 'R2: sold-out badge hidden on phones, no extra tile padding');

  // F9: sticky bar tip (setHint is private to cart-bar.js, so the wording is pinned in the source)
  const bar = fs.readFileSync(path.join(SITE, 'js/cart-bar.js'), 'utf8');
  const fn = (bar.match(/function setHint\(c\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok(/c\.suggestionHtml\(sg\)/.test(fn), 'setHint returns c.suggestionHtml(sg)');
  ok(!/Tip: save/.test(bar), 'old "Tip: save" wording gone from cart-bar.js');

  console.log(`website-cart-suggestion-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
