/* Label sheet: lays courier labels out on a 13 x 19 in sheet (3 across, 3 down, each cell 4 x 6 in) with N copies of each label (an order's copies stay together on one sheet).
 * Runs in the browser (admin > Label sheet) and in node (scripts/labelsheet-test.js). Nothing is uploaded: the PDFs stay on the device.
 * Needs pdf-lib (served at /admin/pdf-lib.min.js). Cells touch each other; the 0.5 in margin all round carries cut marks.
 */
(function (root) {
  'use strict';
  var IN = 72;
  var SHEET = { w: 13 * IN, h: 19 * IN, cols: 3, rows: 3, cellW: 4 * IN, cellH: 6 * IN };
  var MARGIN_X = (SHEET.w - SHEET.cols * SHEET.cellW) / 2;   // 36 pt = 0.5 in
  var MARGIN_Y = (SHEET.h - SHEET.rows * SHEET.cellH) / 2;   // 36 pt = 0.5 in

  // files: array of Uint8Array/ArrayBuffer (each a PDF; every page is one label). opts: { copies = 2, cutMarks = true }
  async function build(PDFLib, files, opts) {
    opts = opts || {};
    var copies = Math.max(1, Math.min(5, parseInt(opts.copies, 10) || 2));
    var out = await PDFLib.PDFDocument.create();
    var labels = [];   // { page, w, h }
    for (var i = 0; i < files.length; i++) {
      var src = await PDFLib.PDFDocument.load(files[i], { ignoreEncryption: true });
      var pages = src.getPages();
      var embedded = await out.embedPages(pages);
      for (var p = 0; p < pages.length; p++) { var sz = pages[p].getSize(); labels.push({ page: embedded[p], w: sz.width, h: sz.height }); }
    }
    if (!labels.length) throw new Error('No labels found in the file(s).');
    // An order's copies always stay together on one sheet, so a sheet holds floor(9 / copies) orders (copies = 2: four orders, 8 cells,
    // the last cell left blank). Cutting by hand never separates a pair.
    var perSheet = SHEET.cols * SHEET.rows;
    var perOrder = Math.max(1, Math.floor(perSheet / copies));
    var sheets = Math.ceil(labels.length / perOrder);
    var gray = PDFLib.rgb(0.35, 0.35, 0.35);
    for (var s = 0; s < sheets; s++) {
      var sheet = out.addPage([SHEET.w, SHEET.h]);
      if (opts.cutMarks !== false) drawMarks(sheet, PDFLib, gray);
      for (var g = 0; g < perOrder; g++) {
        var lab = labels[s * perOrder + g]; if (!lab) break;
        for (var c = 0; c < copies; c++) {
          var k = g * copies + c;
          var col = k % SHEET.cols, row = Math.floor(k / SHEET.cols);
          var x0 = MARGIN_X + col * SHEET.cellW, yTop = SHEET.h - MARGIN_Y - row * SHEET.cellH;
          // A landscape source label is turned a quarter turn so it fills the portrait cell.
          var turn = lab.w > lab.h, sw = turn ? lab.h : lab.w, sh = turn ? lab.w : lab.h;
          var f = Math.min(SHEET.cellW / sw, SHEET.cellH / sh), dw = sw * f, dh = sh * f;
          var cx = x0 + (SHEET.cellW - dw) / 2, cy = yTop - SHEET.cellH + (SHEET.cellH - dh) / 2;
          if (turn) sheet.drawPage(lab.page, { x: cx + dw, y: cy, xScale: f, yScale: f, rotate: PDFLib.degrees(90) });
          else sheet.drawPage(lab.page, { x: cx, y: cy, xScale: f, yScale: f });
        }
      }
    }
    out.setTitle('Munchingo label sheet 13x19');
    return { bytes: await out.save(), labels: labels.length, stickers: labels.length * copies, sheets: sheets, copies: copies, perSheet: perOrder * copies };
  }

  // Short ticks in the margin at every cut line (vertical cuts at the top and bottom, horizontal cuts at the sides).
  function drawMarks(page, PDFLib, color) {
    var t = 14, o = { thickness: 0.5, color: color }, i, x, y;
    for (i = 0; i <= SHEET.cols; i++) { x = MARGIN_X + i * SHEET.cellW; page.drawLine({ start: { x: x, y: SHEET.h - MARGIN_Y + 4 }, end: { x: x, y: SHEET.h - MARGIN_Y + 4 + t }, thickness: o.thickness, color: o.color }); page.drawLine({ start: { x: x, y: MARGIN_Y - 4 }, end: { x: x, y: MARGIN_Y - 4 - t }, thickness: o.thickness, color: o.color }); }
    for (i = 0; i <= SHEET.rows; i++) { y = MARGIN_Y + i * SHEET.cellH; page.drawLine({ start: { x: MARGIN_X - 4, y: y }, end: { x: MARGIN_X - 4 - t, y: y }, thickness: o.thickness, color: o.color }); page.drawLine({ start: { x: SHEET.w - MARGIN_X + 4, y: y }, end: { x: SHEET.w - MARGIN_X + 4 + t, y: y }, thickness: o.thickness, color: o.color }); }
  }

  var api = { build: build, SHEET: SHEET };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MunchingoLabelSheet = api;
})(typeof window !== 'undefined' ? window : this);
