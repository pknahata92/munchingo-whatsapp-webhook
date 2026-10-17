'use strict';
/**
 * Click-through test of the admin page in a simulated browser (jsdom) against the practice admin (fake data, no database).
 *   npm install --no-save jsdom@24     (once; never committed)
 *   node scripts/admin-ui-test.js
 * It starts scripts/admin-dev.js itself, signs in as the owner and as staff, and drives the real page.
 */
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require('jsdom')); } catch (e) { console.log('jsdom is not installed: run  npm install --no-save jsdom@24'); process.exit(2); }

const BASE = 'http://localhost:8430';
const CODE_FILE = '/tmp/admin-dev-code.txt';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, what = 'condition') { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch (e) { /* keep waiting */ } await sleep(60); } throw new Error('Timed out waiting for ' + what); }

async function tokenFor(email) {
  await fetch(BASE + '/admin/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  await sleep(250);
  const code = fs.readFileSync(CODE_FILE, 'utf8').trim();
  const r = await (await fetch(BASE + '/admin/api/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code }) })).json();
  if (!r.ok) throw new Error('could not sign in as ' + email);
  return r.token;
}

// Opens the admin page as `role`, already signed in. `size` is the window width in px (default phone).
async function openAdmin(role, { width = 390 } = {}) {
  const token = await tokenFor(role === 'owner' ? 'owner@example.com' : 'staff@example.com');
  const errors = []; const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errors.push(String(e.message || e))); vc.on('error', (e) => errors.push(String(e)));
  const dom = await JSDOM.fromURL(BASE + '/admin', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
      win.fetch = (u, o) => fetch(new URL(u, BASE), o);
      win.confirm = () => true; win.prompt = (m, d) => (d == null ? '' : String(d)); win.alert = () => {};
      win.innerWidth = width; win.URL.createObjectURL = () => 'blob:test'; win.URL.revokeObjectURL = () => {};
      win.localStorage.setItem('mngAdminToken', token);
      win.HTMLElement.prototype.scrollIntoView = () => {};
    },
  });
  const win = dom.window, doc = win.document;
  const q = (s) => doc.querySelector(s), qa = (s) => Array.from(doc.querySelectorAll(s));
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const click = (el) => { if (!el) throw new Error('nothing to click'); el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true })); };
  const byText = (sel, re) => qa(sel).find((e) => re.test(text(e)));
  const set = (el, v) => { el.value = v; el.dispatchEvent(new win.Event('input', { bubbles: true })); el.dispatchEvent(new win.Event('change', { bubbles: true })); };
  await until(() => qa('#list .card').length > 0, 8000, 'the order list');
  return { win, doc, q, qa, text, click, byText, set, errors, until, close: () => dom.window.close() };
}

async function main() {
  const dev = spawn(process.execPath, [path.join(__dirname, 'admin-dev.js')], { stdio: 'ignore' });
  try {
    await until(async () => (await fetch(BASE + '/admin')).ok, 10000, 'the practice admin to start');
    const o = await openAdmin('owner');
    const { q, qa, text, click, byText, set } = o;

    // ── baseline: what must keep working through the redesign ──
    ok(qa('#flow .step').length === 4, 'four step buttons');
    const count = (re) => Number(text(byText('#flow .step', re).querySelector('b')));
    const topack0 = count(/To pack/), packed0 = count(/Packed/);
    ok(topack0 >= 1, 'practice data has an order to pack');
    click(byText('#flow .step', /Packed/)); await sleep(100);
    ok(qa('#list .card').every((c) => /PACKED/.test(text(c))) && qa('#list .card').length === packed0, 'the Packed step lists only packed orders [' + qa('#list .card').map((c) => text(c).slice(0, 60)).join(' || ') + '] expected ' + packed0);
    click(byText('#flow .step', /To pack/)); await sleep(100);
    const firstId = text(q('#list .card .top span')).match(/MNG-[A-Z0-9]+-\d+/)[0];
    set(q('#q'), 'ZZZ-no-such-order'); await sleep(100); ok(qa('#list .card').length === 0, 'search narrows the list to nothing');
    set(q('#q'), firstId); await sleep(100); ok(qa('#list .card').length === 1, 'search finds one order by number (' + firstId + ', cards ' + qa('#list .card').length + ', filter ' + text(q('#hint')).slice(0, 30) + ')');
    click(q('#list .card')); await until(() => q('#sheet.on'), 3000, 'the order sheet'); ok(/Ship to/.test(text(q('#panel'))), 'a card opens the order with its details');
    click(byText('#panel button', /^Close$/)); await sleep(100); set(q('#q'), '');
    click(byText('#list .card button', /Mark packed/)); await until(async () => count(/Packed/) === packed0 + 1, 4000, 'order to move to Packed');
    ok(count(/To pack/) === topack0 - 1, 'Mark packed on a card moves the order from To pack to Packed');
    ok(o.errors.length === 0, 'no page errors in the baseline (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();

    // ── later tasks add their checks below ──
    for (const check of require('./admin-ui-checks')({ openAdmin, ok, sleep, until, BASE })) await check();
  } finally { dev.kill(); }
  console.log(`admin-ui-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
