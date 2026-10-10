'use strict';

/**
 * Customer-facing email design. One shared shell (navy header with the logo, cream body,
 * footer with contact + GSTIN/FSSAI) and a reusable "gift it / browse more" block, so every
 * email invites the customer back to the shop. Table layout + inline styles for Gmail/Outlook.
 * Images are served from munchingo.com (they go live with the website push).
 */

const SITE = 'https://munchingo.com';
const C = { navy: '#0B2D50', gold: '#CEAD5E', terra: '#A35A34', terraDeep: '#86482A', ink: '#2A1A12', ink2: '#5B4537', cream: '#FAF6EB', paper: '#FFFDF8', line: '#E9DCC3', band: '#F3E6CC' };
const FONT = "'Poppins','Helvetica Neue',Helvetica,Arial,sans-serif";

const FLAVOURS = [
  { slug: 'atta-original', name: 'Atta Original', tag: 'Gently sweet', price: 259, img: 'email-original.jpg' },
  { slug: 'atta-kesari', name: 'Atta Kesari', tag: 'Royally sweet', price: 299, img: 'email-kesari.jpg' },
  { slug: 'atta-ajwain', name: 'Atta Ajwain', tag: 'Spiced & less sweet', price: 259, img: 'email-ajwain.jpg' },
  { slug: 'atta-lite-sugar', name: 'Atta Sugar-Lite', tag: 'No added sugar', price: 299, img: 'email-lite.jpg' },
];

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const inr = (n) => '&#8377;' + Number(n).toLocaleString('en-IN');
const inrPaise = (p) => '&#8377;' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function button(href, label, style = 'solid') {
  const solid = style === 'solid';
  return `<a href="${href}" style="display:inline-block;background:${solid ? C.terra : 'transparent'};color:${solid ? '#FFF6E8' : C.terra};border:2px solid ${C.terra};font-family:${FONT};font-weight:600;font-size:13px;letter-spacing:.08em;text-transform:uppercase;text-decoration:none;padding:13px 26px;border-radius:999px;">${label} &#8599;</a>`;
}

// ── Gift block ────────────────────────────────────────────────────────────────
function giftBlock() {
  return `
  <tr><td style="padding:8px 28px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.navy};border-radius:16px;">
      <tr><td style="padding:28px 26px;text-align:center;">
        <div style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:${C.gold};">Love it? Pass it on</div>
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.2;color:#FFF9EC;margin:10px 0 8px;">Somebody you love deserves a box too.</div>
        <div style="font-family:${FONT};font-size:14px;line-height:1.6;color:#DCE3EE;margin:0 auto 18px;max-width:420px;">Pick a gift set, fill it with their favourite flavours and add a note in your own words. We pack it in Faridabad and ship it straight to their door, anywhere in India.</div>
        <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto 20px;">
          <tr>
            <td style="background:#14406B;border-radius:12px;padding:12px 18px;font-family:${FONT};color:#FFF9EC;font-size:13px;text-align:center;"><b style="color:${C.gold};font-size:18px;">${inr(739)}</b><br>Trio set &middot; any 3 flavours</td>
            <td width="12"></td>
            <td style="background:#14406B;border-radius:12px;padding:12px 18px;font-family:${FONT};color:#FFF9EC;font-size:13px;text-align:center;"><b style="color:${C.gold};font-size:18px;">${inr(999)}</b><br>Full Range &middot; all 4</td>
          </tr>
        </table>
        <a href="${SITE}/gifting.html#gifting" style="display:inline-block;background:${C.gold};color:${C.navy};font-family:${FONT};font-weight:700;font-size:13px;letter-spacing:.08em;text-transform:uppercase;text-decoration:none;padding:14px 30px;border-radius:999px;">Build a gift set &#8599;</a>
      </td></tr>
    </table>
  </td></tr>`;
}

// ── Browse block: flavours they haven't tried yet come first ──────────────────
function browseBlock(boughtSlugs = [], heading = 'Which one is next?') {
  const bought = new Set(boughtSlugs);
  const ordered = [...FLAVOURS.filter((f) => !bought.has(f.slug)), ...FLAVOURS.filter((f) => bought.has(f.slug))];
  const tiles = ordered.slice(0, 4).map((f) => `
        <td width="50%" valign="top" style="padding:7px;">
          <a href="${SITE}/${f.slug}.html" style="text-decoration:none;display:block;border:1px solid ${C.line};border-radius:14px;background:${C.paper};overflow:hidden;">
            <img src="${SITE}/images/${f.img}" width="240" alt="${esc(f.name)}" style="display:block;width:100%;height:auto;border:0;">
            <div style="padding:12px 14px 14px;font-family:${FONT};text-align:left;">
              <div style="font-size:10.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${C.terra};">${esc(f.tag)}</div>
              <div style="font-size:15px;font-weight:600;color:${C.ink};margin:3px 0 2px;">${esc(f.name)}</div>
              <div style="font-size:13px;color:${C.ink2};">${inr(f.price)} &middot; 250g &nbsp;<span style="color:${C.terra};font-weight:600;">Shop &#8599;</span></div>
            </div>
          </a>
        </td>`);
  return `
  <tr><td style="padding:30px 21px 0;">
    <div style="padding:0 7px 8px;font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:${C.terra};">The range</div>
    <div style="padding:0 7px 10px;font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.2;color:${C.ink};">${esc(heading)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>${tiles[0]}${tiles[1] || ''}</tr>
      <tr>${tiles[2] || ''}${tiles[3] || ''}</tr>
    </table>
  </td></tr>`;
}

// ── Shell ─────────────────────────────────────────────────────────────────────
function shell({ preheader = '', title, subtitle = '', body, promo = 'full', boughtSlugs = [], browseHeading }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${C.band};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.band};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:${C.cream};border-radius:18px;overflow:hidden;">
  <tr><td style="background:${C.navy};padding:22px 28px;text-align:center;">
    <a href="${SITE}" style="text-decoration:none;"><img src="${SITE}/images/logo-gold-v2.png" height="46" alt="Munchingo" style="height:46px;width:auto;border:0;"></a>
  </td></tr>
  <tr><td style="padding:34px 28px 6px;text-align:center;">
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:31px;line-height:1.15;color:${C.ink};">${title}</div>
    ${subtitle ? `<div style="font-family:${FONT};font-size:15px;line-height:1.6;color:${C.ink2};margin:12px auto 0;max-width:430px;">${subtitle}</div>` : ''}
  </td></tr>
  ${body}
  ${promo === 'full' ? giftBlock() + browseBlock(boughtSlugs, browseHeading) : ''}
  ${promo === 'light' ? browseBlock(boughtSlugs, browseHeading || 'Come back hungry') : ''}
  <tr><td style="padding:34px 28px 10px;text-align:center;">
    ${button(SITE, 'Visit munchingo.com', 'outline')}
  </td></tr>
  <tr><td style="padding:22px 28px 30px;text-align:center;font-family:${FONT};font-size:12px;line-height:1.7;color:${C.ink2};">
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:17px;color:${C.terra};margin-bottom:6px;">Tiny Treats, Mighty Flavors.</div>
    Questions? WhatsApp <a href="https://wa.me/919988992024" style="color:${C.terra};text-decoration:none;font-weight:600;">+91 99889 92024</a> &middot; <a href="mailto:info.munchingo@gmail.com" style="color:${C.terra};text-decoration:none;font-weight:600;">info.munchingo@gmail.com</a> &middot; <a href="https://instagram.com/munchingo.delhi" style="color:${C.terra};text-decoration:none;font-weight:600;">@munchingo.delhi</a><br>
    Baked in small batches in Bikaner &middot; Made in India &middot; Vegetarian<br>
    <span style="color:#8A7765;">Munchingo, H. No. 43, Sector 14, Faridabad, Haryana 121007 &middot; GSTIN 06AIIPN5005C2ZP &middot; FSSAI Lic. 10826003000333</span>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// ── Order summary table (shared) ──────────────────────────────────────────────
function summaryTable({ items, totalRupees, discountRupees = 0, couponCode = null, gstAmount }) {
  const rows = items.map((it) => `
      <tr>
        <td style="padding:11px 0;border-bottom:1px solid ${C.line};font-family:${FONT};font-size:14px;color:${C.ink};">${esc(it.productName || it.name || it.product_retailer_id)}${it.unit ? `<span style="color:${C.ink2};"> &middot; ${esc(it.unit)}</span>` : ''}</td>
        <td style="padding:11px 0;border-bottom:1px solid ${C.line};font-family:${FONT};font-size:14px;color:${C.ink2};text-align:center;">&times;${it.quantity}</td>
        <td style="padding:11px 0;border-bottom:1px solid ${C.line};font-family:${FONT};font-size:14px;color:${C.ink};text-align:right;">${inr((it.item_price ?? 0) * it.quantity)}</td>
      </tr>`).join('');
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${rows}
      ${discountRupees ? `<tr><td colspan="2" style="padding:10px 0 0;font-family:${FONT};font-size:13px;color:${C.ink2};">Discount${couponCode ? ` (${esc(couponCode)})` : ''}</td><td style="padding:10px 0 0;font-family:${FONT};font-size:13px;color:#2F7A4B;text-align:right;">&minus; ${inr(discountRupees)}</td></tr>` : ''}
      <tr><td colspan="2" style="padding:14px 0 2px;font-family:${FONT};font-size:16px;font-weight:700;color:${C.ink};">Total paid</td><td style="padding:14px 0 2px;font-family:${FONT};font-size:18px;font-weight:700;color:${C.ink};text-align:right;">${inr(totalRupees)}</td></tr>
      ${gstAmount != null ? `<tr><td colspan="3" style="padding:0;font-family:${FONT};font-size:11.5px;color:#8A7765;">Includes GST (5%): ${inrPaise(gstAmount)} &middot; Free shipping</td></tr>` : ''}
    </table>`;
}

function card(inner) {
  return `<tr><td style="padding:22px 28px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.paper};border:1px solid ${C.line};border-radius:16px;"><tr><td style="padding:22px 24px;">${inner}</td></tr></table></td></tr>`;
}

function steps() {
  const s = [
    ['1', 'Packed fresh', 'Boxed by hand in Faridabad, fresh from the bakery.'],
    ['2', 'On its way', 'Shipped across India. We&rsquo;ll update you on WhatsApp.'],
    ['3', 'Snack time', 'Open, share, and save the last bite for yourself.'],
  ];
  return `<tr><td style="padding:22px 28px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${s.map(([n, h, t]) => `
    <td width="33%" valign="top" style="padding:0 6px;text-align:center;">
      <div style="width:34px;height:34px;line-height:34px;border-radius:50%;background:${C.terra};color:#FFF6E8;font-family:${FONT};font-weight:700;font-size:14px;margin:0 auto 8px;">${n}</div>
      <div style="font-family:${FONT};font-size:13px;font-weight:700;color:${C.ink};">${h}</div>
      <div style="font-family:${FONT};font-size:12px;line-height:1.5;color:${C.ink2};margin-top:3px;">${t}</div>
    </td>`).join('')}</tr></table></td></tr>`;
}

// ── Customer: payment confirmed + invoice ─────────────────────────────────────
function customerConfirmationHtml({ order, invoice }) {
  const first = String(order.customer_name || 'there').trim().split(/\s+/)[0];
  const items = order.items || [];
  const gstAmount = invoice ? invoice.cgstPaise + invoice.sgstPaise + invoice.igstPaise : null;
  const discount = Number(order.discount_amount || 0);
  const when = new Date(order.created_at || Date.now()).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

  const body = [
    card(`
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${C.terra};">Order ${esc(order.order_id)}</td>
        <td style="font-family:${FONT};font-size:12px;color:${C.ink2};text-align:right;">${esc(when)}</td>
      </tr></table>
      <div style="height:10px;"></div>
      ${summaryTable({ items, totalRupees: order.total, discountRupees: discount, couponCode: order.coupon_code, gstAmount })}`),
    order.gift_note ? `<tr><td style="padding:16px 28px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBEFE8;border:1px dashed ${C.terra};border-radius:12px;"><tr><td style="padding:14px 18px;font-family:${FONT};font-size:13px;color:${C.ink};"><b style="color:${C.terra};">&#127873; Your gift note</b><br>${esc(order.gift_note)}</td></tr></table></td></tr>` : '',
    invoice ? `<tr><td style="padding:16px 28px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EAF1EC;border-radius:12px;"><tr><td style="padding:14px 18px;font-family:${FONT};font-size:13px;line-height:1.55;color:${C.ink};"><b>&#128196; Your GST tax invoice is attached</b><br><span style="color:${C.ink2};">Invoice ${esc(invoice.invoiceNo)} &middot; PDF attached to this email. Keep it handy for your records.</span></td></tr></table></td></tr>` : '',
    steps(),
  ].join('');

  const bought = items.map((i) => i.slug).filter(Boolean);
  return shell({
    preheader: `Payment received. Your Munchingo order ${order.order_id} is confirmed${invoice ? ` and your invoice ${invoice.invoiceNo} is attached` : ''}.`,
    title: `Thank you, ${esc(first)}. Your box is in the oven.`,
    subtitle: 'Your payment is confirmed. We&rsquo;ll pack your order by hand in Faridabad and message you on WhatsApp the moment it ships.',
    body,
    promo: 'full',
    boughtSlugs: bought,
    browseHeading: bought.length ? 'Curious about the others?' : 'Which one is next?',
  });
}

// ── Customer: subscription box ready ──────────────────────────────────────────
function subscriptionRenewalHtml({ customerName, orderId, items, discountPct, total, paymentUrl }) {
  const first = String(customerName || 'there').trim().split(/\s+/)[0];
  const body = [
    card(`
      <div style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${C.terra};margin-bottom:10px;">Subscribe &amp; Save &middot; ${discountPct}% off &middot; Order ${esc(orderId)}</div>
      ${summaryTable({ items, totalRupees: total, gstAmount: Math.round((total - total / 1.05) * 100) }).replace('Total paid', `Total (after ${discountPct}% subscriber discount)`)}
      <div style="text-align:center;padding:22px 0 4px;">${button(paymentUrl, `Pay &#8377;${total} to confirm`)}</div>`),
    `<tr><td style="padding:14px 34px 0;font-family:${FONT};font-size:12.5px;line-height:1.6;color:${C.ink2};text-align:center;">Delivering somewhere else this time, or want to skip, pause or cancel? Just reply to this email or WhatsApp us at +91 99889 92024.</td></tr>`,
  ].join('');
  return shell({
    preheader: `Your next Munchingo box is ready. Pay ₹${total} to confirm.`,
    title: `Your next box is ready, ${esc(first)}.`,
    subtitle: 'Same cookies you love, fresh from the oven. One tap to confirm and we&rsquo;ll pack it.',
    body,
    promo: 'full',
    boughtSlugs: (items || []).map((i) => i.slug).filter(Boolean),
    browseHeading: 'Fancy something new this month?',
  });
}

// ── Customer: refund ──────────────────────────────────────────────────────────
function refundHtml({ customerName, orderId, amount, isFull }) {
  const first = String(customerName || 'there').trim().split(/\s+/)[0];
  const body = card(`
    <div style="font-family:${FONT};font-size:14px;line-height:1.7;color:${C.ink};">
      We&rsquo;ve refunded <b>${inr(amount)}</b> for order ${esc(orderId)}${isFull ? ', and the order is now cancelled' : ''}.<br><br>
      It should reach your original payment method within 5&ndash;7 working days, depending on your bank. If it hasn&rsquo;t arrived after that, reply to this email and we&rsquo;ll help trace it.
    </div>`);
  return shell({
    preheader: `Your refund of ₹${amount} for order ${orderId} is on its way.`,
    title: `Your refund is on its way, ${esc(first)}.`,
    subtitle: 'Sorry we couldn&rsquo;t get this one right. We&rsquo;d love another chance.',
    body,
    promo: 'light',
    browseHeading: 'Come back hungry',
  });
}

// ── Owner: payment received + invoice ─────────────────────────────────────────
function ownerPaidHtml({ order, invoice }) {
  const total = invoice ? invoice.totalPaise / 100 : order.total;
  const rows = [
    ['Customer', esc(order.customer_name)],
    ['WhatsApp', `+${esc(order.customer_phone)}`],
    ['Email', esc(order.customer_email || 'not given (invoice sent on WhatsApp only)')],
    ['Ship to', esc((order.delivery_address && order.delivery_address.raw) || '')],
    ['Invoice', invoice ? esc(invoice.invoiceNo) : 'not generated (run invoices_migration.sql)'],
    ['Supply', invoice ? `${invoice.supplyType === 'intra' ? 'CGST+SGST' : 'IGST'} &middot; ${esc(invoice.placeOfSupply)}` : '&mdash;'],
  ].map(([k, v]) => `<tr><td style="padding:5px 0;color:#8A7765;width:92px;vertical-align:top;font-family:${FONT};font-size:13px;">${k}</td><td style="padding:5px 0;font-family:${FONT};font-size:13px;color:${C.ink};">${v}</td></tr>`).join('');
  return `<!doctype html><html><body style="margin:0;background:${C.band};"><table role="presentation" width="100%"><tr><td align="center" style="padding:20px 10px;">
  <table role="presentation" width="560" style="width:100%;max-width:560px;background:${C.cream};border-radius:14px;overflow:hidden;">
    <tr><td style="background:#2F7A4B;padding:20px 26px;font-family:${FONT};color:#fff;"><div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;opacity:.85;">Payment received</div><div style="font-size:22px;font-weight:700;margin-top:4px;">${inr(total)} &middot; Order ${esc(order.order_id)}</div></td></tr>
    <tr><td style="padding:20px 26px;"><table role="presentation" width="100%">${rows}</table>
      <div style="height:14px;"></div>${summaryTable({ items: order.items || [], totalRupees: total, discountRupees: Number(order.discount_amount || 0), couponCode: order.coupon_code })}
      ${order.gift_note ? `<p style="font-family:${FONT};font-size:13px;color:${C.ink};background:#FBEFE8;border-radius:8px;padding:10px 14px;">&#127873; <b>Gift note:</b> ${esc(order.gift_note)}</p>` : ''}
      <p style="font-family:${FONT};font-size:12px;color:#8A7765;margin:16px 0 0;">The customer&rsquo;s copy of the invoice is attached here too.</p></td></tr>
  </table></td></tr></table></body></html>`;
}

module.exports = { customerConfirmationHtml, subscriptionRenewalHtml, refundHtml, ownerPaidHtml, shell, FLAVOURS };
