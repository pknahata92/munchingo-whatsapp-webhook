'use strict';

/**
 * GST tax invoices for paid website/WhatsApp orders.
 *
 *   buildInvoice(order, { invoiceNo, issuedAt })  -> plain object (all money in paise)
 *   renderInvoicePdf(invoice)                      -> Promise<Buffer>
 *   issueInvoice(order)                            -> reserves a number, stores, returns { invoice, pdf, created }
 *
 * Prices are GST-inclusive (5%, HSN 1905). Any coupon / subscription discount is
 * spread pro-rata across the lines first, then tax is backed out of each net line,
 * so the invoice total always equals exactly what the customer paid.
 * Supply from Haryana to Haryana = CGST 2.5% + SGST 2.5%; anywhere else = IGST 5%.
 */

const path = require('path');
const { contentsOf } = require('./orderText');
const PDFDocument = require('pdfkit');

const SELLER = {
  name: 'Munchingo',
  proprietor: 'Prashant Nahata',
  address: ['H. No. 43, Sector 14', 'Faridabad, Haryana 121007'],
  state: 'Haryana',
  gstin: '06AIIPN5005C2ZP',
  fssai: '10826003000333',
  email: 'info.munchingo@gmail.com',
  phone: '+91 99889 92024',
  site: 'munchingo.com',
};
const GST_RATE = 5;
const HSN = '1905';

const STATE_CODES = {
  'jammu and kashmir': '01', 'himachal pradesh': '02', 'punjab': '03', 'chandigarh': '04', 'uttarakhand': '05',
  'haryana': '06', 'delhi': '07', 'rajasthan': '08', 'uttar pradesh': '09', 'bihar': '10', 'sikkim': '11',
  'arunachal pradesh': '12', 'nagaland': '13', 'manipur': '14', 'mizoram': '15', 'tripura': '16', 'meghalaya': '17',
  'assam': '18', 'west bengal': '19', 'jharkhand': '20', 'odisha': '21', 'chhattisgarh': '22', 'madhya pradesh': '23',
  'gujarat': '24', 'dadra and nagar haveli and daman and diu': '26', 'maharashtra': '27', 'karnataka': '29', 'goa': '30',
  'lakshadweep': '31', 'kerala': '32', 'tamil nadu': '33', 'puducherry': '34', 'andaman and nicobar islands': '35',
  'telangana': '36', 'andhra pradesh': '37', 'ladakh': '38',
};
const STATE_ALIASES = {
  'nct of delhi': 'delhi', 'new delhi': 'delhi', 'delhi ncr': 'delhi', 'orissa': 'odisha', 'uttaranchal': 'uttarakhand',
  'pondicherry': 'puducherry', 'jammu & kashmir': 'jammu and kashmir', 'andaman & nicobar islands': 'andaman and nicobar islands',
  'andaman and nicobar': 'andaman and nicobar islands', 'dadra and nagar haveli': 'dadra and nagar haveli and daman and diu',
  'daman and diu': 'dadra and nagar haveli and daman and diu', 'the dadra and nagar haveli and daman and diu': 'dadra and nagar haveli and daman and diu',
};

// Longest names first so "Andaman and Nicobar Islands" wins over a shorter match; whole words only.
function findStateIn(raw) {
  const text = ' ' + String(raw || '').toLowerCase().replace(/[^a-z& ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
  const names = [...Object.keys(STATE_CODES), ...Object.keys(STATE_ALIASES)].sort((a, b) => b.length - a.length);
  const hit = names.find((n) => text.includes(' ' + n + ' '));
  return hit || '';
}

// Spelling-tolerant matching: letters only ("U.P." -> "up", "Tamilnadu" -> "tamilnadu"), two-letter codes and common misspellings.
const STATE_ABBR = {
  jk: 'jammu and kashmir', hp: 'himachal pradesh', pb: 'punjab', ch: 'chandigarh', uk: 'uttarakhand', ut: 'uttarakhand', hr: 'haryana', dl: 'delhi',
  rj: 'rajasthan', up: 'uttar pradesh', br: 'bihar', sk: 'sikkim', ar: 'arunachal pradesh', nl: 'nagaland', mn: 'manipur', mz: 'mizoram',
  tr: 'tripura', ml: 'meghalaya', as: 'assam', wb: 'west bengal', jh: 'jharkhand', od: 'odisha', or: 'odisha', cg: 'chhattisgarh', mp: 'madhya pradesh',
  gj: 'gujarat', dd: 'dadra and nagar haveli and daman and diu', dn: 'dadra and nagar haveli and daman and diu', mh: 'maharashtra', ka: 'karnataka',
  ga: 'goa', ld: 'lakshadweep', kl: 'kerala', tn: 'tamil nadu', py: 'puducherry', an: 'andaman and nicobar islands', tg: 'telangana', ts: 'telangana',
  ap: 'andhra pradesh', la: 'ladakh',
};
const STATE_EXTRA = { chattisgarh: 'chhattisgarh', telengana: 'telangana', himachal: 'himachal pradesh', jammukashmir: 'jammu and kashmir', ncrdelhi: 'delhi', nctdelhi: 'delhi', delhincr: 'delhi', newdelhi: 'delhi', gurgaon: 'haryana', noida: 'uttar pradesh', bombay: 'maharashtra', madras: 'tamil nadu', calcutta: 'west bengal', bengal: 'west bengal' };
const compactKey = (v) => String(v || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
let COMPACT = null;
function compactMap() {
  if (COMPACT) return COMPACT;
  COMPACT = {};
  for (const n of Object.keys(STATE_CODES)) COMPACT[compactKey(n)] = n;
  for (const [a, n] of Object.entries(STATE_ALIASES)) COMPACT[compactKey(a)] = n;
  for (const [a, n] of Object.entries(STATE_EXTRA)) COMPACT[a] = n;
  return COMPACT;
}

function normaliseState(raw) {
  const k = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  let key = STATE_ALIASES[k] || k;
  if (!STATE_CODES[key]) { const c = compactKey(raw); key = compactMap()[c] || STATE_ABBR[c] || key; }
  return STATE_CODES[key] ? { name: key.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/ And /g, ' and '), code: STATE_CODES[key] } : null;
}

// Checkout stores { raw: "line, city, State - 110001" }; newer checkouts also store state/city/pincode.
function parseAddress(deliveryAddress) {
  const a = deliveryAddress || {};
  const raw = a.raw || (typeof deliveryAddress === 'string' ? deliveryAddress : '') || '';
  let state = a.state, pincode = a.pincode, city = a.city;
  if (!state || !pincode) {
    const m = raw.match(/,\s*([^,]+?)\s*-\s*(\d{6})\s*$/);
    if (m) { state = state || m[1]; pincode = pincode || m[2]; }
  }
  if (!city) {
    const parts = raw.split(',').map((s) => s.trim());
    if (parts.length >= 3) city = parts[parts.length - 2];
  }
  // Addresses typed freely (WhatsApp bot, older orders) may not end in "State - 123456": look for a state name anywhere.
  if (!normaliseState(state)) {
    const found = findStateIn(raw);
    if (found) state = found;
  }
  return { raw, state: state || '', pincode: pincode || '', city: city || '' };
}

const paise = (rupees) => Math.round(Number(rupees) * 100);

function financialYear(date) {
  // Indian FY runs Apr–Mar, judged in IST.
  const ist = new Date(date.getTime() + 5.5 * 3600 * 1000);
  const y = ist.getUTCFullYear(), m = ist.getUTCMonth() + 1;
  const start = m >= 4 ? y : y - 1;
  return `${String(start).slice(2)}-${String(start + 1).slice(2)}`;
}

function amountInWords(p) {
  const rupees = Math.floor(p / 100), ps = p % 100;
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (n) => (n < 20 ? ones[n] : tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : ''));
  const three = (n) => (n >= 100 ? ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + two(n % 100) : '') : two(n));
  function words(n) {
    if (n === 0) return 'Zero';
    const parts = [];
    const crore = Math.floor(n / 10000000); n %= 10000000;
    const lakh = Math.floor(n / 100000); n %= 100000;
    const thou = Math.floor(n / 1000); n %= 1000;
    if (crore) parts.push(three(crore) + ' Crore');
    if (lakh) parts.push(three(lakh) + ' Lakh');
    if (thou) parts.push(three(thou) + ' Thousand');
    if (n) parts.push(three(n));
    return parts.join(' ');
  }
  return `Rupees ${words(rupees)}${ps ? ' and ' + words(ps) + ' Paise' : ''} Only`;
}

function buildInvoice(order, { invoiceNo, issuedAt }) {
  const addr = parseAddress(order.delivery_address);
  const st = normaliseState(addr.state);
  const supplyType = st && st.code === '06' ? 'intra' : 'inter';

  const items = (order.items || []).map((i) => ({
    name: i.productName || i.product_retailer_id || 'Munchingo item',
    qty: Number(i.quantity) || 1,
    grossPaise: paise(i.item_price) * (Number(i.quantity) || 1),
    unit: i.unit || null,
    contents: contentsOf(i),   // gift sets: which flavours are inside
    slug: i.slug || null,
  }));
  // The shipping fee (a line with no flavours, see utils/shipping.js) is never discounted: the discount is spread over the goods only.
  items.forEach((it, idx) => { it.isShipping = require('./shipping').isShippingItem((order.items || [])[idx]); });
  const grossTotal = items.reduce((s, i) => s + i.grossPaise, 0);
  const goodsGross = items.filter((i) => !i.isShipping).reduce((s, i) => s + i.grossPaise, 0);
  const discount = Math.min(paise(order.discount_amount || 0), goodsGross);

  // Spread the discount pro-rata over the lines it was earned on: single boxes only (gift boxes and hampers are never discounted).
  // An older order whose discount exceeds its single boxes (before this rule) spreads over all goods as before.
  const BASE = require('./catalog').BASE_SLUGS;
  const singlesGross = items.filter((i) => !i.isShipping && BASE.includes(i.slug)).reduce((s, i) => s + i.grossPaise, 0);
  const onSinglesOnly = singlesGross > 0 && discount <= singlesGross;
  const eligible = (i) => !i.isShipping && (!onSinglesOnly || BASE.includes(i.slug));
  const eligibleGross = onSinglesOnly ? singlesGross : goodsGross;
  let allocated = 0;
  const lastGoods = items.map((i) => eligible(i)).lastIndexOf(true);
  items.forEach((it, idx) => {
    const d = !eligible(it) ? 0 : (idx === lastGoods ? discount - allocated : Math.round((discount * it.grossPaise) / (eligibleGross || 1)));
    allocated += d;
    it.discountPaise = d;
    it.netPaise = it.grossPaise - d;
    it.taxPaise = Math.round(it.netPaise - it.netPaise / (1 + GST_RATE / 100));
    it.taxablePaise = it.netPaise - it.taxPaise;
  });

  const taxable = items.reduce((s, i) => s + i.taxablePaise, 0);
  const tax = items.reduce((s, i) => s + i.taxPaise, 0);
  const total = items.reduce((s, i) => s + i.netPaise, 0);
  const cgst = supplyType === 'intra' ? Math.floor(tax / 2) : 0;
  const sgst = supplyType === 'intra' ? tax - cgst : 0;
  const igst = supplyType === 'inter' ? tax : 0;

  return {
    invoiceNo,
    orderId: order.order_id,
    issuedAt: issuedAt.toISOString(),
    seller: SELLER,
    gstRate: GST_RATE,
    hsn: HSN,
    buyer: {
      name: order.customer_name || 'Customer',
      phone: order.customer_phone ? `+${order.customer_phone}` : '',
      email: order.customer_email || '',
      address: addr.raw,
      city: addr.city,
      pincode: addr.pincode,
      state: st ? st.name : addr.state,
      stateCode: st ? st.code : '',
    },
    supplyType,
    placeOfSupply: st ? `${st.name} (${st.code})` : addr.state || '—',
    items,
    couponCode: order.coupon_code || null,
    grossPaise: grossTotal,
    discountPaise: discount,
    taxablePaise: taxable,
    cgstPaise: cgst,
    sgstPaise: sgst,
    igstPaise: igst,
    totalPaise: total,
    amountInWords: amountInWords(total),
    paymentId: order.payment_id || null,
  };
}

// ── PDF ───────────────────────────────────────────────────────────────────────
const C = { ink: '#2A1A12', ink2: '#5B4537', terra: '#A35A34', line: '#E4D6BE', band: '#F6EEDD', cream: '#FAF6EB' };
const INVOICE_ASSETS = path.join(__dirname, '..', 'assets', 'invoice');
// '₹' + the amount in Indian digit grouping (was 'Rs. 1,076.00', now '₹1,076.00').
const money = (p) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Line thumbnails, matched by slug as in the customer emails: a flavour shows its pack, a Trio or Full Range Set the Set photo.
// The shipping line, an item without a slug or an old WhatsApp-catalogue retailer id get none.
const THUMBS = { 'atta-original': 'original.jpg', 'atta-kesari': 'kesari.jpg', 'atta-ajwain': 'ajwain.jpg', 'atta-lite-sugar': 'lite.jpg' };
function invoiceThumb(item) {
  const slug = item && item.slug;
  if (!slug || require('./shipping').isShippingItem(item)) return null;
  const file = THUMBS[slug] || (require('./catalog').boxesForSlug(slug) > 1 ? 'set.jpg' : null);
  return file ? path.join(INVOICE_ASSETS, file) : null;
}
const THUMB = 24, THUMB_SHIFT = 30;   // the picture sits left of the item name; the name moves right by THUMB_SHIFT
const STRIP_RATIO = 200 / 1200;       // assets/invoice/strip.jpg is 1200x200
const FOOTER_TEXT = (inv) => 'Prices include GST. This is a computer-generated invoice and does not require a signature. Questions about this order? Write to ' + inv.seller.email + ' or WhatsApp ' + inv.seller.phone + '.';
const PROMO_TEXT = (inv) => 'Loved it? A Munchingo Trio or Full Range Set makes the best "just because". Visit ' + inv.seller.site + '/build-a-box';

function renderInvoicePdf(inv) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Tax Invoice ${inv.invoiceNo}`, Author: 'Munchingo' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const L = 40, R = 555, W = R - L;
    let display = 'Helvetica-Bold';
    try { doc.registerFont('Display', path.join(__dirname, '..', 'assets', 'Monthoers.otf')); display = 'Display'; } catch (_) { /* fall back to Helvetica-Bold */ }
    // Helvetica has no ₹ glyph: only the sign is drawn in Poppins-Bold (open licence). Without the file the invoice falls back to "Rs.".
    let rupee = false;
    try { doc.registerFont('Rupee', path.join(INVOICE_ASSETS, 'Poppins-Bold.ttf')); doc.font('Rupee'); rupee = true; } catch (_) { /* "Rs." */ }
    doc.font('Helvetica');

    // An amount right-aligned in [x, x + w]: the digits in the given Helvetica face end exactly where they did before,
    // the ₹ sits flush to their left on the same baseline, and an optional prefix ('- ' for a discount) to the left of that.
    const amount = (p, x, y, w, face, size, prefix = '') => {
      const digits = money(p).slice(1);
      doc.font(face).fontSize(size);
      if (!rupee) { doc.text(prefix + 'Rs. ' + digits, x, y, { width: w, align: 'right' }); return; }
      doc.text(digits, x, y, { width: w, align: 'right' });
      const digitsW = doc.widthOfString(digits), ascender = doc._font.ascender;
      doc.font('Rupee').fontSize(size);
      const signX = x + w - digitsW - doc.widthOfString('₹');
      doc.text('₹', signX, y + ((ascender - doc._font.ascender) / 1000) * size, { lineBreak: false });
      doc.font(face).fontSize(size);
      if (prefix) doc.text(prefix, signX - doc.widthOfString(prefix), y, { lineBreak: false });
    };

    // Header band: navy with the real Munchingo logo (gold ringed mark with the TM sign)
    doc.rect(0, 0, 595, 104).fill('#0B2D50');
    doc.rect(0, 104, 595, 3).fill('#CEAD5E');
    try {
      doc.image(path.join(__dirname, '..', 'assets', 'logo-tm.png'), L, 14, { fit: [150, 76] });
    } catch (_) {
      doc.fillColor('#CEAD5E').font('Helvetica-Bold').fontSize(24).text('MUNCHINGO', L, 38);
    }
    doc.fillColor('#FFF9EC').font('Helvetica-Bold').fontSize(16).text('TAX INVOICE', 330, 30, { width: R - 330, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor('#DCE3EE')
      .text(`Invoice No: ${inv.invoiceNo}`, 330, 54, { width: R - 330, align: 'right' })
      .text(`Date: ${new Date(inv.issuedAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })}`, 330, 67, { width: R - 330, align: 'right' })
      .text(`Order: ${inv.orderId}`, 330, 80, { width: R - 330, align: 'right' });

    // Seller / Buyer
    let y = 124;
    doc.fillColor(C.terra).font('Helvetica-Bold').fontSize(8).text('SOLD BY', L, y).text('BILLED & SHIPPED TO', 310, y);
    y += 13;
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(10).text(`${inv.seller.name} (Prop. ${inv.seller.proprietor})`, L, y, { width: 250 });
    doc.font('Helvetica').fontSize(9).fillColor(C.ink2)
      .text(inv.seller.address.join('\n'), L, y + 14, { width: 250 })
      .text(`GSTIN: ${inv.seller.gstin}`, L, y + 40)
      .text(`FSSAI Lic. No.: ${inv.seller.fssai}`, L, y + 52)
      .text(`${inv.seller.email}  |  ${inv.seller.phone}`, L, y + 64, { width: 260 });
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(10).text(inv.buyer.name, 310, y, { width: 245 });
    doc.font('Helvetica').fontSize(9).fillColor(C.ink2)
      .text(inv.buyer.address || '—', 310, y + 14, { width: 245 });
    const afterAddr = doc.y + 3;
    doc.text(`Phone: ${inv.buyer.phone}${inv.buyer.email ? '   |   ' + inv.buyer.email : ''}`, 310, afterAddr, { width: 245 });
    doc.text(`Place of supply: ${inv.placeOfSupply}`, 310, doc.y + 1, { width: 245 });

    // Items table
    y = 244;
    const cols = [
      { k: '#', x: L, w: 22, a: 'left' },
      { k: 'Item', x: L + 22, w: 190, a: 'left' },
      { k: 'HSN', x: L + 212, w: 40, a: 'left' },
      { k: 'Qty', x: L + 252, w: 30, a: 'right' },
      { k: 'Taxable', x: L + 282, w: 70, a: 'right' },
      { k: `GST ${inv.gstRate}%`, x: L + 352, w: 60, a: 'right' },
      { k: 'Amount', x: L + 412, w: 103, a: 'right' },
    ];
    doc.rect(L, y, W, 20).fill(C.band);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(8.5);
    cols.forEach((c) => doc.text(c.k, c.x + (c.a === 'left' ? 4 : 0), y + 6, { width: c.w - 4, align: c.a }));
    y += 20;
    const thumbX = cols[1].x + 4, nameX = thumbX + THUMB_SHIFT, nameW = cols[1].w - 4 - THUMB_SHIFT;
    inv.items.forEach((it, i) => {
      const label = it.unit ? `${it.name} (${it.unit})` : it.name;
      // The name column is 30 pt narrower than before: a long name or "Contains" line wraps and the row grows to hold it.
      doc.font('Helvetica').fontSize(9);
      const nameExtra = Math.max(0, doc.heightOfString(label, { width: nameW }) - doc.heightOfString('X', { width: nameW }));
      const contentsY = y + 19 + nameExtra;
      let rowH = 26 + nameExtra;
      // "Contains" wraps between Flavors, never inside one: the Full Range line no longer fits on one line and "Sugar-Lite" must stay whole.
      let contains = '';
      if (it.contents) {
        doc.font('Helvetica-Oblique').fontSize(7.5);
        const lines = [];
        it.contents.split(' + ').forEach((f, k) => {
          const next = k ? lines[lines.length - 1] + ' + ' + f : 'Contains: ' + f;
          if (!k || doc.widthOfString(next + ' +') <= nameW) lines[Math.max(0, lines.length - 1)] = next;   // room for a trailing ' +'
          else { lines[lines.length - 1] += ' +'; lines.push(f); }
        });
        contains = lines.join('\n');
        rowH = Math.max(34 + nameExtra, contentsY - y + doc.heightOfString(contains, { width: nameW }) + 6);
      }
      doc.font('Helvetica').fontSize(9).fillColor(C.ink);
      [String(i + 1), null, inv.hsn, String(it.qty)].forEach((v, ci) => { if (v !== null) doc.text(v, cols[ci].x + (cols[ci].a === 'left' ? 4 : 0), y + 7, { width: cols[ci].w - 4, align: cols[ci].a }); });
      doc.text(label, nameX, y + 7, { width: nameW });
      [it.taxablePaise, it.taxPaise, it.netPaise].forEach((p, k) => amount(p, cols[4 + k].x, y + 7, cols[4 + k].w - 4, 'Helvetica', 9));
      if (contains) doc.fillColor(C.ink2).font('Helvetica-Oblique').fontSize(7.5).text(contains, nameX, contentsY, { width: nameW }).font('Helvetica').fontSize(9);
      const thumb = invoiceThumb(it);
      if (thumb) {
        const ty = y + (rowH - THUMB) / 2;
        doc.save();
        try { doc.roundedRect(thumbX, ty, THUMB, THUMB, 3).clip(); doc.image(thumb, thumbX, ty, { width: THUMB, height: THUMB }); } catch (_) { /* a missing picture never stops an invoice */ } finally { doc.restore(); }
      }
      y += rowH;
      doc.moveTo(L, y).lineTo(R, y).strokeColor(C.line).lineWidth(0.6).stroke();
    });

    // Totals
    y += 12;
    const lab = 330, val = R;
    // v: paise (drawn with the ₹ sign) or plain text.
    const line = (label, v, bold, prefix) => {
      const face = bold ? 'Helvetica-Bold' : 'Helvetica', size = bold ? 11 : 9;
      doc.fillColor(bold ? C.ink : C.ink2).font(face).fontSize(size).text(label, lab, y, { width: 130 });
      if (typeof v === 'number') amount(v, lab + 130, y, val - lab - 130, face, size, prefix);
      else doc.text(v, lab + 130, y, { width: val - lab - 130, align: 'right' });
      y += bold ? 20 : 15;
    };
    line('Items total (incl. GST)', inv.grossPaise);
    if (inv.discountPaise) line(`Discount${inv.couponCode ? ' (' + inv.couponCode + ')' : ''}`, inv.discountPaise, false, '- ');
    line('Taxable value', inv.taxablePaise);
    if (inv.supplyType === 'intra') {
      line(`CGST @ ${inv.gstRate / 2}%`, inv.cgstPaise);
      line(`SGST @ ${inv.gstRate / 2}%`, inv.sgstPaise);
    } else {
      line(`IGST @ ${inv.gstRate}%`, inv.igstPaise);
    }
    // No Shipping line in the totals (Prashant, 16 Nov 2026: "The shipping should be mentioned only if it's charged. It should
    // directly come from checkout."). A charged fee is the "Shipping charges" row checkout saved on the order, shown in the items
    // table and already inside the items total and the tax above; an order without that row says nothing about shipping.
    doc.moveTo(lab, y).lineTo(R, y).strokeColor(C.terra).lineWidth(1).stroke(); y += 6;
    line('Total paid', inv.totalPaise, true);

    doc.fillColor(C.ink2).font('Helvetica-Oblique').fontSize(8.5).text(inv.amountInWords, L, y - 18, { width: 270 });
    const totalsEnd = Math.max(y, doc.y);   // the amount in words may wrap below the Total paid line

    // Photo strip between the totals and the payment box, only when everything below it still fits on page 1.
    const footerH = 62 + doc.font('Helvetica').fontSize(8).heightOfString(FOOTER_TEXT(inv), { width: W })
      + 10 + doc.font('Helvetica-Bold').fontSize(9).heightOfString(PROMO_TEXT(inv), { width: W });
    const stripH = W * STRIP_RATIO;
    const stripTop = Math.max(totalsEnd + 12, 560 - 14 - stripH);
    const stripFits = stripTop + stripH + 14 + footerH <= doc.page.height - doc.page.margins.bottom;
    let drewStrip = false;
    if (stripFits) {
      doc.save();
      try { doc.roundedRect(L, stripTop, W, stripH, 6).clip(); doc.image(path.join(INVOICE_ASSETS, 'strip.jpg'), L, stripTop, { width: W, height: stripH }); drewStrip = true; } catch (_) { /* no strip */ } finally { doc.restore(); }
    }

    // Payment + footer
    y = drewStrip ? stripTop + stripH + 14 : Math.max(y + 18, 560);
    doc.roundedRect(L, y, W, 44, 6).fill(C.cream);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9).text('Payment received', L + 12, y + 9);
    doc.font('Helvetica').fillColor(C.ink2).fontSize(8.5)
      .text(`Paid online via Razorpay${inv.paymentId ? '  |  Payment ID: ' + inv.paymentId : ''}`, L + 12, y + 23, { width: W - 24 });
    y += 62;
    doc.fillColor(C.ink2).font('Helvetica').fontSize(8)
      .text(FOOTER_TEXT(inv), L, y, { width: W });
    doc.fillColor(C.terra).font('Helvetica-Bold').fontSize(9)
      .text(PROMO_TEXT(inv), L, doc.y + 10, { width: W });
    doc.end();
  });
}

// ── Issue: number + persist + PDF ─────────────────────────────────────────────
async function issueInvoice(order) {
  const { getInvoiceByOrder, reserveInvoiceNumber, saveInvoice } = require('./database');

  const existing = await getInvoiceByOrder(order.order_id);
  if (existing) {
    return { invoice: existing.data, pdf: await renderInvoicePdf(existing.data), created: false, row: existing };
  }
  const issuedAt = new Date();
  const fy = financialYear(issuedAt);
  const seq = await reserveInvoiceNumber(fy);
  const invoiceNo = `MUN/${fy}/${String(seq).padStart(4, '0')}`;
  const invoice = buildInvoice(order, { invoiceNo, issuedAt });
  const row = await saveInvoice({ invoice, fy, seq });
  return { invoice, pdf: await renderInvoicePdf(invoice), created: true, row };
}

module.exports = { SELLER, buildInvoice, renderInvoicePdf, issueInvoice, parseAddress, normaliseState, financialYear, amountInWords, money, invoiceThumb };
