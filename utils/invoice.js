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

function normaliseState(raw) {
  const k = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const key = STATE_ALIASES[k] || k;
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
  }));
  const grossTotal = items.reduce((s, i) => s + i.grossPaise, 0);
  const discount = Math.min(paise(order.discount_amount || 0), grossTotal);

  // Spread the discount pro-rata; the last line absorbs rounding so the sum is exact.
  let allocated = 0;
  items.forEach((it, idx) => {
    const d = idx === items.length - 1 ? discount - allocated : Math.round((discount * it.grossPaise) / (grossTotal || 1));
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
const rs = (p) => 'Rs. ' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

    // Header band
    doc.rect(0, 0, 595, 96).fill(C.cream);
    doc.rect(0, 96, 595, 3).fill(C.terra);
    doc.fillColor(C.terra).font(display).fontSize(30).text('MUNCHINGO', L, 30, { characterSpacing: 1 });
    doc.fillColor(C.ink2).font('Helvetica').fontSize(8.5).text('Tiny Treats, Mighty Flavors.', L, 66);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(16).text('TAX INVOICE', 330, 30, { width: R - 330, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor(C.ink2)
      .text(`Invoice No: ${inv.invoiceNo}`, 330, 54, { width: R - 330, align: 'right' })
      .text(`Date: ${new Date(inv.issuedAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })}`, 330, 67, { width: R - 330, align: 'right' })
      .text(`Order: ${inv.orderId}`, 330, 80, { width: R - 330, align: 'right' });

    // Seller / Buyer
    let y = 116;
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
    y = 232;
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
    doc.font('Helvetica').fontSize(9);
    inv.items.forEach((it, i) => {
      const label = it.unit ? `${it.name} (${it.unit})` : it.name;
      const row = [String(i + 1), label, inv.hsn, String(it.qty), rs(it.taxablePaise), rs(it.taxPaise), rs(it.netPaise)];
      cols.forEach((c, ci) => doc.fillColor(C.ink).text(row[ci], c.x + (c.a === 'left' ? 4 : 0), y + 7, { width: c.w - 4, align: c.a }));
      y += 26;
      doc.moveTo(L, y).lineTo(R, y).strokeColor(C.line).lineWidth(0.6).stroke();
    });

    // Totals
    y += 12;
    const lab = 330, val = R;
    const line = (label, v, bold) => {
      doc.fillColor(bold ? C.ink : C.ink2).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9)
        .text(label, lab, y, { width: 130 }).text(v, lab + 130, y, { width: val - lab - 130, align: 'right' });
      y += bold ? 20 : 15;
    };
    line('Items total (incl. GST)', rs(inv.grossPaise));
    if (inv.discountPaise) line(`Discount${inv.couponCode ? ' (' + inv.couponCode + ')' : ''}`, '- ' + rs(inv.discountPaise));
    line('Taxable value', rs(inv.taxablePaise));
    if (inv.supplyType === 'intra') {
      line(`CGST @ ${inv.gstRate / 2}%`, rs(inv.cgstPaise));
      line(`SGST @ ${inv.gstRate / 2}%`, rs(inv.sgstPaise));
    } else {
      line(`IGST @ ${inv.gstRate}%`, rs(inv.igstPaise));
    }
    line('Shipping', 'Free');
    doc.moveTo(lab, y).lineTo(R, y).strokeColor(C.terra).lineWidth(1).stroke(); y += 6;
    line('Total paid', rs(inv.totalPaise), true);

    doc.fillColor(C.ink2).font('Helvetica-Oblique').fontSize(8.5).text(inv.amountInWords, L, y - 18, { width: 270 });

    // Payment + footer
    y = Math.max(y + 18, 560);
    doc.roundedRect(L, y, W, 44, 6).fill(C.cream);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9).text('Payment received', L + 12, y + 9);
    doc.font('Helvetica').fillColor(C.ink2).fontSize(8.5)
      .text(`Paid online via Razorpay${inv.paymentId ? '  |  Payment ID: ' + inv.paymentId : ''}`, L + 12, y + 23, { width: W - 24 });
    y += 62;
    doc.fillColor(C.ink2).font('Helvetica').fontSize(8)
      .text('Prices include GST. This is a computer-generated invoice and does not require a signature. Questions about this order? Write to ' + inv.seller.email + ' or WhatsApp ' + inv.seller.phone + '.', L, y, { width: W });
    doc.fillColor(C.terra).font('Helvetica-Bold').fontSize(9)
      .text('Loved it? A Munchingo gift set makes the best "just because". Visit ' + inv.seller.site + '/#gifts', L, doc.y + 10, { width: W });
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

module.exports = { SELLER, buildInvoice, renderInvoicePdf, issueInvoice, parseAddress, normaliseState, financialYear, amountInWords };
