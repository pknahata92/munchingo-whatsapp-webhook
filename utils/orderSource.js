'use strict';
// Where an order came from: what the buyer says ("How did you hear about us?") plus the first-touch UTM tags and referrer
// the website saved. Stored inside the order's delivery_address JSON (no schema change), like the gift recipient and the
// tracking ids. Everything here is whitelisted or pattern-checked because the values are shown in the admin and in emails.

const HOW = {
  instagram: 'Instagram',
  friend_family: 'Friend or family',
  google: 'Google',
  prashant: 'Told directly by Prashant',
  corporate: 'Corporate or event',
  other: 'Other',
};
// People who already know Prashant. Their orders prove the machinery, not the market.
const NETWORK = new Set(['friend_family', 'prashant']);

const UTM_OK = /^[A-Za-z0-9._+\- ]+$/;

function cleanUtmValue(v) {
  v = String(v == null ? '' : v).trim().slice(0, 60);
  return v && UTM_OK.test(v) ? v : '';
}

/** Pure. Returns only what is safe to keep; {} when nothing is. Never throws. */
function cleanSource(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  if (typeof input.how === 'string' && Object.prototype.hasOwnProperty.call(HOW, input.how)) out.how = input.how;
  if (input.utm && typeof input.utm === 'object' && !Array.isArray(input.utm)) {
    const utm = {};
    for (const k of ['source', 'medium', 'campaign']) {
      const v = cleanUtmValue(input.utm[k]);
      if (v) utm[k] = v;
    }
    if (Object.keys(utm).length) out.utm = utm;
  }
  if (typeof input.ref === 'string') {
    try {
      const u = new URL(input.ref);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && /^[a-z0-9.-]{1,80}$/i.test(u.hostname)) out.ref = u.hostname.toLowerCase();
    } catch (e) { /* not a URL: dropped */ }
  }
  if (typeof input.landed === 'string' && /^\/[A-Za-z0-9._\-/]{0,100}$/.test(input.landed.trim())) out.landed = input.landed.trim();
  return out;
}

/** Pure. A short human label for the admin and the owner email; '' when there is no tag. */
function labelSource(src) {
  if (!src || typeof src !== 'object') return '';
  const how = HOW[src.how] || '';
  const utm = src.utm && typeof src.utm === 'object' ? [src.utm.source, src.utm.medium, src.utm.campaign].filter(Boolean).join(' / ') : '';
  if (how && utm) return `${how} (utm ${utm})`;
  if (how) return how;
  if (utm) return `utm ${utm}`;
  return '';
}

/** Adds the cleaned tag to the order's address parts only when there is something valid to keep. Returns parts. */
function attachSource(parts, input) {
  const src = cleanSource(input);
  if (Object.keys(src).length) parts.source = src;
  return parts;
}

function isNetwork(src) { return !!(src && NETWORK.has(src.how)); }

module.exports = { HOW, cleanSource, attachSource, labelSource, isNetwork };
