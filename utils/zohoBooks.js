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
 *   ZOHO_DEPOSIT_ACCOUNT_ID  (account payments land in; Undeposited Funds works until a Razorpay bank/clearing account exists),
 *   ZOHO_GST_TAX_ID_5        (5% GST group, used for Haryana -> Haryana sales: CGST 2.5% + SGST 2.5%),
 *   ZOHO_IGST_TAX_ID_5       (IGST 5%, used for every other state),
 *   ZOHO_PAYMENT_MODE        (optional, default "others")
 * Munchingo org values (read via the Zoho Books connector on 2026-10-10): org 60091499971, DC "in",
 *   GST5 = 4288800000000034214, IGST5 = 4288800000000034177, Undeposited Funds = 4288800000000000456.
 * Get the refresh token once with scripts/zoho-get-refresh-token.js.
 */

const axios = require('axios');

// Catalog items created in the Munchingo Books org on 2026-10-10 (HSN 1905, GST5 / IGST5).
// Keyed by the item name our checkout stores (utils/catalog.js NAMES). Override with ZOHO_ITEM_IDS='{"Atta Original":"..."}'.
const ITEM_IDS = {
  'Atta Original': '4288800000000039021',
  'Atta Kesari': '4288800000000041001',
  'Atta Ajwain': '4288800000000039030',
  'Atta Sugar-Lite': '4288800000000042001',
  'Trio Gift Set': '4288800000000043001',
  'Full Range Gift Set': '4288800000000034246',
};
const itemIds = () => ({ ...ITEM_IDS, ...(process.env.ZOHO_ITEM_IDS ? JSON.parse(process.env.ZOHO_ITEM_IDS) : {}) });

// Orders from the WhatsApp catalogue store names like "Munchingo Atta Original" (and older ones other spellings),
// the website stores "Atta Original". Match on the flavour/set so both reach the same Zoho item.
function itemIdFor(name) {
  const ids = itemIds();
  if (ids[name]) return ids[name];
  const n = String(name || '').toLowerCase();
  const key = /full\s*range/.test(n) ? 'Full Range Gift Set'
    : /trio/.test(n) ? 'Trio Gift Set'
    : /ajwain/.test(n) ? 'Atta Ajwain'
    : /kesari/.test(n) ? 'Atta Kesari'
    : /(sugar|lite)/.test(n) ? 'Atta Sugar-Lite'
    : /original/.test(n) ? 'Atta Original' : null;
  return key ? ids[key] : undefined;
}

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
  // Same person (name + phone) always maps to the same Books customer; different people who share a name don't merge.
  const displayName = `${buyer.name} (${buyer.phone || 'no phone'})`.slice(0, 100);
  const found = await call('get', '/contacts', { params: { contact_name: displayName } });
  const hit = (found.contacts || []).find((c) => c.contact_name === displayName);
  if (hit) return hit.contact_id;
  const created = await call('post', '/contacts', {
    data: {
      contact_name: displayName,
      contact_type: 'customer',
      customer_sub_type: 'individual',
      gst_treatment: 'consumer',
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

  const taxId = invoice.supplyType === 'intra' ? process.env.ZOHO_GST_TAX_ID_5 : process.env.ZOHO_IGST_TAX_ID_5;

  // Line rate is the GST-inclusive net price per unit after discount (is_inclusive_tax = true).
  const ids = itemIds();
  const line_items = invoice.items.map((it) => ({
    item_id: itemIdFor(it.name),
    name: it.name,
    description: `${it.name}${it.unit ? ' (' + it.unit + ')' : ''}${it.contents ? ' - ' + it.contents : ''} - HSN ${invoice.hsn}`,
    rate: +(it.netPaise / it.qty / 100).toFixed(2),
    quantity: it.qty,
    hsn_or_sac: invoice.hsn,
    ...(taxId ? { tax_id: taxId } : {}),
  }));

  const missing = invoice.items.filter((it) => !itemIdFor(it.name)).map((it) => it.name);
  if (missing.length) throw new Error('No Zoho item for: ' + missing.join(', ') + ' (add it in Books and ZOHO_ITEM_IDS)');

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
        payment_mode: process.env.ZOHO_PAYMENT_MODE || 'others',
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

/**
 * Credit note + refund for a refunded order. Needs the extra OAuth scope ZohoBooks.creditnotes.CREATE
 * (re-run scripts/zoho-get-refresh-token.js with it). Returns null when Zoho isn't configured.
 */
async function syncCreditNote({ creditNote, zohoInvoiceId }) {
  if (!configured()) return null;
  const contactId = await findOrCreateContact(creditNote.buyer);
  const date = new Date(creditNote.issuedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const taxId = creditNote.supplyType === 'intra' ? process.env.ZOHO_GST_TAX_ID_5 : process.env.ZOHO_IGST_TAX_ID_5;
  const missing = creditNote.items.filter((it) => it.netPaise > 0 && !itemIdFor(it.name)).map((it) => it.name);
  if (missing.length) throw new Error('No Zoho item for: ' + missing.join(', '));

  const line_items = creditNote.items.filter((it) => it.netPaise > 0).map((it) => ({
    item_id: itemIdFor(it.name),
    name: it.name,
    description: `Refund: ${it.name}${it.contents ? ' - ' + it.contents : ''} (against ${creditNote.invoiceNo}) - HSN ${creditNote.hsn}`,
    rate: +(it.netPaise / 100).toFixed(2),
    quantity: 1,
    hsn_or_sac: creditNote.hsn,
    ...(taxId ? { tax_id: taxId } : {}),
  }));

  // Zoho (India) wants a credit note tied to the invoice it reverses, otherwise: "Select the associated invoice number" (12069).
  const cn = await call('post', '/creditnotes', {
    params: { ignore_auto_number_generation: true, ...(zohoInvoiceId ? { invoice_id: zohoInvoiceId } : {}) },
    data: {
      ...(zohoInvoiceId ? { invoice_id: zohoInvoiceId } : {}),
      customer_id: contactId,
      creditnote_number: creditNote.creditNoteNo,
      reference_number: creditNote.invoiceNo,
      date,
      is_inclusive_tax: true,
      gst_treatment: 'consumer',
      place_of_supply: creditNote.buyer.stateCode ? stateAbbrev(creditNote.buyer.stateCode) : 'HR',
      line_items,
      notes: `Refund for order ${creditNote.orderId}: ${creditNote.reasonLabel}${creditNote.reasonNote ? ' - ' + creditNote.reasonNote : ''}`,
    },
  });
  const creditNoteId = cn.creditnote.creditnote_id;

  // Money out: the refund against this credit note, from the same account the sale was deposited to.
  if (process.env.ZOHO_DEPOSIT_ACCOUNT_ID) {
    await call('post', `/creditnotes/${creditNoteId}/refunds`, {
      data: {
        date,
        refund_mode: process.env.ZOHO_PAYMENT_MODE || 'others',
        amount: creditNote.amountPaise / 100,
        from_account_id: process.env.ZOHO_DEPOSIT_ACCOUNT_ID,
        reference_number: creditNote.refundId,
        description: `Razorpay refund ${creditNote.refundId} for ${creditNote.orderId}`,
      },
    });
  }
  return { creditNoteId };
}

module.exports = { configured, syncPaidOrder, syncCreditNote };
