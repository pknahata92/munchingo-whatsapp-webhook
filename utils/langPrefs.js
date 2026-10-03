'use strict';

/**
 * Per-customer language preference ('en' | 'hi'), keyed by WhatsApp number.
 *
 * getStoredLang() returns null ONLY when the lookup succeeded and the customer
 * has never chosen (=> show the English/हिन्दी picker). Any DB problem (table
 * not migrated yet, Supabase down) returns 'en' so the bot never loops on the
 * picker and templates never fail because of this feature.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPPORTED = ['en', 'hi'];
// Hindi is off until the Hindi templates are approved at Meta: with ENABLE_HINDI unset
// everyone is English, the picker never shows, and no Hindi message is attempted.
// Turn on by setting ENABLE_HINDI=true on Render.
const HINDI_ENABLED = () => process.env.ENABLE_HINDI === 'true';
const cache = new Map(); // phone -> lang (this process only; DB is the truth)
let _client = null;

function db() {
  if (!_client) _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return _client;
}
const key = (phone) => String(phone || '').replace(/\D/g, '');

async function getStoredLang(phone) {
  if (!HINDI_ENABLED()) return 'en';
  const k = key(phone);
  if (!k) return 'en';
  if (cache.has(k)) return cache.get(k);
  try {
    const { data, error } = await db().from('customer_prefs').select('lang').eq('phone', k).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    cache.set(k, data.lang);
    return data.lang;
  } catch (err) {
    console.warn(`[LANG] lookup failed (${err.message}) — defaulting to en`);
    return 'en';
  }
}

async function getLang(phone) {
  return (await getStoredLang(phone)) || 'en';
}

async function setLang(phone, lang) {
  if (!HINDI_ENABLED()) return;
  if (!SUPPORTED.includes(lang)) throw new Error(`Unsupported language: ${lang}`);
  const k = key(phone);
  cache.set(k, lang); // honour the choice immediately even if the DB write fails
  try {
    const { error } = await db()
      .from('customer_prefs')
      .upsert({ phone: k, lang, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
  } catch (err) {
    console.warn(`[LANG] could not persist ${lang} for ${k}: ${err.message}`);
  }
}

module.exports = { HINDI_ENABLED, getStoredLang, getLang, setLang, SUPPORTED };
