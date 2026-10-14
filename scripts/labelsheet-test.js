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
  ok(r.labels === 4 && r.stickers === 8 && r.sheets === 1, '4 labels x 2 = 8 stickers on one sheet');
  let doc = await PDFLib.PDFDocument.load(r.bytes); const s = doc.getPage(0).getSize();
  ok(Math.round(s.width) === 936 && Math.round(s.height) === 1368, 'sheet is 13 x 19 in (936 x 1368 pt)');
  r = await LS.build(PDFLib, [await labels(5)], { copies: 2 });
  ok(r.stickers === 10 && r.sheets === 2, '5 labels x 2 = 10 stickers -> 2 sheets (9 + 1)');
  r = await LS.build(PDFLib, [await labels(3), await labels(6)], { copies: 1 });
  ok(r.labels === 9 && r.sheets === 1, 'two files are combined, one copy: 9 labels fill one sheet exactly');
  r = await LS.build(PDFLib, [await labels(9)], { copies: 3 });
  ok(r.stickers === 27 && r.sheets === 3, '9 x 3 = 27 stickers = 3 full sheets');
  r = await LS.build(PDFLib, [await labels(2, 432, 288)], { copies: 2 });
  ok(r.sheets === 1 && r.stickers === 4, 'landscape labels are accepted (turned to fit)');
  r = await LS.build(PDFLib, [await labels(1)], { copies: 2, cutMarks: false }); ok(r.sheets === 1, 'cut marks can be switched off');
  r = await LS.build(PDFLib, [await labels(1, 595, 842)], { copies: 2 }); ok(r.sheets === 1, 'an A4-size source page is scaled into one cell');
  let e = await LS.build(PDFLib, [], {}).catch((x) => x); ok(e instanceof Error, 'no files is an error');
  e = await LS.build(PDFLib, [new Uint8Array([1, 2, 3])], {}).catch((x) => x); ok(e instanceof Error, 'a non-PDF is an error');
  require('fs').writeFileSync(process.env.LS_OUT || '/tmp/labelsheet-sample.pdf', (await LS.build(PDFLib, [await labels(5)], { copies: 2 })).bytes);
  console.log(`labelsheet-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
