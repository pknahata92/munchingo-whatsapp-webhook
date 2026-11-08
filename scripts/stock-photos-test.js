'use strict';
// utils/stockPhotos.js itself, against a fake storage client (nothing real is called).   node scripts/stock-photos-test.js
const path = require('path');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const calls = []; let uploadError = null, signError = null;
const dbPath = require.resolve(path.join(__dirname, '..', 'utils', 'database.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { client: () => ({ storage: { from: (bucket) => ({
  upload: async (p, bytes, opts) => { calls.push({ op: 'upload', bucket, p, len: bytes.length, opts }); return { error: uploadError }; },
  createSignedUrl: async (p, secs) => { calls.push({ op: 'sign', bucket, p, secs }); return signError ? { data: null, error: signError } : { data: { signedUrl: 'https://signed.example/' + p }, error: null }; },
}) } }) } };
const photos = require('../utils/stockPhotos');
const { StockError } = require('../utils/inventory');
const rejects = async (p, re, m, status) => { try { await p; ok(false, m + ' (did not throw)'); } catch (e) { ok(e instanceof StockError && re.test(e.message) && (!status || e.status === status), m + ' (got: ' + e.message + ' / ' + e.status + ')'); } };
const jpeg = (n) => { const b = Buffer.alloc(n, 7); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; return b; };
const url = (b, mime = 'image/jpeg') => `data:${mime};base64,${b.toString('base64')}`;

(async () => {
  const istNow = new Date(Date.now() + 330 * 60000).toISOString();
  const r = await photos.upload(url(jpeg(2000)));
  ok(/^\d{4}\/\d{2}\/[0-9a-f]{16}\.jpg$/.test(r.path) && r.path.startsWith(istNow.slice(0, 4) + '/' + istNow.slice(5, 7) + '/'), 'path is YYYY/MM/<16 hex>.jpg with the IST year and month (' + r.path + ')');
  const up = calls.find((c) => c.op === 'upload');
  ok(up && up.bucket === 'stock-photos' && up.p === r.path && up.len === 2000 && JSON.stringify(up.opts) === JSON.stringify({ contentType: 'image/jpeg', upsert: false }), 'uploaded to stock-photos with contentType image/jpeg and upsert false: ' + JSON.stringify(up && up.opts));
  const r2 = await photos.upload(url(jpeg(100)));
  ok(r2.path !== r.path, 'two uploads get different paths');

  ok((await photos.upload(url(jpeg(750 * 1024)))).path, 'exactly 750 KB is accepted');
  await rejects(photos.upload(url(jpeg(750 * 1024 + 1))), /^The photo is too large\. Take it again\.$/, '750 KB + 1 byte is refused', 400);
  const n = calls.length;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
  await rejects(photos.upload(url(png)), /^Only a photo \(JPEG\) can be added\.$/, 'PNG bytes behind a jpeg prefix are refused', 400);
  await rejects(photos.upload(url(png, 'image/png')), /^Only a photo \(JPEG\) can be added\.$/, 'a PNG data URL is refused', 400);
  for (const bad of [null, undefined, '', 'hello', 'data:image/jpeg;base64,', 'data:image/jpeg;base64,@@@', 12, { a: 1 }])
    await rejects(photos.upload(bad), /^Only a photo \(JPEG\) can be added\.$/, 'not a JPEG data URL refused: ' + JSON.stringify(bad), 400);
  ok(calls.length === n, 'nothing was uploaded by any refusal');
  uploadError = { message: 'bucket down' };
  await rejects(photos.upload(url(jpeg(50))), /^The photo did not upload\. Take it again\.$/, 'a storage failure is plain words', 502);
  uploadError = null;

  const before = calls.length;
  ok(await photos.url(r.path) === 'https://signed.example/' + r.path, 'url() returns the signed link');
  const sg = calls[calls.length - 1];
  ok(sg.op === 'sign' && sg.bucket === 'stock-photos' && sg.p === r.path && sg.secs === 600, 'signed for 600 seconds in stock-photos');
  for (const bad of ['../../etc/passwd', '2026/11/0123456789abcdef.jpg\n', '2026/11/0123456789ABCDEF.jpg', '2026/11/0123456789abcdef.png', '/2026/11/0123456789abcdef.jpg', '2026/11/../0123456789abcdef.jpg', '', null, undefined, 5, ['2026/11/0123456789abcdef.jpg']])
    await rejects(photos.url(bad), /^That photo could not be found\.$/, 'url() refuses ' + JSON.stringify(bad), 400);
  ok(calls.length === before + 1, 'no signing call was made for a refused path');
  signError = { message: 'Object not found' };
  await rejects(photos.url('2026/11/0123456789abcdef.jpg'), /^That photo could not be found\.$/, 'a missing object is a 404', 404);

  console.log(`stock-photos-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
