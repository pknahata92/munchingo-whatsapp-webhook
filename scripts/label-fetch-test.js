'use strict';
// Delhivery label fetch against a stand-in API (no token, no network).   node scripts/label-fetch-test.js
let pass = 0, fail = 0, MODE = 'pdf', calls = [];
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const PDF = Buffer.from('%PDF-1.4\n%fake\n');
const res = (status, buf) => ({ ok: status >= 200 && status < 300, status, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
global.fetch = async (url, opts) => {
  calls.push(url);
  if (MODE === 'down') throw new Error('ECONNRESET');
  if (MODE === '401') return res(401, Buffer.from('{}'));
  if (/s3\.example\.com/.test(url)) return res(200, MODE === 'badlink' ? Buffer.from('nope') : PDF);
  if (MODE === 'pdf') return res(200, PDF);
  if (MODE === 'size4r-refused') return /pdf_size=4R/.test(url) ? res(400, Buffer.from('{}')) : res(200, PDF);
  if (MODE === 'link' || MODE === 'badlink') return res(200, Buffer.from(JSON.stringify({ pdf_download_link: 'https://s3.example.com/l.pdf' })));
  if (MODE === 'httplink') return res(200, Buffer.from(JSON.stringify({ pdf_download_link: 'http://10.0.0.1/l.pdf' })));
  if (MODE === 'empty') return res(200, Buffer.from(JSON.stringify({ packages_found: 0, packages: [] })));
  return res(200, Buffer.from('<html>'));
};
(async () => {
  delete process.env.DELHIVERY_API_TOKEN;
  const d = require('../utils/delhiveryLabel');
  let e = await d.fetchLabel('1234567890123').catch((x) => x); ok(e instanceof d.LabelError && e.status === 503 && !calls.length, 'no token: clear error, no call');
  process.env.DELHIVERY_API_TOKEN = 'tok_test';
  e = await d.fetchLabel('abc').catch((x) => x); ok(e instanceof d.LabelError && /no Delhivery tracking/.test(e.message), 'bad AWB refused');
  let b = await d.fetchLabel('1234567890123'); ok(Buffer.isBuffer(b) && b.slice(0, 5).toString() === '%PDF-', 'PDF answer returned as is');
  ok(/packing_slip\?wbns=1234567890123&pdf=true&pdf_size=4R/.test(calls[0]), 'asks for the 4R size');
  MODE = 'link'; b = await d.fetchLabel('1234567890123'); ok(b.slice(0, 5).toString() === '%PDF-', 'JSON with a download link: link is followed');
  MODE = 'size4r-refused'; calls = []; b = await d.fetchLabel('1234567890123'); ok(b.length && calls.length === 2 && !/pdf_size/.test(calls[1]), '4R refused: retries without a size');
  MODE = 'httplink'; e = await d.fetchLabel('1234567890123').catch((x) => x); ok(e instanceof d.LabelError, 'a non-https / private link is refused');
  MODE = 'badlink'; e = await d.fetchLabel('1234567890123').catch((x) => x); ok(/not a PDF/.test(e.message), 'a link that is not a PDF is an error');
  MODE = 'empty'; e = await d.fetchLabel('1234567890123').catch((x) => x); ok(/no label/.test(e.message), 'no packages: says Delhivery has no label yet');
  MODE = 'html'; e = await d.fetchLabel('1234567890123').catch((x) => x); ok(e instanceof d.LabelError, 'HTML is not accepted as a label');
  MODE = '401'; e = await d.fetchLabel('1234567890123').catch((x) => x); ok(/token/.test(e.message), '401 says the token was rejected');
  MODE = 'down'; e = await d.fetchLabel('1234567890123').catch((x) => x); ok(/reach/.test(e.message), 'network failure is a clear error');
  console.log(`label-fetch-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
