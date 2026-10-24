'use strict';
// The stall tally page (munchingo-website/stall.html, served at munchingo.com/stall): one tap per sale, UPI/cash, hamper
// flavour mix, undo, per-flavour packs and money, saved on the device per day, CSV export.
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
// One shared storage across page loads, so a reload proves the tally survives.
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
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
const q = (d, s) => d.querySelector(s);
const num = (d, id) => Number((text(q(d, '#' + id)) || '').replace(/[^\d-]/g, ''));

(async () => {
  const store = memStorage();
  let p = await open(store, '2026-10-25T06:00:00Z');   // 11:30 IST
  if (!p) { console.log(`stall-page-test: ${pass} passed, ${fail} failed`); process.exit(1); }
  let { w, d } = p;
  ok(/noindex/.test((q(d, 'meta[name="robots"]') || {}).content || ''), 'the page is noindex');
  ok(/25 Oct/.test(text(q(d, '#st-day'))), 'shows today (IST): ' + text(q(d, '#st-day')));
  for (const [id, label, price] of [['original', 'Original', 200], ['ajwain', 'Ajwain', 200], ['kesari', 'Kesari', 250], ['lite', 'Sugar-Lite', 250], ['h3', 'Hamper of 3', 799], ['h4', 'Hamper of 4', 999]]) {
    const b = q(d, `button[data-item="${id}"]`);
    ok(b && new RegExp(label).test(text(b)) && new RegExp('₹' + price).test(text(b)), `button ${label} ₹${price}`);
  }
  ok(q(d, '#st-pay-upi').getAttribute('aria-pressed') === 'true', 'UPI is the default payment');

  click(w, q(d, 'button[data-item="kesari"]'));
  click(w, q(d, 'button[data-item="original"]'));
  click(w, q(d, '#st-pay-cash'));
  click(w, q(d, 'button[data-item="lite"]'));
  ok(num(d, 'st-total') === 700 && num(d, 'st-upi') === 450 && num(d, 'st-cash') === 250, `money: total 700, UPI 450, cash 250 (got ${num(d, 'st-total')}/${num(d, 'st-upi')}/${num(d, 'st-cash')})`);
  ok(num(d, 'st-n-kesari') === 1 && num(d, 'st-n-original') === 1 && num(d, 'st-n-lite') === 1 && num(d, 'st-n-ajwain') === 0, 'packs per flavour');
  ok(num(d, 'st-sales') === 3, 'sale count 3');

  // Hamper of 3: choose the mix, must add up to 3
  click(w, q(d, 'button[data-item="h3"]'));
  const dlg = q(d, '#st-mix');
  ok(dlg && !dlg.hidden, 'hamper of 3 asks for the flavour mix');
  const add = (f) => click(w, q(d, `#st-mix button[data-plus="${f}"]`));
  const okBtn = q(d, '#st-mix-ok');
  add('kesari'); add('kesari');
  ok(okBtn.disabled, 'cannot confirm with 2 flavours');
  add('ajwain');
  ok(!okBtn.disabled, 'can confirm at exactly 3');
  add('original');
  ok(text(q(d, '#st-mix-count')) === '3 / 3' && !okBtn.disabled, 'a 4th tap is ignored: ' + text(q(d, '#st-mix-count')));
  click(w, okBtn);
  ok(dlg.hidden, 'the mix closes after confirming');
  ok(num(d, 'st-n-kesari') === 3 && num(d, 'st-n-ajwain') === 1 && num(d, 'st-total') === 1499 && num(d, 'st-cash') === 1049, 'hamper of 3 (cash) counts 2 Kesari + 1 Ajwain and ₹799');
  click(w, q(d, 'button[data-item="h4"]'));
  ok(num(d, 'st-n-original') === 2 && num(d, 'st-n-ajwain') === 2 && num(d, 'st-n-kesari') === 4 && num(d, 'st-n-lite') === 2 && num(d, 'st-total') === 2498, 'hamper of 4 adds one of each flavour and ₹999');

  // contribution: price/1.05 - pack costs - ₹100 hamper packaging; v14 costs 119/119/133/156
  // kesari 105.10 + original 71.48 + lite 82.10 + h3(K,K,A) 760.95-385-100=275.95 + h4 951.43-527-100=324.43 = 859.06
  ok(num(d, 'st-contrib') === 859, 'contribution ≈ ₹859 (got ' + num(d, 'st-contrib') + ')');

  // undo + delete one
  click(w, q(d, '#st-undo'));
  ok(num(d, 'st-total') === 1499 && num(d, 'st-n-lite') === 1, 'Undo removes the last sale (the hamper of 4)');
  const rows = d.querySelectorAll('#st-log li');
  ok(rows.length === 4 && /Hamper of 3/.test(text(rows[0])), 'recent sales list, newest first');
  click(w, rows[rows.length - 1].querySelector('button[data-del]'));   // delete the first Kesari
  ok(num(d, 'st-total') === 1249 && num(d, 'st-n-kesari') === 2, 'a single sale can be deleted');

  // opening stock -> remaining
  const inp = q(d, '#st-open-kesari'); inp.value = '20'; inp.dispatchEvent(new w.Event('change', { bubbles: true }));
  ok(num(d, 'st-left-kesari') === 18, 'remaining = opening stock - sold (got ' + num(d, 'st-left-kesari') + ')');

  // CSV
  const csv = w.StallTally.csv();
  const lines = csv.trim().split('\n');
  ok(lines[0] === 'date,time,item,original,ajwain,kesari,sugar_lite,price,payment', 'CSV header: ' + lines[0]);
  ok(lines.length === 4 && lines.some((l) => /^2026-10-25,\d\d:\d\d,Hamper of 3,0,1,2,0,799,cash$/.test(l)), 'CSV rows: ' + lines.slice(1).join(' / '));
  p.close();

  // reload: the day survives; a new day starts empty, the old day is kept
  p = await open(store, '2026-10-25T09:00:00Z'); ({ w, d } = p);
  ok(num(d, 'st-total') === 1249 && num(d, 'st-n-kesari') === 2 && q(d, '#st-open-kesari').value === '20', 'reloading keeps today\'s tally and opening stock');
  p.close();
  p = await open(store, '2026-10-26T05:00:00Z'); ({ w, d } = p);
  ok(num(d, 'st-total') === 0 && /26 Oct/.test(text(q(d, '#st-day'))), 'a new day starts at zero');
  ok(/25 Oct/.test(text(q(d, '#st-days'))) && /1,249/.test(text(q(d, '#st-days'))), 'earlier days are listed with their total: ' + text(q(d, '#st-days')));
  p.close();

  // storage unavailable (private mode): warn loudly
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} };
  p = await open(broken, '2026-10-25T06:00:00Z'); ({ w, d } = p);
  ok(q(d, '#st-warn') && !q(d, '#st-warn').hidden && /not being saved/i.test(text(q(d, '#st-warn'))), 'warns when the device cannot save');
  p.close();

  // the site must not list it
  const sitemap = fs.readFileSync(path.join(SITE, 'sitemap.xml'), 'utf8');
  ok(!/stall/.test(sitemap), 'stall page is not in the sitemap');

  console.log(`stall-page-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
