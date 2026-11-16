'use strict';
// Our Story goes live (Prashant, 17 Nov 2026): approved words, findable by Google and from the menu, a real photo,
// the site's current header, nothing dated on the page. Static check only: no scripts run, no network.
//   SITE_DIR=<absolute path to website> node scripts/website-our-story-test.js
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) { console.log('jsdom is not installed: run  npm install --no-save jsdom@24'); process.exit(1); }
const fs = require('fs'), path = require('path');
const SITE = process.env.SITE_DIR || path.resolve(__dirname, '../../../munchingo-website');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const read = (f) => fs.readFileSync(path.join(SITE, f), 'utf8');
const doc = (f) => new JSDOM(read(f)).window.document;

const TITLE = 'Why We Started Munchingo | Bikaner Atta Biscuits';
const DESC = 'How Munchingo began: atta biscuits from Bikaner, made the way we grew up eating them. Desi ghee and whole wheat flour, no maida, no palm oil.';
const d = doc('our-story.html');
const meta = (sel) => (d.querySelector(sel) || { getAttribute: () => null }).getAttribute('content');

// 1. Google can index it, with the approved title and snippet everywhere they are shown
ok(!/noindex/i.test(meta('meta[name="robots"]') || ''), 'no noindex on our-story');
ok(!/DRAFT/.test(read('our-story.html')), 'no DRAFT marker left in the page');
ok(norm(d.title) === TITLE, 'title is the approved one (got "' + norm(d.title) + '")');
ok(TITLE.length <= 60, 'title fits in 60 characters');
for (const sel of ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) ok(meta(sel) === DESC, sel + ' is the approved snippet (got "' + meta(sel) + '")');
for (const sel of ['meta[property="og:title"]', 'meta[name="twitter:title"]']) ok(meta(sel) === TITLE, sel + ' is the approved title');
ok(DESC.length <= 160, 'snippet fits in 160 characters');
ok(meta('meta[property="og:type"]') === 'article', 'og:type is article');
ok((d.querySelector('link[rel="canonical"]') || {}).href === 'https://munchingo.com/our-story', 'canonical is https://munchingo.com/our-story');
ok(read('sitemap.xml').includes('<loc>https://munchingo.com/our-story</loc>'), 'our-story is in the sitemap');

// 2. approved words: four changes made, the rest kept
const art = d.querySelector('article.pg-article');
ok(art, 'article.pg-article exists');
const text = norm(art && art.textContent);
ok(norm((art.querySelector('.meta') || {}).textContent) === 'By Prashant Nahata, Munchingo', 'byline has no date');
ok(!/\b(19|20)\d\d\b/.test(text) && !/\b\d{1,2} (january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(text), 'no date or year anywhere in the article text');
ok(text.includes('we have been fed home-baked atta biscuits by our grandmothers'), '"home-baked" replaces "handmade"');
ok(!/hand-?made/i.test(read('our-story.html')), 'no "handmade" anywhere in the page, snippet included');
ok([...art.querySelectorAll('h2')].map((h) => norm(h.textContent)).includes('Tasty first, made better underneath'), 'heading is "Tasty first, made better underneath"');
ok(!/better for you/i.test(text), 'no "better for you"');
ok(text.includes('Nothing in the list should make you think twice, and you can check that yourself'), 'gut line replaced by "think twice"');
ok(!/\bgut\b/i.test(text), 'no "gut"');
ok(text.includes('with no maida, no palm oil and no preservatives'), '"no preservatives" kept (Prashant, 16 Nov)');
ok(text.includes('Munchingo does not stand for "healthy"'), 'the "healthy" denial is kept');

// 3. links: palm oil guide from the body, label guide, products; menu "Our story" opens this page on every page
const links = [...art.querySelectorAll('a')].map((a) => [norm(a.textContent), a.getAttribute('href')]);
ok(links.some(([t, h]) => t === 'no palm oil' && h === 'how-to-spot-palm-oil.html'), '"no palm oil" links to the palm-oil guide');
ok(links.some(([t, h]) => t === 'label guide' && h === 'maida-free-cookies-guide.html'), '"label guide" still links to the label guide');
let menus = 0;
for (const f of fs.readdirSync(SITE).filter((x) => x.endsWith('.html'))) {
  const nav = doc(f).querySelector('nav.v2-header ul');
  if (!nav) continue;
  menus++;
  const story = [...nav.querySelectorAll('a')].find((a) => norm(a.textContent) === 'Our story');
  ok(story && story.getAttribute('href') === 'our-story.html', f + ': menu "Our story" opens our-story.html');
}
ok(menus >= 18, 'menu found on at least 18 pages (found ' + menus + ')');
const nav = (f) => norm(doc(f).querySelector('nav.v2-header').outerHTML);
ok(nav('our-story.html') === nav('about.html'), 'our-story has the same header as the rest of the site');
const css = read('css/style.css');
ok(/\.pg-article a\{[^}]*text-decoration:underline/.test(css), 'article links are styled (underlined, brand colour)');

// 4. a real photo, sized, described
const img = art.querySelector('figure img');
ok(img, 'the article has a photo');
if (img) {
  const src = img.getAttribute('src');
  ok(src === 'images/bikaner-baking.webp' && fs.existsSync(path.join(SITE, src)), 'photo is images/bikaner-baking.webp (Bikaner shoot, photo 6) and exists');
  ok(fs.existsSync(path.join(SITE, src)) && fs.statSync(path.join(SITE, src)).size < 200 * 1024, 'photo file under 200 KB');
  ok(+img.getAttribute('width') > 0 && +img.getAttribute('height') > 0, 'photo has width and height');
  ok(norm(img.getAttribute('alt')).length >= 20, 'photo has a real alt text');
}

// 5. schema: Article with the photo, an author, dates that parse
const ld = [...d.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent));
const graph = ld.flatMap((j) => j['@graph'] || [j]);
const a = graph.find((x) => x['@type'] === 'Article');
ok(a && a.author && a.author.name === 'Prashant Nahata', 'Article schema with author');
ok(a && /bikaner-baking\.webp$/.test(String(a.image)), 'Article schema image is the photo');
ok(!/family-thali/.test(read('our-story.html')), 'no family photo on the page (Prashant, 17 Nov: family members)');
ok(meta('meta[property="og:image"]') === 'https://munchingo.com/images/bikaner-baking.jpg' && fs.existsSync(path.join(SITE, 'images/bikaner-baking.jpg')), 'share image is images/bikaner-baking.jpg and exists');
ok(a && a.headline === 'Why we started Munchingo', 'Article headline unchanged');
ok(a && !isNaN(Date.parse(a.datePublished)) && Date.parse(a.dateModified) >= Date.parse(a.datePublished), 'Article dates parse and modified >= published');

console.log('website-our-story: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
