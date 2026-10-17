/* Label sheet: lays courier labels out on the chosen paper (default 13 x 19 in, 3 across and 3 down, each cell 4 x 6 in; also A3, A4 and a thermal roll) with N copies of each label (an order's copies stay together on one sheet).
 * Runs in the browser (admin > Label sheet) and in node (scripts/labelsheet-test.js). Nothing is uploaded: the PDFs stay on the device.
 * Needs pdf-lib (served at /admin/pdf-lib.min.js). Cells touch each other; the 0.5 in margin all round carries cut marks.
 */
(function (root) {
  'use strict';
  var IN = 72;
  // Paper presets. Every cell is a 4 x 6 in label. 'roll' is a thermal printer (e.g. TSC TTP-244 Pro): one label per 4 x 6 in page, no cut marks.
  var LAYOUTS = {
    '13x19': { name: '13 x 19 in sheet (3 x 3)', w: 13 * IN, h: 19 * IN, cols: 3, rows: 3 },
    a3: { name: 'A3 sheet (2 x 2)', w: 841.89, h: 1190.55, cols: 2, rows: 2 },
    a4: { name: 'A4 sheet (2 x 1)', w: 595.28, h: 841.89, cols: 2, rows: 1 },
    roll: { name: '4 x 6 in thermal roll (one per page)', w: 4 * IN, h: 6 * IN, cols: 1, rows: 1, roll: true }
  };
  Object.keys(LAYOUTS).forEach(function (k) { var L = LAYOUTS[k]; L.cellW = 4 * IN; L.cellH = 6 * IN; L.key = k; });
  var SHEET = LAYOUTS['13x19'], MARGIN_X, MARGIN_Y;
  function use(key) { SHEET = LAYOUTS[key] || LAYOUTS['13x19']; MARGIN_X = (SHEET.w - SHEET.cols * SHEET.cellW) / 2; MARGIN_Y = (SHEET.h - SHEET.rows * SHEET.cellH) / 2; return SHEET; }
  use('13x19');

  // files: array of Uint8Array/ArrayBuffer (each a PDF; every page is one label). opts: { copies = 2, cutMarks = true }
  async function build(PDFLib, files, opts) {
    opts = opts || {};
    use(opts.layout);
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
    // On a roll each copy is its own page. A label whose copies exceed one sheet simply takes more sheets.
    var perOrder = SHEET.roll ? 1 : Math.max(1, Math.floor(perSheet / copies));
    var pagesPer = SHEET.roll ? copies : 1;
    var sheets = Math.ceil(labels.length / perOrder) * pagesPer;
    var minScale = 1, gray = PDFLib.rgb(0.35, 0.35, 0.35);
    for (var s = 0; s < sheets; s++) {
      var sheet = out.addPage([SHEET.w, SHEET.h]);
      if (opts.cutMarks !== false && !SHEET.roll) drawMarks(sheet, PDFLib, gray);
      for (var g = 0; g < perOrder; g++) {
        var lab = labels[Math.floor(s / pagesPer) * perOrder + g]; if (!lab) break;
        for (var c = 0; c < (SHEET.roll ? 1 : copies); c++) {
          var k = g * copies + c; if (SHEET.roll) k = 0;
          var col = k % SHEET.cols, row = Math.floor(k / SHEET.cols);
          var x0 = MARGIN_X + col * SHEET.cellW, yTop = SHEET.h - MARGIN_Y - row * SHEET.cellH;
          // A landscape source label is turned a quarter turn so it fills the portrait cell.
          var turn = lab.w > lab.h, sw = turn ? lab.h : lab.w, sh = turn ? lab.w : lab.h;
          var f = Math.min(SHEET.cellW / sw, SHEET.cellH / sh); if (f < minScale) minScale = f; var dw = sw * f, dh = sh * f;
          var cx = x0 + (SHEET.cellW - dw) / 2, cy = yTop - SHEET.cellH + (SHEET.cellH - dh) / 2;
          if (turn) sheet.drawPage(lab.page, { x: cx + dw, y: cy, xScale: f, yScale: f, rotate: PDFLib.degrees(90) });
          else sheet.drawPage(lab.page, { x: cx, y: cy, xScale: f, yScale: f });
        }
      }
    }
    out.setTitle('Munchingo labels ' + SHEET.key);
    return { bytes: await out.save(), labels: labels.length, stickers: labels.length * copies, sheets: sheets, copies: copies, perSheet: SHEET.roll ? 1 : perOrder * copies, minScale: minScale, layout: SHEET.key, paper: SHEET.name };
  }

  // Short ticks in the margin at every cut line (vertical cuts at the top and bottom, horizontal cuts at the sides).
  function drawMarks(page, PDFLib, color) {
    var t = 14, o = { thickness: 0.5, color: color }, i, x, y;
    for (i = 0; i <= SHEET.cols; i++) { x = MARGIN_X + i * SHEET.cellW; page.drawLine({ start: { x: x, y: SHEET.h - MARGIN_Y + 4 }, end: { x: x, y: SHEET.h - MARGIN_Y + 4 + t }, thickness: o.thickness, color: o.color }); page.drawLine({ start: { x: x, y: MARGIN_Y - 4 }, end: { x: x, y: MARGIN_Y - 4 - t }, thickness: o.thickness, color: o.color }); }
    for (i = 0; i <= SHEET.rows; i++) { y = MARGIN_Y + i * SHEET.cellH; page.drawLine({ start: { x: MARGIN_X - 4, y: y }, end: { x: MARGIN_X - 4 - t, y: y }, thickness: o.thickness, color: o.color }); page.drawLine({ start: { x: SHEET.w - MARGIN_X + 4, y: y }, end: { x: SHEET.w - MARGIN_X + 4 + t, y: y }, thickness: o.thickness, color: o.color }); }
  }

  var api = { build: build, LAYOUTS: LAYOUTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MunchingoLabelSheet = api;
})(typeof window !== 'undefined' ? window : this);
