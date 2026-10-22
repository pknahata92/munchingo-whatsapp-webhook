'use strict';
// The real review page (munchingo-website/review.html): star rows per flavour, the submit gate, what is sent, and the
// thank-you with the Google link for every reviewer.   npm install --no-save jsdom@24   then   node scripts/review-page-test.js
let JSDOM, ResourceLoader;
try { ({ JSDOM, ResourceLoader } = require('jsdom')); } catch (e) { console.log('jsdom is not installed: run  npm install --no-save jsdom@24'); process.exit(1); }
const fs = require('fs'), path = require('path');
const SITE = process.env.SITE_DIR || path.resolve(__dirname, '../../../munchingo-website');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const GOOGLE = 'https://g.page/r/CThPt_VWhjZkEAI/review';

class Local extends ResourceLoader {   // local scripts from the site folder; nothing leaves the machine
  fetch(url) {
    const u = new URL(url);
    if (u.hostname !== 'localhost') return Promise.resolve(Buffer.from(''));
    const f = path.join(SITE, decodeURIComponent(u.pathname));
    return Promise.resolve(fs.existsSync(f) ? fs.readFileSync(f) : Buffer.from(''));
  }
}

async function open({ form, post }) {
  const file = path.join(SITE, 'review.html');
  if (!fs.existsSync(file)) { ok(false, 'review.html exists in ' + SITE); return null; }
  const sent = [];
  const dom = new JSDOM(fs.readFileSync(file, 'utf8'), {
    url: 'http://localhost/review.html?t=TOKEN123', runScripts: 'dangerously', resources: new Local(), pretendToBeVisual: true,
    beforeParse(w) {
      w.scrollTo = () => {};
      w.fetch = (u, o) => {
        const U = String(u);
        if (!/\/api\/review\/TOKEN123$/.test(U)) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
        if (o && o.method === 'POST') { sent.push(JSON.parse(o.body)); return Promise.resolve({ ok: post.status < 300, status: post.status, json: async () => post.body }); }
        return Promise.resolve({ ok: form.status < 300, status: form.status, json: async () => form.body });
      };
    },
  });
  await wait(900);
  return { w: dom.window, d: dom.window.document, sent, close: () => dom.window.close() };
}
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
const pick = (w, d, slug, n) => { const r = d.querySelector(`input[name="r-${slug}"][value="${n}"]`); r.checked = true; r.dispatchEvent(new w.Event('change', { bubbles: true })); };

(async () => {
  const FLAV = [{ slug: 'atta-original', name: 'Atta Original' }, { slug: 'atta-kesari', name: 'Atta Kesari' }, { slug: 'atta-lite-sugar', name: 'Atta Sugar-Lite' }];
  let p = await open({ form: { status: 200, body: { first: 'Riya', flavours: FLAV, reviewed: false } }, post: { status: 201, body: { ok: true, googleUrl: GOOGLE } } });
  if (!p) { console.log(`review-page-test: ${pass} passed, ${fail} failed`); process.exit(1); }
  const { w, d, sent } = p;
  ok(/noindex/.test((d.querySelector('meta[name="robots"]') || {}).content || ''), 'the page is noindex');
  ok(/Hi Riya, how was your box\?/.test(text(d.body)), 'greets the buyer by first name');
  const sets = Array.from(d.querySelectorAll('fieldset[data-flavour]'));
  ok(sets.length === 3 && ['atta-original', 'atta-kesari', 'atta-lite-sugar'].every((s) => d.querySelectorAll(`input[type=radio][name="r-${s}"]`).length === 5), 'one fieldset with 5 star choices per flavour received');
  const btn = d.querySelector('#rv-submit');
  ok(btn && btn.disabled, 'Submit is disabled before any rating');
  pick(w, d, 'atta-original', 5); pick(w, d, 'atta-kesari', 1); await wait(50);
  ok(btn.disabled, 'still disabled with one flavour unrated');
  pick(w, d, 'atta-lite-sugar', 4); await wait(50);
  ok(!btn.disabled, 'enabled once every flavour is rated');
  ok((d.querySelector('#rv-comment') || {}).maxLength === 500, 'the comment box stops at 500 characters');
  const c = d.querySelector('#rv-comment'); c.value = 'Kesari too sweet'; c.dispatchEvent(new w.Event('input', { bubbles: true }));
  const consent = d.querySelector('#rv-consent'); ok(consent && /You can show my review on munchingo\.com/.test(text(consent.closest('label'))), 'the consent line is the agreed wording');
  consent.checked = true;
  click(w, btn); await wait(400);
  ok(sent.length === 1 && JSON.stringify(sent[0]) === JSON.stringify({ ratings: { 'atta-original': 5, 'atta-kesari': 1, 'atta-lite-sugar': 4 }, comment: 'Kesari too sweet', showAs: 'name', consent: true }), 'what is sent: ' + JSON.stringify(sent[0]));
  const g = d.querySelector('a#rv-google');
  ok(/Thank you\. Would you also leave a word on Google\? It helps other people find us\./.test(text(d.body)), 'the thank-you text');
  ok(g && g.href === GOOGLE && g.target === '_blank' && /noopener/.test(g.rel), 'the Google link is shown even after a 1-star rating, opening in a new tab');
  p.close();

  p = await open({ form: { status: 200, body: { first: 'Riya', flavours: FLAV, reviewed: true } }, post: { status: 409, body: {} } });
  ok(/Thanks, we have your review/.test(text(p.d.body)) && !p.d.querySelector('fieldset[data-flavour]'), 'an already reviewed order shows the thanks, no form');
  p.close();
  p = await open({ form: { status: 404, body: {} }, post: { status: 404, body: {} } });
  ok(/This link doesn't work\. Message us on WhatsApp and we'll sort it out\./.test(text(p.d.body)), 'a bad link shows the WhatsApp line');
  p.close();
  p = await open({ form: { status: 200, body: { first: 'Om', flavours: [FLAV[1]], reviewed: false } }, post: { status: 409, body: { error: 'Thanks, we have your review.' } } });
  pick(p.w, p.d, 'atta-kesari', 5); await wait(50); click(p.w, p.d.querySelector('#rv-submit')); await wait(400);
  ok(/Thanks, we have your review/.test(text(p.d.body)), 'a submit that comes back 409 shows the thanks');
  p.close();

  console.log(`review-page-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
