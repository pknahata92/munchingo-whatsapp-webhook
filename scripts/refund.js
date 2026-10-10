'use strict';
/**
 * Refund or cancel an order from your Mac.
 *
 *   node scripts/refund.js MNG-ABCD-1015                       # full refund, reason "other"
 *   node scripts/refund.js MNG-ABCD-1015 full out_of_stock     # full refund, item out of stock
 *   node scripts/refund.js MNG-ABCD-1015 259 damaged "one box crushed"   # partial: Rs 259
 *   node scripts/refund.js MNG-ABCD-1015 cancel                # UNPAID order: just cancel it
 *   node scripts/refund.js reasons                             # list the reason codes
 *
 * Needs DIGEST_SECRET in your shell (the same value as on Render). Safest way, hidden as you type:
 *   read -s "DIGEST_SECRET?Secret: " && export DIGEST_SECRET && node scripts/refund.js ...
 */
const axios = require('axios');
const { REASONS } = require('../utils/refundReasons');

const [, , orderId, amountArg, reasonCode = 'other', note = ''] = process.argv;
const base = process.env.BACKEND_URL || 'https://munchingo-whatsapp-webhook.onrender.com';

(async () => {
  if (!orderId || orderId === 'reasons') {
    console.log('Reason codes:\n' + Object.entries(REASONS).map(([k, v]) => `  ${k.padEnd(20)} ${v.label}`).join('\n'));
    return;
  }
  if (!process.env.DIGEST_SECRET) { console.error('Set DIGEST_SECRET first (see the comment at the top of this file).'); process.exit(1); }
  const headers = { 'x-admin-secret': process.env.DIGEST_SECRET };
  try {
    if (amountArg === 'cancel') {
      const r = await axios.post(`${base}/internal/cancel`, { orderId }, { headers, timeout: 90000 });
      console.log(r.data); return;
    }
    const body = { orderId, reasonCode, note };
    if (amountArg && amountArg !== 'full') body.amountRupees = Number(amountArg);
    const r = await axios.post(`${base}/internal/refund`, body, { headers, timeout: 90000 });
    console.log(r.data);
  } catch (e) {
    console.error('Failed:', e.response ? `${e.response.status} ${JSON.stringify(e.response.data)}` : e.message);
    process.exit(1);
  }
})();
