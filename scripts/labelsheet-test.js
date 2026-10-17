'use strict';
// Label sheet layout: 13x19 in, 3x3 cells of 4x6 in, N copies each.   node scripts/labelsheet-test.js
const PDFLib = require('pdf-lib');
const LS = require('../admin/labelsheet');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
async function labels(n, w = 288, h = 432) {
  const d = await PDFLib.PDFDocument.create(); const f = await d.embedFont(PDFLib.StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) { const p = d.addPage([w, h]); p.drawRectangle({ x: 2, y: 2, width: w - 4, height: h - 4, borderWidth: 1, color: PDFLib.rgb(1, 1, 1), borderColor: PDFLib.rgb(0, 0, 0) }); p.drawText('AWB ' + i, { x: 20, y: h - 40, size: 24, font: f }); }
  return d.save();
}
(async () => {
  let r = await LS.build(PDFLib, [await labels(4)], { copies: 2 });
  ok(r.labels === 4 && r.stickers === 8 && r.sheets === 1 && r.perSheet === 9 && r.blank === 1, '13 x 19 holds 9 labels: 4 labels x 2 = 8 stickers on one sheet, 1 spot left');
  let doc = await PDFLib.PDFDocument.load(r.bytes); const s = doc.getPage(0).getSize();
  ok(Math.round(s.width) === 936 && Math.round(s.height) === 1368, 'sheet is 13 x 19 in (936 x 1368 pt)');
  r = await LS.build(PDFLib, [await labels(5)], { copies: 2 });
  ok(r.stickers === 10 && r.sheets === 2, 'copies are packed tight: 10 stickers need 2 sheets (9 + 1)');
  r = await LS.build(PDFLib, [await labels(9)], { copies: 2 });
  ok(r.stickers === 18 && r.sheets === 2 && r.blank === 0, 'no wasted cells by default: 18 stickers fill exactly 2 sheets');
  r = await LS.build(PDFLib, [await labels(9)], { copies: 2, keepTogether: true });
  ok(r.sheets === 3, 'keep-together puts a label\'s copies on one sheet: 4 + 4 + 1 labels over 3 sheets');
  r = await LS.build(PDFLib, [await labels(3), await labels(6)], { copies: 1 });
  ok(r.labels === 9 && r.sheets === 1, 'two files are combined; 9 single labels fill one sheet');
  r = await LS.build(PDFLib, [await labels(2, 432, 288)], { copies: 2 });
  ok(r.sheets === 1 && r.stickers === 4, 'landscape labels are accepted (turned to fit)');
  r = await LS.build(PDFLib, [await labels(1)], { copies: 2, cutLines: false }); ok(r.sheets === 1, 'cut lines can be switched off');
  r = await LS.build(PDFLib, [await labels(1, 595, 842)], { copies: 1 }); ok(r.minScale < 0.95, 'a big source page reports it was shrunk, so the screen can warn');
  r = await LS.build(PDFLib, [await labels(4)], { copies: 1 }); ok(r.minScale === 1, '4 x 6 in labels are never shrunk (Delhivery minimums hold)');
  // packing: more labels per sheet by turning some sideways
  const cnt = (k, m) => { const l = LS.LAYOUTS[k], mm = (m == null ? 0.125 : m) * 72; return LS.pack(l.w - 2 * mm, l.h - 2 * mm); };
  ok(cnt('13x19').length === 9, '13 x 19: 9 labels (the most that fits)');
  ok(cnt('a4').length === 3 && cnt('a4').some((c) => c.turn), 'A4 packed tight: 3 labels, one turned sideways');
  ok(cnt('a3').length === 6 && cnt('a3').some((c) => c.turn), 'A3 packed tight: 6 labels with sideways ones');
  const gr = (k) => { const l = LS.LAYOUTS[k], mm = 9; return LS.grid(l.w - 2 * mm, l.h - 2 * mm); };
  ok(gr('a4').length === 2 && gr('a3').length === 4 && gr('13x19').length === 9 && gr('letter').length === 2, 'straight grid: A4 2, A3 4, 13 x 19 9, Letter 2');
  ok(gr('a4').every((c) => !c.turn) && new Set(gr('a4').map((c) => c.y)).size === 1, 'A4 grid: both labels upright in one straight row');
  ok(cnt('letter').length === 3, 'Letter packed tight: 3 labels');
  ok(cnt('12x18').length >= 6, '12 x 18: at least 6 labels');
  for (const k of ['13x19', 'a3', 'a4', 'letter', '12x18']) {   // no two labels overlap and all sit inside the page
    const l = LS.LAYOUTS[k], cs = cnt(k), mm = 9; let bad = false;
    cs.forEach((c, i) => { if (c.x < -0.01 || c.y < -0.01 || c.x + c.w > l.w - 2 * mm + 0.01 || c.y + c.h > l.h - 2 * mm + 0.01) bad = true; cs.forEach((d, j) => { if (j > i && c.x < d.x + d.w - 0.01 && d.x < c.x + c.w - 0.01 && c.y < d.y + d.h - 0.01 && d.y < c.y + c.h - 0.01) bad = true; }); });
    ok(!bad, k + ': labels do not overlap and stay inside the page');
  }
  r = await LS.build(PDFLib, [await labels(7)], { copies: 1, layout: 'a4' }); ok(r.perSheet === 2 && r.sheets === 4 && r.sideways === 0, 'A4 default: 2 upright labels per sheet in a straight row (7 labels, 4 sheets)');
  r = await LS.build(PDFLib, [await labels(7)], { copies: 1, layout: 'a4', packTight: true }); ok(r.perSheet === 3 && r.sheets === 3 && r.sideways >= 1, 'A4 packed tight: 3 per sheet, 7 labels over 3 sheets');
  r = await LS.build(PDFLib, [await labels(3)], { copies: 1, layout: 'custom', pageW: 8.5, pageH: 12 }); ok(r.perSheet >= 2, 'a custom size works');
  r = await LS.build(PDFLib, [await labels(5)], { copies: 2, layout: 'roll' });
  doc = await PDFLib.PDFDocument.load(r.bytes); let z = doc.getPage(0).getSize();
  ok(r.sheets === 10 && doc.getPageCount() === 10 && Math.round(z.width) === 288 && Math.round(z.height) === 432, 'roll: 4 x 6 in pages, one sticker per page (5 x 2 = 10)');
  r = await LS.build(PDFLib, [await labels(1)], { copies: 1, layout: 'nonsense' }); ok(r.layout === '13x19', 'unknown paper falls back to 13 x 19');
  let e = await LS.build(PDFLib, [], {}).catch((x) => x); ok(e instanceof Error, 'no files is an error');
  e = await LS.build(PDFLib, [new Uint8Array([1, 2, 3])], {}).catch((x) => x); ok(e instanceof Error, 'a non-PDF is an error');
  e = await LS.build(PDFLib, [await labels(1)], { layout: 'custom', pageW: 4, pageH: 4 }).catch((x) => x); ok(e instanceof Error, 'paper too small for a label is an error');
  require('fs').writeFileSync(process.env.LS_OUT || '/tmp/labelsheet-sample.pdf', (await LS.build(PDFLib, [await labels(7)], { copies: 1, layout: 'a4' })).bytes);
  console.log(`labelsheet-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
