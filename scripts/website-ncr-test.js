'use strict';
// Delhi NCR only on the website (2 Nov 2026): the pincode check on product pages and at checkout shows the backend's message,
// Pay is refused for a pincode outside NCR, and no page promises delivery "across India".
//   npm install --no-save jsdom@24   then   SITE_DIR=<website> node scripts/website-ncr-test.js
let JSDOM, ResourceLoader;
try { ({ JSDOM, ResourceLoader } = require('jsdom')); } catch (e) { console.log('jsdom is not installed: run  npm install --no-save jsdom@24'); process.exit(1); }
const fs = require('fs'), path = require('path');
const SITE = process.env.SITE_DIR || path.resolve(__dirname, '../../../munchingo-website');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const MSG = 'We’re delivering in Delhi NCR only.';

class Local extends ResourceLoader {
  fetch(url) {
    const u = new URL(url);
    if (u.hostname !== 'localhost') return Promise.resolve(Buffer.from(''));
    const f = path.join(SITE, decodeURIComponent(u.pathname));
    return Promise.resolve(fs.existsSync(f) ? fs.readFileSync(f) : Buffer.from(''));
  }
}
// The backend's answer: Mumbai is outside the area, Delhi is fine.
const pinApi = (U) => {
  const pin = /\/api\/pincode\/(\d+)/.exec(U)[1];
  const body = pin.startsWith('110') ? { ok: true, pin, valid: true, serviceable: true, city: 'New Delhi', state: 'Delhi' }
    : { ok: true, pin, valid: true, serviceable: false, outside: true, message: MSG };
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
};
const page = (file, extra) => new JSDOM(fs.readFileSync(path.join(SITE, file), 'utf8'), {
  url: 'http://localhost/' + file, runScripts: 'dangerously', resources: new Local(), pretendToBeVisual: true,
  beforeParse(w) {
    w.scrollTo = () => {}; w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    w.fetch = (u, o) => { const U = String(u); if (/\/api\/pincode\//.test(U)) return pinApi(U); if (extra) { const r = extra(U, o); if (r) return r; } return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' }); };
    if (file === 'checkout.html') w.localStorage.setItem('munchingo_cart', JSON.stringify([{ slug: 'atta-original', name: 'Atta Original', price: 300, unit: '250g', qty: 3 }]));
  },
});

(async () => {
  // product page "Check delivery"
  let dom = page('atta-original.html'); let w = dom.window, d = w.document; await wait(1200);
  const inp = d.querySelector('.pc-in'), msg = d.querySelector('.pc-msg');
  ok(inp && msg, 'the product page has the Check delivery box');
  inp.value = '400001'; inp.dispatchEvent(new w.Event('input', { bubbles: true })); await wait(400);
  ok(msg.textContent.trim() === MSG && /bad/.test(msg.className), 'product page: a Mumbai pincode shows only "' + MSG + '" (got: ' + msg.textContent.trim() + ')');
  inp.value = '110017'; inp.dispatchEvent(new w.Event('input', { bubbles: true })); await wait(400);
  ok(/Delivery available/.test(msg.textContent), 'product page: a Delhi pincode shows delivery available');
  w.close();

  // checkout: status line and Pay
  const sent = [];
  dom = page('checkout.html', (U, o) => (o && o.method === 'POST' && /\/api\/checkout$/.test(U)) ? (sent.push(U), Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, paymentUrl: 'http://localhost/x#paid' }) })) : null);
  w = dom.window; d = w.document; await wait(1200);
  const set = (id, v) => { const e = d.getElementById(id); e.value = v; e.dispatchEvent(new w.Event('input', { bubbles: true })); e.dispatchEvent(new w.Event('change', { bubbles: true })); };
  set('ck-name', 'Test Buyer'); set('ck-phone', '9999900001'); set('ck-addr-line1', '12 Marine Drive test street'); set('ck-addr-city', 'Mumbai'); set('ck-addr-state', 'Maharashtra'); set('ck-email', 't@example.com');
  set('ck-addr-pincode', '400001'); await wait(800);
  ok((d.getElementById('ck-pin-status').textContent || '').trim() === MSG, 'checkout: the pincode line shows the NCR message (got: ' + (d.getElementById('ck-pin-status').textContent || '').trim() + ')');
  d.getElementById('ck-submit').form.requestSubmit(); await wait(800);
  ok(sent.length === 0 && (d.getElementById('checkout-error').textContent || '').trim() === MSG, 'checkout: Pay is refused with the same words and nothing is sent');
  w.close();

  // no page promises delivery across India
  const pages = fs.readdirSync(SITE).filter((f) => f.endsWith('.html'));
  const promising = pages.filter((f) => /across India|all over India|pan[- ]India|nationwide/i.test(fs.readFileSync(path.join(SITE, f), 'utf8')));
  ok(promising.length === 0, 'no page says we deliver across India (found in: ' + promising.join(', ') + ')');
  const stale = pages.filter((f) => /js\/pincode\.js\?v=2/.test(fs.readFileSync(path.join(SITE, f), 'utf8')));
  ok(stale.length === 0, 'every page loads the new pincode.js (v=3), so phones do not keep the old copy');

  console.log(`website-ncr-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
