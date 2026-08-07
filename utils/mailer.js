'use strict';

const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

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

module.exports = { sendOrderEmail };
