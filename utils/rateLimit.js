'use strict';

// Minimal in-memory fixed-window rate limiter, keyed by client IP.
// No new dependency, no persistence needed - this is a single-instance
// Render service, so in-memory state is fine for basic abuse protection
// (e.g. someone scripting POST /api/checkout to spam orders/emails/Razorpay
// payment links). Not a replacement for a CDN-level limiter, but stops
// casual abuse.
const hits = new Map(); // ip -> [timestamps]

function rateLimit({ windowMs = 60_000, max = 10 } = {}) {
  return function (req, res, next) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;

    const timestamps = (hits.get(ip) || []).filter((t) => t > windowStart);
    if (timestamps.length >= max) {
      return res.status(429).json({ ok: false, error: 'Too many requests. Please try again in a minute.' });
    }

    timestamps.push(now);
    hits.set(ip, timestamps);
    next();
  };
}

module.exports = { rateLimit };
