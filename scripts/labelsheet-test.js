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
  // straight grid on standard 4 x 6 cells (labels upright; the page turns landscape only when that fits more)
  const gr = (k, cw, ch) => { const l = LS.LAYOUTS[k], mm = 9; return LS.grid(l.w - 2 * mm, l.h - 2 * mm, cw, ch); };
  ok(gr('13x19').length === 9 && gr('a3').length === 4 && gr('a4').length === 2 && gr('letter').length === 2 && gr('12x18').length === 4, 'straight grid: 13 x 19 holds 9, A3 4, A4 2, Letter 2, 12 x 18 4');
  ok(gr('a4').every((c) => !c.turn) && new Set(gr('a4').map((c) => c.y)).size === 1, 'A4 grid: labels upright in one straight row');
  for (const k of ['13x19', 'a3', 'a4', 'letter', '12x18']) {   // no two labels overlap and all sit inside the page
    const l = LS.LAYOUTS[k], cs = gr(k), mm = 9; let bad = false;
    cs.forEach((c, i) => { if (c.x < -0.01 || c.y < -0.01 || c.x + c.w > l.w - 2 * mm + 0.01 || c.y + c.h > l.h - 2 * mm + 0.01) bad = true; cs.forEach((d, j) => { if (j > i && c.x < d.x + d.w - 0.01 && d.x < c.x + c.w - 0.01 && c.y < d.y + d.h - 0.01 && d.y < c.y + c.h - 0.01) bad = true; }); });
    ok(!bad, k + ': labels do not overlap and stay inside the page');
  }
  r = await LS.build(PDFLib, [await labels(7)], { copies: 1, layout: 'a4' }); ok(r.perSheet === 2 && r.sheets === 4 && r.landscape === false, 'A4 with full 4 x 6 labels: 2 per sheet, portrait page (7 labels, 4 sheets)');
  r = await LS.build(PDFLib, [await labels(3)], { copies: 1, layout: 'custom', pageW: 8.5, pageH: 12 }); ok(r.perSheet >= 2, 'a custom size works');
  r = await LS.build(PDFLib, [await labels(5)], { copies: 2, layout: 'roll' });
  doc = await PDFLib.PDFDocument.load(r.bytes); let z = doc.getPage(0).getSize();
  ok(r.sheets === 10 && doc.getPageCount() === 10 && Math.round(z.width) === 288 && Math.round(z.height) === 432, 'roll: 4 x 6 in pages, one sticker per page (5 x 2 = 10)');
  r = await LS.build(PDFLib, [await labels(1)], { copies: 1, layout: 'nonsense' }); ok(r.layout === '13x19', 'unknown paper falls back to 13 x 19');
  r = await LS.build(PDFLib, [await labels(3)], { copies: 1, layout: 'a4', perSheet: 1 }); ok(r.perSheet === 1 && r.sheets === 3, '1 label per sheet: 3 labels, 3 sheets');
  r = await LS.build(PDFLib, [await labels(3)], { copies: 2, layout: '13x19', perSheet: 1 }); ok(r.sheets === 6, '1 per sheet with 2 copies = 6 sheets');
  r = await LS.build(PDFLib, [await labels(5)], { copies: 1, layout: '13x19', perSheet: 4 }); ok(r.perSheet === 4 && r.sheets === 2, '4 per sheet on a 13 x 19 sheet');
  r = await LS.build(PDFLib, [await labels(2)], { copies: 1, layout: 'a4', cell: 'actual', crops: [[{ left: 0, bottom: 0, right: 259, top: 413 }, { left: 0, bottom: 0, right: 259, top: 413 }]] });
  ok(r.cellW < 288 && r.cellH < 432 && r.minScale >= 1, 'cropped labels use their real size and are not shrunk');
  r = await LS.build(PDFLib, [await labels(4, 595, 842)], { copies: 1, layout: '9x12', crops: [Array(4).fill({ left: 36, bottom: 393, right: 295, top: 806 })] });
  ok(r.perSheet === 4 && r.sheets === 1 && r.minScale >= 1, 'cut out of larger pages, 4 real-size labels fit on one 9 x 12 in sheet');
  r = await LS.build(PDFLib, [await labels(4, 595, 842)], { copies: 1, layout: 'a4', crops: [Array(4).fill({ left: 36, bottom: 393, right: 295, top: 806 })] });
  doc = await PDFLib.PDFDocument.load(r.bytes); z = doc.getPage(0).getSize();
  ok(r.perSheet === 3 && r.landscape === true && z.width > z.height && r.minScale >= 1, 'A4 with real-size cut-out labels: the page turns landscape and holds 3 upright labels, none shrunk');
  let e = await LS.build(PDFLib, [], {}).catch((x) => x); ok(e instanceof Error, 'no files is an error');
  e = await LS.build(PDFLib, [new Uint8Array([1, 2, 3])], {}).catch((x) => x); ok(e instanceof Error, 'a non-PDF is an error');
  e = await LS.build(PDFLib, [await labels(1)], { layout: 'custom', pageW: 4, pageH: 4 }).catch((x) => x); ok(e instanceof Error, 'paper too small for a label is an error');
  require('fs').writeFileSync(process.env.LS_OUT || '/tmp/labelsheet-sample.pdf', (await LS.build(PDFLib, [await labels(7)], { copies: 1, layout: 'a4' })).bytes);
  console.log(`labelsheet-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
