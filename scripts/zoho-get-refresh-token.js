'use strict';
/**
 * One-time helper: turns a Zoho "Self Client" grant code into a refresh token.
 *
 * 1. https://api-console.zoho.in  ->  Add Client  ->  Self Client  (copy Client ID + Client Secret)
 * 2. Self Client -> "Generate Code" tab. Scope:
 *      ZohoBooks.invoices.CREATE,ZohoBooks.contacts.CREATE,ZohoBooks.contacts.READ,ZohoBooks.customerpayments.CREATE,ZohoBooks.settings.READ
 *    Time duration 10 minutes -> Create -> copy the code.
 * 3. Run (secrets stay on your machine; nothing is printed except the refresh token):
 *      ZOHO_CLIENT_ID=... ZOHO_CLIENT_SECRET=... ZOHO_GRANT_CODE=... node scripts/zoho-get-refresh-token.js
 * 4. Paste the printed token into Render as ZOHO_REFRESH_TOKEN (plus ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET).
 */
const axios = require('axios');
const dc = process.env.ZOHO_DC || 'in';
(async () => {
  const { ZOHO_CLIENT_ID: id, ZOHO_CLIENT_SECRET: secret, ZOHO_GRANT_CODE: code } = process.env;
  if (!id || !secret || !code) { console.error('Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_GRANT_CODE.'); process.exit(1); }
  const res = await axios.post(`https://accounts.zoho.${dc}/oauth/v2/token`, null, {
    params: { grant_type: 'authorization_code', client_id: id, client_secret: secret, code },
  });
  if (!res.data.refresh_token) { console.error('No refresh token returned:', JSON.stringify(res.data)); process.exit(1); }
  console.log('ZOHO_REFRESH_TOKEN=' + res.data.refresh_token);
})().catch((e) => { console.error(e.response?.data || e.message); process.exit(1); });
