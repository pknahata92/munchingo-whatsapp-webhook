'use strict';

const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// Prices are GST-inclusive; this rate/GSTIN feed the tax breakup line shown
// on order emails. HSN 1905 (biscuits) is 5% GST post the Sept 2025 GST 2.0
// rate revision.
const GST_RATE = 0.05;
const GSTIN = '06AIIPN5005C2ZP';

function gstBreakupHtml(total) {
  const gstAmount = Math.round(total - total / (1 + GST_RATE));
  return `<p style="margin:10px 0 0;font-size:12px;color:#999;">Price inclusive of GST (5%): &#8377;${gstAmount} &middot; GSTIN: ${GSTIN}</p>`;
}

async function sendOrderEmail({ orderId, customerPhone, customerName, items, total, timestamp }) {
  const itemRows = items
    .map(
      (item) =>
        `<tr>
          <td style="padding:8px 14px;border-bottom:1px solid #f0e6d3;">${item.productName || item.product_retailer_id}</td>
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
          <tr><td style="padding:4px 0;color:#888;width:110px;">Customer</td><td style="padding:4px 0;font-weight:600;">${customerName}</td></tr>
          <tr><td style="padding:4px 0;color:#888;">WhatsApp</td><td style="padding:4px 0;">+${customerPhone}</td></tr>
          <tr><td style="padding:4px 0;color:#888;">Time</td><td style="padding:4px 0;">${new Date(timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td></tr>
        </table>

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
          <tr><td style="padding:4px 0;color:#888;width:110px;">Customer</td><td style="padding:4px 0;font-weight:600;">${customerName || 'Unknown'}</td></tr>
          <tr><td style="padding:4px 0;color:#888;">WhatsApp</td><td style="padding:4px 0;">+${customerPhone}</td></tr>
          ${message ? `<tr><td style="padding:4px 0;color:#888;vertical-align:top;">Message</td><td style="padding:4px 0;">${message}</td></tr>` : ''}
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
          <tr><td style="padding:4px 0;color:#888;width:110px;">Customer</td><td style="padding:4px 0;font-weight:600;">${customerName || 'Unknown'}</td></tr>
          <tr><td style="padding:4px 0;color:#888;">WhatsApp</td><td style="padding:4px 0;">+${customerPhone}</td></tr>
          <tr><td style="padding:4px 0;color:#888;">Rating</td><td style="padding:4px 0;font-weight:600;">${rating}</td></tr>
          ${comments ? `<tr><td style="padding:4px 0;color:#888;vertical-align:top;">Comments</td><td style="padding:4px 0;">${comments}</td></tr>` : ''}
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
          <tr><td style="padding:4px 0;color:#888;width:130px;">Company</td><td style="padding:4px 0;font-weight:600;">${company_name}</td></tr>
          <tr><td style="padding:4px 0;color:#888;">Contact</td><td style="padding:4px 0;">${contact_name || customerName || 'Unknown'}</td></tr>
          <tr><td style="padding:4px 0;color:#888;">WhatsApp</td><td style="padding:4px 0;">+${customerPhone}</td></tr>
          <tr><td style="padding:4px 0;color:#888;">Quantity</td><td style="padding:4px 0;">${quantity}</td></tr>
          ${needed_by ? `<tr><td style="padding:4px 0;color:#888;">Needed by</td><td style="padding:4px 0;">${needed_by}</td></tr>` : ''}
          ${budget ? `<tr><td style="padding:4px 0;color:#888;">Budget</td><td style="padding:4px 0;">${budget}</td></tr>` : ''}
          ${notes ? `<tr><td style="padding:4px 0;color:#888;vertical-align:top;">Notes</td><td style="padding:4px 0;">${notes}</td></tr>` : ''}
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

async function sendCustomerConfirmationEmail({ email, orderId, customerName, items, total, timestamp }) {
  const itemRows = items
    .map(
      (item) =>
        `<tr>
          <td style="padding:8px 14px;border-bottom:1px solid #f0e6d3;">${item.productName || item.product_retailer_id}</td>
          <td style="padding:8px 14px;border-bottom:1px solid #f0e6d3;text-align:center;">${item.quantity}</td>
          <td style="padding:8px 14px;border-bottom:1px solid #f0e6d3;text-align:right;">&#8377;${item.item_price * item.quantity}</td>
        </tr>`
    )
    .join('');

  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;border:1px solid #e0d0c0;border-radius:10px;overflow:hidden;">
      <div style="background:#6B3A2A;padding:22px 26px;">
        <h2 style="color:#fff;margin:0;font-size:20px;">&#127850; Thanks for your order, ${customerName}!</h2>
        <p style="color:#f5deb3;margin:6px 0 0;font-size:14px;">Order #${orderId}</p>
      </div>
      <div style="padding:22px 26px;background:#fffaf6;">
        <p style="margin:0 0 16px;font-size:14px;color:#555;">
          Your payment for the order below has been confirmed. We'll pack it fresh and ship within 1-2 business days -- you'll get a tracking update on WhatsApp once it's dispatched.
        </p>

        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:8px;">
          <tr><td style="padding:4px 0;color:#888;width:110px;">Order date</td><td style="padding:4px 0;">${new Date(timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td></tr>
        </table>

        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px;">
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
          Questions about your order? WhatsApp us at +91 99889 92024 or reply to this email.
        </p>
      </div>
    </div>
  `;

  const { error } = await resend.emails.send({
    from: 'Munchingo Orders <orders@munchingo.com>',
    to: [email],
    subject: `Your Munchingo order #${orderId} is confirmed!`,
    html,
  });

  if (error) throw new Error(error.message);
  console.log(`[MAILER] Customer confirmation sent for #${orderId}`);
}

async function sendContactFormEmail({ name, email, orderNumber, message }) {
  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;border:1px solid #e0d0c0;border-radius:10px;overflow:hidden;">
      <div style="background:#6B3A2A;padding:22px 26px;">
        <h2 style="color:#fff;margin:0;font-size:20px;">&#9993; New contact form message</h2>
      </div>
      <div style="padding:22px 26px;background:#fffaf6;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px;">
          <tr><td style="padding:4px 0;color:#888;width:110px;">Name</td><td style="padding:4px 0;font-weight:600;">${name}</td></tr>
          <tr><td style="padding:4px 0;color:#888;">Email</td><td style="padding:4px 0;"><a href="mailto:${email}">${email}</a></td></tr>
          ${orderNumber ? `<tr><td style="padding:4px 0;color:#888;">Order #</td><td style="padding:4px 0;">${orderNumber}</td></tr>` : ''}
        </table>
        <p style="margin:0 0 4px;color:#888;font-size:13px;">Message</p>
        <p style="margin:0;font-size:14px;white-space:pre-wrap;">${message}</p>
        <p style="margin:20px 0 0;font-size:13px;color:#999;">
          Reply directly to this email to respond to ${name}.
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
  return typeof addr === 'string' ? addr : (addr.raw || JSON.stringify(addr));
}

async function sendDailyDigestEmail({ orders, windowLabel }) {
  // Always send, even with zero orders — a "no orders today" email that
  // reliably arrives every morning is also the simplest proof the digest
  // pipeline itself is alive. Skipping on empty made a real pipeline outage
  // indistinguishable from a genuinely slow day (see CLAUDE.md 2026-08-11).
  if (!orders.length) {
    const { error } = await resend.emails.send({
      from: 'Munchingo Orders <orders@munchingo.com>',
      to: [process.env.NOTIFY_EMAIL],
      subject: `Daily packing list — 0 orders`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;border:1px solid #e0d0c0;border-radius:10px;overflow:hidden;">
          <div style="background:#6B3A2A;padding:22px 26px;">
            <h2 style="color:#fff;margin:0;font-size:20px;">&#128230; Munchingo Daily Packing List</h2>
            <p style="color:#f5deb3;margin:6px 0 0;font-size:14px;">${windowLabel} &middot; 0 orders</p>
          </div>
          <div style="padding:22px 26px;background:#fffaf6;">
            <p style="font-size:14px;color:#444;margin:0;">No orders turned <strong>paid</strong> in the last 24 hours. Nothing to pack today.</p>
          </div>
        </div>
      `,
    });
    if (error) throw new Error(error.message);
    console.log('[MAILER] Daily digest sent — 0 orders');
    return;
  }

  // Packing summary: total quantity per product across all of today's orders,
  // so whoever's packing can pull stock once instead of re-reading every order.
  const productTotals = {};
  orders.forEach((o) => {
    (o.items || []).forEach((item) => {
      const key = item.productName || item.product_retailer_id || 'Unknown item';
      productTotals[key] = (productTotals[key] || 0) + Number(item.quantity || 0);
    });
  });
  const packingRows = Object.entries(productTotals)
    .map(([name, qty]) => `<tr><td style="padding:6px 14px;border-bottom:1px solid #f0e6d3;">${name}</td><td style="padding:6px 14px;border-bottom:1px solid #f0e6d3;text-align:right;font-weight:600;">${qty}</td></tr>`)
    .join('');

  const revenue = orders.reduce((sum, o) => sum + Number(o.total || 0), 0);

  const orderCards = orders.map((o) => {
    const itemLines = (o.items || [])
      .map((item) => `${item.productName || item.product_retailer_id} × ${item.quantity}`)
      .join('<br>');
    return `
      <div style="border:1px solid #e0d0c0;border-radius:8px;padding:14px 18px;margin-bottom:12px;">
        <div style="font-weight:700;color:#6B3A2A;margin-bottom:6px;">#${o.order_id} — ₹${o.total}</div>
        <div style="font-size:13px;color:#444;line-height:1.6;">
          <strong>${o.customer_name || 'Unknown'}</strong> · +${o.customer_phone}<br>
          ${itemLines}<br>
          <span style="color:#888;">Ship to:</span> ${formatAddress(o)}
        </div>
      </div>`;
  }).join('');

  const html = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;border:1px solid #e0d0c0;border-radius:10px;overflow:hidden;">
      <div style="background:#6B3A2A;padding:22px 26px;">
        <h2 style="color:#fff;margin:0;font-size:20px;">&#128230; Munchingo Daily Packing List</h2>
        <p style="color:#f5deb3;margin:6px 0 0;font-size:14px;">${windowLabel} &middot; ${orders.length} order${orders.length === 1 ? '' : 's'} &middot; &#8377;${revenue} collected</p>
      </div>
      <div style="padding:22px 26px;background:#fffaf6;">
        <h3 style="font-size:14px;color:#6B3A2A;margin:0 0 8px;">Pack today</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:22px;">
          <tbody>${packingRows}</tbody>
        </table>

        <h3 style="font-size:14px;color:#6B3A2A;margin:0 0 8px;">Orders &amp; shipping labels</h3>
        ${orderCards}
      </div>
    </div>
  `;

  const { error } = await resend.emails.send({
    from: 'Munchingo Orders <orders@munchingo.com>',
    to: [process.env.NOTIFY_EMAIL],
    subject: `Daily packing list — ${orders.length} order${orders.length === 1 ? '' : 's'}, ₹${revenue}`,
    html,
  });

  if (error) throw new Error(error.message);
  console.log(`[MAILER] Daily digest sent — ${orders.length} orders`);
}

module.exports = { sendOrderEmail, sendCustomerConfirmationEmail, sendHumanHandoffAlert, sendFeedbackAlert, sendBulkInquiryAlert, sendDailyDigestEmail, sendContactFormEmail };
