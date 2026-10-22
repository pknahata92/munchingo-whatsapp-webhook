'use strict';
// Checks for the redesigned admin, one block per plan task. Each is an async function run by admin-ui-test.js.
module.exports = function checks({ openAdmin, ok, sleep, until, BASE }) {
  const list = [];
  const vis = (el) => !!el && !el.hidden && !el.closest('[hidden]');

  // Task 1: shell, tabs, header
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click } = o;
    const tabs = qa('#tabs .tab').filter(vis).map((t) => text(t));
    ok(tabs.join('|') === 'Orders|Stock|More', 'owner sees the tabs Orders, Stock and More (saw: ' + tabs.join('|') + ')');
    ok(['priceBtn', 'couponBtn', 'teamBtn', 'invBtn', 'labelBtn'].every((id) => !o.doc.getElementById(id)), 'the old header tool buttons are gone');
    ok(vis(q('#helpBtn')) && vis(q('#out')) && /owner/.test(text(q('#who'))), 'header keeps only who you are, Help and Sign out');
    ok(vis(q('#viewOrders')) && !vis(q('#viewStock')) && !vis(q('#viewMore')), 'Orders is shown first');
    click(o.byText('#tabs .tab', /^Stock$/)); await sleep(300);
    ok(!vis(q('#viewOrders')) && vis(q('#viewStock')), 'the Stock tab swaps the page');
    click(o.byText('#tabs .tab', /^More$/)); await sleep(200);
    ok(vis(q('#viewMore')) && !vis(q('#viewStock')), 'the More tab swaps the page');
    click(o.byText('#tabs .tab', /^Orders$/)); await sleep(100);
    ok(vis(q('#viewOrders')), 'back to Orders');
    ok(o.errors.length === 0, 'no page errors in the shell (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
    const s = await openAdmin('staff');
    ok(s.qa('#tabs .tab').filter(vis).map((t) => s.text(t)).join('|') === 'Orders|Stock', 'staff sees only Orders and Stock');
    s.close();
  });

  // Task 2: the Needs-you-now strip replaces the stacked bars
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click } = o;
    ok(!o.doc.getElementById('unpaidBar') && !o.doc.getElementById('lowBar'), 'the old unpaid and low-stock bars are gone');
    const cards = qa('#needs .need');
    ok(cards.length >= 2, 'the strip shows cards for what needs doing (' + cards.map((c) => text(c)).join(' | ') + ')');
    const step = (re) => o.byText('#flow .step', re);
    const topackCount = Number(text(step(/To pack/).querySelector('b')));
    const needPack = cards.find((c) => /to pack/.test(text(c)));
    ok(topackCount === 0 ? !needPack : (needPack && Number(text(needPack.querySelector('b'))) === topackCount), 'the to-pack card carries the same count as the step button');
    ok(cards.every((c) => Number(text(c.querySelector('b'))) > 0), 'a card appears only when its count is above zero');
    ok(!cards.some((c) => /packed order|shipped order/.test(text(c))) || topackCount === 0, 'the strip gives ONE do-this-next card and does not repeat every step button');
    click(o.byText('#flow .step', /Delivered/)); await sleep(100);
    if (needPack) { click(qa('#needs .need').find((c) => /to pack/.test(text(c)))); await sleep(100); ok(/To pack/.test(text(q('#flow .step.on'))), 'tapping the card opens that step'); }
    const low = qa('#needs .need').find((c) => /low/i.test(text(c)));
    ok(!!low, 'a running-low card shows the flavours that are low');
    if (low) { click(low); await sleep(300); ok(!q('#viewStock').hidden, 'the running-low card opens the Stock tab'); }
    ok(/Today/.test(text(q('#todayLine'))) && !q('#todayLine').hidden, 'the owner sees one quiet line of today\'s money');
    ok(o.errors.length === 0, 'no page errors with the strip (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
    const s = await openAdmin('staff');
    ok(s.q('#todayLine').hidden, 'staff do not see the money line');
    s.close();
  });

  // Task 3: filters live in a sheet
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, set } = o;
    ok(!q('details.more') && !!q('#filterBtn'), 'the "More filters" accordion is replaced by a Filter button');
    click(o.byText('#flow .step', /Delivered/)); await sleep(100);
    const amounts = () => qa('#list .card .top').map((t) => Number((text(t).match(/₹([\d,.]+)$/) || [0, '0'])[1].replace(/,/g, '')));
    click(q('#filterBtn')); await sleep(150);
    ok(q('#sheet.on') && q('#panel #sort') && q('#panel #csv') && q('#panel #reset'), 'the Filter button opens a sheet with sort, download and clear');
    set(q('#sort'), 'valueAsc'); await sleep(150);
    const a = amounts(); ok(a.length < 2 || a.every((v, i) => i === 0 || a[i - 1] <= v), 'sorting by lowest value reorders the list (' + a.join(',') + ')');
    click(o.byText('#panel button', /^Close$/)); await sleep(100); click(q('#filterBtn')); await sleep(150);
    ok(q('#sort').value === 'valueAsc', 'the choice is remembered when the sheet is reopened');
    ok(/•|on/.test(q('#filterBtn').className + text(q('#filterBtn'))), 'the Filter button shows a dot while a filter is active');
    click(q('#reset')); await sleep(150);
    ok(q('#sort').value === 'new' && /To pack/.test(text(q('#flow .step.on'))), 'Clear filters returns to the default view');
    click(o.byText('#panel button', /^Close$/)); await sleep(100); click(o.byText('#tabs .tab', /^More$/)); await sleep(100); click(o.byText('.morebtn', /Prices/)); await until(() => q('#sheet.on') && /Prices/i.test(text(q('#panel'))), 3000, 'the Prices sheet').catch(() => {});
    ok(!!q('#sheet.on') && /Prices/i.test(text(q('#panel'))), 'another sheet still opens normally after the filter sheet (the filter box is not lost)');
    ok(!!o.doc.getElementById('filterBox'), 'the filter box survives other sheets');
    ok(o.errors.length === 0, 'no page errors with the filter sheet (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Task 4: Stock is a page, not a popup
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click } = o;
    click(o.byText('#tabs .tab', /^Stock$/)); await until(() => qa('#viewStock .line').length >= 4, 4000, 'the stock page');
    ok(!q('#sheet.on'), 'Stock opens as a page, not a popup');
    ok(/Atta Kesari/.test(text(q('#viewStock'))) && /Atta Sugar-Lite/.test(text(q('#viewStock'))) && /Packing tape/.test(text(q('#viewStock'))), 'the page lists the flavours and the packaging');
    const top = o.byText('#viewStock button', /^Receive stock$/);
    ok(!!top, 'one Receive stock button sits at the top');
    click(top); await sleep(200);
    ok(/Atta Kesari/.test(text(q('#viewStock'))) && /Which/i.test(text(q('#viewStock'))), 'it asks which item arrived');
    click(o.byText('#viewStock button', /Atta Kesari/)); await sleep(200);
    ok(/Receive: Atta Kesari/.test(text(q('#viewStock'))) && !q('#sheet.on'), 'the receive form opens in the page');
    click(o.byText('#viewStock button', /^Back$/)); await until(() => qa('#viewStock .line').length >= 4, 3000, 'back to the stock list');
    ok(true, 'Back returns to the stock list');
    click(o.byText('#viewStock button', /^History$/)); await until(() => /Stock history/.test(text(q('#viewStock'))), 4000, 'the history page').catch(() => {});
    ok(/Stock history/.test(text(q('#viewStock'))) && !q('#sheet.on'), 'History also opens in the page');
    ok(o.errors.length === 0, 'no page errors on the stock page (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
    const s = await openAdmin('staff'); click(s.byText('#tabs .tab', /^Stock$/)); await until(() => s.qa('#viewStock .line').length >= 4, 4000, 'the stock page for staff');
    ok(!s.byText('#viewStock button', /^Add item$/) && !s.byText('#viewStock button', /Low level/), 'staff do not see owner-only stock controls');
    s.close();
  });

  // Offline sales: hamper form and the flow report
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click } = o;
    click(o.byText('#tabs .tab', /^Stock$/)); await until(() => qa('#viewStock .line').length >= 4, 4000, 'the stock page');
    click(o.byText('#viewStock button', /Sold offline: hamper/)); await sleep(200);
    ok(/Hamper sold offline/.test(text(q('#viewStock'))) && /Which hamper/.test(text(q('#viewStock'))) && !/candle/i.test(text(q('#viewStock')).replace(/Bags, candles and paper are not counted here\./,'')), 'the hamper form asks which hamper, how many and the boxes opened (no supplies)');
    click(o.byText('#viewStock button', /Save hamper sale/)); await sleep(400);
    ok(!/Recorded/.test(text(q('#viewStock'))), 'an empty hamper sale is refused');
    click(o.byText('#viewStock button', /^Back$/)); await until(() => qa('#viewStock .line').length >= 4, 3000, 'back to stock');
    await until(() => o.byText('#viewStock button', /Where did it go/), 4000, 'the flow button'); click(o.byText('#viewStock button', /Where did it go/)); await until(() => /Where did the stock go/.test(text(q('#viewStock'))), 4000, 'the flow report').catch(() => {});
    ok(/Where did the stock go/.test(text(q('#viewStock'))) && /On the shelf/.test(text(q('#viewStock'))), 'the flow report lists where each item went');
    ok(o.errors.length === 0, 'no page errors on the hamper screens (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Refunded is its own tab, apart from Cancelled
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click } = o;
    const chips = qa('#chips .chip').map((c) => text(c));
    ok(chips.some((t) => /^Cancelled \d+/.test(t)) && chips.some((t) => /^Refunded \d+/.test(t)), 'Cancelled and Refunded are separate filter tabs (' + chips.join(' | ') + ')');
    click(o.byText('#chips .chip', /^Refunded/)); await sleep(150);
    ok(qa('#list .card').some((c) => /MNG-EEEE-1008/.test(text(c)) && /REFUNDED/.test(text(c))), 'a refunded order sits under Refunded with a REFUNDED badge');
    ok(/refunded/.test(text(q('#count'))), 'the Refunded tab totals the money refunded');
    click(o.byText('#chips .chip', /^Cancelled/)); await sleep(150);
    ok(!qa('#list .card').some((c) => /MNG-EEEE-1008/.test(text(c))), 'a refunded order is not listed under Cancelled');
    ok(o.errors.length === 0, 'no page errors on the refunded tab');
    o.close();
  });

  // Task 5: plain words
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click } = o;
    for (const re of [/To pack/, /Packed/, /Shipped/, /Delivered/]) { click(o.byText('#flow .step', re)); await sleep(60); ok(!/AWB/.test(text(q('#hint'))) && text(q('#hint')).length > 10, 'the hint under ' + re + ' is a plain sentence'); }
    click(o.byText('#flow .step', /Packed/)); await sleep(100);
    const btn = o.byText('#list .card button', /Create shipment/);
    ok(!!btn && !o.byText('#list .card button', /Ship \/ hand over/), 'a packed order\'s button reads Create shipment');
    click(q('#list .card')); await until(() => q('#sheet.on'), 3000, 'the order'); await sleep(200);
    ok(/Tracking number \(AWB\)/.test(text(q('#panel'))), 'the manual form says Tracking number (AWB)');
    ok(/Create Delhivery shipment/.test(text(q('#panel'))), 'the one-tap shipment button is on the order');
    o.close();
  });

  // Task 6: bulk create shipments and bulk mark delivered
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click } = o;
    let prompts = 0; o.win.prompt = (m, d) => { prompts++; return d == null ? '' : String(d); };
    const markPacked = async (idRe) => { click(o.byText('#flow .step', /To pack/)); await sleep(80); const c = qa('#list .card').find((x) => idRe.test(text(x))); if (c) { click(Array.from(c.querySelectorAll('button')).find((b) => /Mark packed/.test(text(b)))); await sleep(400); } };
    await markPacked(/MNG-GGGG-1010/);
    click(o.byText('#flow .step', /^STEP 2/)); await sleep(100);
    const packedIds = qa('#list .card').map((c) => text(c).match(/MNG-[A-Z0-9]+-\d+/)[0]);
    ok(packedIds.length >= 3 && packedIds.includes('MNG-GGGG-1010'), 'there are packed orders to ship (' + packedIds.join(',') + ')');
    click(o.byText('#bulk .chip', /Select all/)); await sleep(100);
    const shipBtn = o.byText('#bulk button', /Create Delhivery shipments/);
    ok(!!shipBtn && new RegExp('\\(' + packedIds.length + '\\)').test(text(shipBtn)), 'the Packed step offers Create Delhivery shipments for all ticked orders (' + (shipBtn ? text(shipBtn) : 'missing') + ')');
    click(shipBtn); await until(() => /Finished:/.test(text(q('#panel'))), 8000, 'the shipments to finish');
    const panel = text(q('#panel'));
    ok((panel.match(/Created/g) || []).length === packedIds.length - 1, 'every order except the failing one was created (' + panel.slice(0, 300) + ')');
    ok(/MNG-GGGG-1010Not created:[^]*?not serviceable/i.test(panel), 'the failing order shows a red line with Delhivery\'s reason and does not stop the others (' + panel.slice(0, 500) + ')');
    ok(prompts === 0, 'bulk shipping asks no weight question (each parcel uses its own estimate)');
    click(o.byText('#panel button', /Go to Shipped/)); await sleep(200);
    ok(/Shipped/.test(text(q('#flow .step.on'))) && qa('#list .card').length >= packedIds.length - 1, 'the created orders are now under Shipped');
    click(o.byText('#bulk .chip', /Select all/)); await sleep(100);
    const del = o.byText('#bulk button', /Mark delivered/); ok(!!del, 'the Shipped step offers Mark delivered for all ticked orders');
    const before = Number(text(o.byText('#flow .step', /Delivered/).querySelector('b')));
    click(del); await until(() => /Finished:/.test(text(q('#panel'))), 8000, 'delivery to finish');
    click(o.byText('#panel button', /Close/)); await until(() => Number(text(o.byText('#flow .step', /Delivered/).querySelector('b'))) > before, 4000, 'the delivered count').catch(() => {});
    ok(Number(text(o.byText('#flow .step', /Delivered/).querySelector('b'))) > before, 'ticked shipped orders moved to Delivered');
    ok(o.errors.length === 0, 'no page errors with bulk actions (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Sorting has both directions everywhere
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, set } = o;
    click(o.byText('#flow .step', /Delivered/)); await sleep(100);
    const opts = qa('#sort option').map((x) => x.value).sort().join(',');
    ok(opts === 'boxesAsc,boxesDesc,nameAZ,nameZA,new,old,valueAsc,valueDesc', 'every sort has both directions (' + opts + ')');
    const ids = () => qa('#list .card').map((c) => text(c).match(/MNG-[A-Z0-9]+-\d+/)[0]);
    const boxes = () => qa('#list .card .meta:first-of-type').map((m) => Number((text(m).match(/(\d+) boxes?/) || [0, 0])[1]));
    set(q('#sort'), 'boxesAsc'); await sleep(100); let b = boxes(); ok(b.every((v, i) => i === 0 || b[i - 1] <= v), 'fewest boxes first (' + b + ')');
    set(q('#sort'), 'boxesDesc'); await sleep(100); b = boxes(); ok(b.every((v, i) => i === 0 || b[i - 1] >= v), 'most boxes first (' + b + ')');
    set(q('#sort'), 'nameZA'); await sleep(100); const za = ids(); set(q('#sort'), 'nameAZ'); await sleep(100); ok(JSON.stringify(za) === JSON.stringify(ids().reverse()), 'name Z to A is the exact reverse of A to Z');
    const flip = q('#sortFlip'); ok(!!flip && /Name A to Z/.test(text(flip)), 'a visible button shows the current sort (' + (flip ? text(flip) : 'missing') + ')');
    click(flip); await sleep(100); ok(q('#sort').value === 'nameZA' && /Name Z to A/.test(text(q('#sortFlip'))), 'tapping it flips the direction');
    set(q('#sort'), 'new'); await sleep(100); const newest = ids(); click(q('#sortFlip')); await sleep(100); ok(q('#sort').value === 'old' && JSON.stringify(ids()) === JSON.stringify(newest.slice().reverse()), 'newest and oldest are exact reverses');
    ok(o.errors.length === 0, 'no page errors while sorting (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Task 7: first-time guide, Help, accessibility
  list.push(async () => {
    const o = await openAdmin('owner', { guide: true }); const { q, qa, text, click } = o;
    const g = q('#guide'); ok(!!g && !g.hidden, 'a first-time visitor sees the guide');
    ok(qa('#guide li').length === 4 && /Pack/.test(text(g)) && /shipment/i.test(text(g)) && /label/i.test(text(g)) && /delivered/i.test(text(g)), 'the guide has the four steps in plain words');
    click(o.byText('#guide button', /Got it/)); await sleep(100);
    ok(q('#guide').hidden && o.win.localStorage.getItem('mngGuideSeen') === '1', 'Got it hides it and remembers that on this device');
    click(q('#helpBtn')); await sleep(150);
    ok(!!q('#sheet.on') && /How this works/.test(text(q('#panel'))) && qa('#panel li').length === 4, 'the ? button reopens the four steps as Help');
    click(o.byText('#panel button', /^Close$/)); await sleep(60);
    // accessibility
    const unnamed = qa('button').filter((b) => !text(b) && !b.getAttribute('aria-label') && !b.getAttribute('title'));
    ok(unnamed.length === 0, 'every button has a name (' + unnamed.map((b) => b.id || b.className).join(',') + ')');
    ok(q('#tabs').getAttribute('role') === 'tablist' && qa('#tabs .tab').every((t) => t.getAttribute('role') === 'tab' && /true|false/.test(t.getAttribute('aria-selected'))), 'tabs are announced as tabs with a selected state');
    click(o.byText('#tabs .tab', /^Stock$/)); await sleep(300); ok(o.byText('#tabs .tab', /^Stock$/).getAttribute('aria-selected') === 'true', 'the selected tab is marked');
    ok(!!q('#q').getAttribute('aria-label'), 'the search box has an accessible name');
    ok(o.errors.length === 0, 'no page errors with the guide and help (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
    const seen = await openAdmin('owner'); ok(seen.q('#guide').hidden, 'someone who has seen it does not get it again'); seen.close();
  });

  // Every button style combination the page uses must set its own text AND background colours (a ghost button with a red
  // background once showed terracotta text on red: Pause selling).
  list.push(async () => {
    const html = await (await fetch(BASE + '/admin')).text();
    const used = new Set(); for (const m of html.matchAll(/class: '(btn[^']*)'/g)) used.add(m[1].trim().split(/\s+/).filter((c) => !['small'].includes(c)).sort().join(' '));
    for (const m of html.matchAll(/class: '(btn ghost small)' \+ \([^)]*'\s?(red)'/g)) used.add('btn ghost red');
    ok(used.has('btn ghost red'), 'the page really uses the ghost + red combination (Pause selling, Clear low flag)');
    const rule = (html.match(/\.btn\.ghost\.red\{[^}]*\}/) || [''])[0];
    ok(/background:transparent/.test(rule) && /color:var\(--tx-red\)/.test(rule) && /border[^;]*var\(--red\)/.test(rule), 'a ghost red button is outlined with red text on a clear background (' + rule + ')');
    ok(/\.btn\.red\{[^}]*background:var\(--red\)/.test(html) && !/\.btn\.red\{[^}]*color:var\(--tx-terra\)/.test(html), 'a filled red button keeps white text');
  });

  // Contrast: text and button colours meet WCAG AA (4.5:1) in the light and dark palettes
  list.push(async () => {
    const html = await (await fetch(BASE + '/admin')).text();
    const root = (re) => Object.fromEntries([...(html.match(re) || [''])[0].matchAll(/--([a-z0-9-]+):(#[0-9A-Fa-f]{3,6})/g)].map((m) => [m[1], m[2]]));
    const light = root(/:root\{[^}]*\}/); const darkOver = root(/prefers-color-scheme:dark\)\{:root\{[^}]*\}/); const dark = { ...light, ...darkOver };
    const lum = (hex) => { let h = hex.slice(1); if (h.length === 3) h = h.replace(/./g, '$&$&'); const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const pairs = (t) => [['ink on paper', t.ink, t.paper], ['ink2 on paper', t.ink2, t.paper], ['ink on cream', t.ink, t.cream], ['ink2 on cream', t.ink2, t.cream], ['white on terracotta button', '#FFFFFF', t['terra']], ['white on green button', '#FFFFFF', t.green], ['white on red button', '#FFFFFF', t.red], ['terracotta text on paper', t['tx-terra'], t.paper], ['amber note on cream', t['tx-amber'], t.cream], ['red text on paper', t['tx-red'], t.paper], ['green text on paper', t['tx-green'], t.paper], ['terracotta text on cream', t['tx-terra'], t.cream], ['badge: amber on pale amber', t.amber, '#FDF0D5'], ['badge: green on pale green', t.green, '#DDEFE3'], ['badge: red on pale red', t.red, '#F6DAD8'], ['badge: navy on pale blue', t.navy, '#E3ECF6'], ['badge: purple on pale purple', '#5A3E99', '#E8E1F4'], ['white on navy', '#FFFFFF', t.navy], ['white on delivered green', '#FFFFFF', t.green]];
    for (const [name, theme] of [['light', light], ['dark', dark]]) for (const [label, fg, bg] of pairs(theme)) { if (!fg || !bg) continue; const r = ratio(fg, bg); ok(r >= 4.5, name + ': ' + label + ' is ' + r.toFixed(2) + ':1 (needs 4.5)'); }
  });

  // Pick-list footer: says what the list covers and what it left out
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click } = o;
    let page = ''; o.win.open = () => ({ document: { open() {}, write(h) { page += h; }, close() {} }, focus() {}, print() {}, close() {} });
    click(o.byText('#flow .step', /To pack/)); await sleep(100);
    const toPack = qa('#list .card').map((c) => text(c).match(/MNG-[A-Z0-9]+-\d+/)[0]);
    click(o.byText('#bulk button', /Print pick list/)); await until(() => /What this list covers/.test(page), 4000, 'the pick list');
    const covers = (page.match(/What this list covers[\s\S]*?Left out/) || [''])[0];
    ok(toPack.length > 0 && toPack.every((id) => covers.includes(id)), 'the footer names every order the list covers (' + toPack.join(',') + ')');
    ok(new RegExp('<b>' + toPack.length + ' order').test(covers), 'and says how many there are');
    const left = (page.match(/Left out of this list[\s\S]*$/) || [''])[0];
    ok(/MNG-TEST-1001/.test(left) && /test order/i.test(left), 'a test order is named under left out, with the reason');
    ok(/MNG-UUUU-1011/.test(left) && /waiting for payment/.test(left), 'unpaid orders are named too');
    ok(/already shipped/.test(left) || /already delivered/.test(left), 'shipped and delivered orders are counted');
    ok(!toPack.some((id) => left.includes(id)), 'a covered order is never listed as left out');
    ok(/count only the orders listed/i.test(page), 'a plain-words note explains what the box totals include');
    ok(o.errors.length === 0, 'no page errors printing the pick list (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Shipped tab is split: "Awaiting pickup" (booked, courier has not collected) above "With courier".
  // Runs FIRST: later checks mark the practice parcels delivered, which would empty the Shipped step.
  list.unshift(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, set } = o;
    click(o.byText('#flow .step', /Shipped/)); await sleep(150);
    const shippedCount = Number(text(o.byText('#flow .step', /Shipped/).querySelector('b')));
    const heads = qa('#list .sechead').map((h) => text(h));
    ok(heads.length === 2 && /^Awaiting pickup/.test(heads[0]) && /^With courier/.test(heads[1]), 'Shipped shows Awaiting pickup above With courier (saw: ' + heads.join(' | ') + ')');
    const section = {}; let cur = '';
    Array.from(q('#list').children).forEach((k) => { if (k.classList.contains('sechead')) cur = text(k); else if (k.classList.contains('card')) section[(text(k).match(/MNG-[A-Z0-9]+-\d+/) || [''])[0]] = cur; });
    ok(/^Awaiting pickup/.test(section['MNG-CCCC-1009'] || ''), 'a booked Delhivery parcel sits under Awaiting pickup');
    ok(/^With courier/.test(section['MNG-WITH-1009'] || ''), 'a parcel the courier has collected sits under With courier');
    ok(qa('#list .card').length === shippedCount, 'section headers are not cards: the card count still equals the Shipped step count (' + qa('#list .card').length + ' vs ' + shippedCount + ')');
    ok(/Awaiting pickup/.test(text(q('#list .sechead'))) && /\b1\b/.test(heads[0]), 'the header carries how many parcels wait (saw: ' + heads[0] + ')');
    const cardOf = (id) => qa('#list .card').find((c) => text(c).includes(id));
    ok(!/Mark delivered/.test(text(cardOf('MNG-CCCC-1009'))), 'a parcel awaiting pickup has no one-tap Mark delivered (it has not even been collected)');
    ok(/Mark delivered/.test(text(cardOf('MNG-WITH-1009'))), 'a parcel with the courier keeps its one-tap Mark delivered');
    set(q('#q'), 'WITH-1009'); await sleep(120);
    ok(qa('#list .sechead').length === 1 && /^With courier/.test(text(q('#list .sechead'))), 'a section with nothing in it shows no header');
    set(q('#q'), '');
    click(o.byText('#flow .step', /Packed/)); await sleep(120);
    ok(qa('#list .sechead').length === 0, 'other steps have no pick-up sections');
    ok(o.errors.length === 0, 'no page errors on the Shipped split (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Day headers: orders from different days are visibly separated when the list is in date order
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, set } = o;
    const token = o.win.localStorage.getItem('mngAdminToken');
    const api = await (await fetch(BASE + '/admin/api/orders', { headers: { Authorization: 'Bearer ' + token } })).json();
    const istDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const label = (iso) => new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
    const dayOf = Object.fromEntries(api.orders.map((x) => [x.id, { day: istDay(x.paid_at || x.created_at), label: label(x.paid_at || x.created_at) }]));
    click(o.byText('#chips .chip', /^All\b/)); await sleep(150);
    for (const sort of ['new', 'old']) {
      set(q('#sort'), sort); await sleep(150);
      const kids = Array.from(q('#list').children);
      let prev = null, headNow = null, good = true, why = '', heads = 0;
      kids.forEach((k) => {
        if (k.classList.contains('dayhead')) { heads++; headNow = k; return; }
        if (!k.classList.contains('card')) return;
        const id = (text(k).match(/MNG-[A-Z0-9]+-\d+/) || [''])[0]; const d = dayOf[id];
        if (!d) return;
        if (!prev || prev !== d.day) { if (!headNow || !text(headNow).includes(d.label)) { good = false; why = id + ' should follow a header with ' + d.label + ' (saw ' + (headNow ? text(headNow) : 'none') + ')'; } }
        else if (headNow) { good = false; why = id + ' is the same day as the card above, so no header should sit between them'; }
        prev = d.day; headNow = null;
      });
      const days = new Set(Array.from(q('#list').querySelectorAll('.card')).map((c) => (dayOf[(text(c).match(/MNG-[A-Z0-9]+-\d+/) || [''])[0]] || {}).day));
      ok(good, 'sort ' + sort + ': exactly one header at the start of each new day (' + why + ')');
      ok(heads === days.size && heads >= 3, 'sort ' + sort + ': one header per day (' + heads + ' headers, ' + days.size + ' days)');
    }
    set(q('#sort'), 'new'); await sleep(120);
    const under = {}; let hd = '';
    Array.from(q('#list').children).forEach((k) => { if (k.classList.contains('dayhead')) hd = text(k); else if (k.classList.contains('card')) under[(text(k).match(/MNG-[A-Z0-9]+-\d+/) || [''])[0]] = hd; });
    ok(/20 Oct/.test(under['MNG-ISTA-1000'] || '') && /21 Oct/.test(under['MNG-ISTB-1000'] || ''), 'days are Indian days: 22:30 IST on 20 Oct and 00:30 IST on 21 Oct are different days (saw: ' + under['MNG-ISTA-1000'] + ' / ' + under['MNG-ISTB-1000'] + ')');
    const first = text(q('#list .dayhead')); ok(/\b\d+ orders?\b/.test(first) && /\b\d+ boxes?\b/.test(first), 'a header says how many orders and boxes that day (saw: ' + first + ')');
    for (const sort of ['valueAsc', 'boxesDesc', 'nameAZ']) { set(q('#sort'), sort); await sleep(120); ok(qa('#list .dayhead').length === 0, 'sort ' + sort + ': no day headers (they only make sense in date order)'); }
    set(q('#sort'), 'new'); await sleep(120);
    set(q('#q'), 'ISTB'); await sleep(120);
    ok(qa('#list .dayhead').length === 1 && qa('#list .card').length === 1, 'a search that leaves one order shows one header');
    ok(o.errors.length === 0, 'no page errors with day headers (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Receive form: pick the date the batch was prepared on a calendar instead of typing a lot code
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, byText, set } = o;
    click(byText('#tabs .tab', /^Stock$/)); await until(() => qa('#viewStock .line').length >= 4, 4000, 'the stock list');
    click(byText('#viewStock button', /^Receive stock$/)); await until(() => /Which/i.test(text(q('#viewStock'))), 3000, 'the item picker');
    click(byText('#viewStock button', /Atta Original/)); await until(() => /Receive: Atta Original/.test(text(q('#viewStock'))), 3000, 'the receive form');
    const dates = qa('#viewStock input[type=date]');
    ok(dates.length === 2, 'the receive form has two calendar pickers: prepared on, and best before (saw ' + dates.length + ')');
    ok(/Prepared on/i.test(text(q('#viewStock'))), 'the first one is labelled Prepared on');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    ok(dates[0].max === today, 'a batch cannot be prepared in the future: the calendar stops at today (' + dates[0].max + ')');
    set(dates[0], '2026-10-15');
    ok(qa('#viewStock input').some((i) => i.value === '15OCT26'), 'picking 15 Oct 2026 fills the lot code as 15OCT26 (capitals, same style every time)');
    ok(dates[1].value === '2027-01-13', 'best before fills in 90 days later: 2027-01-13 (saw ' + dates[1].value + ')');
    set(dates[0], '2027-03-05');
    ok(qa('#viewStock input').some((i) => i.value === '05MAR27') && dates[1].value === '2027-06-03', 'another date: 05MAR27, best before 2027-06-03');
    set(dates[1], '2027-06-10');
    ok(dates[1].value === '2027-06-10', 'best before can still be changed by hand');
    ok(o.errors.length === 0, 'no page errors on the receive form (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Stock history: filter chips (receipts were buried under packed-order lines), and Correct on a receipt
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, byText, set } = o;
    const token = o.win.localStorage.getItem('mngAdminToken');
    const apiGet = async (p) => (await (await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + token } })).json());
    click(byText('#tabs .tab', /^Stock$/)); await until(() => qa('#viewStock .line').length >= 4, 4000, 'the stock list');
    click(byText('#viewStock button', /^History$/)); await until(() => /Stock history/.test(text(q('#viewStock'))), 4000, 'the history page');
    const chips = qa('#viewStock .chip').map((c) => text(c));
    ok(['All', 'Received', 'Taken out', 'Sales'].every((c) => chips.includes(c)), 'History has filter chips All, Received, Taken out, Sales (saw: ' + chips.join('|') + ')');
    click(byText('#viewStock .chip', /^Received$/)); await until(() => qa('#viewStock .line').length >= 2 && qa('#viewStock .line').every((l) => /Received/.test(text(l))), 4000, 'only received lines');
    let lines = qa('#viewStock .line');
    ok(lines.length >= 2 && lines.every((l) => /Received/.test(text(l))), 'the Received chip lists only receipts (' + lines.length + ' lines)');
    const btn = (l, re) => Array.from(l.querySelectorAll('button')).find((b) => re.test(text(b)));
    ok(lines.every((l) => !!btn(l, /^Correct$/)), 'every receipt has a Correct button');
    ok(!!byText('#viewStock .chip.on', /^Received$/), 'the chosen chip is shown as selected');

    // Correct the Sugar-Lite receipt (33 received, 3 damaged) to 36 received, 0 damaged
    const before = (await apiGet('/admin/api/inventory')).items.find((i) => i.slug === 'atta-lite-sugar').on_hand;
    click(btn(lines.find((l) => /atta-lite-sugar/.test(text(l))), /^Correct$/));
    await until(() => /Correct receipt: Atta Sugar-Lite/.test(text(q('#viewStock'))), 4000, 'the correct form');
    const inputs = qa('#viewStock input');
    ok(inputs[0].value === '33' && inputs[1].value === '3' && inputs.some((i) => i.value === '15OCT26'), 'the form is filled with the old receipt: 33 received, 3 damaged, lot 15OCT26 (saw ' + inputs.map((i) => i.value).join('/') + ')');
    const dates = qa('#viewStock input[type=date]');
    ok(dates.length === 2 && dates[0].value === '2026-10-15' && dates[1].value === '2027-01-13', 'the dates are calendar pickers, refilled from the old receipt: prepared 2026-10-15, best before 2027-01-13 (saw ' + dates.map((d) => d.value).join(' / ') + ')');
    ok(inputs.some((i) => i.value === '15OCT26'), 'correcting without touching the date keeps the old lot code exactly');
    ok(inputs.some((i) => i.value === '3 crushed'), 'the old note is carried over');
    ok((await apiGet('/admin/api/inventory')).items.find((i) => i.slug === 'atta-lite-sugar').on_hand === before, 'opening Correct changes nothing yet');
    set(inputs[0], '36'); set(inputs[1], '0');
    click(byText('#viewStock button', /^Save receipt$/));
    // the practice data has packed orders already taken off Sugar-Lite, so check the change, not an absolute number: +33 -3 becomes +36 -0, a net +6
    await until(async () => (await apiGet('/admin/api/inventory')).items.find((i) => i.slug === 'atta-lite-sugar').on_hand === before + 6, 5000, 'stock to update').catch(() => {});
    ok((await apiGet('/admin/api/inventory')).items.find((i) => i.slug === 'atta-lite-sugar').on_hand === before + 6, 'saving the correction adds the difference, +6 (was ' + before + ')');
    await until(() => qa('#viewStock .line').length >= 4, 4000, 'back at the stock list');

    click(byText('#viewStock button', /^History$/)); await until(() => /Stock history/.test(text(q('#viewStock'))), 4000, 'history again');
    click(byText('#viewStock .chip', /^Received$/)); await sleep(300);
    lines = qa('#viewStock .line').filter((l) => /atta-lite-sugar/.test(text(l)));
    const oldLine = lines.find((l) => /\+33/.test(text(l))), newLine = lines.find((l) => /\+36/.test(text(l)));
    ok(!!oldLine && /Cancelled/.test(text(oldLine)) && !btn(oldLine, /^(Correct|Reverse)$/), 'the old receipt now says Cancelled and offers no Correct or Reverse (' + (oldLine ? text(oldLine).slice(0, 80) : 'missing') + ')');
    ok(!!newLine && !!btn(newLine, /^Correct$/), 'the new receipt is there, and can itself be corrected');
    click(byText('#viewStock .chip', /^All$/)); await sleep(300);
    ok(qa('#viewStock .line').some((l) => /Reversed/.test(text(l))), 'the All view shows the reversing lines too');
    ok(o.errors.length === 0, 'no page errors on stock history (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Rename a lot (owner only): fixes a mistyped lot code without a phantom negative lot
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, byText, set } = o;
    const token = o.win.localStorage.getItem('mngAdminToken');
    const apiGet = async (p) => (await (await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + token } })).json());
    click(byText('#tabs .tab', /^Stock$/)); await until(() => qa('#viewStock .line').length >= 4, 4000, 'the stock list');
    ok(!!byText('#viewStock button', /^Rename lot$/), 'the owner sees a Rename lot button');
    const before = (await apiGet('/admin/api/inventory')).items.find((i) => i.slug === 'atta-lite-sugar');
    click(byText('#viewStock button', /^Rename lot$/)); await until(() => /Which/i.test(text(q('#viewStock'))), 3000, 'the item picker');
    click(byText('#viewStock button', /Atta Sugar-Lite/)); await until(() => /Rename lot: Atta Sugar-Lite/.test(text(q('#viewStock'))), 3000, 'the rename form');
    const sel = q('#viewStock select');
    ok(!!sel && Array.from(sel.options).some((x) => /15OCT26/.test(x.textContent)), 'the form lists the product\'s current lots (' + (sel ? Array.from(sel.options).map((x) => x.textContent).join(' | ') : 'no select') + ')');
    set(qa('#viewStock input').find((i) => /15OCT26/.test(i.placeholder)), '16OCT26');
    click(byText('#viewStock button', /^Rename lot$/)); await until(async () => (await apiGet('/admin/api/inventory')).items.find((i) => i.slug === 'atta-lite-sugar').lots.some((l) => l.lot_code === '16OCT26'), 5000, 'the lot to be renamed').catch(() => {});
    const after = (await apiGet('/admin/api/inventory')).items.find((i) => i.slug === 'atta-lite-sugar');
    ok(after.lots.length === before.lots.length && after.lots.every((l) => l.lot_code !== '15OCT26') && after.lots.some((l) => l.lot_code === '16OCT26'), 'the lot now carries the new code and the old one is gone from the stock list (' + after.lots.map((l) => l.lot_code + ':' + l.qty).join(',') + ')');
    ok(after.on_hand === before.on_hand, 'total on hand is unchanged (' + before.on_hand + ' -> ' + after.on_hand + ')');
    ok(o.errors.length === 0, 'no page errors renaming a lot (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
    const s = await openAdmin('staff'); click(s.byText('#tabs .tab', /^Stock$/)); await until(() => s.qa('#viewStock .line').length >= 4, 4000, 'the stock page for staff');
    ok(!s.byText('#viewStock button', /^Rename lot$/), 'staff do not see Rename lot');
    s.close();
  });

  return list;
};
