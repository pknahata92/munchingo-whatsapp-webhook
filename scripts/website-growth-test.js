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
    if (!['localhost', 'www.munchingo.com', 'abc123.munchingo-website.pages.dev'].includes(u.hostname)) return Promise.resolve(Buffer.from(''));
    const f = path.join(SITE, decodeURIComponent(u.pathname));
    return Promise.resolve(fs.existsSync(f) ? fs.readFileSync(f) : Buffer.from(''));
  }
}
const json = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const page = (file, url, handler) => new JSDOM(fs.readFileSync(path.join(SITE, file), 'utf8'), {
  url: /^https?:/.test(url || '') ? url : 'http://localhost/' + (url || file), runScripts: 'dangerously', resources: new Local(), pretendToBeVisual: true,
  beforeParse(w) {
    w.scrollTo = () => {}; w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    // every call is stubbed: only what the handler answers comes back, everything else is a 404
    w.fetch = (u, o) => { const r = handler && handler(String(u), o || {}); return r || Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' }); };
    if (global.PRESET_SOLDOUT) w.localStorage.setItem('munchingo_soldout', JSON.stringify(global.PRESET_SOLDOUT));
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

  // 3. pincode outside the area: the note gets a "notify" link. The live /api/pincode outside answer carries NO city
  //    (routes/checkout.js), so the city comes from India Post (A8 fix 11); if India Post fails too, the pincode.
  const OUTSIDE = (pin) => json({ ok: true, pin, valid: true, serviceable: false, outside: true, message: 'We’re delivering in Delhi NCR only.' });
  const POST = (district) => json([{ Message: 'Number of pincode(s) found:1', Status: 'Success', PostOffice: [{ Name: 'Jaipur G.P.O.', District: district, State: 'Rajasthan' }] }]);
  const IP = /api\.postalpincode\.in\/pincode\//;
  for (const c of [{ pin: '302001', post: () => POST('Jaipur'), want: 'Jaipur' }, { pin: '302001', post: () => null, want: '302001' },
    { pin: '302001', post: () => json([{ Message: 'No records found', Status: 'Error', PostOffice: null }]), want: '302001' }, { pin: '302001', post: () => Promise.reject(new Error('offline')), want: '302001' }]) {
    const dom = page('atta-original.html', 'atta-original.html', (U) => /\/api\/pincode\//.test(U) ? OUTSIDE(c.pin) : IP.test(U) ? c.post() : null);
    const w = dom.window, d = w.document; await wait(1200);
    const inp = d.querySelector('.pc-in'), msg = d.querySelector('.pc-msg');
    inp.value = c.pin; inp.dispatchEvent(new w.Event('input', { bubbles: true })); await wait(500);
    const a = msg.querySelector('a');
    ok(a && norm(a.textContent) === 'Tell me when you deliver to ' + c.want, 'outside answer shows "Tell me when you deliver to ' + c.want + '" (got: ' + (a && norm(a.textContent)) + ')');
    ok(a && a.getAttribute('href') === WA + '?text=' + encodeURIComponent('NOTIFY - ' + c.want), 'notify link goes to wa.me with NOTIFY - ' + c.want + ' (got: ' + (a && a.getAttribute('href')) + ')');
    ok(/Delhi NCR only/.test(msg.textContent), 'the backend message is still shown');
    w.close();
  }
  // a hostile city name (from India Post) is escaped in the text and encoded in the href
  for (const city of ['<img src=x onerror=alert(1)>', 'Ja"ipur']) {
    const dom = page('atta-original.html', 'atta-original.html', (U) => /\/api\/pincode\//.test(U) ? OUTSIDE('302001') : IP.test(U) ? POST(city) : null);
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
  // checkout: the status line's notify link names the city India Post gave checkout (ip.district), even when js/pincode.js's own
  // India Post call fails; with no India Post answer at all, the pincode
  for (const c of [{ answers: ['ok', 'fail'], want: 'Jaipur' }, { answers: ['ok', 'ok'], want: 'Jaipur' }, { answers: ['fail', 'fail'], want: '302001' }]) {
    let ipCalls = 0;
    const dom = page('checkout.html', 'checkout.html', (U) => {
      if (/\/api\/pincode\//.test(U)) return OUTSIDE('302001');
      if (IP.test(U)) return c.answers[ipCalls++] === 'ok' ? POST('Jaipur') : null;
      return null;
    });
    const w = dom.window, d = w.document; await wait(1200);
    const pinEl = d.getElementById('ck-addr-pincode');
    pinEl.value = '302001'; pinEl.dispatchEvent(new w.Event('input', { bubbles: true })); await wait(800);
    const st = d.getElementById('ck-pin-status'), a = st && st.querySelector('a');
    ok(a && norm(a.textContent) === 'Tell me when you deliver to ' + c.want, 'checkout outside NCR (India Post ' + c.answers.join('/') + '): "Tell me when you deliver to ' + c.want + '" (got: ' + (st && norm(st.textContent)) + ')');
    ok(a && a.getAttribute('href') === WA + '?text=' + encodeURIComponent('NOTIFY - ' + c.want), 'checkout notify link: NOTIFY - ' + c.want + ' (got: ' + (a && a.getAttribute('href')) + ')');
    ok(w.__pinBlocked === true && /Delhi NCR only/.test(st.textContent), 'checkout: still blocked, the backend message still shown');
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

  // 5. palm-oil label guide (task B3): the page, the guide link, the sitemap, Organization and WebSite schema
  {
    const read = (f) => fs.readFileSync(path.join(SITE, f), 'utf8');
    const TITLE = 'How to Spot Palm Oil on a Biscuit Label | Munchingo';
    const DESC = 'Turn the pack over. Ingredients are listed from most to least by weight, so the first three tell you what you are mostly eating.';
    const PARAS = [
      'Turn the pack over. The front of a box is designed; the ingredient list is not. Ingredients are listed from most to least by weight, so the first three tell you what you are mostly eating.',
      'Step 1: Find the fat. In most biscuits it is the second or third ingredient, right after the flour and often before or after the sugar.',
      'Step 2: Read its name. These words mean palm or a fat made from it: palm oil, palmolein, edible vegetable oil (palm), vegetable fat, hydrogenated vegetable oil, vanaspati, interesterified vegetable fat. If the list only says "vegetable oil" or "vegetable fat", look for the oil\'s name in brackets.',
      'Step 3: Read the flour too. "Refined wheat flour" is maida. "Whole wheat flour" is atta.',
      'What is in ours: whole wheat flour and pure desi ghee. No maida, no palm oil. Baked in Bikaner.',
      'Questions people ask',
      'Is "edible vegetable oil" palm oil? It can be. It is a family of oils, so look for the name of the oil in brackets after it.',
      'What does "refined wheat flour" mean? That is maida, the white flour most biscuits start with.',
      'Why desi ghee? For taste. Desi ghee is what an atta biscuit made at home tastes of.',
      'Does no palm oil make a biscuit good for you? It is still a biscuit, with sugar and ghee. "No palm oil" tells you what is in the pack. It is not a health promise.',
      'See all four Flavors.',
    ];
    const F = 'how-to-spot-palm-oil.html';
    ok(fs.existsSync(path.join(SITE, F)), F + ' exists');
    if (fs.existsSync(path.join(SITE, F))) {
      const html = read(F), d = new JSDOM(html).window.document;
      const meta = (sel) => { const e = d.querySelector(sel); return e && e.getAttribute('content'); };
      ok(d.title === TITLE, 'palm page title is the ruled text (got: ' + d.title + ')');
      ok(!/Task \d|this task's file list/.test(html), 'palm page carries no build-process comment (public HTML, A8 fix 12)');
      ok(meta('meta[name="description"]') === DESC && meta('meta[property="og:description"]') === DESC && meta('meta[name="twitter:description"]') === DESC, 'palm page description, og and twitter descriptions are the ruled text');
      ok(meta('meta[property="og:title"]') === TITLE && meta('meta[name="twitter:title"]') === TITLE, 'palm page og:title and twitter:title match the title');
      ok(d.querySelector('link[rel="canonical"]') && d.querySelector('link[rel="canonical"]').getAttribute('href') === 'https://munchingo.com/how-to-spot-palm-oil', 'palm page canonical is https://munchingo.com/how-to-spot-palm-oil');
      const h1s = d.querySelectorAll('h1');
      ok(h1s.length === 1 && norm(h1s[0].textContent) === 'How to spot palm oil on a biscuit label', 'palm page has one H1 with the approved words');
      const art = d.querySelector('article') || d.body, text = norm(art.textContent);
      const pageText = norm(d.body.textContent);
      PARAS.forEach((p) => ok(pageText.includes(p), 'palm page shows approved text: ' + p.slice(0, 50)));
      const qs = [...d.querySelectorAll('h2,h3,h4,summary,dt')].map((e) => norm(e.textContent));
      ['Is "edible vegetable oil" palm oil?', 'What does "refined wheat flour" mean?', 'Why desi ghee?', 'Does no palm oil make a biscuit good for you?'].forEach((q) => ok(qs.includes(q), 'palm page question is a visible heading: ' + q));
      const hrefs = [...art.querySelectorAll('a')].map((a) => a.getAttribute('href'));
      const seeAll = [...art.querySelectorAll('a')].find((a) => norm(a.textContent) === 'See all four Flavors.');
      ok(seeAll && seeAll.getAttribute('href') === 'shop.html', 'palm page: "See all four Flavors." links to shop.html');
      ok(hrefs.includes('shop.html'), 'palm page links to shop.html');
      [['atta-original.html', 'Atta Original'], ['atta-kesari.html', 'Atta Kesari'], ['atta-ajwain.html', 'Atta Ajwain'], ['atta-lite-sugar.html', 'Atta Sugar-Lite']].forEach(([h, n]) => {
        const a = [...art.querySelectorAll('a')].find((x) => x.getAttribute('href') === h);
        ok(a && norm(a.textContent) === n, 'palm page links ' + h + ' with the text ' + n + ' (got: ' + (a && norm(a.textContent)) + ')');
      });
      ok(!/\b(Britannia|Parle|Sunfeast|Haldiram|Bikanervala|McVitie)\b/i.test(html), 'palm page names no competitor brand');
      ok(!/100\s*%/.test(html) && !/\bhealthy\b/i.test(html), 'palm page has no "100%" and no "healthy"');
      ok(!/Faridabad/i.test(html) && !/gift box/i.test(html), 'palm page has no Faridabad and no "gift box"');
      ok(!/FAQPage/.test(html), 'palm page has no FAQPage markup (R33)');
      // same shell as the guide: the same stylesheet and script versions
      const g = read('maida-free-cookies-guide.html');
      ['css/style.css?v=', 'js/cart.js?v=', 'js/prices.js?v=', 'js/minicart.js?v='].forEach((k) => {
        const m = (h) => { const i = h.indexOf(k); return i < 0 ? null : h.slice(i, h.indexOf('"', i)); };
        ok(m(html) && m(html) === m(g), 'palm page uses the same ' + k + ' version as the guide');
      });
    }
    // the guide links to it, once, with the exact anchor text
    {
      const d = new JSDOM(read('maida-free-cookies-guide.html')).window.document;
      const links = [...d.querySelectorAll('article a')].filter((a) => /how-to-spot-palm-oil/.test(a.getAttribute('href')));
      ok(links.length === 1 && norm(links[0].textContent) === 'How to spot palm oil on a biscuit label', 'the guide has one link to the palm-oil page with the exact anchor text');
    }
    // the sitemap lists it
    ok(/<loc>https:\/\/munchingo\.com\/how-to-spot-palm-oil<\/loc>/.test(read('sitemap.xml')), 'sitemap.xml lists the palm-oil page');
    // index.html: exactly one Organization and one WebSite, no address, no SearchAction
    {
      const html = read('index.html'), d = new JSDOM(html).window.document;
      const blocks = [...d.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent));
      const nodes = []; const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (o['@type']) nodes.push(o); if (o['@graph']) walk(o['@graph']); } };
      blocks.forEach(walk);
      const orgs = nodes.filter((n) => n['@type'] === 'Organization'), sites = nodes.filter((n) => n['@type'] === 'WebSite');
      ok(orgs.length === 1, 'index.html has exactly one Organization (got ' + orgs.length + ')');
      ok(sites.length === 1, 'index.html has exactly one WebSite (got ' + sites.length + ')');
      const o = orgs[0] || {}, s = sites[0] || {};
      ok(o.name === 'Munchingo' && o.url === 'https://munchingo.com/', 'Organization has name Munchingo and url https://munchingo.com/');
      ok(o.logo === 'https://munchingo.com/images/logo-gold-v2.png', 'Organization logo is the site logo image');
      ok(JSON.stringify(o.sameAs) === JSON.stringify(['https://www.instagram.com/munchingo.india']), 'Organization sameAs is the Instagram URL the site links');
      ok(!('address' in o) && !('telephone' in o) && !/Faridabad/i.test(JSON.stringify(blocks)), 'Organization has no address, no phone, no Faridabad');
      ok(s.name === 'Munchingo' && s.url === 'https://munchingo.com/' && !('potentialAction' in s), 'WebSite has name and url only, no SearchAction');
    }
  }

  // 6. task B4: product pages show "Now shipping: baked <D> <Month>" from /api/stock packing. Stubbed fetch only.
  {
    const stock = (extra) => (U) => /\/api\/stock/.test(U) ? json(Object.assign({ ok: true, soldOut: [] }, extra)) : null;
    const LIVE = 'https://www.munchingo.com/';   // cart.js only talks to /api/stock on the real domain
    let stockCalls = 0;
    const probe = async (file, handler, host) => {
      const errors = []; stockCalls = 0;
      const counted = handler && ((U, o) => { if (/\/api\/stock/.test(U)) stockCalls++; return handler(U, o); });
      const dom = page(file, (host || LIVE) + file, counted);
      dom.window.addEventListener('error', (e) => errors.push(e.message));
      const d = dom.window.document; await wait(900);
      const el = d.querySelector('.pdp-baked');
      const r = { dom, el, calls: () => stockCalls, visible: !!el && !el.hidden, text: el ? norm(el.textContent) : null, errors, d };
      return r;
    };
    // exists on all four pages, hidden by default, after Add to bag, before the minimum-order strip, never inside the price row
    for (const f of ['atta-original.html', 'atta-kesari.html', 'atta-ajwain.html', 'atta-lite-sugar.html']) {
      const d = new JSDOM(fs.readFileSync(path.join(SITE, f), 'utf8')).window.document;
      const el = d.querySelectorAll('.pdp-baked');
      ok(el.length === 1 && el[0].hidden && norm(el[0].textContent) === '', f + ' has one empty hidden .pdp-baked line');
      ok(el.length === 1 && !!(d.getElementById('add').compareDocumentPosition(el[0]) & 4) && !!(el[0].compareDocumentPosition(d.querySelector('.v2-mov')) & 4), f + ' the baked line sits after Add to bag (CTA does not drop, R31)');
    }
    const cases = [
      ['atta-kesari.html', { packing: { 'atta-kesari': '2026-11-20' } }, 'Now shipping: baked 20 November'],
      ['atta-original.html', { packing: { 'atta-original': '2026-12-05' } }, 'Now shipping: baked 5 December'],
      ['atta-ajwain.html', { packing: { 'atta-ajwain': '2026-01-01' } }, 'Now shipping: baked 1 January'],
      ['atta-lite-sugar.html', { packing: { 'atta-lite-sugar': '2026-11-20' } }, 'Now shipping: baked 20 November'],
      ['atta-kesari.html', { packing: { 'atta-kesari': '2026-11-20', 'atta-original': '2026-11-01' } }, 'Now shipping: baked 20 November'],
    ];
    for (const [f, extra, want] of cases) {
      const r = await probe(f, stock(extra));
      ok(r.visible && r.text === want, f + ' shows "' + want + '" (got: ' + r.text + ', hidden=' + !r.visible + ')');
      ok(!/\bLOT\b|\bB\d{2}|MUN-/i.test(r.text || ''), f + ' baked line shows no lot code');
      ok(r.errors.length === 0, f + ' no script error with a date (got: ' + r.errors.join('|') + ')');
      r.dom.window.close();
    }
    const hidden = [
      ['field missing', { }],
      ['value null', { packing: { 'atta-kesari': null } }],
      ['slug missing from the map', { packing: { 'atta-original': '2026-11-20' } }],
      ['packing is not an object', { packing: 'x' }],
      ['malformed string', { packing: { 'atta-kesari': 'next week' } }],
      ['impossible date', { packing: { 'atta-kesari': '2026-13-45' } }],
      ['date with extra text', { packing: { 'atta-kesari': '2026-11-20 LOT-ABC' } }],
      ['non-string value', { packing: { 'atta-kesari': 20261120 } }],
    ];
    for (const [name, extra] of hidden) {
      const r = await probe('atta-kesari.html', stock(extra));
      ok(!r.visible && r.text === '', 'baked line stays hidden and empty: ' + name + ' (got: ' + r.text + ', hidden=' + !r.visible + ')');
      ok(r.errors.length === 0, 'no script error: ' + name + ' (got: ' + r.errors.join('|') + ')');
      ok(!!r.d.getElementById('add') && !r.d.getElementById('add').disabled, 'Add to bag still works: ' + name);
      r.dom.window.close();
    }
    for (const [name, h] of [
      ['fetch rejects', (U) => /\/api\/stock/.test(U) ? Promise.reject(new Error('network')) : null],
      ['fetch 500', (U) => /\/api\/stock/.test(U) ? Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => '' }) : null],
      ['body is not JSON', (U) => /\/api\/stock/.test(U) ? Promise.resolve({ ok: true, status: 200, json: async () => { throw new Error('bad json'); }, text: async () => 'x' }) : null],
      ['fetch never answers (timeout)', (U) => /\/api\/stock/.test(U) ? new Promise(() => {}) : null],
    ]) {
      const r = await probe('atta-kesari.html', h);
      ok(!r.visible && r.text === '', 'baked line stays hidden and empty: ' + name);
      ok(r.errors.length === 0, 'no script error: ' + name + ' (got: ' + r.errors.join('|') + ')');
      r.dom.window.close();
    }
    // one request per page on the real domain (cart.js's), none on localhost or a preview, and pdp.js itself never fetches
    {
      let r = await probe('atta-kesari.html', stock({ packing: { 'atta-kesari': '2026-11-20' } }));
      ok(r.calls() === 1, 'on munchingo.com exactly one /api/stock request is made (got ' + r.calls() + ')');
      ok(typeof r.dom.window.MunchingoCart.packingFor === 'function' && r.dom.window.MunchingoCart.packingFor('atta-kesari') === '2026-11-20' && r.dom.window.MunchingoCart.packingFor('atta-original') === null, 'MunchingoCart.packingFor returns the bake date or null');
      r.dom.window.close();
      for (const h of ['http://localhost/', 'https://abc123.munchingo-website.pages.dev/']) {
        r = await probe('atta-kesari.html', stock({ packing: { 'atta-kesari': '2026-11-20' } }), h);
        ok(r.calls() === 0, h + ': no /api/stock request is made (got ' + r.calls() + ')');
        ok(!r.visible && r.text === '', h + ': the baked line stays hidden');
        r.dom.window.close();
      }
    }
    // a sold-out Flavor does not advertise a ship date
    {
      global.PRESET_SOLDOUT = ['atta-kesari'];   // the sold-out list the site remembers from /api/stock
      const r = await probe('atta-kesari.html', stock({ soldOut: ['atta-kesari'], packing: { 'atta-kesari': '2026-11-20' } }));
      global.PRESET_SOLDOUT = null;
      ok(r.d.getElementById('add').disabled && !r.visible, 'a sold-out Flavor keeps the baked line hidden');
      r.dom.window.close();
    }
  }

  console.log(`website-growth-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
