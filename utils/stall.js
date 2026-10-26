'use strict';
// Stall tally storage (27 Oct 2026). The page at munchingo.com/stall sends its whole day after every change (a snapshot), so a
// retry or a resend is harmless: rows are upserted by the id the iPad made, and a customer missing from the snapshot was
// deleted or undone on the iPad (soft-deleted here, never lost). A buyer's name and phone are kept ONLY when they ticked the
// marketing box on the page: no tick, nothing about the buyer is stored. Ticked buyers join `contacts` (utils/contacts.js).
const crypto = require('crypto');

const FLAVORS = ['original', 'ajwain', 'kesari', 'lite'];
const MAX_ORDERS = 400, MAX_LINES = 20;
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const istDay = (ms) => new Date(ms + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

let deps = null;
function setDeps(d) { deps = d; }   // tests only
function D() { return deps || { db: require('./database'), now: () => Date.now() }; }

/** An Indian mobile as 91 + 10 digits, or null. Accepts 10 digits, 0/91/+91 prefixes and spaces or dashes. */
function normalisePhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '0') d = d.slice(1);
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  return /^[6-9]\d{9}$/.test(d) ? '91' + d : null;
}

/** Constant-time check of the stall key the iPad sends (set STALL_KEY on Render; the owner types it on the iPad once). */
function keyOk(provided) {
  const secret = process.env.STALL_KEY;
  if (!secret) return false;
  const a = Buffer.from(String(secret)), b = Buffer.from(String(provided || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function checkLine(l) {
  if (!l || typeof l.name !== 'string' || l.name.length > 40 || !intIn(l.price, 0, 5000) || typeof l.item !== 'string' || l.item.length > 20) return false;
  const mix = l.mix || {};
  return Object.keys(mix).every((k) => FLAVORS.includes(k) && intIn(mix[k], 0, 20));
}
/** Returns { error } or the cleaned snapshot { day, opening, orders }. */
function validate(body) {
  const b = body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.day || ''))) return { error: 'day must be YYYY-MM-DD' };
  const opening = {};
  for (const [k, v] of Object.entries(b.opening || {})) { if (!FLAVORS.includes(k) || !intIn(v, 0, 99999)) return { error: 'bad opening stock' }; opening[k] = v; }
  if (!Array.isArray(b.orders) || b.orders.length > MAX_ORDERS) return { error: 'orders must be a list of at most ' + MAX_ORDERS };
  const seen = new Set(), orders = [];
  for (const o of b.orders) {
    if (!o || typeof o.id !== 'string' || !/^[\w.-]{1,64}$/.test(o.id) || seen.has(o.id)) return { error: 'bad or repeated order id' };
    seen.add(o.id);
    if (!intIn(o.n, 1, 100000) || !Number.isFinite(o.t) || (o.pay !== 'upi' && o.pay !== 'cash')) return { error: 'bad order ' + o.id };
    if (!Array.isArray(o.lines) || !o.lines.length || o.lines.length > MAX_LINES || !o.lines.every(checkLine)) return { error: 'bad lines in ' + o.id };
    const buyer = o.buyer && typeof o.buyer === 'object' ? o.buyer : null;
    orders.push({ id: o.id, n: o.n, t: o.t, pay: o.pay, lines: o.lines.map((l) => ({ item: l.item, name: l.name, price: l.price, hamper: !!l.hamper, mix: l.mix || {} })), buyer });
  }
  return { day: b.day, opening, orders };
}

/** Save the snapshot. Buyers are kept only with consent === true AND a valid mobile. */
async function sync(body) {
  const v = validate(body);
  if (v.error) return { status: 400, body: { ok: false, error: v.error } };
  const { db, now } = D();
  const at = new Date(now()).toISOString();
  await db.upsertStallDay(v.day, v.opening);
  const rows = [], consented = [];
  for (const o of v.orders) {
    const b = o.buyer;
    const phone = b && b.consent === true ? normalisePhone(b.phone) : null;
    rows.push({ id: o.id, day: v.day, customer_no: o.n, sold_at: new Date(o.t).toISOString(), pay: o.pay, lines: o.lines, total: o.lines.reduce((s, l) => s + l.price, 0), contact_phone: phone, deleted_at: null, updated_at: at });
    if (phone) consented.push({ phone, name: String(b.name || '').trim().slice(0, 60) || null, text: String(b.consentText || '').slice(0, 300), day: v.day });
  }
  await db.upsertStallOrders(rows);
  const keep = new Set(v.orders.map((o) => o.id));
  const gone = (await db.listStallOrderIds(v.day)).filter((r) => !keep.has(r.id) && !r.deleted_at).map((r) => r.id);
  await db.markStallOrdersDeleted(gone);

  let contacts = 0;
  for (const c of consented) {
    try {
      const old = await db.getContact(c.phone);
      const source = 'stall:' + c.day;
      const fields = { consent_marketing: true, consent_at: at, consent_text: c.text || 'stall: ticked the marketing box', last_source: source, updated_at: at };
      if (old) await db.updateContact(c.phone, { ...fields, name: old.name || c.name });
      else await db.insertContact({ phone: c.phone, name: c.name, first_source: source, ...fields });
      contacts++;
    } catch (e) { console.error('[STALL] contact save failed for', c.phone, e.message); }
  }
  return { status: 200, body: { ok: true, orders: rows.length, deleted: gone.length, contacts } };
}

module.exports = { sync, validate, normalisePhone, keyOk, setDeps, istDay };
