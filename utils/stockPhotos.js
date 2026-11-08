'use strict';
// Private photos for deliveries and broken boxes (spec 6.4). The bucket `stock-photos` is private: a photo is only ever seen through a
// signed link that expires after 10 minutes. The phone shrinks each photo first (longest side 1600 px, JPEG), so 750 KB is plenty.
const crypto = require('crypto');
const { StockError } = require('./inventory');
const { PHOTO_PATH } = require('./deliveries');

const BUCKET = 'stock-photos';
const MAX_BYTES = 750 * 1024;
const SIGNED_SECONDS = 600;
const bucket = () => require('./database').client().storage.from(BUCKET);

async function upload(dataUrl) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl || ''));
  if (!m) throw new StockError('Only a photo (JPEG) can be added.', 400);
  const bytes = Buffer.from(m[1], 'base64');
  if (bytes.length > MAX_BYTES) throw new StockError('The photo is too large. Take it again.', 400);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new StockError('Only a photo (JPEG) can be added.', 400);
  const ist = new Date(Date.now() + 330 * 60000).toISOString();   // the IST year and month
  const path = `${ist.slice(0, 4)}/${ist.slice(5, 7)}/${crypto.randomBytes(8).toString('hex')}.jpg`;
  const { error } = await bucket().upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
  if (error) { console.error('[STOCK] photo upload failed:', error.message); throw new StockError('The photo did not upload. Take it again.', 502); }
  return { path };
}

async function url(path) {
  if (typeof path !== 'string' || !PHOTO_PATH.test(path)) throw new StockError('That photo could not be found.', 400);
  const { data, error } = await bucket().createSignedUrl(path, SIGNED_SECONDS);
  if (error || !data || !data.signedUrl) throw new StockError('That photo could not be found.', 404);
  return data.signedUrl;
}

module.exports = { upload, url, MAX_BYTES };
