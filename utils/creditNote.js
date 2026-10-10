'use strict';

/**
 * GST credit notes for refunds. A refund returns the customer's money; the credit note is the tax
 * document that reduces the original sale (and the GST you owe on it) - see Section 34 CGST Act.
 *
 *   buildCreditNote(invoice, { amountPaise, refundId, reason... }) -> plain object (money in paise)
 *   renderCreditNotePdf(cn)                                         -> Promise<Buffer>
 *   issueCreditNote({ invoice, amountPaise, ... })                  -> number + store + PDF (idempotent per refund)
 *
 * A full refund mirrors the invoice exactly. A part refund takes the same share (amount / invoice total)
 * of every line, then backs 5% GST out of each share, so taxable + GST always equals the refunded amount.
 */

const path = require('path');
const PDFDocument = require('pdfkit');
const { financialYear, amountInWords } = require('./invoice');
const { reasonOf } = require('./refundReasons');

const GST_RATE = 5;

function buildCreditNote(invoice, { amountPaise, refundId, paymentId, reasonCode, reasonNote, creditNoteNo, issuedAt }) {
  const isFull = amountPaise >= invoice.totalPaise;
  const total = isFull ? invoice.totalPaise : amountPaise;

  // Share of each line (pro-rata by amount); the last line takes the rounding remainder.
  let allocated = 0;
  const items = invoice.items.map((it, idx) => {
    const last = idx === invoice.items.length - 1;
    const net = isFull ? it.netPaise : (last ? total - allocated : Math.round((it.netPaise * total) / invoice.totalPaise));
    allocated += net;
    const tax = isFull ? it.taxPaise : Math.round(net - net / (1 + GST_RATE / 100));
    return { name: it.name, unit: it.unit, contents: it.contents || '', qty: it.qty, netPaise: net, taxPaise: tax, taxablePaise: net - tax };
  });
  const taxable = items.reduce((n, i) => n + i.taxablePaise, 0);
  const tax = items.reduce((n, i) => n + i.taxPaise, 0);
  const intra = invoice.supplyType === 'intra';
  const cgst = intra ? Math.floor(tax / 2) : 0;
  const sgst = intra ? tax - cgst : 0;
  const igst = intra ? 0 : tax;

  return {
    creditNoteNo, refundId, paymentId: paymentId || invoice.paymentId || null,
    orderId: invoice.orderId, invoiceNo: invoice.invoiceNo, invoiceDate: invoice.issuedAt,
    issuedAt: issuedAt.toISOString(),
    seller: invoice.seller, buyer: invoice.buyer, supplyType: invoice.supplyType, placeOfSupply: invoice.placeOfSupply,
    hsn: invoice.hsn, gstRate: GST_RATE,
    reasonCode: reasonCode || 'other', reasonLabel: reasonOf(reasonCode).label, reasonNote: reasonNote || '',
    isFull, items,
    amountPaise: total, taxablePaise: taxable, cgstPaise: cgst, sgstPaise: sgst, igstPaise: igst,
    amountInWords: amountInWords(total),
  };
}

const C = { ink: '#2A1A12', ink2: '#5B4537', terra: '#A35A34', line: '#E4D6BE', band: '#F6EEDD', cream: '#FAF6EB' };
const rs = (p) => 'Rs. ' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function renderCreditNotePdf(cn) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Credit Note ${cn.creditNoteNo}`, Author: 'Munchingo' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const L = 40, R = 555, W = R - L;

    doc.rect(0, 0, 595, 104).fill('#0B2D50');
    doc.rect(0, 104, 595, 3).fill('#CEAD5E');
    try { doc.image(path.join(__dirname, '..', 'assets', 'logo-tm.png'), L, 14, { fit: [150, 76] }); }
    catch (_) { doc.fillColor('#CEAD5E').font('Helvetica-Bold').fontSize(24).text('MUNCHINGO', L, 38); }
    const dt = (iso) => new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
    doc.fillColor('#FFF9EC').font('Helvetica-Bold').fontSize(16).text('CREDIT NOTE', 330, 30, { width: R - 330, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor('#DCE3EE')
      .text(`Credit Note No: ${cn.creditNoteNo}`, 330, 54, { width: R - 330, align: 'right' })
      .text(`Date: ${dt(cn.issuedAt)}`, 330, 67, { width: R - 330, align: 'right' })
      .text(`Against Invoice: ${cn.invoiceNo} (${dt(cn.invoiceDate)})`, 330, 80, { width: R - 330, align: 'right' });

    let y = 124;
    doc.fillColor(C.terra).font('Helvetica-Bold').fontSize(8).text('ISSUED BY', L, y).text('CREDITED TO', 310, y);
    y += 13;
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(10).text(`${cn.seller.name} (Prop. ${cn.seller.proprietor})`, L, y, { width: 250 });
    doc.font('Helvetica').fontSize(9).fillColor(C.ink2)
      .text(cn.seller.address.join('\n'), L, y + 14, { width: 250 })
      .text(`GSTIN: ${cn.seller.gstin}`, L, y + 40)
      .text(`${cn.seller.email}  |  ${cn.seller.phone}`, L, y + 52, { width: 260 });
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(10).text(cn.buyer.name, 310, y, { width: 245 });
    doc.font('Helvetica').fontSize(9).fillColor(C.ink2).text(cn.buyer.address || '-', 310, y + 14, { width: 245 });
    doc.text(`Place of supply: ${cn.placeOfSupply}`, 310, doc.y + 2, { width: 245 });

    y = 232;
    doc.roundedRect(L, y, W, 40, 6).fill(C.cream);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9).text('Reason', L + 12, y + 8);
    doc.font('Helvetica').fillColor(C.ink2).fontSize(9).text(`${cn.reasonLabel}${cn.reasonNote ? ' - ' + cn.reasonNote : ''}   |   Order ${cn.orderId}   |   ${cn.isFull ? 'Full' : 'Partial'} refund`, L + 12, y + 22, { width: W - 24 });

    y = 290;
    const cols = [
      { k: '#', x: L, w: 22, a: 'left' }, { k: 'Item', x: L + 22, w: 200, a: 'left' }, { k: 'HSN', x: L + 222, w: 40, a: 'left' },
      { k: 'Taxable', x: L + 262, w: 80, a: 'right' }, { k: `GST ${cn.gstRate}%`, x: L + 342, w: 70, a: 'right' }, { k: 'Credited', x: L + 412, w: 103, a: 'right' },
    ];
    doc.rect(L, y, W, 20).fill(C.band);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(8.5);
    cols.forEach((c) => doc.text(c.k, c.x + (c.a === 'left' ? 4 : 0), y + 6, { width: c.w - 4, align: c.a }));
    y += 20; doc.font('Helvetica').fontSize(9);
    cn.items.filter((i) => i.netPaise > 0).forEach((it, i) => {
      const label = it.unit ? `${it.name} (${it.unit})` : it.name;
      const row = [String(i + 1), label, cn.hsn, rs(it.taxablePaise), rs(it.taxPaise), rs(it.netPaise)];
      cols.forEach((c, ci) => doc.fillColor(C.ink).text(row[ci], c.x + (c.a === 'left' ? 4 : 0), y + 7, { width: c.w - 4, align: c.a }));
      if (it.contents) doc.fillColor(C.ink2).font('Helvetica-Oblique').fontSize(7.5).text('Contains: ' + it.contents, cols[1].x + 4, y + 19, { width: cols[1].w - 4 }).font('Helvetica').fontSize(9);
      y += it.contents ? 34 : 26;
      doc.moveTo(L, y).lineTo(R, y).strokeColor(C.line).lineWidth(0.6).stroke();
    });

    y += 12; const lab = 330;
    const line = (label, v, bold) => {
      doc.fillColor(bold ? C.ink : C.ink2).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9)
        .text(label, lab, y, { width: 130 }).text(v, lab + 130, y, { width: R - lab - 130, align: 'right' });
      y += bold ? 20 : 15;
    };
    line('Taxable value credited', rs(cn.taxablePaise));
    if (cn.supplyType === 'intra') { line(`CGST @ ${cn.gstRate / 2}%`, rs(cn.cgstPaise)); line(`SGST @ ${cn.gstRate / 2}%`, rs(cn.sgstPaise)); }
    else line(`IGST @ ${cn.gstRate}%`, rs(cn.igstPaise));
    doc.moveTo(lab, y).lineTo(R, y).strokeColor(C.terra).lineWidth(1).stroke(); y += 6;
    line('Total credited / refunded', rs(cn.amountPaise), true);
    doc.fillColor(C.ink2).font('Helvetica-Oblique').fontSize(8.5).text(cn.amountInWords, L, y - 18, { width: 270 });

    y = Math.max(y + 18, 520);
    doc.roundedRect(L, y, W, 44, 6).fill(C.cream);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9).text('Refund', L + 12, y + 9);
    doc.font('Helvetica').fillColor(C.ink2).fontSize(8.5).text(`Refunded to the original payment method via Razorpay${cn.refundId ? '  |  Refund ID: ' + cn.refundId : ''}`, L + 12, y + 23, { width: W - 24 });
    doc.fillColor(C.ink2).font('Helvetica').fontSize(8)
      .text('This credit note reduces the taxable value and GST of the invoice referred to above. Computer-generated; no signature required. Questions: ' + cn.seller.email + ' or WhatsApp ' + cn.seller.phone + '.', L, y + 62, { width: W });
    doc.end();
  });
}

async function issueCreditNote({ invoice, amountPaise, refundId, paymentId, reasonCode, reasonNote }) {
  const { getCreditNoteByRefund, reserveInvoiceNumber, saveCreditNote } = require('./database');
  const existing = await getCreditNoteByRefund(refundId);
  if (existing) return { creditNote: existing.data, pdf: await renderCreditNotePdf(existing.data), created: false, row: existing };
  const issuedAt = new Date();
  const fy = financialYear(issuedAt);
  const seq = await reserveInvoiceNumber(`CN-${fy}`);
  const creditNoteNo = `CN/${fy}/${String(seq).padStart(4, '0')}`;
  const creditNote = buildCreditNote(invoice, { amountPaise, refundId, paymentId, reasonCode, reasonNote, creditNoteNo, issuedAt });
  const row = await saveCreditNote({ creditNote, fy, seq });
  return { creditNote, pdf: await renderCreditNotePdf(creditNote), created: true, row };
}

module.exports = { buildCreditNote, renderCreditNotePdf, issueCreditNote };
