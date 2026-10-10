'use strict';

const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// Prices are GST-inclusive; this rate/GSTIN feed the tax breakup line shown
// on order emails. HSN 1905 (biscuits) is 5% GST post the Sept 2025 GST 2.0
// rate revision.
const GST_RATE = 0.05;
const GSTIN = '06AIIPN5005C2ZP';

// Every field below that originates from a customer (name, address, gift
// note, item name, feedback comments, etc.) is untrusted and must be
// escaped before landing in one of these HTML email bodies — otherwise a
// crafted value could inject markup/scripts into an email opened by the
// owner or the customer. Numbers (price, qty, rating-as-enum) are not
// escaped since they're never attacker-controlled strings.
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function gstBreakupHtml(total) {
  const gstAmount = Math.round(total - total / (1 + GST_RATE));
  return `<p style="margin:10px 0 0;font-size:12px;color:#999;">Price inclusive of GST (5%): &#8377;${gstAmount} &middot; GSTIN: ${GSTIN}</p>`;
}

async function sendOrderEmail({ orderId, customerPhone, customerName, items, total, timestamp, giftNote }) {
  const itemRows = items
    .map(
      (item) =>
        `<tr>
          <td style="padding:8px 14px;border-bottom:1px solid #f0e6d3;">${escapeHtml(item.productName || item.product_retailer_id)}</td>
          <td style="padding:8px 14px;border-bottom:1px solid #f0e6d3;text-align:center;">${item.quantity}</td>
          <td style="padding:8px 14px;border-bottom:1px solid #f0e6d3;text-align:right;">&#8377;${item.item_price * item.quantity}</td>
        </tr>`
    )
    .join('');

  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;border:1px solid #e0d0c0;border-radius:10px;overflow:hidden;">
      <div style="background:#6B3A2A;padding:22px 26px;">
        <h2 style="color:#fff;margin:0;font-size:20px;">&#127850; New Munchingo Order</h2>
        <p style="color:#f5deb3;margin:6px 0 0;font-size:14px;">Order #${orderId}</p>
      </div>
      <div style="padding:22px 26px;background:#fffaf6;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px;">
          <tr><td style="padding:4px 0;color:#888;width:110px;">Customer</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(customerName)}</td></tr>
          <tr><td style="padding:4px 0;color:#888;">WhatsApp</td><td style="padding:4px 0;">+${customerPhone}</td></tr>
          <tr><td style="padding:4px 0;color:#888;">Time</td><td style="padding:4px 0;">${new Date(timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td></tr>
        </table>
        ${giftNote ? `<div style="background:#FBEFE8;border:1px solid #B7673E;border-radius:6px;padding:.7rem 1rem;font-size:13px;margin-bottom:16px;"><strong>🎁 Gift note:</strong> ${escapeHtml(giftNote)}</div>` : ''}

        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <thead>
            <tr style="background:#f5e6d8;">
              <th style="padding:9px 14px;text-align:left;border-bottom:2px solid #e0d0c0;">Product</th>
              <th style="padding:9px 14px;text-align:center;border-bottom:2px solid #e0d0c0;">Qty</th>
              <th style="padding:9px 14px;text-align:right;border-bottom:2px solid #e0d0c0;">Amount</th>
            </tr>
          </thead>
          <tbody>${itemRows}</tbody>
          <tfoot>
            <tr style="background:#f5e6d8;">
              <td colspan="2" style="padding:10px 14px;font-weight:700;font-size:15px;">Total</td>
              <td style="padding:10px 14px;font-weight:700;font-size:15px;text-align:right;">&#8377;${total}</td>
            </tr>
          </tfoot>
        </table>
        ${gstBreakupHtml(total)}

        <p style="margin:20px 0 0;font-size:13px;color:#999;">
          Reply to this email or WhatsApp the customer at +${customerPhone} to follow up.
        </p>
      </div>
    </div>
  `;

  const { error } = await resend.emails.send({
    from: 'Munchingo Orders <orders@munchingo.com>',
    to: [process.env.NOTIFY_EMAIL],
    subject: `New Order #${orderId} - Rs.${total} from ${customerName}`,
    html,
  });

  if (error) throw new Error(error.message);
  console.log(`[MAILER] Order notification sent for #${orderId}`);
}

async function sendHumanHandoffAlert({ customerPhone, customerName, message }) {
  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;border:1px solid #e0d0c0;border-radius:10px;overflow:hidden;">
      <div style="background:#B0413E;padding:22px 26px;">
        <h2 style="color:#fff;margin:0;font-size:20px;">&#128075; Customer wants a human</h2>
      </div>
      <div style="padding:22px 26px;background:#fffaf6;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px;">
          <tr><td style="padding:4px 0;color:#888;width:110px;">Customer</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(customerName) || 'Unknown'}</td></tr>
          <tr><td style="padding:4px 0;color:#888;">WhatsApp</td><td style="padding:4px 0;">+${customerPhone}</td></tr>
          ${message ? `<tr><td style="padding:4px 0;color:#888;vertical-align:top;">Message</td><td style="padding:4px 0;">${escapeHtml(message)}</td></tr>` : ''}
        </table>
        <p style="margin:0;font-size:13px;color:#999;">
          Reply directly on WhatsApp: <a href="https://wa.me/${customerPhone}">+${customerPhone}</a>
        </p>
      </div>
    </div>
  `;

  const { error } = await resend.emails.send({
    from: 'Munchingo Orders <orders@munchingo.com>',
    to: [process.env.NOTIFY_EMAIL],
    subject: `Customer wants a human — +${customerPhone}`,
    html,
  });

  if (error) throw new Error(error.message);
  console.log(`[MAILER] Human handoff alert sent for ${customerPhone}`);
}

async function sendFeedbackAlert({ customerPhone, customerName, rating, comments }) {
  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;border:1px solid #e0d0c0;border-radius:10px;overflow:hidden;">
      <div style="background:#6B3A2A;padding:22px 26px;">
        <h2 style="color:#fff;margin:0;font-size:20px;">&#127850; New customer feedback</h2>
      </div>
      <div style="padding:22px 26px;background:#fffaf6;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px;">
          <tr><td style="padding:4px 0;color:#888;width:110px;">Customer</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(customerName) || 'Unknown'}</td></tr>
          <tr><td style="padding:4px 0;color:#888;">WhatsApp</td><td style="padding:4px 0;">+${customerPhone}</td></tr>
          <tr><td style="padding:4px 0;color:#888;">Rating</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(rating)}</td></tr>
          ${comments ? `<tr><td style="padding:4px 0;color:#888;vertical-align:top;">Comments</td><td style="padding:4px 0;">${escapeHtml(comments)}</td></tr>` : ''}
        </table>
      </div>
    </div>
  `;

  const { error } = await resend.emails.send({
    from: 'Munchingo Orders <orders@munchingo.com>',
    to: [process.env.NOTIFY_EMAIL],
    subject: `New feedback (${rating}) from +${customerPhone}`,
    html,
  });

  if (error) throw new Error(error.message);
  console.log(`[MAILER] Feedback alert sent for ${customerPhone}`);
}

async function sendBulkInquiryAlert({ customerPhone, customerName, company_name, contact_name, quantity, needed_by, budget, notes }) {
  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;border:1px solid #e0d0c0;border-radius:10px;overflow:hidden;">
      <div style="background:#6B3A2A;padding:22px 26px;">
        <h2 style="color:#fff;margin:0;font-size:20px;">&#127873; New corporate gifting inquiry</h2>
      </div>
      <div style="padding:22px 26px;background:#fffaf6;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px;">
          <tr><td style="padding:4px 0;color:#888;width:130px;">Company</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(company_name)}</td></tr>
          <tr><td style="padding:4px 0;color:#888;">Contact</td><td style="padding:4px 0;">${escapeHtml(contact_name || customerName) || 'Unknown'}</td></tr>
          <tr><td style="padding:4px 0;color:#888;">WhatsApp</td><td style="padding:4px 0;">+${customerPhone}</td></tr>
          <tr><td style="padding:4px 0;color:#888;">Quantity</td><td style="padding:4px 0;">${escapeHtml(quantity)}</td></tr>
          ${needed_by ? `<tr><td style="padding:4px 0;color:#888;">Needed by</td><td style="padding:4px 0;">${escapeHtml(needed_by)}</td></tr>` : ''}
          ${budget ? `<tr><td style="padding:4px 0;color:#888;">Budget</td><td style="padding:4px 0;">${escapeHtml(budget)}</td></tr>` : ''}
          ${notes ? `<tr><td style="padding:4px 0;color:#888;vertical-align:top;">Notes</td><td style="padding:4px 0;">${escapeHtml(notes)}</td></tr>` : ''}
        </table>
        <p style="margin:0;font-size:13px;color:#999;">
          Reply directly on WhatsApp: <a href="https://wa.me/${customerPhone}">+${customerPhone}</a>
        </p>
      </div>
    </div>
  `;

  const { error } = await resend.emails.send({
    from: 'Munchingo Orders <orders@munchingo.com>',
    to: [process.env.NOTIFY_EMAIL],
    subject: `Corporate gifting inquiry — ${company_name}`,
    html,
  });

  if (error) throw new Error(error.message);
  console.log(`[MAILER] Bulk inquiry alert sent for ${customerPhone}`);
}

// Payment-confirmed email to the customer. `invoice` + `pdf` are optional: if invoice
// generation failed (or the migration hasn't been run) the email still goes out without them.
// (The owner gets their own single order email, sendOwnerPaidEmail: no BCC copy of this one.)
async function sendCustomerConfirmationEmail({ order, invoice, pdf }) {
  const t = require('./emailTemplates');
  const payload = {
    from: 'Munchingo Orders <orders@munchingo.com>',
    to: [order.customer_email],
    subject: `Order confirmed: your Munchingo box is on its way to the oven (#${order.order_id})`,
    html: t.customerConfirmationHtml({ order, invoice }),
  };
  if (invoice && pdf) payload.attachments = [{ filename: `Munchingo-Invoice-${invoice.invoiceNo.replace(/\//g, '-')}.pdf`, content: pdf.toString('base64') }];
  const { error } = await resend.emails.send(payload);
  if (error) throw new Error(error.message);
  console.log(`[MAILER] Customer confirmation sent for #${order.order_id}${invoice ? ' with invoice ' + invoice.invoiceNo : ''}`);
}

// Owner heads-up when money actually lands (the checkout-time email fires before payment).
async function sendOwnerPaidEmail({ order, invoice, pdf }) {
  // Set OWNER_ORDER_ALERT=off on Render to rely on the 8:00 AM daily summary alone.
  if (String(process.env.OWNER_ORDER_ALERT || '').toLowerCase() === 'off') return;
  const t = require('./emailTemplates');
  const payload = {
    from: 'Munchingo Orders <orders@munchingo.com>',
    to: [process.env.NOTIFY_EMAIL],
    subject: `${order.gift_note ? '🎁 ' : ''}New order: Rs.${invoice ? invoice.totalPaise / 100 : order.total} from ${order.customer_name} (${order.order_id})`,
    html: t.ownerPaidHtml({ order, invoice }),
  };
  if (invoice && pdf) payload.attachments = [{ filename: `Munchingo-Invoice-${invoice.invoiceNo.replace(/\//g, '-')}.pdf`, content: pdf.toString('base64') }];
  const { error } = await resend.emails.send(payload);
  if (error) throw new Error(error.message);
  console.log(`[MAILER] Owner payment alert sent for #${order.order_id}`);
}

async function sendSubscriptionRenewalEmail({ email, customerName, orderId, items, discountPct, total, paymentUrl }) {
  const t = require('./emailTemplates');
  const { error } = await resend.emails.send({
    from: 'Munchingo Orders <orders@munchingo.com>',
    to: [email],
    subject: `Your next Munchingo box is ready (#${orderId})`,
    html: t.subscriptionRenewalHtml({ customerName, orderId, items, discountPct, total, paymentUrl }),
  });
  if (error) throw new Error(error.message);
  console.log(`[MAILER] Subscription renewal email sent for #${orderId}`);
}

async function sendRefundEmail({ email, customerName, orderId, amount, isFull }) {
  const t = require('./emailTemplates');
  const { error } = await resend.emails.send({
    from: 'Munchingo Orders <orders@munchingo.com>',
    to: [email],
    subject: `Your Munchingo refund for order #${orderId}`,
    html: t.refundHtml({ customerName, orderId, amount, isFull }),
  });
  if (error) throw new Error(error.message);
  console.log(`[MAILER] Refund email sent for #${orderId}`);
}

// One email to the owner for every refund, with the credit note attached.
async function sendOwnerRefundEmail({ order, refund, creditNote, pdf }) {
  const t = require('./emailTemplates');
  const payload = {
    from: 'Munchingo Orders <orders@munchingo.com>',
    to: [process.env.NOTIFY_EMAIL],
    subject: `Refund Rs.${refund.amountRupees} (${refund.isFull ? 'full' : 'partial'}): ${order.order_id} - ${refund.reason}`,
    html: t.ownerRefundHtml({ order, refund, creditNote }),
  };
  if (creditNote && pdf) payload.attachments = [{ filename: `Munchingo-Credit-Note-${creditNote.creditNoteNo.replace(/\//g, '-')}.pdf`, content: pdf.toString('base64') }];
  const { error } = await resend.emails.send(payload);
  if (error) throw new Error(error.message);
  console.log(`[MAILER] Owner refund email sent for #${order.order_id}`);
}

async function sendContactFormEmail({ name, email, orderNumber, message }) {
  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;border:1px solid #e0d0c0;border-radius:10px;overflow:hidden;">
      <div style="background:#6B3A2A;padding:22px 26px;">
        <h2 style="color:#fff;margin:0;font-size:20px;">&#9993; New contact form message</h2>
      </div>
      <div style="padding:22px 26px;background:#fffaf6;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px;">
          <tr><td style="padding:4px 0;color:#888;width:110px;">Name</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(name)}</td></tr>
          <tr><td style="padding:4px 0;color:#888;">Email</td><td style="padding:4px 0;"><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td></tr>
          ${orderNumber ? `<tr><td style="padding:4px 0;color:#888;">Order #</td><td style="padding:4px 0;">${escapeHtml(orderNumber)}</td></tr>` : ''}
        </table>
        <p style="margin:0 0 4px;color:#888;font-size:13px;">Message</p>
        <p style="margin:0;font-size:14px;white-space:pre-wrap;">${escapeHtml(message)}</p>
        <p style="margin:20px 0 0;font-size:13px;color:#999;">
          Reply directly to this email to respond to ${escapeHtml(name)}.
        </p>
      </div>
    </div>
  `;

  const { error } = await resend.emails.send({
    from: 'Munchingo Orders <orders@munchingo.com>',
    to: [process.env.NOTIFY_EMAIL],
    replyTo: email,
    subject: `Contact form: ${name}${orderNumber ? ` (Order #${orderNumber})` : ''}`,
    html,
  });

  if (error) throw new Error(error.message);
  console.log(`[MAILER] Contact form email sent from ${email}`);
}

function formatAddress(order) {
  const addr = order.delivery_address;
  if (!addr) return '(no address on file)';
  return escapeHtml(typeof addr === 'string' ? addr : (addr.raw || JSON.stringify(addr)));
}

function csvCell(v) {
  const t = String(v ?? '');
  return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

// 8:00 AM summary of the previous day: totals, pack list, every order, plus a CSV for accounting.
async function sendDailyDigestEmail({ orders, dayLabel, invoicesByOrder = {}, creditNotes = [] }) {
  const t = require('./emailTemplates');
  const { contentsOf } = require('./orderText');
  const revenue = orders.reduce((n, o) => n + Number(o.total || 0), 0);
  const payload = {
    from: 'Munchingo Orders <orders@munchingo.com>',
    to: [process.env.NOTIFY_EMAIL],
    subject: (orders.length ? `Munchingo ${dayLabel}: ${orders.length} order${orders.length === 1 ? '' : 's'}, Rs.${revenue}` : `Munchingo ${dayLabel}: no orders`) + (creditNotes.length ? ` (${creditNotes.length} refund${creditNotes.length === 1 ? '' : 's'})` : ''),
    html: t.dailySummaryHtml({ dayLabel, orders, invoicesByOrder, creditNotes }),
  };
  if (orders.length) {
    const head = ['order_id', 'paid_at_ist', 'name', 'phone', 'email', 'items', 'boxes', 'gift_note', 'coupon', 'discount', 'total', 'invoice_no', 'taxable', 'cgst', 'sgst', 'igst', 'payment_id', 'ship_to'];
    const { boxesIn } = require('./orderText');
    const rows = orders.map((o) => {
      const i = invoicesByOrder[o.order_id] || {};
      const items = (o.items || []).map((it) => `${it.productName} x${it.quantity}${contentsOf(it) ? ' (' + contentsOf(it) + ')' : ''}`).join('; ');
      const boxes = (o.items || []).reduce((n, it) => n + (Number(it.quantity) || 0) * boxesIn(it), 0);
      return [o.order_id, new Date(o.updated_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), o.customer_name, '+' + o.customer_phone, o.customer_email || '', items, boxes, o.gift_note || '', o.coupon_code || '', o.discount_amount || 0, o.total, i.invoice_no || '', (i.taxable_paise || 0) / 100, (i.cgst_paise || 0) / 100, (i.sgst_paise || 0) / 100, (i.igst_paise || 0) / 100, o.payment_id || '', (o.delivery_address && o.delivery_address.raw) || ''];
    });
    const csv = [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
    payload.attachments = [{ filename: `munchingo-orders-${dayLabel.replace(/[^A-Za-z0-9]+/g, '-')}.csv`, content: Buffer.from('\uFEFF' + csv, 'utf8').toString('base64') }];
  }
  const { error } = await resend.emails.send(payload);
  if (error) throw new Error(error.message);
  console.log(`[MAILER] Daily summary sent for ${dayLabel}: ${orders.length} orders`);
}

module.exports = { sendOwnerRefundEmail, sendOrderEmail, sendCustomerConfirmationEmail, sendOwnerPaidEmail, sendHumanHandoffAlert, sendFeedbackAlert, sendBulkInquiryAlert, sendDailyDigestEmail, sendContactFormEmail, sendSubscriptionRenewalEmail, sendRefundEmail };
