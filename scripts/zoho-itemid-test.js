'use strict';
// Zoho Books item lookup: the sets are now named "Trio Set" / "Full Range Set" (9 Nov 2026), but the Zoho item keys stay
// "Trio Gift Set" / "Full Range Gift Set", and old orders stored under the old names must still resolve to the same items.
//   node scripts/zoho-itemid-test.js
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
delete process.env.ZOHO_ITEM_IDS;
const { itemIdFor } = require('../utils/zohoBooks');
const TRIO = '4288800000000043001', FULL = '4288800000000034246';
ok(itemIdFor('Trio Set') === TRIO, 'Trio Set');
ok(itemIdFor('Trio Set (Original, Kesari, Sugar-Lite)') === TRIO, 'Trio Set with its mix');
ok(itemIdFor('Munchingo Trio Set (Original, Kesari, Ajwain)') === TRIO, 'WhatsApp-style Trio Set name');
ok(itemIdFor('Trio Gift Set') === TRIO, 'old name Trio Gift Set still resolves');
ok(itemIdFor('Full Range Set') === FULL, 'Full Range Set');
ok(itemIdFor('Full Range Gift Set') === FULL, 'old name Full Range Gift Set still resolves');
ok(itemIdFor('Atta Original') === '4288800000000039021', 'single unchanged');
const cat = require('../utils/catalog');
ok(cat.nameForSlug('full-range-set') === 'Full Range Set' && cat.nameForSlug('trio-gift-set-ajwain-kesari-original') === 'Trio Set', 'catalog names: Full Range Set / Trio Set');
ok(itemIdFor(cat.nameForSlug('full-range-set')) === FULL && itemIdFor(cat.nameForSlug('trio-gift-set-ajwain-kesari-original')) === TRIO, 'catalog names resolve to the Zoho items');
process.env.ZOHO_ITEM_IDS = JSON.stringify({ 'Trio Gift Set': 'OVERRIDE' });
ok(itemIdFor('Trio Set') === 'OVERRIDE', 'ZOHO_ITEM_IDS override still reaches the new name');
console.log(`zoho-itemid-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
