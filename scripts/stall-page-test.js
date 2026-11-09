'use strict';
// The stall tally page (munchingo-website/stall.html, served at munchingo.com/stall). One entry per CUSTOMER: tap the packs
// into a basket, then Paid UPI / Paid Cash, so each entry matches one UPI payment. Tiles in the flavor colors; both
// hampers ask for their flavor mix. Saved on the device per IST day (basket too), CSV export, older single-tap data kept.
// 1 Nov 2026: prices 250/250/300/300, a tiered discount box on loose boxes only (hampers never count), no margin or fee shown.
// 6 Nov 2026: customers can see the iPad, so every dashboard card starts hidden; the gear ticks each one on for this iPad. Contribution
// uses box costs typed on the iPad, so no cost is ever in the public script.
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
  for (const [id, label, price] of [['original', 'Original', 250], ['ajwain', 'Ajwain', 250], ['kesari', 'Kesari', 300], ['lite', 'Sugar-Lite', 300], ['h3', 'Hamper of 3', 799], ['h4', 'Hamper of 4', 999]]) {
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
  ok(d.querySelectorAll('#st-basket li').length === 2 && num(d, 'st-basket-total') === 550, 'basket shows 2 packs, ₹550');
  ok(/550/.test(text(q(d, '#st-paid-upi'))) && !q(d, '#st-paid-upi').disabled, 'Paid UPI shows the basket total');
  ok(num(d, 'st-total') === 0 && num(d, 'st-sales') === 0, 'nothing counted before payment');
  click(w, q(d, '#st-paid-upi'));
  ok(num(d, 'st-total') === 550 && num(d, 'st-upi') === 550 && num(d, 'st-sales') === 1 && d.querySelectorAll('#st-basket li').length === 0, 'Paid UPI records ONE customer for ₹550 (no discount unless tapped) and empties the basket');

  // basket edits: remove a line, clear
  tap('ajwain'); tap('lite');
  click(w, q(d, '#st-basket li button[data-remove]'));   // remove the Ajwain
  ok(d.querySelectorAll('#st-basket li').length === 1 && num(d, 'st-basket-total') === 300, 'a pack can be taken out of the basket');
  click(w, q(d, '#st-paid-cash'));
  ok(num(d, 'st-cash') === 300 && num(d, 'st-sales') === 2, 'Paid Cash: second customer ₹300');
  tap('original'); click(w, q(d, '#st-clear'));
  ok(d.querySelectorAll('#st-basket li').length === 0 && num(d, 'st-total') === 850, 'Clear empties the basket without recording');

  // ── hamper of 3: choose 3 ──
  tap('h3');
  ok(!q(d, '#st-mix').hidden && /3/.test(text(q(d, '#st-mix-title'))), 'hamper of 3 asks for 3 flavors');
  plus('kesari'); plus('kesari');
  ok(q(d, '#st-mix-ok').disabled, 'cannot add with 2 of 3');
  plus('ajwain'); plus('original');
  ok(text(q(d, '#st-mix-count')) === '3 / 3' && !q(d, '#st-mix-ok').disabled, 'a 4th pack is ignored for a hamper of 3');
  click(w, q(d, '#st-mix-ok'));
  tap('kesari');
  ok(num(d, 'st-basket-total') === 1099, 'basket: hamper of 3 + a Kesari = ₹1,099');
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

  ok(num(d, 'st-total') === 3947 && num(d, 'st-upi') === 2548 && num(d, 'st-cash') === 1399, `money: 3947 / UPI 2548 / cash 1399 (got ${num(d, 'st-total')}/${num(d, 'st-upi')}/${num(d, 'st-cash')})`);
  ok(num(d, 'st-sales') === 5, '5 customers');
  ok(num(d, 'st-n-original') === 4 && num(d, 'st-n-ajwain') === 2 && num(d, 'st-n-kesari') === 7 && num(d, 'st-n-lite') === 2, `packs by flavor 4/2/7/2 (got ${num(d, 'st-n-original')}/${num(d, 'st-n-ajwain')}/${num(d, 'st-n-kesari')}/${num(d, 'st-n-lite')})`);
  ok(!q(d, '#st-fee') && !/stall fee|margin/i.test(text(d.body)), 'no margin or stall fee anywhere on the page (customers can see the iPad)');
  ok(num(d, 'st-avg') === 789, 'average per customer ₹789 (got ' + num(d, 'st-avg') + ')');

  // undo + delete whole customers
  click(w, q(d, '#st-undo'));
  ok(num(d, 'st-total') === 2948 && num(d, 'st-n-kesari') === 5 && num(d, 'st-sales') === 4, 'Undo removes the last customer');
  const rows = d.querySelectorAll('#st-log li');
  ok(rows.length === 4 && /#4/.test(text(rows[0])) && /#1/.test(text(rows[3])), 'recent customers, newest first, numbered');
  click(w, rows[3].querySelector('button[data-del]'));
  ok(num(d, 'st-total') === 2398 && num(d, 'st-n-original') === 1 && num(d, 'st-sales') === 3, 'a customer can be deleted');

  // opening stock -> left
  const inp = q(d, '#st-open-kesari'); inp.value = '20'; inp.dispatchEvent(new w.Event('change', { bubbles: true }));
  ok(num(d, 'st-left-kesari') === 16, 'left = opening - sold (got ' + num(d, 'st-left-kesari') + ')');

  // CSV: one row per pack line, with the customer number so a basket matches one UPI payment
  const lines = w.StallTally.csv().trim().split('\n');
  ok(lines[0] === 'date,time,customer,item,original,ajwain,kesari,sugar_lite,price,payment,customer_total,buyer_name,buyer_phone,marketing_ok,list_price,offer_off', 'CSV header: ' + lines[0]);
  ok(lines.length === 5 && lines.some((l) => /^2026-10-25,\d\d:\d\d,3,Hamper of 3,0,1,2,0,799,cash,1099,,,,799,0$/.test(l)) && lines.some((l) => /^2026-10-25,\d\d:\d\d,3,Kesari,0,0,1,0,300,cash,1099,,,,300,0$/.test(l)), 'CSV rows: ' + lines.slice(1).join(' / '));

  // a basket in progress survives a reload
  tap('ajwain');
  p.close();
  p = await open(store, '2026-10-25T09:00:00Z'); ({ w, d } = p);
  ok(num(d, 'st-total') === 2398 && q(d, '#st-open-kesari').value === '20', 'reload keeps the day and opening stock');
  ok(d.querySelectorAll('#st-basket li').length === 1 && num(d, 'st-basket-total') === 250, 'reload keeps the basket in progress');
  p.close();

  // ── discount box: tiers on loose boxes only, tapped by the seller ──
  {
    const st = memStorage();
    p = await open(st, '2026-11-01T06:00:00Z'); ({ w, d } = p);
    const tap2 = (item) => click(w, q(d, `button[data-item="${item}"]`));
    const tier = (off) => q(d, `#st-disc-opts button[data-off="${off}"]`);
    ok(d.querySelectorAll('#st-disc-opts button').length === 3 && /₹50 off/.test(text(tier(50))) && /₹500\+/.test(text(tier(50))) && /₹100 off/.test(text(tier(100))) && /₹1,000\+/.test(text(tier(100))) && /₹250 off/.test(text(tier(250))) && /₹2,000\+/.test(text(tier(250))),
      'three tiers: ₹50 off at ₹500+, ₹100 off at ₹1,000+, ₹250 off at ₹2,000+');
    tap2('original');
    ok(tier(50).disabled && tier(100).disabled && tier(250).disabled && /₹250 more unlocks ₹50 off/.test(text(q(d, '#st-disc-note'))), 'below ₹500 nothing unlocks; the note says how much more: ' + text(q(d, '#st-disc-note')));
    tap2('kesari');
    ok(!tier(50).disabled && tier(100).disabled, '₹550 of loose boxes unlocks ₹50 only');
    ok(num(d, 'st-basket-total') === 550, 'no discount until the seller taps one');
    click(w, tier(50));
    ok(tier(50).classList.contains('on') && num(d, 'st-basket-total') === 500 && /500/.test(text(q(d, '#st-paid-upi'))), 'tapping ₹50 off: basket and Paid show ₹500');
    tap2('h4'); click(w, q(d, '#st-mix-each')); click(w, q(d, '#st-mix-ok'));
    ok(tier(100).disabled && num(d, 'st-basket-total') === 1499, 'a hamper does not count toward a tier and is not discounted (550 + 999 − 50 = 1,499)');
    click(w, q(d, '#st-basket li button[data-remove="1"]'));   // take out the Kesari: loose falls to ₹250
    ok(num(d, 'st-basket-total') === 1249 && !d.querySelector('#st-disc-opts button.on'), 'dropping below the tier removes the discount (250 + 999)');
    click(w, q(d, '#st-clear'));
    tap2('original'); tap2('ajwain'); tap2('kesari'); tap2('lite');
    click(w, tier(100));
    ok(num(d, 'st-basket-total') === 1000, 'one of each loose (₹1,100) with ₹100 off = ₹1,000');
    click(w, tier(100));
    ok(num(d, 'st-basket-total') === 1100, 'tapping the chosen tier again takes it off');
    click(w, tier(100));
    click(w, q(d, '#st-paid-upi'));
    ok(num(d, 'st-total') === 1000 && num(d, 'st-upi') === 1000, 'the day records ₹1,000 received');
    ok(!d.querySelector('#st-disc-opts button.on') && num(d, 'st-basket-total') === 0, 'the discount resets for the next customer');
    ok(/₹100 off/.test(text(q(d, '#st-log li'))), 'recent customers show the discount: ' + text(q(d, '#st-log li')));
    const day = JSON.parse(st.getItem('munchingo-stall-v1')).days['2026-11-01'], o = day.orders[0];
    ok(o.offer === 100 && o.lines.reduce((a, l) => a + l.price, 0) === 1000 && o.lines.every((l) => l.list && l.price < l.list), 'saved lines carry what was charged (sum ₹1,000, the server total) and their list prices: ' + JSON.stringify(o.lines.map((l) => [l.list, l.price])));
    const rows2 = w.StallTally.csv().trim().split('\n').slice(1);
    ok(rows2.length === 4 && rows2.every((r) => /,upi,1000,,,,\d+,100$/.test(r)) && rows2.some((r) => /,Kesari,0,0,1,0,\d+,upi,1000,,,,300,100$/.test(r)), 'CSV: charged price, list price and ₹100 off on each line: ' + rows2.join(' / '));
    p.close();
  }

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


  // ── private dashboard: nothing about the day's money shows until the owner ticks it (6 Nov 2026) ──
  {
    const src = fs.readFileSync(path.join(SITE, 'js/stall.js'), 'utf8');
    ok(!/cost:\s*\d/.test(src) && !/\b(119|133|156|137|154|183)\b/.test(src), 'no box cost is written in the public script');
    const st = memStorage();
    let v = await open(st, '2026-11-06T12:00:00Z');
    let { w: w3, d: d3 } = v;
    const shown = (name) => { const el = q(d3, `[data-card="${name}"]`); return !!el && !el.hidden && !el.closest('[hidden]'); };
    const cards = ['today', 'contrib', 'packs', 'log', 'days'];
    const setView = (name, on) => { const c = q(d3, `input[data-view="${name}"]`); c.checked = on; c.dispatchEvent(new w3.Event('change', { bubbles: true })); };
    const setCost = (id, val) => { const c = q(d3, '#st-cost-' + id); c.value = val; c.dispatchEvent(new w3.Event('change', { bubbles: true })); };
    ok(cards.every((c) => !shown(c)), 'a fresh iPad shows no sales, packs, customers or earlier days');
    ok(q(d3, 'main').classList.contains('solo'), 'with nothing ticked the selling area takes the whole width');
    ok(q(d3, '#st-view').hidden, 'the customise panel starts closed');
    click(w3, q(d3, 'button[data-item="kesari"]'));
    ok(/₹300/.test(text(q(d3, '#st-basket-total'))), 'the customer still sees their own basket total');
    click(w3, q(d3, '#st-paid-upi'));
    ok(cards.every((c) => !shown(c)), 'a sale does not bring anything back');
    click(w3, q(d3, '#st-view-open'));
    ok(!q(d3, '#st-view').hidden, 'the gear opens the panel');
    ok(cards.every((c) => q(d3, `input[data-view="${c}"]`)), 'every card has its own tick box');
    setView('today', true);
    ok(shown('today') && !shown('packs') && !q(d3, 'main').classList.contains('solo'), 'ticking Total sales shows only that card');
    ok(num(d3, 'st-total') === 300, 'and it is correct');
    click(w3, q(d3, '#st-view-close'));
    ok(q(d3, '#st-view').hidden, 'Done closes the panel');
    setView('contrib', true);
    ok(shown('contrib') && /box costs/i.test(text(q(d3, '[data-card="contrib"]'))) && !/₹/.test(text(q(d3, '#st-contrib'))), 'contribution without costs asks for them, never guesses');
    [['original', 137], ['ajwain', 137], ['kesari', 154], ['lite', 183], ['h3', 45], ['h4', 55]].forEach(([k, c]) => setCost(k, c));
    ok(text(q(d3, '#st-contrib')) === '₹132', 'contribution: ₹300 less 5% GST less ₹154 box = ₹132 (got ' + text(q(d3, '#st-contrib')) + ')');
    click(w3, q(d3, 'button[data-item="h3"]'));
    ['original', 'ajwain', 'kesari'].forEach((f) => click(w3, q(d3, `button[data-plus="${f}"]`)));
    click(w3, q(d3, '#st-mix-ok')); click(w3, q(d3, '#st-paid-cash'));
    ok(text(q(d3, '#st-contrib')) === '₹420', 'a hamper counts its boxes and outer box: 131.71 + 760.95 - 428 - 45 = ₹420 (got ' + text(q(d3, '#st-contrib')) + ')');
    ok(!st.getItem('munchingo-stall-v1').includes('"h3":45'), 'costs are not in the day data that goes to the server');
    v.close();
    v = await open(st, '2026-11-06T13:00:00Z'); ({ w: w3, d: d3 } = v);
    ok(shown('today') && shown('contrib') && !shown('packs'), 'the choice survives a reload');
    ok(text(q(d3, '#st-contrib')) === '₹420', 'and so do the costs');
    click(w3, q(d3, '#st-view-open')); click(w3, q(d3, '#st-view-hide'));
    ok(cards.every((c) => !shown(c)) && q(d3, '#st-view').hidden && !q(d3, `input[data-view="today"]`).checked, 'Hide all puts everything away in one tap');
    v.close();
    const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {} };
    v = await open(blocked, '2026-11-06T13:00:00Z'); ({ w: w3, d: d3 } = v);
    ok(cards.every((c) => !shown(c)), 'storage blocked: everything stays hidden');
    v.close();
  }

  // ── buyer details (only with the marketing tick) and saving to the server ──
  {
    const calls = [];
    const st = memStorage({ 'munchingo-stall-key': 'k1' });
    const file = path.join(SITE, 'stall.html');
    const dom = new JSDOM(fs.readFileSync(file, 'utf8'), {
      url: 'http://localhost/stall.html', runScripts: 'dangerously', resources: new Local(), pretendToBeVisual: true,
      beforeParse(w2) {
        Object.defineProperty(w2, 'localStorage', { value: st, configurable: true });
        const RealDate = w2.Date; const fixed = RealDate.parse('2026-10-27T06:00:00Z');
        w2.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } };
        w2.confirm = () => true; w2.navigator.serviceWorker = undefined;
        w2.fetch = (url, opt) => { calls.push({ url, opt }); return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) }); };
      },
    });
    await wait(600);
    const w2 = dom.window, d2 = w2.document;
    const tap2 = (item) => click(w2, q(d2, `button[data-item="${item}"]`));
    const set = (id, v) => { const el = q(d2, '#' + id); el.value = v; el.dispatchEvent(new w2.Event('input', { bubbles: true })); };
    const tick = (on) => { const c = q(d2, '#st-b-ok'); c.checked = on; };
    const lastBody = () => JSON.parse(calls[calls.length - 1].opt.body);
    ok(/Server backup|Saved to server|Saving/.test(text(q(d2, '#st-sync'))), 'a sync status line is shown');

    // no buyer: the sale still saves, no buyer stored
    tap2('original'); click(w2, q(d2, '#st-paid-upi')); await wait(1700);
    ok(calls.length >= 1 && calls[0].url.endsWith('/api/stall/sync') && calls[0].opt.headers['X-Stall-Key'] === 'k1', 'the day is sent to the server with the stall key');
    ok(lastBody().orders.length === 1 && !lastBody().orders[0].buyer, 'a sale without buyer details sends no buyer');
    // phone typed, box NOT ticked: not stored
    tap2('kesari'); set('st-b-name', 'Asha'); set('st-b-phone', '98765 43210'); tick(false); click(w2, q(d2, '#st-paid-cash')); await wait(1700);
    ok(lastBody().orders.length === 2 && !lastBody().orders[1].buyer, 'number typed but box not ticked: nothing about the buyer is kept');
    ok(!JSON.stringify(JSON.parse(st.getItem('munchingo-stall-v1'))).includes('9876543210'), 'and the number is not in the device copy either');
    ok(q(d2, '#st-b-phone').value === '' && q(d2, '#st-b-name').value === '', 'the fields are cleared for the next customer');
    // ticked with a good number: stored with the exact wording
    tap2('ajwain'); set('st-b-name', 'Ravi Kumar'); set('st-b-phone', '9811122233'); tick(true); click(w2, q(d2, '#st-paid-upi')); await wait(1700);
    const b = lastBody().orders[2].buyer;
    ok(b && b.phone === '9811122233' && b.name === 'Ravi Kumar' && b.consent === true && /OK to send me new Flavors and offers on WhatsApp/.test(b.consentText), 'ticked + valid number: buyer kept with the consent wording');
    ok(q(d2, '#st-b-text').textContent.trim() === b.consentText, 'the wording sent is exactly the wording shown on the page');
    // ticked but a bad number: refused
    tap2('lite'); set('st-b-phone', '12345'); tick(true); click(w2, q(d2, '#st-paid-upi')); await wait(1700);
    ok(!lastBody().orders[3].buyer, 'ticked but a bad number: not kept');
    // CSV carries the buyer only when kept
    const csv2 = w2.StallTally.csv().trim().split('\n');
    ok(csv2.some((l) => /"Ravi Kumar",9811122233,yes,\d+,0$/.test(l)) && csv2.filter((l) => /,yes,\d+,\d+$/.test(l)).length === 1, 'CSV: only the ticked buyer, with the marketing_ok flag');
    ok(/Saved to server/.test(text(q(d2, '#st-sync'))), 'status shows saved once the server accepts');
    dom.window.close();

    // offline: the sale is kept on the device and sent when the server is back; a wrong key is reported
    let mode = 'down'; const calls2 = [];
    const st2 = memStorage({ 'munchingo-stall-key': 'k1' });
    const dom2 = new JSDOM(fs.readFileSync(file, 'utf8'), {
      url: 'http://localhost/stall.html', runScripts: 'dangerously', resources: new Local(), pretendToBeVisual: true,
      beforeParse(w3) {
        Object.defineProperty(w3, 'localStorage', { value: st2, configurable: true });
        const RealDate = w3.Date; const fixed = RealDate.parse('2026-10-27T06:00:00Z');
        w3.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } };
        w3.confirm = () => true; w3.navigator.serviceWorker = undefined;
        w3.fetch = (url, opt) => { calls2.push(mode); if (mode === 'down') return Promise.reject(new Error('offline')); if (mode === 'wrong') return Promise.resolve({ ok: false, status: 403 }); return Promise.resolve({ ok: true, status: 200 }); };
      },
    });
    await wait(600);
    const w3 = dom2.window, d3 = w3.document;
    click(w3, q(d3, 'button[data-item="original"]')); click(w3, q(d3, '#st-paid-upi')); await wait(1700);
    ok(/Not yet saved/.test(text(q(d3, '#st-sync'))) && JSON.parse(st2.getItem('munchingo-stall-v1')).days['2026-10-27'].orders.length === 1, 'offline: the sale is kept on the device and the page says it is not yet saved');
    mode = 'wrong'; w3.dispatchEvent(new w3.Event('online')); await wait(300);
    ok(/Wrong stall key/.test(text(q(d3, '#st-sync'))), 'a wrong key is reported');
    mode = 'up'; w3.localStorage.setItem('munchingo-stall-key', 'k1'); w3.dispatchEvent(new w3.Event('online')); await wait(300);
    ok(/Saved to server/.test(text(q(d3, '#st-sync'))), 'back online: it catches up and says saved');
    dom2.window.close();

    // no key yet: says so
    const dom3 = new JSDOM(fs.readFileSync(file, 'utf8'), { url: 'http://localhost/stall.html', runScripts: 'dangerously', resources: new Local(), pretendToBeVisual: true,
      beforeParse(w4) { Object.defineProperty(w4, 'localStorage', { value: memStorage(), configurable: true }); w4.navigator.serviceWorker = undefined; w4.fetch = () => Promise.reject(new Error('no')); } });
    await wait(500);
    ok(/OFF/.test(text(dom3.window.document.querySelector('#st-sync'))), 'no key entered yet: the page says server backup is off');
    dom3.window.close();
  }
  ok(!/stall/.test(fs.readFileSync(path.join(SITE, 'sitemap.xml'), 'utf8')), 'stall page is not in the sitemap');
  console.log(`stall-page-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log(`stall-page-test: ${pass} passed, ${fail} failed`); process.exit(1); });
