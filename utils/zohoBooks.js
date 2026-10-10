'use strict';

/**
 * Pushes each paid order into Zoho Books: customer contact -> invoice (tax-inclusive, 5% GST,
 * same invoice number as our PDF) -> customer payment against it. No-ops cleanly until the
 * ZOHO_* env vars are set, so the rest of the payment flow never depends on it.
 *
 * One-time setup (Zoho API console, "Self Client"):
 *   scope  ZohoBooks.invoices.CREATE,ZohoBooks.contacts.CREATE,ZohoBooks.contacts.READ,
 *          ZohoBooks.customerpayments.CREATE,ZohoBooks.settings.READ
 *   -> exchange the grant code once for a refresh token, then set on Render:
 *   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORG_ID,
 *   ZOHO_DC (in | com | eu ...; default "in"),
 *   ZOHO_DEPOSIT_ACCOUNT_ID  (the bank/"Razorpay clearing" account payments land in),
 *   ZOHO_GST_TAX_ID_5        (the 5% GST tax id, optional if tax is set on the items)
 */

const axios = require('axios');

const dc = () => process.env.ZOHO_DC || 'in';
const accountsUrl = () => `https://accounts.zoho.${dc()}/oauth/v2/token`;
const apiUrl = () => `https://www.zohoapis.${dc()}/books/v3`;

function configured() {
  return ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ORG_ID'].every((k) => process.env[k]);
}

let _token = null, _tokenExp = 0;
async function accessToken() {
  if (_token && Date.now() < _tokenExp - 60_000) return _token;
  const res = await axios.post(accountsUrl(), null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token',
    },
  });
  if (!res.data.access_token) throw new Error('Zoho token refresh failed: ' + JSON.stringify(res.data));
  _token = res.data.access_token;
  _tokenExp = Date.now() + (res.data.expires_in || 3600) * 1000;
  return _token;
}

async function call(method, path, { params, data } = {}) {
  const token = await accessToken();
  const res = await axios({
    method,
    url: apiUrl() + path,
    params: { organization_id: process.env.ZOHO_ORG_ID, ...(params || {}) },
    data,
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  if (res.data.code !== 0) throw new Error(`Zoho ${path}: ${res.data.message}`);
  return res.data;
}

async function findOrCreateContact(buyer) {
  const email = buyer.email || undefined;
  const search = email ? { email } : { contact_name: buyer.name };
  const found = await call('get', '/contacts', { params: search });
  const hit = (found.contacts || []).find((c) => (email ? c.email === email : c.contact_name === buyer.name));
  if (hit) return hit.contact_id;
  const created = await call('post', '/contacts', {
    data: {
      contact_name: buyer.name,
      contact_type: 'customer',
      customer_sub_type: 'individual',
      place_of_contact: buyer.stateCode ? stateAbbrev(buyer.stateCode) : undefined,
      contact_persons: [{ first_name: buyer.name, email: buyer.email || undefined, mobile: buyer.phone || undefined, is_primary_contact: true }],
      billing_address: { address: buyer.address, city: buyer.city, state: buyer.state, zip: buyer.pincode, country: 'India' },
    },
  });
  return created.contact.contact_id;
}

// GST state codes -> Zoho's two-letter place_of_supply codes.
const ABBREV = { '01': 'JK', '02': 'HP', '03': 'PB', '04': 'CH', '05': 'UT', '06': 'HR', '07': 'DL', '08': 'RJ', '09': 'UP', '10': 'BR', '11': 'SK', '12': 'AR', '13': 'NL', '14': 'MN', '15': 'MZ', '16': 'TR', '17': 'ML', '18': 'AS', '19': 'WB', '20': 'JH', '21': 'OD', '22': 'CG', '23': 'MP', '24': 'GJ', '26': 'DN', '27': 'MH', '29': 'KA', '30': 'GA', '31': 'LD', '32': 'KL', '33': 'TN', '34': 'PY', '35': 'AN', '36': 'TS', '37': 'AP', '38': 'LA' };
const stateAbbrev = (code) => ABBREV[code];

/**
 * @returns {Promise<{ invoiceId: string }|null>} null when Zoho isn't configured.
 */
async function syncPaidOrder({ invoice, order }) {
  if (!configured()) return null;

  const contactId = await findOrCreateContact(invoice.buyer);
  const date = new Date(invoice.issuedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  // Line rate is the GST-inclusive net price per unit after discount (is_inclusive_tax = true).
  const line_items = invoice.items.map((it) => ({
    name: it.name,
    description: `${it.name}${it.unit ? ' (' + it.unit + ')' : ''} - HSN ${invoice.hsn}`,
    rate: +(it.netPaise / it.qty / 100).toFixed(2),
    quantity: it.qty,
    hsn_or_sac: invoice.hsn,
    ...(process.env.ZOHO_GST_TAX_ID_5 ? { tax_id: process.env.ZOHO_GST_TAX_ID_5 } : {}),
  }));

  const inv = await call('post', '/invoices', {
    params: { ignore_auto_number_generation: true },
    data: {
      customer_id: contactId,
      invoice_number: invoice.invoiceNo,
      reference_number: invoice.orderId,
      date,
      due_date: date,
      is_inclusive_tax: true,
      gst_treatment: 'consumer',
      place_of_supply: invoice.buyer.stateCode ? stateAbbrev(invoice.buyer.stateCode) : 'HR',
      line_items,
      notes: invoice.couponCode ? `Coupon ${invoice.couponCode} applied (pro-rata across lines).` : undefined,
    },
  });
  const invoiceId = inv.invoice.invoice_id;

  if (process.env.ZOHO_DEPOSIT_ACCOUNT_ID) {
    await call('post', '/customerpayments', {
      data: {
        customer_id: contactId,
        payment_mode: 'Razorpay',
        amount: invoice.totalPaise / 100,
        date,
        reference_number: invoice.paymentId || order.payment_id || undefined,
        account_id: process.env.ZOHO_DEPOSIT_ACCOUNT_ID,
        invoices: [{ invoice_id: invoiceId, amount_applied: invoice.totalPaise / 100 }],
      },
    });
  }
  return { invoiceId };
}

module.exports = { configured, syncPaidOrder };
