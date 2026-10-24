'use strict';
// The stall tally page (munchingo-website/stall.html, served at munchingo.com/stall). One entry per CUSTOMER: tap the packs
// into a basket, then Paid UPI / Paid Cash, so each entry matches one UPI payment. Tiles in the flavor colors; both
// hampers ask for their flavor mix. Saved on the device per IST day (basket too), CSV export, older single-tap data kept.
//   npm install --no-save jsdom@24   then   node scripts/stall-page-test.js
let JSDOM, ResourceLoader;
try { ({ JSDOM, ResourceLoader } = require('jsdom')); } catch (e) { console.log('jsdom is not installed: run  npm install --no-save jsdom@24'); process.exit(1); }
const fs = require('fs'), path = require('path');
const SITE = process.env.SITE_DIR || path.resolve(__dirname, '../../../munchingo-website');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class Local extends ResourceLoader {
  fetch(url) {
    const u = new URL(url);
    if (u.hostname !== 'localhost') return Promise.resolve(Buffer.from(''));
    const f = path.join(SITE, decodeURIComponent(u.pathname));
    return Promise.resolve(fs.existsSync(f) ? fs.readFileSync(f) : Buffer.from(''));
  }
}
function memStorage(seed) { const m = new Map(Object.entries(seed || {})); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; }

async function open(store, nowIso) {
  const file = path.join(SITE, 'stall.html');
  if (!fs.existsSync(file)) { ok(false, 'stall.html exists in ' + SITE); return null; }
  const dom = new JSDOM(fs.readFileSync(file, 'utf8'), {
    url: 'http://localhost/stall.html', runScripts: 'dangerously', resources: new Local(), pretendToBeVisual: true,
    beforeParse(w) {
      Object.defineProperty(w, 'localStorage', { value: store, configurable: true });
      const RealDate = w.Date; const fixed = RealDate.parse(nowIso);
      w.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } };
      w.confirm = () => true;
      w.navigator.serviceWorker = undefined;
    },
  });
  await wait(500);
  return { w: dom.window, d: dom.window.document, close: () => dom.window.close() };
}
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const click = (w, el) => { if (!el) throw new Error('missing element'); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); };
const q = (d, s) => d.querySelector(s);
const num = (d, id) => Number((text(q(d, '#' + id)) || '').replace(/[^\d-]/g, ''));

(async () => {
  const store = memStorage();
  let p = await open(store, '2026-10-25T06:00:00Z');   // 11:30 IST
  if (!p) { console.log(`stall-page-test: ${pass} passed, ${fail} failed`); process.exit(1); }
  let { w, d } = p;
  const tap = (item) => click(w, q(d, `button[data-item="${item}"]`));
  const plus = (f) => click(w, q(d, `#st-mix button[data-plus="${f}"]`));

  ok(/noindex/.test((q(d, 'meta[name="robots"]') || {}).content || ''), 'the page is noindex');
  { const src = (q(d, 'script[src*="stall.js"]') || {}).getAttribute ? q(d, 'script[src*="stall.js"]').getAttribute('src') : '';
    const v = (src.match(/stall\.js\?v=(\d+)$/) || [])[1];
    ok(!!v, 'the script is loaded with a version (?v=N) so the 4-hour browser cache cannot serve an old copy: ' + src);
    ok(v && String(w.StallTally.version) === v, `page and script versions match (page v=${v}, script ${w.StallTally.version})`);
    const sw = fs.readFileSync(path.join(SITE, 'stall-sw.js'), 'utf8');
    ok(sw.includes('/js/stall.js?v=' + v) && new RegExp("CACHE = 'munchingo-stall-v" + v + "'").test(sw), 'the offline copy caches this version under its own name'); }
  ok(/25 Oct/.test(text(q(d, '#st-day'))), 'shows today (IST)');
  for (const [id, label, price] of [['original', 'Original', 200], ['ajwain', 'Ajwain', 200], ['kesari', 'Kesari', 250], ['lite', 'Sugar-Lite', 250], ['h3', 'Hamper of 3', 799], ['h4', 'Hamper of 4', 999]]) {
    const b = q(d, `button[data-item="${id}"]`);
    ok(b && new RegExp(label).test(text(b)) && new RegExp('₹' + price).test(text(b)), `button ${label} ₹${price}`);
  }
  // flavor colors (the website's pack colors)
  const bg = (id) => w.getComputedStyle(q(d, `button[data-item="${id}"]`)).backgroundColor;
  ok(bg('original') === 'rgb(124, 34, 48)' && bg('kesari') === 'rgb(169, 88, 47)' && bg('ajwain') === 'rgb(79, 101, 121)' && bg('lite') === 'rgb(107, 79, 99)',
    `tiles use the flavor colors (got ${bg('original')} / ${bg('kesari')} / ${bg('ajwain')} / ${bg('lite')})`);
  ok(!q(d, '#st-pay-upi') || q(d, '#st-pay-upi').closest('header') === null, 'no UPI/Cash switch in the header any more');

  // ── a customer: basket first, nothing recorded until paid ──
  ok(q(d, '#st-paid-upi').disabled && q(d, '#st-paid-cash').disabled, 'Paid buttons are off while the basket is empty');
  tap('kesari'); tap('original');
  ok(d.querySelectorAll('#st-basket li').length === 2 && num(d, 'st-basket-total') === 450, 'basket shows 2 packs, ₹450');
  ok(/450/.test(text(q(d, '#st-paid-upi'))) && !q(d, '#st-paid-upi').disabled, 'Paid UPI shows the basket total');
  ok(num(d, 'st-total') === 0 && num(d, 'st-sales') === 0, 'nothing counted before payment');
  click(w, q(d, '#st-paid-upi'));
  ok(num(d, 'st-total') === 450 && num(d, 'st-upi') === 450 && num(d, 'st-sales') === 1 && d.querySelectorAll('#st-basket li').length === 0, 'Paid UPI records ONE customer for ₹450 and empties the basket');

  // basket edits: remove a line, clear
  tap('ajwain'); tap('lite');
  click(w, q(d, '#st-basket li button[data-remove]'));   // remove the Ajwain
  ok(d.querySelectorAll('#st-basket li').length === 1 && num(d, 'st-basket-total') === 250, 'a pack can be taken out of the basket');
  click(w, q(d, '#st-paid-cash'));
  ok(num(d, 'st-cash') === 250 && num(d, 'st-sales') === 2, 'Paid Cash: second customer ₹250');
  tap('original'); click(w, q(d, '#st-clear'));
  ok(d.querySelectorAll('#st-basket li').length === 0 && num(d, 'st-total') === 700, 'Clear empties the basket without recording');

  // ── hamper of 3: choose 3 ──
  tap('h3');
  ok(!q(d, '#st-mix').hidden && /3/.test(text(q(d, '#st-mix-title'))), 'hamper of 3 asks for 3 flavors');
  plus('kesari'); plus('kesari');
  ok(q(d, '#st-mix-ok').disabled, 'cannot add with 2 of 3');
  plus('ajwain'); plus('original');
  ok(text(q(d, '#st-mix-count')) === '3 / 3' && !q(d, '#st-mix-ok').disabled, 'a 4th pack is ignored for a hamper of 3');
  click(w, q(d, '#st-mix-ok'));
  tap('kesari');
  ok(num(d, 'st-basket-total') === 1049, 'basket: hamper of 3 + a Kesari = ₹1,049');
  click(w, q(d, '#st-paid-cash'));

  // ── hamper of 4: also asks; "One of each" shortcut; any mix of 4 ──
  tap('h4');
  ok(!q(d, '#st-mix').hidden && /4/.test(text(q(d, '#st-mix-title'))), 'hamper of 4 asks for its flavors too');
  click(w, q(d, '#st-mix-each'));
  ok(text(q(d, '#st-mix-count')) === '4 / 4', 'One of each fills all four flavors');
  click(w, q(d, '#st-mix-ok'));
  click(w, q(d, '#st-paid-upi'));
  tap('h4'); plus('original'); plus('original'); plus('kesari'); plus('kesari');
  click(w, q(d, '#st-mix-ok'));
  ok(/2× Original, 2× Kesari/.test(text(q(d, '#st-basket'))), 'a 2+2 hamper of 4 is listed by its mix: ' + text(q(d, '#st-basket')));
  click(w, q(d, '#st-paid-upi'));

  ok(num(d, 'st-total') === 3747 && num(d, 'st-upi') === 2448 && num(d, 'st-cash') === 1299, `money: 3747 / UPI 2448 / cash 1299 (got ${num(d, 'st-total')}/${num(d, 'st-upi')}/${num(d, 'st-cash')})`);
  ok(num(d, 'st-sales') === 5, '5 customers');
  ok(num(d, 'st-n-original') === 4 && num(d, 'st-n-ajwain') === 2 && num(d, 'st-n-kesari') === 7 && num(d, 'st-n-lite') === 2, `packs by flavor 4/2/7/2 (got ${num(d, 'st-n-original')}/${num(d, 'st-n-ajwain')}/${num(d, 'st-n-kesari')}/${num(d, 'st-n-lite')})`);
  ok(num(d, 'st-contrib') === 1312, 'contribution ≈ ₹1,312 (got ' + num(d, 'st-contrib') + ')');
  ok(num(d, 'st-avg') === 749, 'average per customer ₹749 (got ' + num(d, 'st-avg') + ')');

  // undo + delete whole customers
  click(w, q(d, '#st-undo'));
  ok(num(d, 'st-total') === 2748 && num(d, 'st-n-kesari') === 5 && num(d, 'st-sales') === 4, 'Undo removes the last customer');
  const rows = d.querySelectorAll('#st-log li');
  ok(rows.length === 4 && /#4/.test(text(rows[0])) && /#1/.test(text(rows[3])), 'recent customers, newest first, numbered');
  click(w, rows[3].querySelector('button[data-del]'));
  ok(num(d, 'st-total') === 2298 && num(d, 'st-n-original') === 1 && num(d, 'st-sales') === 3, 'a customer can be deleted');

  // opening stock -> left
  const inp = q(d, '#st-open-kesari'); inp.value = '20'; inp.dispatchEvent(new w.Event('change', { bubbles: true }));
  ok(num(d, 'st-left-kesari') === 16, 'left = opening - sold (got ' + num(d, 'st-left-kesari') + ')');

  // CSV: one row per pack line, with the customer number so a basket matches one UPI payment
  const lines = w.StallTally.csv().trim().split('\n');
  ok(lines[0] === 'date,time,customer,item,original,ajwain,kesari,sugar_lite,price,payment,customer_total', 'CSV header: ' + lines[0]);
  ok(lines.length === 5 && lines.some((l) => /^2026-10-25,\d\d:\d\d,3,Hamper of 3,0,1,2,0,799,cash,1049$/.test(l)) && lines.some((l) => /^2026-10-25,\d\d:\d\d,3,Kesari,0,0,1,0,250,cash,1049$/.test(l)), 'CSV rows: ' + lines.slice(1).join(' / '));

  // a basket in progress survives a reload
  tap('ajwain');
  p.close();
  p = await open(store, '2026-10-25T09:00:00Z'); ({ w, d } = p);
  ok(num(d, 'st-total') === 2298 && q(d, '#st-open-kesari').value === '20', 'reload keeps the day and opening stock');
  ok(d.querySelectorAll('#st-basket li').length === 1 && num(d, 'st-basket-total') === 200, 'reload keeps the basket in progress');
  p.close();

  // older single-tap data (before this change) still counts
  const old = memStorage({ 'munchingo-stall-v1': JSON.stringify({ days: { '2026-10-24': { sales: [{ id: 'a', t: Date.parse('2026-10-24T07:00:00Z'), item: 'kesari', name: 'Kesari', price: 250, hamper: false, mix: { kesari: 1 }, pay: 'upi' }], opening: {} } } }) });
  p = await open(old, '2026-10-25T06:00:00Z'); ({ w, d } = p);
  ok(/24 Oct/.test(text(q(d, '#st-days'))) && /₹250/.test(text(q(d, '#st-days'))), 'earlier single-tap data is kept and listed: ' + text(q(d, '#st-days')));
  ok(/Kesari,0,0,1,0,250,upi,250/.test(w.StallTally.csv()), 'earlier data exports too');
  p.close();

  // storage unavailable: warn
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} };
  p = await open(broken, '2026-10-25T06:00:00Z'); ({ w, d } = p);
  ok(!q(d, '#st-warn').hidden && /not being saved/i.test(text(q(d, '#st-warn'))), 'warns when the device cannot save');
  p.close();

  ok(!/stall/.test(fs.readFileSync(path.join(SITE, 'sitemap.xml'), 'utf8')), 'stall page is not in the sitemap');
  console.log(`stall-page-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log(`stall-page-test: ${pass} passed, ${fail} failed`); process.exit(1); });
