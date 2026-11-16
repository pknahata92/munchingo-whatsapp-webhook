'use strict';
// The admin follows the device's light/dark setting until the owner flips the switch. Every dark rule must therefore exist twice:
// under the media query (unless the page is forced light) and under [data-theme="dark"] (when forced dark).   node scripts/admin-theme-test.js
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');
const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const AUTO = ':root:not([data-theme="light"])', FORCED = ':root[data-theme="dark"]';
const blocks = []; const re = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/g; let m;
while ((m = re.exec(css))) { let i = re.lastIndex, d = 1; while (d && i < css.length) { const ch = css[i++]; if (ch === '{') d++; else if (ch === '}') d--; } blocks.push(css.slice(re.lastIndex, i - 1)); }
const rules = (txt) => { const out = []; const r = /([^{}]+)\{([^{}]*)\}/g; let x; while ((x = r.exec(txt))) out.push({ sel: x[1].trim(), body: x[2].trim().replace(/;$/, '') }); return out; };
ok(blocks.length >= 4, 'the page has its dark rules (found ' + blocks.length + ' blocks)');
const outside = rules(css.replace(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/g, '@@DARK{').replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, ''));
const forced = outside.filter((r) => r.sel.indexOf(FORCED) >= 0);
blocks.forEach((b, n) => rules(b).forEach((r) => {
  const parts = r.sel.split(',').map((s) => s.trim());
  ok(parts.every((p) => p.startsWith(AUTO)), 'dark block ' + n + ': "' + r.sel.slice(0, 60) + '" is switched off when the page is forced light');
  const want = parts.map((p) => p.replace(AUTO, FORCED)).join(',');
  ok(forced.some((f) => f.sel.split(',').map((s) => s.trim()).join(',') === want && f.body === r.body), 'dark block ' + n + ': "' + r.sel.slice(0, 60) + '" has its forced-dark twin');
}));
ok(/<script>[^<]*mun_admin_theme[^<]*data-theme/.test(html.slice(0, html.indexOf('</head>') + 7)), 'the saved choice is applied in the head, before the page paints (no flash)');
ok(/id="themeBtn"/.test(html) && /role="switch"/.test(html.slice(html.indexOf('id="themeBtn"') - 80, html.indexOf('id="themeBtn"') + 200)), 'the header has the light/dark switch');
console.log(`admin-theme-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
