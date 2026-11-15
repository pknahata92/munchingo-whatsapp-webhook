'use strict';
// Invoice visuals (16 Nov 2026): the ₹ sign, a thumbnail per line, a photo strip when it fits on page 1, and a truthful
// Shipping line. Every GST field and figure stays as it was. Renders real PDFs and reads them back with pdfjs-dist.
//   node scripts/invoice-visuals-test.js
const fs = require('fs');
const path = require('path');

// pdfjs-dist's legacy build warns on load that it cannot polyfill canvas helpers; reading text and operators does not need them.
const quiet = (fn) => { const l = console.log, w = console.warn; console.log = console.warn = () => {}; try { return fn(); } finally { console.log = l; console.warn = w; } };
const pdfjs = quiet(() => require('pdfjs-dist/legacy/build/pdf.js'));

const invoice = require('../utils/invoice');
const { buildInvoice, renderInvoicePdf } = invoice;
const shipping = require('../utils/shipping');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const ASSETS = path.join(__dirname, '..', 'assets', 'invoice');
const PAGE_H = 842, W = 515;

function jpegSize(file) {
  const b = fs.readFileSync(file);
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

// Text items and painted images of every page, in top-down page coordinates (y grows downwards, like pdfkit).
async function readPdf(buf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0, disableFontFace: true, isEvalSupported: false }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const texts = tc.items.filter((t) => t.str !== undefined).map((t) => {
      const fs_ = Math.abs(t.transform[3]) || t.height || 9, base = PAGE_H - t.transform[5];
      return { str: t.str, x0: t.transform[4], x1: t.transform[4] + t.width, base, top: base - 0.75 * fs_, bottom: base + 0.2 * fs_ };
    });
    const ol = await page.getOperatorList();
    const O = pdfjs.OPS, T = pdfjs.Util.transform;
    let ctm = [1, 0, 0, 1, 0, 0]; const stack = []; const images = [];
    const box = (m) => {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]]);
      const xs = pts.map((q) => q[0]), ys = pts.map((q) => PAGE_H - q[1]);
      return { x0: Math.min(...xs), x1: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
    };
    ol.fnArray.forEach((fn, k) => {
      const a = ol.argsArray[k];
      if (fn === O.save) stack.push(ctm);
      else if (fn === O.restore) ctm = stack.pop() || ctm;
      else if (fn === O.transform) ctm = T(ctm, a);
      else if (fn === O.paintImageXObject) images.push({ ...box(ctm), px: [a[1], a[2]] });
      else if (fn === O.paintImageXObjectRepeat) {
        for (let j = 0; j < a[3].length; j += 2) images.push({ ...box(T(ctm, [a[1], 0, 0, a[2], a[3][j], a[3][j + 1]])), px: null });
      }
    });
    pages.push({ texts, images });
  }
  return { numPages: doc.numPages, pages };
}

// The text of one printed line: items sharing a baseline, left to right, whitespace collapsed. minX keeps only one block
// (the totals block starts at x 330; "Total paid" shares its baseline with the amount in words on the left).
function linesOf(page, minX = 0) {
  const rows = new Map();
  page.texts.filter((t) => t.x0 >= minX).forEach((t) => { const k = Math.round(t.base); const row = rows.get(k) || rows.get(k - 1) || rows.get(k + 1); if (row) row.push(t); else rows.set(k, [t]); });
  // Items are joined as printed: a space where there is a visible gap (over 1 pt), nothing where they touch (₹ and its digits).
  return [...rows.values()].map((r) => r.sort((a, b) => a.x0 - b.x0).reduce((acc, t, k, arr) => acc + (k && t.x0 - arr[k - 1].x1 > 1 ? ' ' : '') + t.str, '').replace(/\s+/g, ' ').trim());
}
const textOf = (pdf) => pdf.pages.map((p) => linesOf(p).join(' ')).join(' ').replace(/\s+/g, ' ');
const overlaps = (a, b) => a.x0 < b.x1 - 0.5 && b.x0 < a.x1 - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const isThumb = (im) => Math.abs(im.x1 - im.x0 - 24) < 1 && Math.abs(im.bottom - im.top - 24) < 1;
const isStrip = (im) => Math.abs(im.x1 - im.x0 - W) < 1 && Math.abs((im.x1 - im.x0) / (im.bottom - im.top) - 6) < 0.1;

const sample = {
  order_id: 'MNG-4821-1015', customer_name: 'Priya Sharma', customer_phone: '919876543210', customer_email: 'priya@example.com',
  items: [
    { productName: 'Atta Original', quantity: 2, item_price: 259, unit: '250g', slug: 'atta-original' },
    { productName: 'Atta Kesari', quantity: 1, item_price: 299, unit: '250g', slug: 'atta-kesari' },
    { productName: 'Atta Ajwain', quantity: 1, item_price: 259, unit: '250g', slug: 'atta-ajwain' },
  ],
  total: 976, discount_amount: 100, coupon_code: 'FOUNDING10', payment_id: 'pay_QxAmPlE12345',
  delivery_address: { raw: 'Flat 12, Green Park Apartments, Dwarka Sector 6, New Delhi, Delhi - 110075' },
};
const intraSample = { ...sample, delivery_address: { raw: 'Plot 4, Sector 14, Faridabad, Haryana - 121007' } };
const single = (slug, name, price, q = 1) => ({ productName: name, quantity: q, item_price: price, unit: '250g', slug });
const shipOrder = {
  order_id: 'MNG-SHIP-1', customer_name: 'Asha', customer_phone: '919800000001', payment_id: 'pay_SHIP1',
  items: [single('atta-original', 'Atta Original', 259, 2), shipping.shippingItem(49)], total: 567,
  delivery_address: { raw: '5 MG Road, Bengaluru, Karnataka - 560001' },
};
const fullRangeOrder = {
  order_id: 'MNG-SET-1', customer_name: 'Ravi', customer_phone: '919800000002', payment_id: 'pay_SET1',
  items: [{ productName: 'Full Range Set', quantity: 1, item_price: 999, unit: '1kg', slug: 'full-range-set' }], total: 999,
  delivery_address: { raw: '9 Park Street, Kolkata, West Bengal - 700016' },
};
const legacyOrder = {
  order_id: 'MNG-OLD-1', customer_name: 'Old Customer', customer_phone: '919800000003', payment_id: 'pay_OLD1',
  items: [{ product_retailer_id: 'mun_orig_250', productName: 'Munchingo Atta Original (WhatsApp)', quantity: 2, item_price: 259 }], total: 518,
  delivery_address: { raw: '1 Civil Lines, Jaipur, Rajasthan - 302006' },
};
const sevenLines = {
  order_id: 'MNG-SEVEN-1', customer_name: 'Meera Iyer', customer_phone: '919800000004', customer_email: 'meera@example.com', payment_id: 'pay_SEVEN1',
  items: [
    single('atta-original', 'Atta Original', 259, 2), single('atta-kesari', 'Atta Kesari', 299, 2), single('atta-ajwain', 'Atta Ajwain', 259),
    single('atta-lite-sugar', 'Atta Sugar-Lite', 329),
    { productName: 'Trio Set', quantity: 1, item_price: 749, unit: '750g', slug: 'trio-gift-set-ajwain-kesari-original' },
    { productName: 'Full Range Set', quantity: 1, item_price: 999, unit: '1kg', slug: 'full-range-set' },
    { product_retailer_id: 'mun_orig_250', productName: 'Atta Original (WhatsApp catalogue)', quantity: 1, item_price: 259 },
  ],
  total: 3712 - 100, discount_amount: 100, coupon_code: 'WELCOME', delivery_address: { raw: '22 Marine Drive, Mumbai, Maharashtra - 400002' },
};
const tenLines = { ...sevenLines, order_id: 'MNG-TEN-1', items: [...sevenLines.items, single('atta-kesari', 'Atta Kesari', 299), single('atta-ajwain', 'Atta Ajwain', 259, 3), { productName: 'Trio Set', quantity: 1, item_price: 749, unit: '750g', slug: 'trio-gift-set-ajwain-lite-sugar-original' }] };

const inv = (order, no = 'MUN/26-27/0001') => buildInvoice(order, { invoiceNo: no, issuedAt: new Date('2026-11-16T06:00:00Z') });

(async () => {
  // 1. money() and the bundled files.
  ok(typeof invoice.money === 'function', 'money() is exported');
  if (typeof invoice.money === 'function') {
    ok(invoice.money(97600) === '₹976.00', 'money(97600) is ₹976.00');
    ok(invoice.money(107600) === '₹1,076.00', 'money keeps the Indian digit grouping: ₹1,076.00');
    ok(invoice.money(4900) === '₹49.00', 'money(4900) is ₹49.00');
  }
  for (const n of ['original', 'kesari', 'ajwain', 'lite', 'set']) {
    const f = path.join(ASSETS, n + '.jpg');
    const s = fs.existsSync(f) && jpegSize(f);
    ok(s && s.w === 160 && s.h === 160, `assets/invoice/${n}.jpg is a 160x160 JPEG`);
  }
  const strip = path.join(ASSETS, 'strip.jpg');
  const ss = fs.existsSync(strip) && jpegSize(strip);
  ok(ss && ss.w === 1200 && ss.h === 200, 'assets/invoice/strip.jpg is a 1200x200 JPEG');
  ok(fs.existsSync(path.join(ASSETS, 'Poppins-Bold.ttf')), 'assets/invoice/Poppins-Bold.ttf is bundled');

  // 2. invoiceThumb maps slugs as the emails do.
  ok(typeof invoice.invoiceThumb === 'function', 'invoiceThumb() is exported');
  if (typeof invoice.invoiceThumb === 'function') {
    const t = invoice.invoiceThumb;
    ok(t({ slug: 'atta-original' }) === path.join(ASSETS, 'original.jpg'), 'atta-original -> original.jpg');
    ok(t({ slug: 'atta-kesari' }) === path.join(ASSETS, 'kesari.jpg'), 'atta-kesari -> kesari.jpg');
    ok(t({ slug: 'atta-ajwain' }) === path.join(ASSETS, 'ajwain.jpg'), 'atta-ajwain -> ajwain.jpg');
    ok(t({ slug: 'atta-lite-sugar' }) === path.join(ASSETS, 'lite.jpg'), 'atta-lite-sugar -> lite.jpg');
    ok(t({ slug: 'full-range-set' }) === path.join(ASSETS, 'set.jpg'), 'full-range-set -> set.jpg');
    ok(t({ slug: 'trio-gift-set-ajwain-kesari-original' }) === path.join(ASSETS, 'set.jpg'), 'a Trio -> set.jpg');
    ok(t({ slug: null, name: 'Munchingo item' }) === null, 'no slug -> no thumbnail');
    ok(t({ slug: 'mun_orig_250' }) === null, 'an old WhatsApp retailer id -> no thumbnail');
    ok(t(shipping.shippingItem(49)) === null, 'the shipping line -> no thumbnail');
    ok(t(inv(shipOrder).items[1]) === null, 'the invoice shipping item -> no thumbnail');
  }

  // 3. The sample order: ₹ everywhere, no "Rs.", the same GST figures as before, every legal line still printed.
  const sInv = inv(sample);
  ok(sInv.taxablePaise === 92953 && sInv.igstPaise === 4647 && sInv.totalPaise === 97600 && sInv.cgstPaise === 0, 'sample maths unchanged (taxable 929.53, IGST 46.47, total 976.00)');
  const sBuf = await renderInvoicePdf(sInv);
  const sPdf = await readPdf(sBuf);
  const sText = textOf(sPdf), sLines = linesOf(sPdf.pages[0], 320);
  ok(sText.includes('₹'), 'sample invoice text carries ₹');
  ok(!sText.includes('Rs.'), 'sample invoice text has no "Rs."');
  for (const l of ['Items total (incl. GST) ₹1,076.00', 'Discount (FOUNDING10) - ₹100.00', 'Taxable value ₹929.53', 'IGST @ 5% ₹46.47', 'Shipping Free', 'Total paid ₹976.00']) {
    ok(sLines.includes(l), `sample totals line "${l}" (got: ${sLines.filter((x) => x.startsWith(l.split(' ')[0])).join(' / ')})`);
  }
  // Every ₹ is flush with its digits (no gap, no overlap) and on the same baseline.
  const signs = sPdf.pages[0].texts.filter((t) => t.str === '₹');
  ok(signs.length === 9 + 5, `sample: 14 ₹ signs, 9 in the rows and 5 in the totals: items total, discount, taxable, IGST, total paid (got ${signs.length})`);
  signs.forEach((sg) => {
    const d = sPdf.pages[0].texts.find((t) => /^[0-9]/.test(t.str) && Math.abs(t.base - sg.base) < 0.3 && Math.abs(t.x0 - sg.x1) < 0.6);
    ok(!!d, `₹ at x ${sg.x0.toFixed(1)}, y ${sg.base.toFixed(1)} sits flush with its digits on one baseline`);
  });
  for (const row of ['₹447.49', '₹22.37', '₹469.86', '₹258.30', '₹12.91', '₹271.21', '₹223.74', '₹11.19', '₹234.93']) ok(sText.includes(row), `sample row figure ${row}`);
  for (const legal of ['TAX INVOICE', 'Invoice No: MUN/26-27/0001', 'Order: MNG-4821-1015', 'Munchingo (Prop. Prashant Nahata)', 'H. No. 43, Sector 14', 'Faridabad, Haryana 121007',
    'GSTIN: 06AIIPN5005C2ZP', 'FSSAI Lic. No.: 10826003000333', 'Place of supply: Delhi (07)', 'HSN', '1905', 'GST 5%', 'Rupees Nine Hundred Seventy Six Only',
    'Payment received', 'Paid online via Razorpay | Payment ID: pay_QxAmPlE12345',
    'Prices include GST. This is a computer-generated invoice and does not require a signature. Questions about this order? Write to info.munchingo@gmail.com or WhatsApp +91 99889 92024.',
    'Loved it? A Munchingo Trio or Full Range Set makes the best "just because". Visit munchingo.com/build-a-box']) {
    ok(sText.includes(legal), `legal text still printed: ${legal.slice(0, 60)}`);
  }
  const iInv = inv(intraSample, 'MUN/26-27/0002');
  ok(iInv.cgstPaise === 2323 && iInv.sgstPaise === 2324 && iInv.taxablePaise === 92953, 'intra maths unchanged (CGST 23.23, SGST 23.24)');
  const iLines = linesOf((await readPdf(await renderInvoicePdf(iInv))).pages[0], 320);
  for (const l of ['CGST @ 2.5% ₹23.23', 'SGST @ 2.5% ₹23.24', 'Taxable value ₹929.53', 'Total paid ₹976.00']) ok(iLines.includes(l), `intra totals line "${l}"`);
  ok(sBuf.length < 1000000, `sample PDF under 1,000,000 bytes (${sBuf.length})`);

  // 4. Shipping is truthful: the ₹49 line shows its own amount and never "Free"; an order without one shows Free.
  const shInv = inv(shipOrder, 'MUN/26-27/0003');
  ok(shInv.totalPaise === 56700 && shInv.taxablePaise + shInv.igstPaise === 56700, 'shipping order maths: total ₹567.00 = taxable + IGST');
  const shPdf = await readPdf(await renderInvoicePdf(shInv));
  const shLines = linesOf(shPdf.pages[0], 320);
  ok(shLines.includes('Shipping ₹49.00'), `shipping order reads "Shipping ₹49.00" (got: ${shLines.filter((x) => x.startsWith('Shipping')).join(' / ')})`);
  ok(!textOf(shPdf).includes('Free'), 'shipping order never prints "Free"');
  ok(shLines.includes('Total paid ₹567.00'), 'shipping order total paid ₹567.00');

  // 5. Pictures: a thumbnail per line with a known slug, lined up with its row; a strip only when it fits; one page; no overlaps.
  async function layout(order, label) {
    const i = inv(order, 'MUN/26-27/0009');
    const buf = await renderInvoicePdf(i);
    const pdf = await readPdf(buf);
    ok(pdf.numPages === 1, `${label}: one page (got ${pdf.numPages})`);
    const pg = pdf.pages[0];
    const body = pg.images.filter((im) => im.top > 107);
    const thumbs = body.filter(isThumb), strips = body.filter(isStrip);
    const want = i.items.filter((it) => invoice.invoiceThumb && invoice.invoiceThumb(it)).length;
    ok(thumbs.length === want, `${label}: ${want} thumbnails (got ${thumbs.length})`);
    ok(body.length === thumbs.length + strips.length, `${label}: no other images in the body`);
    // Each thumbnail sits left of an item name on the same row, inside the Item column.
    i.items.forEach((it) => {
      const label2 = it.unit ? `${it.name} (${it.unit})` : it.name;
      const name = pg.texts.find((t) => t.str && label2.startsWith(t.str) && t.str.length > 3 && t.x0 > 60 && t.x0 < 300);
      if (!name) { ok(false, `${label}: item name "${label2}" printed`); return; }
      const th = thumbs.find((im) => im.top <= name.base && im.bottom >= name.top);
      if (invoice.invoiceThumb && invoice.invoiceThumb(it)) {
        ok(!!th && th.x1 <= name.x0 - 2 && th.x0 >= 60, `${label}: thumbnail lines up left of "${label2}"`);
      } else ok(!th, `${label}: no thumbnail beside "${label2}"`);
    });
    // Nothing overlaps: no image over any text, no image over another.
    body.forEach((im, k) => {
      pg.texts.filter((t) => t.str.trim()).forEach((t) => ok(!overlaps(im, t), `${label}: image at y ${Math.round(im.top)} overlaps text "${t.str.slice(0, 30)}"`));
      body.slice(k + 1).forEach((o) => ok(!overlaps(im, o), `${label}: two images overlap at y ${Math.round(im.top)}`));
    });
    const total = pg.texts.find((t) => t.str === 'Total paid');
    const words = pg.texts.find((t) => t.str.startsWith('Rupees '));
    const paid = pg.texts.find((t) => t.str === 'Payment received');
    if (strips.length) {
      const st = strips[0];
      ok(strips.length === 1, `${label}: one strip`);
      ok(total && words && st.top >= Math.max(total.bottom, words.bottom), `${label}: strip below the totals and the amount in words`);
      ok(paid && st.bottom <= paid.top - 8, `${label}: strip above the Payment received box`);
    }
    return { buf, strips: strips.length, thumbs: thumbs.length };
  }
  const L3 = await layout(sample, 'sample (3 lines)');
  ok(L3.strips === 1, 'sample (3 lines): the strip is shown');
  const LS = await layout(fullRangeOrder, 'Full Range Set only');
  const fullBuf = LS.buf;
  ok(fullBuf.includes(fs.existsSync(path.join(ASSETS, 'set.jpg')) ? fs.readFileSync(path.join(ASSETS, 'set.jpg')) : Buffer.from('missing set.jpg')), 'Full Range Set only: the embedded thumbnail is set.jpg');
  ok(LS.strips === 1, 'Full Range Set only: the strip is shown');
  // The narrower name column wraps the Full Range "Contains" line: it must break between Flavors, never inside "Sugar-Lite".
  const fLines = linesOf((await readPdf(fullBuf)).pages[0]);
  ok(fLines.some((l) => l.includes('Sugar-Lite')) && !fLines.some((l) => /Sugar-$/.test(l)), `Full Range Set only: "Sugar-Lite" stays whole (got: ${fLines.filter((l) => /Contains|Lite/.test(l)).join(' / ')})`);
  ok(fLines.some((l) => l.startsWith('Contains: Original + Kesari + Ajwain')), 'Full Range Set only: the Contains line lists the Flavors in order');
  const LL = await layout(legacyOrder, 'legacy item (no slug)');
  ok(LL.thumbs === 0, 'legacy item (no slug): renders without a thumbnail');
  await layout(shipOrder, 'shipping order');
  const L7 = await layout(sevenLines, '7-line order');
  ok(L7.buf.length < 1000000, `7-line PDF under 1,000,000 bytes (${L7.buf.length})`);
  const L10 = await layout(tenLines, '10-line order');
  ok(L10.strips === 0, '10-line order: no room, so the strip is skipped');

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
