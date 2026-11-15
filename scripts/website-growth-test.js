'use strict';
// Growth system, website side (task B1): checkout consent v2, the order-confirmed JOIN button, the "notify" link outside NCR.
// All network calls are stubbed. Nothing reaches a live API and no real checkout is sent.
//   npm install --no-save jsdom@24   then   SITE_DIR=<website> node scripts/website-growth-test.js
let JSDOM, ResourceLoader;
try { ({ JSDOM, ResourceLoader } = require('jsdom')); } catch (e) { console.log('jsdom is not installed: run  npm install --no-save jsdom@24'); process.exit(1); }
const fs = require('fs'), path = require('path');
const SITE = process.env.SITE_DIR || path.resolve(__dirname, '../../../munchingo-website');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const C4 = 'Send me fresh batches, new Flavors and one nudge when my box is likely running low, on WhatsApp. At most 3 a month. Reply STOP any time.';
const FIRST = 'Send me fresh batches, new Flavors and one nudge when my box is likely running low, on WhatsApp.';
const WA = 'https://wa.me/919988992024';

class Local extends ResourceLoader {
  fetch(url) {
    const u = new URL(url);
    if (u.hostname !== 'localhost') return Promise.resolve(Buffer.from(''));
    const f = path.join(SITE, decodeURIComponent(u.pathname));
    return Promise.resolve(fs.existsSync(f) ? fs.readFileSync(f) : Buffer.from(''));
  }
}
const json = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const page = (file, url, handler) => new JSDOM(fs.readFileSync(path.join(SITE, file), 'utf8'), {
  url: 'http://localhost/' + (url || file), runScripts: 'dangerously', resources: new Local(), pretendToBeVisual: true,
  beforeParse(w) {
    w.scrollTo = () => {}; w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    // every call is stubbed: only what the handler answers comes back, everything else is a 404
    w.fetch = (u, o) => { const r = handler && handler(String(u), o || {}); return r || Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' }); };
    if (file === 'checkout.html') w.localStorage.setItem('munchingo_cart', JSON.stringify([{ slug: 'atta-original', name: 'Atta Original', price: 300, unit: '250g', qty: 3 }]));
  },
});

(async () => {
  // 1. checkout: the consent label is C4, a ticked box sends marketing 'v2', an unticked box sends nothing
  for (const ticked of [true, false]) {
    const sent = [];
    const dom = page('checkout.html', 'checkout.html', (U, o) => {
      if (/\/api\/pincode\//.test(U)) return json({ ok: true, valid: true, serviceable: true, city: 'New Delhi', state: 'Delhi' });
      if (o.method === 'POST' && /\/api\/checkout$/.test(U)) { sent.push(JSON.parse(o.body)); return json({ ok: true, paymentUrl: 'http://localhost/checkout.html#paid' }); }
      return null;
    });
    const w = dom.window, d = w.document; await wait(1200);
    const label = d.getElementById('ck-whatsapp-optin-label'), box = d.getElementById('ck-whatsapp-optin');
    ok(label && norm(label.textContent) === C4, 'checkout label is C4 (got: ' + (label && norm(label.textContent)) + ')');
    const strong = label && label.querySelector('strong');
    ok(strong && norm(strong.textContent) === FIRST, 'checkout label shows the first sentence in <strong> (got: ' + (strong && norm(strong.textContent)) + ')');
    ok(box && !box.checked, 'the consent box starts unticked');
    const set = (id, v) => { const e = d.getElementById(id); e.value = v; e.dispatchEvent(new w.Event('input', { bubbles: true })); e.dispatchEvent(new w.Event('change', { bubbles: true })); };
    set('ck-name', 'Test Buyer'); set('ck-phone', '9999900001'); set('ck-addr-line1', '12 Test street'); set('ck-addr-city', 'New Delhi'); set('ck-addr-state', 'Delhi'); set('ck-email', 't@example.com');
    set('ck-addr-pincode', '110017'); await wait(800);
    if (ticked) { box.checked = true; box.dispatchEvent(new w.Event('change', { bubbles: true })); }
    d.getElementById('ck-submit').form.requestSubmit(); await wait(800);
    ok(sent.length === 1, (ticked ? 'ticked' : 'unticked') + ': one stubbed checkout was posted (got ' + sent.length + ')');
    if (sent.length === 1) {
      if (ticked) ok(sent[0].marketing === 'v2', "ticked box posts marketing: 'v2' (got: " + JSON.stringify(sent[0].marketing) + ')');
      else ok(!('marketing' in sent[0]), 'unticked box posts no marketing key (got: ' + JSON.stringify(sent[0].marketing) + ')');
    }
    w.close();
  }

  // 2. order-confirmed: a paid order shows the JOIN button
  {
    const dom = page('order-confirmed.html', 'order-confirmed.html?order=MUN-TEST1', (U) => /\/api\/order\//.test(U)
      ? json({ ok: true, status: 'paid', orderId: 'MUN-TEST1', customerName: 'Test', items: [{ name: 'Atta Original', quantity: 2, price: 259 }], total: 518 }) : null);
    const w = dom.window, d = w.document; await wait(1200);
    const ok1 = d.getElementById('confirm-success').style.display !== 'none';
    ok(ok1, 'the paid state is showing');
    const a = d.querySelector('a[href="' + WA + '?text=JOIN"]');
    ok(a && norm(a.textContent) === 'Get fresh-batch news on WhatsApp', 'order-confirmed has the JOIN button (got: ' + (a && norm(a.textContent)) + ')');
    ok(a && d.getElementById('confirm-success').contains(a), 'the JOIN button sits inside the paid state only');
    ok(a && /\boutline\b/.test(a.className) && !/\bsolid\b/.test(a.className), 'the JOIN button is the secondary (outline) style');
    ok(a && a.parentNode.classList.contains('confirm-ctas'), 'the JOIN button sits in the existing .confirm-ctas block');
    ok(!d.getElementById('confirm-fallback').contains(a) && !d.getElementById('confirm-notfound').contains(a), 'the JOIN button is not in the unpaid states');
    w.close();
  }

  // 3. pincode outside the area: the note gets a "notify" link
  for (const c of [{ pin: '302001', city: 'Jaipur', want: 'Jaipur' }, { pin: '302001', city: '', want: '302001' }]) {
    const dom = page('atta-original.html', 'atta-original.html', (U) => /\/api\/pincode\//.test(U)
      ? json({ ok: true, pin: c.pin, valid: true, serviceable: false, outside: true, city: c.city, message: 'We’re delivering in Delhi NCR only.' }) : null);
    const w = dom.window, d = w.document; await wait(1200);
    const inp = d.querySelector('.pc-in'), msg = d.querySelector('.pc-msg');
    inp.value = c.pin; inp.dispatchEvent(new w.Event('input', { bubbles: true })); await wait(500);
    const a = msg.querySelector('a');
    ok(a && norm(a.textContent) === 'Tell me when you deliver to ' + c.want, 'outside answer shows "Tell me when you deliver to ' + c.want + '" (got: ' + (a && norm(a.textContent)) + ')');
    ok(a && a.getAttribute('href') === WA + '?text=' + encodeURIComponent('NOTIFY - ' + c.want), 'notify link goes to wa.me with NOTIFY - ' + c.want + ' (got: ' + (a && a.getAttribute('href')) + ')');
    ok(/Delhi NCR only/.test(msg.textContent), 'the backend message is still shown');
    w.close();
  }
  // a hostile city name is escaped in the text and encoded in the href
  for (const city of ['<img src=x onerror=alert(1)>', 'Ja"ipur']) {
    const dom = page('atta-original.html', 'atta-original.html', (U) => /\/api\/pincode\//.test(U)
      ? json({ ok: true, pin: '302001', valid: true, serviceable: false, outside: true, city, message: 'We’re delivering in Delhi NCR only.' }) : null);
    const w = dom.window, d = w.document; await wait(1200);
    const inp = d.querySelector('.pc-in'), msg = d.querySelector('.pc-msg');
    inp.value = '302001'; inp.dispatchEvent(new w.Event('input', { bubbles: true })); await wait(500);
    const a = msg.querySelector('a');
    ok(!msg.querySelector('img') && !d.querySelector('img[src="x"]'), 'hostile city ' + city + ': no <img> element is created');
    ok(a && a.textContent === 'Tell me when you deliver to ' + city, 'hostile city ' + city + ': link text is the city as plain text (got: ' + (a && a.textContent) + ')');
    ok(a && a.getAttribute('href') === WA + '?text=' + encodeURIComponent('NOTIFY - ' + city), 'hostile city ' + city + ': href is encodeURIComponent-encoded (got: ' + (a && a.getAttribute('href')) + ')');
    ok(a && !/["<>]/.test(a.getAttribute('href')), 'hostile city ' + city + ': no raw quote or angle bracket in the href');
    w.close();
  }
  // an in-area answer has no notify link
  {
    const dom = page('atta-original.html', 'atta-original.html', (U) => /\/api\/pincode\//.test(U) ? json({ ok: true, pin: '110017', valid: true, serviceable: true, city: 'New Delhi', state: 'Delhi' }) : null);
    const w = dom.window, d = w.document; await wait(1200);
    const inp = d.querySelector('.pc-in'), msg = d.querySelector('.pc-msg');
    inp.value = '110017'; inp.dispatchEvent(new w.Event('input', { bubbles: true })); await wait(500);
    ok(!msg.querySelector('a'), 'an in-area pincode shows no notify link');
    w.close();
  }

  // 4. search words (task B2): approved titles, descriptions, price-reason lines; H1s unchanged; no "100%"
  {
    const LINE = ' Turn any biscuit pack over and read the first three ingredients.';
    const W = [
      ['index.html', 'Munchingo Atta Biscuits: Desi Ghee, No Maida, No Palm Oil', 'Atta biscuits baked in pure desi ghee in Bikaner. Whole wheat flour, no maida, no palm oil. Four Flavors and two Sets, delivering in Delhi NCR.', null, 'Four atta cookies.nothingpretending.'],
      ['shop.html', 'Desi Ghee Atta Biscuits: Shop All Four | Munchingo', 'Shop all four Munchingo atta biscuits, baked in pure desi ghee with whole wheat flour, no maida and no palm oil, plus the Trio and Full Range Sets.', null, 'The whole range.'],
      ['atta-original.html', 'Munchingo Atta Original: Desi Ghee Atta Biscuits', 'Cardamom atta biscuits baked in pure desi ghee in Bikaner. Whole wheat flour, no maida, no palm oil. Gently sweet, made for chai.', 'What you pay for: pure desi ghee, whole wheat flour and cardamom. No maida, no palm oil.' + LINE, 'Atta Original'],
      ['atta-kesari.html', 'Munchingo Atta Kesari: Kesar Atta Biscuits', 'Kesar atta biscuits with real saffron and cardamom, baked in pure desi ghee in Bikaner. Whole wheat flour, no maida, no palm oil.', 'What you pay for: pure desi ghee, whole wheat flour and real saffron. No maida, no palm oil.' + LINE, 'Atta Kesari'],
      ['atta-ajwain.html', 'Munchingo Atta Ajwain: Ajwain Atta Biscuits', 'Ajwain atta biscuits, spiced and less sweet, baked in pure desi ghee in Bikaner. Whole wheat flour, no maida, no palm oil.', 'What you pay for: pure desi ghee, whole wheat flour and ajwain. No maida, no palm oil.' + LINE, 'Atta Ajwain'],
      ['atta-lite-sugar.html', 'Munchingo Atta Sugar-Lite: No Added Sugar Biscuits', 'No added sugar atta biscuits, sweetened with maltitol. Pure desi ghee and whole wheat flour, no maida, no palm oil.', 'What you pay for: pure desi ghee and whole wheat flour, sweetened with maltitol. No maida, no palm oil.' + LINE, 'Atta Sugar-Lite'],
      ['maida-free-cookies-guide.html', 'No Maida Biscuits: How to Read a Biscuit Label | Munchingo', 'How to spot maida, palm oil and added sugar on a biscuit label in India, and what goes into each Munchingo Flavor. A plain guide.', null, 'Maida-free cookies: how to read a biscuit label.'],
    ];
    for (const [file, title, desc, line, h1] of W) {
      const html = fs.readFileSync(path.join(SITE, file), 'utf8');
      const d = new JSDOM(html).window.document;
      const meta = (sel) => { const e = d.querySelector(sel); return e && e.getAttribute('content'); };
      ok(d.title === title, file + ' title is the approved text (got: ' + d.title + ')');
      ok(title.length <= 60 && desc.length <= 155, file + ' title <= 60 and description <= 155 characters');
      ok(meta('meta[name="description"]') === desc, file + ' description is the approved text');
      ok(meta('meta[property="og:title"]') === title && meta('meta[name="twitter:title"]') === title, file + ' og:title and twitter:title match the title');
      ok(meta('meta[property="og:description"]') === desc && meta('meta[name="twitter:description"]') === desc, file + ' og:description and twitter:description match the description');
      if (/^atta-/.test(file)) ok(/Munchingo Atta \S+/.test(d.title) && /Biscuits/.test(d.title), file + ' title has "Munchingo Atta <Flavor>" and "Biscuits"');
      if (file !== 'index.html') ok(norm(d.querySelector('h1').textContent) === h1, file + ' H1 unchanged (got: ' + norm(d.querySelector('h1').textContent) + ')');
      else ok(norm(d.querySelector('h1').textContent).replace(/\s/g, '') === h1.replace(/\s/g, ''), 'index.html H1 unchanged');
      if (line) {
        const p = [...d.querySelectorAll('.v2-buy p')].find((e) => norm(e.textContent) === line);
        ok(!!p, file + ' has the approved "What you pay for" line in the buy block');
        const buy = d.querySelector('.v2-buy');
        ok(p && !!(d.getElementById('add').compareDocumentPosition(p) & 4) && !!(p.compareDocumentPosition(d.querySelector('.v2-mov')) & 4), file + ' the line sits after the add-to-bag row (R31)');
      }
      ok(!/100\s*%/.test(html), file + ' has no "100%"');
    }
    ok(/Desi Ghee Atta Biscuits/.test(new JSDOM(fs.readFileSync(path.join(SITE, 'shop.html'), 'utf8')).window.document.title), 'shop title has "Desi Ghee Atta Biscuits"');
    ok(/No Maida Biscuits/.test(new JSDOM(fs.readFileSync(path.join(SITE, 'maida-free-cookies-guide.html'), 'utf8')).window.document.title), 'guide title has "No Maida Biscuits"');
  }

  console.log(`website-growth-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
