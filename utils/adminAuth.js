'use strict';

/**
 * Admin login without passwords or extra services.
 *   1. POST /admin/api/login  { email }        -> if the address is allowed, a 6-digit code is emailed to it
 *   2. POST /admin/api/verify { email, code }  -> returns a signed session token (12 h)
 * Codes are derived (HMAC) from the email and a 5-minute window, so nothing is stored; a code works for 5-10 minutes.
 * Sessions are stateless signed tokens. Everything is keyed from ADMIN_SECRET, falling back to DIGEST_SECRET (already on Render).
 * Who may sign in: the "env owners" (ADMIN_EMAILS, comma separated, defaulting to NOTIFY_EMAIL) are always owners and can
 * never be locked out. Everyone else comes from the admin_users table (role owner or staff, active flag). The role is looked
 * up again on every request, so disabling someone takes effect immediately.
 */
const crypto = require('crypto');

const WINDOW_MS = 5 * 60 * 1000;
const SESSION_MS = 12 * 60 * 60 * 1000;

const key = () => process.env.ADMIN_SECRET || process.env.DIGEST_SECRET || '';
const hmac = (msg) => crypto.createHmac('sha256', key()).update(msg).digest();
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function allowedEmails() {
  const raw = process.env.ADMIN_EMAILS || process.env.NOTIFY_EMAIL || '';
  return raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}
const norm = (email) => String(email || '').trim().toLowerCase();
const isEnvOwner = (email) => !!key() && allowedEmails().includes(norm(email));

// -> { email, name, role: 'owner' | 'staff' } or null. If the table cannot be read, only env owners get in.
async function resolveUser(email) {
  const e = norm(email);
  if (!key() || !e) return null;
  let row = null;
  try { row = await require('./database').getAdminUser(e); }
  catch (err) { console.error('[ADMIN] could not read admin_users:', err.message); }
  if (isEnvOwner(e)) return { email: e, name: (row && row.name) || e, role: 'owner' };
  if (row && row.active && (row.role === 'owner' || row.role === 'staff')) return { email: e, name: row.name || e, role: row.role };
  return null;
}
const isAllowed = async (email) => !!(await resolveUser(email));

function codeFor(email, win) {
  const n = hmac(`otp|${String(email).toLowerCase()}|${win}`).readUInt32BE(0) % 1000000;
  return String(n).padStart(6, '0');
}
const currentWindow = () => Math.floor(Date.now() / WINDOW_MS);
const issueCode = (email) => codeFor(email, currentWindow());

// Brute-force guard: 8 wrong codes per email locks it for 15 minutes (in memory, resets on restart: acceptable).
const fails = new Map();
function locked(email) {
  const f = fails.get(email);
  if (!f) return false;
  if (Date.now() > f.until) { fails.delete(email); return false; }
  return f.count >= 8;
}
function noteFail(email) {
  const f = fails.get(email) || { count: 0, until: Date.now() + 15 * 60 * 1000 };
  f.count += 1; fails.set(email, f);
}

function verifyCode(email, code) {
  const e = norm(email);
  if (!key() || locked(e)) return false;
  const w = currentWindow();
  const ok = eq(String(code || '').trim(), codeFor(e, w)) || eq(String(code || '').trim(), codeFor(e, w - 1));
  if (!ok) noteFail(e); else fails.delete(e);
  return ok;
}

function issueToken(email) {
  const payload = Buffer.from(JSON.stringify({ e: String(email).toLowerCase(), exp: Date.now() + SESSION_MS })).toString('base64url');
  return `${payload}.${hmac(`session|${payload}`).toString('base64url')}`;
}

function readToken(token) {
  try {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig || !eq(sig, hmac(`session|${payload}`).toString('base64url'))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.exp || Date.now() > data.exp) return null;
    return { email: data.e };
  } catch (_) { return null; }
}

// Express middleware for /admin/api/*
async function requireAdmin(req, res, next) {
  const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
  const tok = m && readToken(m[1]);
  const who = tok && await resolveUser(tok.email);   // role re-checked every request
  if (!who) return res.status(401).json({ ok: false, error: 'Please sign in again.' });
  req.admin = who;
  next();
}

// Gate for owner-only routes (use after requireAdmin).
function requireOwner(req, res, next) {
  if (!req.admin || req.admin.role !== 'owner') return res.status(403).json({ ok: false, error: 'Only the owner can do this.' });
  next();
}

module.exports = { isAllowed, resolveUser, isEnvOwner, issueCode, verifyCode, issueToken, readToken, requireAdmin, requireOwner, locked };
