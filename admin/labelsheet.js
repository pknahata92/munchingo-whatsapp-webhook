/* Label sheet: lays courier labels (never shrunk, so barcodes and text keep Delhivery's minimum sizes) out in a straight grid on the paper you choose,
 * turning the page to landscape when that fits more labels. Paper: 13 x 19, 12 x 18, A3, A4, Letter, any
 * custom size, or a 4 x 6 in thermal roll (one label per page, e.g. TSC TTP-244 Pro). N copies of each label.
 * Runs in the browser (admin > Label sheet) and in node (scripts/labelsheet-test.js). Nothing is uploaded: the PDFs stay on the device.
 * Needs pdf-lib (served at /admin/pdf-lib.min.js).
 */
(function (root) {
  'use strict';
  var IN = 72, STD_W = 4 * IN, STD_H = 6 * IN, EPS = 0.5;
  var LAYOUTS = {
    '13x19': { name: '13 x 19 in sheet', w: 13 * IN, h: 19 * IN },
    '12x18': { name: '12 x 18 in sheet', w: 12 * IN, h: 18 * IN },
    '9x12': { name: '9 x 12 in sheet', w: 9 * IN, h: 12 * IN },
    a3: { name: 'A3 sheet', w: 841.89, h: 1190.55 },
    a4: { name: 'A4 sheet', w: 595.28, h: 841.89 },
    letter: { name: 'Letter 8.5 x 11 in', w: 8.5 * IN, h: 11 * IN },
    custom: { name: 'Custom size (type width x height in inches)', w: 13 * IN, h: 19 * IN, custom: true },
    roll: { name: '4 x 6 in thermal roll (one per page)', w: STD_W, h: STD_H, roll: true }
  };
  Object.keys(LAYOUTS).forEach(function (k) { LAYOUTS[k].key = k; });

  // Straight grid: every label upright, in even rows and columns, the block centred on the page so the margins are equal and the cuts are a few
  // straight lines. Easiest to cut.
  function grid(W, H, LW, LH) {
    LW = LW || STD_W; LH = LH || STD_H;
    var best = null;
    [[LW, LH, false]].forEach(function (o) {
      var cols = Math.floor((W + EPS) / o[0]), rows = Math.floor((H + EPS) / o[1]);
      if (cols * rows > 0 && (!best || cols * rows > best.cols * best.rows)) best = { cols: cols, rows: rows, w: o[0], h: o[1], turn: o[2] };
    });
    if (!best) return [];
    var ox = (W - best.cols * best.w) / 2, oy = (H - best.rows * best.h) / 2, out = [], r, c;
    for (r = 0; r < best.rows; r++) for (c = 0; c < best.cols; c++) out.push({ x: ox + c * best.w, y: oy + (best.rows - 1 - r) * best.h, w: best.w, h: best.h, turn: best.turn });
    return out;
  }

  // files: array of Uint8Array/ArrayBuffer (each a PDF; every page is one label).
  // opts: { cell = 'actual' ('standard' forces 4 x 6 in cells), crops = [[{left,bottom,right,top} per page] per file] to cut each label out of a bigger page, layout = '13x19', copies = 2, margin (inches, default 0.125), keepTogether = false, perSheet = 0 (most that fit; or 1, 2, 3...), cutLines = true, pageW, pageH (inches, layout 'custom') }
  async function build(PDFLib, files, opts) {
    opts = opts || {};
    var L = LAYOUTS[opts.layout] || LAYOUTS['13x19'];
    var copies = Math.max(1, Math.min(10, parseInt(opts.copies, 10) || 2));
    var pw = L.w, ph = L.h;
    if (L.custom) { pw = Math.max(4, Number(opts.pageW) || 13) * IN; ph = Math.max(4, Number(opts.pageH) || 19) * IN; }
    var m = L.roll ? 0 : Math.max(0, Math.min(1, opts.margin == null ? 0.125 : Number(opts.margin))) * IN;
    var out = await PDFLib.PDFDocument.create();
    var labels = [];   // { page, w, h }
    for (var i = 0; i < files.length; i++) {
      var src = await PDFLib.PDFDocument.load(files[i], { ignoreEncryption: true });
      var pages = src.getPages();
      var boxes = pages.map(function (pg, k) { var b = opts.crops && opts.crops[i] && opts.crops[i][k]; return b && b.right > b.left && b.top > b.bottom ? b : undefined; });
      var embedded = await out.embedPages(pages, boxes);
      for (var p = 0; p < pages.length; p++) { var sz = boxes[p] ? { width: boxes[p].right - boxes[p].left, height: boxes[p].top - boxes[p].bottom } : pages[p].getSize(); labels.push({ page: embedded[p], w: sz.width, h: sz.height }); }
    }
    if (!labels.length) throw new Error('No labels found in the file(s).');
    // Cell size: the labels' real (cropped) size, so nothing is shrunk and more fit on a sheet; never bigger than the standard 4 x 6 in.
    var cw = STD_W, ch = STD_H;
    if (opts.cell !== 'standard') {
      var a = 0, b = 0; labels.forEach(function (lb) { a = Math.max(a, Math.min(lb.w, lb.h)); b = Math.max(b, Math.max(lb.w, lb.h)); });
      cw = Math.min(STD_W, Math.ceil(a) + 2); ch = Math.min(STD_H, Math.ceil(b) + 2);
    }
    var cells, landscape = false;
    if (L.roll) cells = [{ x: 0, y: 0, w: STD_W, h: STD_H, turn: false }];
    else {   // the page is turned to landscape when that fits more labels, so the labels stay upright on screen and in the print dialog
      var gp = grid(pw - 2 * m, ph - 2 * m, cw, ch), gl = grid(ph - 2 * m, pw - 2 * m, cw, ch);
      if (gl.length > gp.length) { landscape = true; cells = gl; var tmp = pw; pw = ph; ph = tmp; } else cells = gp;
    }
    if (!cells.length) throw new Error('That paper is too small for a 4 x 6 in label.');
    // Fewer labels per sheet on request (1 = a single label centred on the page).
    var cap = parseInt(opts.perSheet, 10);
    if (!L.roll && cap > 0 && cap < cells.length) {
      cells = cells.slice(0, cap);
      if (cap === 1) { var c0 = cells[0]; c0.x = (pw - 2 * m - c0.w) / 2; c0.y = (ph - 2 * m - c0.h) / 2; }
    }
    var queue = [];   // every sticker, one per cell, in order; a label's copies sit next to each other
    labels.forEach(function (lab) { for (var c = 0; c < copies; c++) queue.push(lab); });
    var perSheet = cells.length, wasted = 0;
    if (opts.keepTogether && !L.roll && copies > 1) {   // a label's copies never split across two sheets
      var perOrder = Math.max(1, Math.floor(perSheet / copies)), q2 = [], g, c2, s;
      for (g = 0; g < labels.length; g += perOrder) { var grp = []; for (s = g; s < Math.min(labels.length, g + perOrder); s++) for (c2 = 0; c2 < copies; c2++) grp.push(labels[s]); while (grp.length < perSheet) grp.push(null); q2 = q2.concat(grp); }
      queue = q2;
    }
    var sheets = Math.ceil(queue.length / perSheet), gray = PDFLib.rgb(0.6, 0.6, 0.6), minScale = 1;
    for (var sh = 0; sh < sheets; sh++) {
      var page = out.addPage([pw, ph]);
      var used = cells.slice(0, Math.min(perSheet, queue.length - sh * perSheet));
      if (opts.cutLines !== false && !L.roll) used.forEach(function (cl) { page.drawRectangle({ x: m + cl.x, y: m + cl.y, width: cl.w, height: cl.h, borderWidth: 0.3, borderColor: gray }); });
      used.forEach(function (cl, k) {
        var lab = queue[sh * perSheet + k]; if (!lab) { wasted++; return; }
        // A label is turned a quarter turn when its shape does not match the cell's.
        var turn = (cl.w > cl.h) !== (lab.w > lab.h), sw = turn ? lab.h : lab.w, sh2 = turn ? lab.w : lab.h;
        var f = Math.min(cl.w / sw, cl.h / sh2); if (f < minScale) minScale = f;
        var dw = sw * f, dh = sh2 * f, cx = m + cl.x + (cl.w - dw) / 2, cy = m + cl.y + (cl.h - dh) / 2;
        if (turn) page.drawPage(lab.page, { x: cx + dw, y: cy, xScale: f, yScale: f, rotate: PDFLib.degrees(90) });
        else page.drawPage(lab.page, { x: cx, y: cy, xScale: f, yScale: f });
      });
    }
    out.setTitle('Munchingo labels ' + L.key);
    var stickers = labels.length * copies;
    return { bytes: await out.save(), labels: labels.length, stickers: stickers, sheets: sheets, copies: copies, perSheet: perSheet, blank: sheets * perSheet - stickers,
      minScale: minScale, layout: L.key, paper: L.name, cellW: cw, cellH: ch, landscape: landscape, sideways: cells.filter(function (c) { return c.turn; }).length };
  }

  var api = { build: build, grid: grid, LAYOUTS: LAYOUTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MunchingoLabelSheet = api;
})(typeof window !== 'undefined' ? window : this);
