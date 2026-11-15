// Checks the real photos used in customer emails exist on the site with the right size.
const fs = require('fs');
const path = require('path');
const SITE_DIR = process.env.SITE_DIR || path.resolve(__dirname, '../../../munchingo-website');
const img = (n) => path.join(SITE_DIR, 'images', n);

function jpegSize(file) {
  const b = fs.readFileSync(file);
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

let fail = 0;
const ok = (c, msg) => { if (!c) { fail++; console.log('FAIL ' + msg); } else console.log('ok   ' + msg); };

for (const n of ['confirmed', 'packed', 'shipped', 'delivered', 'review', 'range']) {
  const f = img(`email-hero-${n}.jpg`);
  if (!fs.existsSync(f)) { ok(false, `email-hero-${n}.jpg exists`); continue; }
  const s = jpegSize(f);
  ok(s && s.w === 1200 && s.h === 600, `email-hero-${n}.jpg is a 1200x600 JPEG`);
  ok(fs.statSync(f).size < 250000, `email-hero-${n}.jpg under 250,000 bytes`);
}
const set = img('email-set.jpg'), orig = img('email-original.jpg');
if (!fs.existsSync(set)) ok(false, 'email-set.jpg exists');
else {
  const a = jpegSize(set), b = jpegSize(orig);
  ok(a && b && a.w === b.w && a.h === b.h, 'email-set.jpg matches email-original.jpg size');
}
if (fail) { console.log(`${fail} FAILED`); process.exit(1); }
console.log('all passed');
