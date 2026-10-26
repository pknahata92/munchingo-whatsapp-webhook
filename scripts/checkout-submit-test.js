'use strict';
// The real checkout page (munchingo-website/checkout.html): fill it in, press Pay, and check the order request is sent.
// This is the click-through that would have caught a Pay handler that threw before sending anything (19 Oct 2026).
//   npm install --no-save jsdom@24   then   node scripts/checkout-submit-test.js
let JSDOM, ResourceLoader;
try { ({ JSDOM, ResourceLoader } = require('jsdom')); } catch (e) { console.log('jsdom is not installed: run  npm install --no-save jsdom@24'); process.exit(1); }
const fs = require('fs'), path = require('path');
const SITE = process.env.SITE_DIR || path.resolve(__dirname, '../../../munchingo-website');
if (!fs.existsSync(path.join(SITE, 'checkout.html'))) { console.log('FAIL: missing ' + SITE + '/checkout.html'); process.exit(1); }
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class Local extends ResourceLoader {   // local scripts from the site folder; nothing leaves the machine
  fetch(url) {
    const u = new URL(url);
    if (u.hostname !== 'localhost') return Promise.resolve(Buffer.from(''));
    const f = path.join(SITE, decodeURIComponent(u.pathname));
    return Promise.resolve(fs.existsSync(f) ? fs.readFileSync(f) : Buffer.from(''));
  }
}

async function prefill() {
  const html = fs.readFileSync(path.join(SITE, 'checkout.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/checkout.html', runScripts: 'dangerously', resources: new Local(), pretendToBeVisual: true,
    beforeParse(w) { w.localStorage.setItem('munchingo_cart', JSON.stringify([{ slug: 'atta-original', name: 'Atta Original', price: 300, unit: '250g', qty: 3 }])); w.localStorage.setItem('munchingo_customer', JSON.stringify({ name: 'Saved Person', phone: '9999900002', address: '1 Old Road', pincode: '110049', city: 'Delhi', state: 'Delhi', email: 's@example.com' })); w.scrollTo = () => {}; w.fetch = () => Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' }); } });
  await wait(1200);
  const d = dom.window.document;
  ok(d.getElementById('ck-name').value === 'Saved Person' && d.getElementById('ck-addr-line1').value === '1 Old Road' && d.getElementById('ck-phone').value === '9999900002', 'a returning customer sees their saved name, phone and address filled in');
  dom.window.close();
}
async function remembersBeforePaying() {
  const html = fs.readFileSync(path.join(SITE, 'checkout.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/checkout.html', runScripts: 'dangerously', resources: new Local(), pretendToBeVisual: true,
    beforeParse(w) { w.localStorage.setItem('munchingo_cart', JSON.stringify([{ slug: 'atta-original', name: 'Atta Original', price: 300, unit: '250g', qty: 3 }])); w.scrollTo = () => {}; w.fetch = () => Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' }); } });
  const w = dom.window, d = w.document; await wait(1200);
  const set = (id, v) => { const e = d.getElementById(id); e.value = v; e.dispatchEvent(new w.Event('input', { bubbles: true })); e.dispatchEvent(new w.Event('change', { bubbles: true })); };
  set('ck-name', 'Early Typer'); set('ck-phone', '9999900003'); set('ck-addr-line1', '9 Typed Street'); await wait(300);
  const mem = JSON.parse(w.localStorage.getItem('munchingo_customer') || 'null');
  ok(mem && mem.name === 'Early Typer' && mem.address === '9 Typed Street', 'details are remembered as soon as they are typed, even if the customer leaves before paying');
  d.getElementById('ck-remember').checked = false; d.getElementById('ck-remember').dispatchEvent(new w.Event('change', { bubbles: true })); await wait(200);
  ok(w.localStorage.getItem('munchingo_customer') === null, 'unticking Remember forgets what was saved');
  w.close();
}
async function run(label, { source, expectSent = true, saved, optin }) {
  const html = fs.readFileSync(path.join(SITE, 'checkout.html'), 'utf8');
  const sent = [];
  const dom = new JSDOM(html, {
    url: 'http://localhost/checkout.html?utm_source=ig', runScripts: 'dangerously', resources: new Local(), pretendToBeVisual: true,
    beforeParse(w) {
      w.localStorage.setItem('munchingo_cart', JSON.stringify([{ slug: 'atta-original', name: 'Atta Original', price: 300, unit: '250g', qty: 3 }]));
      if (saved) w.localStorage.setItem('munchingo_customer', JSON.stringify(saved));
      w.scrollTo = () => {}; w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
      w.fetch = (u, o) => {
        const U = String(u);
        if (/\/api\/pincode\//.test(U)) return Promise.resolve({ ok: true, status: 200, json: async () => ({ serviceable: true, state: 'Haryana', city: 'Faridabad' }) });
        if (o && o.method === 'POST' && /\/api\/checkout$/.test(U)) { sent.push({ url: U, body: JSON.parse(o.body) }); return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, paymentUrl: 'http://localhost/checkout.html?utm_source=ig#paid' }) }); }
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
      };
    },
  });
  const w = dom.window, d = w.document;
  await wait(1200);
  const set = (id, v) => { const e = d.getElementById(id); e.value = v; e.dispatchEvent(new w.Event('input', { bubbles: true })); e.dispatchEvent(new w.Event('change', { bubbles: true })); };
  set('ck-name', 'Test Buyer'); set('ck-phone', '9999900001'); set('ck-addr-pincode', '121007'); set('ck-addr-city', 'Faridabad'); set('ck-addr-state', 'Haryana');
  set('ck-addr-line1', '43 Sector 14 test street'); set('ck-email', 't@example.com'); if (source) set('ck-source', source);
  const box = d.getElementById('ck-whatsapp-optin');
  ok(box && box.type === 'checkbox' && box.checked === false, `${label}: the WhatsApp offers box exists and starts unticked`);
  ok(box && /Send me new Flavors and offers on WhatsApp\. A few messages a month\. Reply STOP any time\./.test((box.closest('label') || {}).textContent || ''), `${label}: the box shows the approved wording`);
  if (optin && box) { box.checked = true; box.dispatchEvent(new w.Event('change', { bubbles: true })); }
  await wait(600); w.__pinBlocked = false;
  d.getElementById('ck-submit').form.requestSubmit();
  await wait(1200);
  const err = (d.getElementById('checkout-error') || {}).textContent || '';
  ok(sent.length === (expectSent ? 1 : 0), `${label}: the order request is sent (${sent.length} sent; page says: ${err.trim().slice(0, 80)})`);
  ok(!/couldn.t reach|Please fill|cannot deliver/i.test(err), `${label}: no error is shown to the customer`);
  if (sent[0]) {
    const b = sent[0].body;
    ok(/\/api\/checkout$/.test(sent[0].url), `${label}: it goes to /api/checkout`);
    ok(b.name === 'Test Buyer' && b.items.length === 1 && b.total === 900, `${label}: name, items and total are in the request`);
    if (source) ok(b.source && b.source.how === source, `${label}: the "how did you hear" answer rides along`);
    ok(optin ? b.marketing === true : b.marketing === undefined, `${label}: marketing is ${optin ? 'true' : 'not sent'} in the request`);
  }
  if (expectSent) { const mem = JSON.parse(w.localStorage.getItem('munchingo_customer') || 'null'); ok(mem && mem.name === 'Test Buyer' && mem.pincode === '121007', `${label}: details are remembered after a successful order`); }
  ok(w.location.hash === '#paid', `${label}: the page moves on to the payment link`);
  w.close();
}

(async () => {
  await run('with a source answer', { source: 'instagram' });
  await run('without a source answer', {});
  await run('with the WhatsApp box ticked', { optin: true });
  await prefill();
  await remembersBeforePaying();
  console.log(`checkout-submit-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
