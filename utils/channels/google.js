'use strict';

/**
 * Google Merchant Center client (Merchant API): signs in as a service account, does the one-time setup,
 * reads the four products and pushes availability and prices through a supplemental data source.
 * Needs GOOGLE_MERCHANT_KEY (the service-account JSON) and GOOGLE_MERCHANT_ID (Prashant adds both on Render; Claude never sees them).
 * The key only ever leaves this file as a signature, and the access token only in the Authorization header:
 * neither is in a URL, a log or an error message.
 * `http` is axios-compatible: http(config) resolves { data }. Tests pass a fake, so nothing here touches the network on its own.
 */
const crypto = require('crypto');
const { GOOGLE_OFFER_IDS, toGoogle, fromGoogle } = require('./shape');

const API = 'https://merchantapi.googleapis.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/content';
const JWT_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const SOURCE_NAME = 'Munchingo admin stock';
const TIMEOUT_MS = 20000;
const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
// Google's own words for a failure: { error: { message } } from the API, { error, error_description } from the token endpoint.
const wording = (body) => { const e = body && body.error; return e && (typeof e === 'string' ? body.error_description || e : e.message); };

function makeGoogle({ http = require('axios'), keyJson = process.env.GOOGLE_MERCHANT_KEY, accountId = process.env.GOOGLE_MERCHANT_ID, now = Date.now } = {}) {
  const secret = {};   // jwt and token once we have them: scrubbed out of any message we throw
  let creds; let cached;

  // The service-account key, or null when it is missing or incomplete. Never echo a parse error: it can quote the JSON.
  const credentials = () => {
    if (creds === undefined) {
      try { const k = typeof keyJson === 'string' ? JSON.parse(keyJson) : keyJson; creds = k && k.client_email && k.private_key ? k : null; } catch (e) { creds = null; }
    }
    return creds;
  };
  const account = () => String(accountId == null ? '' : accountId).trim();
  const configured = () => !!(account() && credentials());
  const ready = () => { if (!configured()) throw new Error('google: key or account number not set'); };
  const acct = (service) => `${API}/${service}/v1/accounts/${encodeURIComponent(account())}`;
  const fail = (msg, status) => {
    let m = String(msg || 'request failed');
    [credentials() && credentials().private_key, secret.jwt, secret.token].forEach((s) => { if (s) m = m.split(s).join('[hidden]'); });
    const e = new Error(`google: ${m}`);
    if (status) e.status = status;
    return e;
  };

  // One Merchant API call with a bearer token. A failure (HTTP error, network error or an { error } body) becomes Error('google: <message>').
  async function call(config, { auth = true } = {}) {
    const headers = auth ? { Authorization: `Bearer ${await token()}` } : config.headers;
    let data;
    try {
      ({ data } = await http({ ...config, headers, timeout: TIMEOUT_MS }));
    } catch (e) {
      const r = e.response || {};
      throw fail(wording(r.data) || e.message, r.status);
    }
    if (data && data.error) throw fail(wording(data));
    return data || {};
  }

  // Access token for the service account (RS256 JWT exchanged at Google), reused until 60 s before it expires.
  async function token() {
    ready();
    if (cached && now() < cached.until) return cached.value;
    const k = credentials(); const t0 = now(); const iat = Math.floor(t0 / 1000);
    const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iss: k.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 })}`;
    try { secret.jwt = `${unsigned}.${crypto.createSign('RSA-SHA256').update(unsigned).sign(k.private_key).toString('base64url')}`; } catch (e) { throw fail('could not sign with the service-account key'); }
    const data = await call({
      method: 'POST', url: TOKEN_URL, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: `grant_type=${encodeURIComponent(JWT_GRANT)}&assertion=${secret.jwt}`,
    }, { auth: false });
    if (!data.access_token) throw fail('no access token in the reply');
    secret.token = data.access_token;
    cached = { value: data.access_token, until: t0 + ((Number(data.expires_in) || 3600) - 60) * 1000 };
    return cached.value;
  }

  // Every item of a paged list, following nextPageToken.
  async function listAll(url, field, pageSize) {
    const out = []; let next = '';
    do {
      const q = [pageSize && `pageSize=${pageSize}`, next && `pageToken=${encodeURIComponent(next)}`].filter(Boolean).join('&');
      const data = await call({ method: 'GET', url: q ? `${url}?${q}` : url });
      out.push(...(data[field] || [])); next = data.nextPageToken || '';
    } while (next);
    return out;
  }

  // The primary whose rule must take ours first: the one FILE primary (a Google Sheet when there are several FILE primaries).
  // An autofeed or API primary is never it. Anything but exactly one stops set-up with the by-hand message.
  function sheetOf(primaries) {
    const files = primaries.filter((s) => s.input === 'FILE');
    const sheets = files.length > 1 ? files.filter((s) => (s.fileInput || {}).fileInputType === 'GOOGLE_SHEETS') : files;
    const pick = sheets.length ? sheets : files;
    if (pick.length !== 1) throw new Error(`Google: found ${pick.length} sheet data sources, expected 1; link "${SOURCE_NAME}" by hand in Merchant Center`);
    return pick[0];
  }

  // One-time (and safe to repeat): register, make our supplemental source, put it ahead of the sheet, find the four products.
  // A failure carries the steps done before it (error.steps), for the owner's set-up panel.
  async function setup() {
    ready();
    const steps = [];
    try { return await setupSteps(steps); } catch (e) { if (e && typeof e === 'object') e.steps = steps.slice(); throw e; }
  }
  async function setupSteps(steps) {
    try {
      await call({ method: 'POST', url: `${acct('accounts')}/developerRegistration:registerGcp`, data: {} });
      steps.push('Registered with Google');
    } catch (e) {
      if (e.status !== 409 && !/already/i.test(e.message)) throw e;
      steps.push('Already registered with Google');
    }

    const sources = await listAll(`${acct('datasources')}/dataSources`, 'dataSources');
    let ours = sources.find((s) => s.displayName === SOURCE_NAME && s.supplementalProductDataSource);
    if (ours) steps.push(`Found the source "${SOURCE_NAME}"`);
    else {
      ours = await call({ method: 'POST', url: `${acct('datasources')}/dataSources`, data: { displayName: SOURCE_NAME, supplementalProductDataSource: {} } });
      if (!ours.name) throw fail('Google did not return the new source name');
      steps.push(`Created the source "${SOURCE_NAME}"`);
    }

    // Ours must come first in the sheet's rule so its availability and price win. The PATCH replaces the whole rule, so existing entries are kept.
    const ruleOf = (src) => (src.primaryProductDataSource.defaultRule || {}).takeFromDataSources || [];
    const primaries = sources.filter((s) => s.primaryProductDataSource);
    if (primaries.some((p) => { const r = ruleOf(p); return r[0] && r[0].supplementalDataSourceName === ours.name; })) steps.push('Already first');
    else {
      const sheet = sheetOf(primaries); const existing = ruleOf(sheet);
      const takeFromDataSources = existing.length
        ? [{ supplementalDataSourceName: ours.name }, ...existing.filter((e) => e.supplementalDataSourceName !== ours.name)]
        : [{ supplementalDataSourceName: ours.name }, { self: true }];
      await call({ method: 'PATCH', url: `${API}/datasources/v1/${sheet.name}`, params: { updateMask: 'primaryProductDataSource.defaultRule' }, data: { primaryProductDataSource: { defaultRule: { takeFromDataSources } } } });
      steps.push('Put it first, ahead of the Google sheet');
    }

    const products = await listAll(`${acct('products')}/products`, 'products', 250);
    const names = {}; const missing = [];
    Object.keys(GOOGLE_OFFER_IDS).forEach((slug) => {
      const p = products.find((x) => x.offerId === GOOGLE_OFFER_IDS[slug]);
      if (p) names[slug] = `${p.contentLanguage}~${p.feedLabel}~${p.offerId}`; else missing.push(GOOGLE_OFFER_IDS[slug]);
    });
    steps.push(`Found ${Object.keys(names).length} of ${Object.keys(GOOGLE_OFFER_IDS).length} products`);
    return { registered: true, source: ours.name, names, missing, steps };
  }

  // { [slug]: { availability, price, mrp, title } | null }, null meaning Google has no such product (a 404, or setup never found it).
  async function read(slugs, names = {}) {
    ready();
    const out = {};
    for (const slug of slugs) {
      if (!GOOGLE_OFFER_IDS[slug]) continue;
      out[slug] = null;
      if (!names[slug]) continue;
      try {
        out[slug] = fromGoogle(await call({ method: 'GET', url: `${acct('products')}/products/${encodeURIComponent(names[slug])}` }));
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    return out;
  }

  // items: [{ slug, state }]. Each goes into our supplemental source; stops at the first failure with Error('google: <slug>: <message>').
  async function push(items, { source, names = {} } = {}) {
    ready();
    if (!items.length) return { ok: true };
    if (!source) throw new Error('google: source not set; run setup first');
    for (const { slug, state } of items) {
      try {
        const [contentLanguage, feedLabel, offerId] = String(names[slug] || '').split('~');
        if (!offerId) throw fail('no product name stored; run setup first');
        await call({ method: 'POST', url: `${acct('products')}/productInputs:insert?dataSource=${source}`, data: { offerId, contentLanguage, feedLabel, productAttributes: toGoogle(state) } });
      } catch (e) {
        throw new Error(`google: ${slug}: ${e.message.replace(/^google: /, '')}`);
      }
    }
    return { ok: true };
  }

  return { configured, token, setup, read, push };
}

module.exports = { makeGoogle, client: () => makeGoogle({}) };
