'use strict';
// Both guides are easy to find (Prashant, 16 Nov): every footer links the label guide AND the palm-oil guide,
// and each product page links them from its approved "What you pay for" line without changing a word.
// Static check only: no scripts run, no network.
//   SITE_DIR=<absolute path to website> node scripts/website-guide-links-test.js
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) { console.log('jsdom is not installed: run  npm install --no-save jsdom@24'); process.exit(1); }
const fs = require('fs'), path = require('path');
const SITE = process.env.SITE_DIR || path.resolve(__dirname, '../../../munchingo-website');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const MAIDA = 'maida-free-cookies-guide.html', PALM = 'how-to-spot-palm-oil.html';
const doc = (f) => new JSDOM(fs.readFileSync(path.join(SITE, f), 'utf8')).window.document;
const pages = fs.readdirSync(SITE).filter((f) => f.endsWith('.html'));

// 1. every page with the site footer lists both guides in the Company column, side by side
let footers = 0;
for (const f of pages) {
  const d = doc(f);
  const company = [...d.querySelectorAll('footer h5')].find((h) => norm(h.textContent) === 'Company');
  if (!company) continue;
  footers++;
  const ul = company.closest('div').parentElement.querySelector('ul');
  const hrefs = [...ul.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  const i = hrefs.indexOf(MAIDA), j = hrefs.indexOf(PALM);
  ok(i >= 0, f + ': footer links the label guide');
  ok(j >= 0, f + ': footer links the palm-oil guide');
  ok(j === i + 1, f + ': palm-oil guide sits right after the label guide');
  const palm = ul.querySelector('a[href="' + PALM + '"]');
  ok(palm && norm(palm.textContent) === 'Palm oil guide', f + ': palm-oil link reads "Palm oil guide"');
}
ok(footers >= 18, 'footer found on at least 18 pages (found ' + footers + ')');

// 2. product pages: the approved line keeps its exact words; "No maida" and "no palm oil" become the links
const LINES = {
  'atta-original.html': 'What you pay for: pure desi ghee, whole wheat flour and cardamom. No maida, no palm oil. Turn any biscuit pack over and read the first three ingredients.',
  'atta-kesari.html': 'What you pay for: pure desi ghee, whole wheat flour and real saffron. No maida, no palm oil. Turn any biscuit pack over and read the first three ingredients.',
  'atta-ajwain.html': 'What you pay for: pure desi ghee, whole wheat flour and ajwain. No maida, no palm oil. Turn any biscuit pack over and read the first three ingredients.',
  'atta-lite-sugar.html': 'What you pay for: pure desi ghee and whole wheat flour, sweetened with maltitol. No maida, no palm oil. Turn any biscuit pack over and read the first three ingredients.',
};
for (const [f, words] of Object.entries(LINES)) {
  const d = doc(f);
  const p = [...d.querySelectorAll('p.v2-sub')].find((x) => norm(x.textContent).startsWith('What you pay for:'));
  ok(p, f + ': has the "What you pay for" line');
  if (!p) continue;
  ok(norm(p.textContent) === words, f + ': words unchanged (got "' + norm(p.textContent) + '")');
  const links = [...p.querySelectorAll('a')].map((a) => [norm(a.textContent), a.getAttribute('href')]);
  ok(JSON.stringify(links) === JSON.stringify([['No maida', MAIDA], ['no palm oil', PALM]]), f + ': links are No maida -> label guide, no palm oil -> palm-oil guide (got ' + JSON.stringify(links) + ')');
}

// 3. the targets exist and stay in the sitemap; the palm-oil guide is no longer reachable from one page only
ok(fs.existsSync(path.join(SITE, MAIDA)) && fs.existsSync(path.join(SITE, PALM)), 'both guide pages exist');
const sitemap = fs.readFileSync(path.join(SITE, 'sitemap.xml'), 'utf8');
ok(sitemap.includes('/maida-free-cookies-guide<') && sitemap.includes('/how-to-spot-palm-oil<'), 'both guides stay in the sitemap');
const inbound = pages.filter((f) => f !== PALM && fs.readFileSync(path.join(SITE, f), 'utf8').includes('href="' + PALM + '"')).length;
ok(inbound >= 18, 'palm-oil guide linked from at least 18 other pages (found ' + inbound + ')');

console.log('website-guide-links: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
