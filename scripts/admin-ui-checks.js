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
    // Task 11 changed this check: the top button was Receive stock (a picker, then the old receive form); biscuits now arrive only through New delivery
    const top = o.byText('#viewStock button', /^New delivery$/);
    ok(!!top && !o.byText('#viewStock button', /^Receive stock$/), 'one New delivery button sits at the top (Receive stock is gone)');
    click(top); await until(() => qa('#viewStock .dlrow').length === 4, 4000, 'the New delivery page').catch(() => {});
    ok(/^New delivery/.test(text(q('#viewStock .pagehead'))) && /Atta Kesari/.test(text(q('#viewStock'))), 'it opens New delivery with a row per flavour');
    ok(!q('#sheet.on'), 'New delivery opens in the page');
    click(o.byText('#viewStock button', /^Back to Stock$/)); await until(() => qa('#viewStock .line').length >= 4, 3000, 'back to the stock list');
    ok(true, 'Back returns to the stock list');
    click(o.byText('#viewStock button', /^History$/)); await until(() => /Stock history/.test(text(q('#viewStock'))), 4000, 'the history page').catch(() => {});
    ok(/Stock history/.test(text(q('#viewStock'))) && !q('#sheet.on'), 'History also opens in the page');
    ok(o.errors.length === 0, 'no page errors on the stock page (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
    const s = await openAdmin('staff'); click(s.byText('#tabs .tab', /^Stock$/)); await until(() => s.qa('#viewStock .line').length >= 4, 4000, 'the stock page for staff');
    ok(!s.byText('#viewStock button', /^Add packaging item$/) && !s.byText('#viewStock button', /Low level/) && !s.byText('#viewStock button', /^Remove$/), 'staff do not see owner-only stock controls');
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

  // Take out several flavours in one entry; sold at an exhibition or event (26 Oct 2026)
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, byText, set } = o;
    const token = o.win.localStorage.getItem('mngAdminToken');
    const apiGet = async (p) => (await (await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + token } })).json());
    const onHand = async (slug) => (await apiGet('/admin/api/inventory')).items.find((i) => i.slug === slug).on_hand;
    click(byText('#tabs .tab', /^Stock$/)); await until(() => qa('#viewStock .line').length >= 4, 4000, 'the stock page');
    ok(!!byText('#viewStock button', /Take out: several/), 'the stock page has a Take out: several flavours button');
    click(byText('#viewStock button', /Take out: several/)); await until(() => /Take out: several flavours/.test(text(q('#viewStock'))), 4000, 'the multi take-out form');
    const sel = q('#viewStock select');
    ok(sel && Array.from(sel.options).some((op) => op.value === 'EVENT_SALE' && /Sold at an exhibition or event/.test(op.textContent)) && sel.value === 'EVENT_SALE', 'reasons include Sold at an exhibition or event, chosen first');
    const boxes = qa('#viewStock input[data-slug]');
    ok(['atta-original', 'atta-ajwain', 'atta-kesari', 'atta-lite-sugar'].every((sl) => boxes.some((b) => b.getAttribute('data-slug') === sl)), 'one box per flavour (' + boxes.map((b) => b.getAttribute('data-slug')).join(',') + ')');
    ok(/Which event/.test(text(q('#viewStock'))), 'it asks which event');
    const k0 = await onHand('atta-kesari'), o0 = await onHand('atta-original');
    click(byText('#viewStock button', /^Save take-out$/)); await sleep(400);
    ok(await onHand('atta-kesari') === k0, 'saving with nothing filled is refused and changes nothing');
    set(q('#viewStock input[data-role="who"]'), 'Diwali Fair, Sector 15');
    set(boxes.find((b) => b.getAttribute('data-slug') === 'atta-kesari'), '3');
    set(boxes.find((b) => b.getAttribute('data-slug') === 'atta-original'), '2');
    click(byText('#viewStock button', /^Save take-out$/));
    await until(async () => (await onHand('atta-kesari')) === k0 - 3, 5000, 'stock to drop').catch(() => {});
    ok(await onHand('atta-kesari') === k0 - 3 && await onHand('atta-original') === o0 - 2, 'one save takes 3 Kesari and 2 Original off stock');
    const hist = await apiGet('/admin/api/inventory/history?types=EVENT_SALE&limit=10');
    ok(hist.movements && hist.movements.length >= 2 && hist.movements.every((m) => m.type === 'EVENT_SALE' && m.ref === 'Diwali Fair, Sector 15'), 'the lines are event sales with the event name');
    // the single take-out and the reports know the new reason
    await until(() => qa('#viewStock .line').length >= 4, 4000, 'back at the stock list').catch(() => {});
    click(byText('#viewStock button', /Where did it go/)); await until(() => /Where did the stock go/.test(text(q('#viewStock'))), 4000, 'the flow report').catch(() => {});
    ok(/Sold at events/.test(text(q('#viewStock'))), 'Where did it go shows Sold at events');
    click(byText('#viewStock button', /^Back$/)); await until(() => qa('#viewStock .line').length >= 4, 3000, 'back');
    click(byText('#viewStock button', /^History$/)); await until(() => /Stock history/.test(text(q('#viewStock'))), 4000, 'history');
    ok(qa('#viewStock .line').some((l) => /Sold at event/.test(text(l)) && /Diwali Fair, Sector 15/.test(text(l))), 'history labels the lines Sold at event, with the event');
    ok(o.errors.length === 0, 'no page errors on the multi take-out (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Delivery dates and LATE orders; per-flavour Take out removed from the stock page (27 Oct 2026)
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, byText } = o;
    const card = (id) => qa('#list .card').find((c) => text(c).includes(id));
    click(byText('#flow .step', /Shipped/)); await until(() => !!card('MNG-WITH-1009'), 4000, 'the shipped list');
    const late = card('MNG-WITH-1009'), waiting = card('MNG-CCCC-1009');
    ok(late && /LATE/.test(text(late)) && /2 days late/.test(text(late)), 'an order past Delhivery\'s promised date shows LATE and how many days (' + (late ? text(late).slice(0, 160) : 'no card') + ')');
    ok(late && /Expected by/.test(text(late)), 'the card shows the expected delivery date');
    ok(late && late.classList.contains('late'), 'the late card is marked out (red edge)');
    ok(waiting && !/LATE/.test(text(waiting)), 'a parcel Delhivery has not collected yet is not LATE');
    ok(qa('#needs .need').some((b) => /1\s*late order/i.test(text(b)) && b.classList.contains('hot')), 'the top bar says 1 late order, in red');
    const chip = qa('#chips .chip').find((c) => /^Late \d+/.test(text(c)));
    ok(chip && /^Late 1$/.test(text(chip)), 'a Late filter tab with the count (' + qa('#chips .chip').map((c) => text(c)).join(' | ') + ')');
    click(chip); await sleep(150);
    ok(qa('#list .card').length === 1 && !!card('MNG-WITH-1009'), 'the Late tab lists only late orders');
    click(late || card('MNG-WITH-1009')); await until(() => /Expected delivery/.test(text(q('#sheet'))), 4000, 'the order sheet').catch(() => {});
    ok(/Expected delivery/.test(text(q('#sheet'))) && /LATE/.test(text(q('#sheet'))), 'the order sheet shows the expected delivery date and LATE');
    o.close();

    // stock page: no per-flavour Take out; packaging is hand-kept (Set count only, no Receive or Take out); the several-flavours form title reads right
    const s = await openAdmin('owner');
    click(s.byText('#tabs .tab', /^Stock$/)); await until(() => s.qa('#viewStock .line').length >= 4, 4000, 'the stock page');
    const rows = s.qa('#viewStock .line');
    const btns = (re) => rows.filter((l) => re.test(s.text(l))).map((l) => Array.from(l.querySelectorAll('button')).map((b) => s.text(b)));
    const kes = btns(/Atta Kesari/)[0] || [], tape = btns(/Packing tape/)[0] || [];
    ok(kes.length && !kes.includes('Take out') && kes.includes('Count') && kes.includes('Receive'), 'a flavour has no Take out of its own any more (' + kes.join(',') + ')');
    ok(tape.includes('Set count') && !tape.includes('Take out') && !tape.includes('Receive'), 'packaging (tape) offers Set count, and no Receive or Take out (' + tape.join(',') + ')');
    s.click(s.byText('#viewStock button', /Take out: several/)); await until(() => /Take out/.test(s.text(s.q('#viewStock'))), 4000, 'the form');
    ok(/Take out: several flavours/.test(s.text(s.q('#viewStock'))) && !/Take out several: flavours/.test(s.text(s.q('#viewStock'))), 'the form title reads Take out: several flavours');
    ok(o.errors.length === 0 && s.errors.length === 0, 'no page errors (' + o.errors.concat(s.errors).join(' | ').slice(0, 200) + ')');
    s.close();
  });

  // Suggestions from WhatsApp: More > Suggestions lists them; the owner marks Planned / Done / Not for us (28 Oct 2026)
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, byText } = o;
    click(byText('#tabs .tab', /^More$/)); await until(() => !!byText('#viewMore .morebtn', /Suggestions/), 4000, 'the More page');
    click(byText('#viewMore .morebtn', /Suggestions/)); await until(() => /jaggery/i.test(text(q('#panel'))), 4000, 'the suggestions list').catch(() => {});
    const p = text(q('#panel'));
    ok(/Make a jaggery one/.test(p) && /Riya Kapoor/.test(p) && /MNG-SUGG-2810/.test(p), 'a suggestion shows its text, who sent it and their latest order');
    ok(/Feedback/.test(p) && /4/.test(p) && /Kesari too sweet/.test(p), 'feedback form answers are listed too, with the rating');
    ok(/taste it first, free/i.test(p), 'the screen reminds the owner of the promise');
    const row = qa('#panel .line').find((l) => /jaggery/i.test(text(l)));
    const done = row && Array.from(row.querySelectorAll('button')).find((b) => /^Done$/.test(text(b)));
    ok(!!done, 'each suggestion has Planned / Done / Not for us');
    click(done); await until(() => qa('#panel .line').some((l) => /jaggery/i.test(text(l)) && /DONE/.test(text(l))), 4000, 'the status to change').catch(() => {});
    ok(qa('#panel .line').some((l) => /jaggery/i.test(text(l)) && /DONE/.test(text(l))), 'marking Done shows DONE (promise to keep: they taste it first)');
    ok(o.errors.length === 0, 'no page errors on Suggestions (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
    const s = await openAdmin('staff');
    click(s.byText('#tabs .tab', /^Orders$/)); await sleep(100);
    ok(!s.byText('#tabs .tab', /^More$/) || s.q('#moreTab').hidden, 'staff cannot open More (Suggestions stays with the owner)');
    s.close();
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

  // Dates on New delivery: picked on a calendar; the code, best before, last ship and website stop are worked out, never typed (spec 6.2).
  // Task 11 changed this check: it was the old Receive form (prepared-on picker that filled 15OCT26 and a best before to edit by hand),
  // which a biscuit's Receive no longer opens.
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, byText, set } = o;
    click(byText('#tabs .tab', /^Stock$/)); await until(() => qa('#viewStock .line').length >= 4, 4000, 'the stock list');
    const orig = qa('#viewStock .line').find((l) => /Atta Original/.test(text(l)));
    click(Array.from(orig.querySelectorAll('button')).find((b) => /^Receive$/.test(text(b))));
    await until(() => qa('#viewStock .dlrow').length === 4, 4000, 'New delivery from Receive');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const arrived = q('#dl-arrivedOn'), bake = q('#dl-bakeDate');
    ok(!!arrived && !!bake && arrived.type === 'date' && bake.type === 'date', 'arrived on and the bake date are calendar pickers');
    ok(arrived.value === today && arrived.max === today && bake.max === today, 'arrived on starts at today; neither can be after today (' + [arrived.value, arrived.max, bake.max].join(' / ') + ')');
    ok(bake.value === '', 'the bake date has no default: it must be entered');
    ok(/Bake date \(from the bill\)/.test(text(q('#viewStock'))), 'the bake date is labelled "Bake date (from the bill)"');
    const labels = qa('#viewStock label').map((l) => text(l)).join(' | ');
    ok(!/best before|lot code/i.test(labels) && !qa('#viewStock input').some((i) => /lot code/i.test(i.placeholder || '')), 'no lot code or best-before field to type (' + labels.slice(0, 160) + ')');
    set(bake, '2026-10-15');
    ok(bake.value === '2026-10-15', 'a bake date can be picked');
    ok(o.errors.length === 0, 'no page errors on the New delivery dates (' + o.errors.join(' | ').slice(0, 200) + ')');
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
    // the practice admin seeds best before relative to its start time (so it never ages past a cut-off), so read the seeded date back; the prepared date comes from the lot code 15OCT26
    const seededBB = ((await apiGet('/admin/api/inventory')).items.find((i) => i.slug === 'atta-lite-sugar').lots.find((l) => l.lot_code === '15OCT26') || {}).best_before;
    ok(dates.length === 2 && !!seededBB && dates[0].value === '2026-10-15' && dates[1].value === seededBB, 'the dates are calendar pickers, refilled from the old receipt: prepared 2026-10-15 (from the lot code), best before ' + seededBB + ' (the practice stock\'s seeded date) (saw ' + dates.map((d) => d.value).join(' / ') + ')');
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
    // Wait for the history to redraw for the chosen chip (it reloads from the server), not a fixed time: a 300 ms sleep
    // read the previous view on a slow run, and the late redraw then hit the closed window (flaky until 29 Oct 2026).
    const shown = (chip, linesOk) => until(() => !!byText('#viewStock .chip.on', chip) && linesOk(qa('#viewStock .line')), 5000, 'the history to show ' + chip);
    click(byText('#viewStock .chip', /^Received$/)); await shown(/^Received$/, (ls) => ls.length >= 2 && ls.every((l) => /Received/.test(text(l)))).catch(() => {});
    lines = qa('#viewStock .line').filter((l) => /atta-lite-sugar/.test(text(l)));
    const oldLine = lines.find((l) => /\+33/.test(text(l))), newLine = lines.find((l) => /\+36/.test(text(l)));
    ok(!!oldLine && /Cancelled/.test(text(oldLine)) && !btn(oldLine, /^(Correct|Reverse)$/), 'the old receipt now says Cancelled and offers no Correct or Reverse (' + (oldLine ? text(oldLine).slice(0, 80) : 'missing') + ')');
    ok(!!newLine && !!btn(newLine, /^Correct$/), 'the new receipt is there, and can itself be corrected');
    click(byText('#viewStock .chip', /^All$/)); await shown(/^All$/, (ls) => ls.some((l) => !/Received/.test(text(l)))).catch(() => {});
    ok(qa('#viewStock .line').some((l) => /Reversed/.test(text(l))), 'the All view shows the reversing lines too');
    ok(o.errors.length === 0, 'no page errors on stock history (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Rename a lot (owner only). Final review C2 changed this block: the Stock screen no longer offers Rename lot (it moved boxes to a code
  // with no lot row, so they slipped past a hold); a biscuit lot is fixed with Fix lot on its lot page, and the server refuses a biscuit rename.
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, byText } = o;
    const token = o.win.localStorage.getItem('mngAdminToken');
    const apiGet = async (p) => (await (await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + token } })).json());
    const apiPost = async (p, b) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(b) }); return { s: r.status, j: await r.json() }; };
    click(byText('#tabs .tab', /^Stock$/)); await until(() => qa('#viewStock .line').length >= 4, 4000, 'the stock list');
    ok(!byText('#viewStock button', /^Rename lot$/), 'the owner no longer sees Rename lot on the Stock screen (biscuit lots are fixed with Fix lot)');
    const before = (await apiGet('/admin/api/inventory')).items.find((i) => i.slug === 'atta-lite-sugar');
    click(byText('#viewStock button', /^Lots$/)); await until(() => qa('#viewStock .lotcard').some((c) => c.getAttribute('data-code') === '15OCT26' && c.getAttribute('data-slug') === 'atta-lite-sugar'), 4000, 'the Lots list');
    click(qa('#viewStock .lotcard').find((c) => c.getAttribute('data-code') === '15OCT26' && c.getAttribute('data-slug') === 'atta-lite-sugar'));
    await until(() => text(q('#viewStock .pagehead')) === '15OCT26' && /Atta Sugar-Lite/.test(text(q('#lotHead'))), 4000, 'the Sugar-Lite lot page').catch(() => {});
    ok(!!byText('#viewStock button', /^Fix lot$/), 'the lot page of Sugar-Lite 15OCT26 offers Fix lot instead (' + text(q('#viewStock .pagehead')) + ')');
    const rn = await apiPost('/admin/api/inventory/rename-lot', { slug: 'atta-lite-sugar', from: '15OCT26', to: '16OCT26' });
    const after = (await apiGet('/admin/api/inventory')).items.find((i) => i.slug === 'atta-lite-sugar');
    ok(rn.s === 409 && rn.j.error === 'Biscuit lots are fixed with Fix lot on the lot page, so the hold and the dates follow the lot.' && after.lots.map((l) => l.lot_code + ':' + l.qty).join() === before.lots.map((l) => l.lot_code + ':' + l.qty).join(), 'the server refuses a biscuit rename in plain words and the lots stay as they were (' + rn.s + ' ' + rn.j.error + ' | ' + after.lots.map((l) => l.lot_code + ':' + l.qty).join(',') + ')');
    ok(after.on_hand === before.on_hand, 'total on hand is unchanged (' + before.on_hand + ' -> ' + after.on_hand + ')');
    ok(o.errors.length === 0, 'no page errors on the Stock screen and the lot page (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
    const s = await openAdmin('staff'); click(s.byText('#tabs .tab', /^Stock$/)); await until(() => s.qa('#viewStock .line').length >= 4, 4000, 'the stock page for staff');
    ok(!s.byText('#viewStock button', /^Rename lot$/), 'staff do not see Rename lot');
    s.close();
  });

  // Reviews and Founding tasters (owner, More)
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, byText } = o;
    click(byText('#tabs .tab', /^More$/)); await sleep(200);
    ok(!!byText('#viewMore button', /Reviews/) && !!byText('#viewMore button', /Founding tasters/), 'More has Reviews and Founding tasters for the owner');
    click(byText('#viewMore button', /Reviews/)); await until(() => /Reviews/.test(text(q('#panel'))) && qa('#panel .rvcard').length >= 2, 4000, 'the reviews list');
    const cards = qa('#panel .rvcard');
    const bad = cards.find((c) => /REVB-1002/.test(text(c)));
    ok(!!bad && !bad.querySelector('img') && /<img src=x onerror=alert\(1\)>/.test(text(bad)), 'a comment with HTML shows as plain text; nothing is injected');
    ok(/Atta Original/.test(text(bad)) && /★/.test(text(bad)) && /NEW/i.test(text(bad)), 'a 1-star review shows its stars and is not hidden');
    ok(/Founding taster: gets new products free/.test(text(bad)), 'the founding taster label');
    ok(cards.some((c) => /Friend or family/.test(text(c))), 'the friend or family label');
    ok(/asked/i.test(text(q('#panel'))) && /received/i.test(text(q('#panel'))), 'the totals line');
    click(byText('#panel button', /^Close$/)); await sleep(100);
    click(byText('#viewMore button', /Founding tasters/)); await until(() => /Founding tasters/.test(text(q('#panel'))) && qa('#panel input[type=checkbox]').length >= 1, 4000, 'the tasters list');
    const rowsT = qa('#panel label.sw');
    const saved = rowsT.find((l) => /REVB-1002/.test(text(l)));
    ok(!!saved && saved.querySelector('input').checked, 'a buyer already on the saved list is ticked');
    ok(rowsT.filter((l) => !/REVB-1002/.test(text(l))).every((l) => !l.querySelector('input').checked), 'after the first save, other 11-17 Oct buyers are listed unticked (nobody is added silently)');
    ok(o.errors.length === 0, 'no page errors on reviews and tasters (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
    const s2 = await openAdmin('staff');
    ok(!s2.byText('#tabs .tab', /^More$/) || !s2.byText('#viewMore button', /Reviews/), 'staff do not see Reviews');
    s2.close();
  });

  // Meta and Google on the Stock screen (channel sync): a line each, owner-only buttons, a problem in Needs you now. Phone width 375 px.
  list.push(async () => {
    const dev = async (b) => (await fetch(BASE + '/dev/channels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json().catch(() => ({}));
    await dev({ reset: true });
    const o = await openAdmin('owner', { width: 375 }); const { q, qa, text, click, byText } = o;
    const token = o.win.localStorage.getItem('mngAdminToken');
    const api = async (p, body) => (await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined })).json().catch(() => ({}));
    const lines = (w) => w.qa('#viewStock .chan .chantx').map((e) => w.text(e));
    const row = (w, L) => w.qa('#viewStock .chan').find((r) => new RegExp('^' + L + '\\b').test(w.text(r.querySelector('.chantx'))));
    const btnIn = (w, L, re) => { const r = row(w, L); return r ? Array.from(r.querySelectorAll('button')).find((b) => re.test(w.text(b))) : null; };
    const lineOf = (w, L) => { const r = row(w, L); return r ? w.text(r.querySelector('.chantx')) : ''; };
    click(byText('#tabs .tab', /^Stock$/)); await until(() => lines(o).length === 2 && qa('#viewStock .line').length >= 4, 4000, 'the Meta and Google lines').catch(() => {});
    ok(lines(o).some((t) => /^Meta: /.test(t)) && lines(o).some((t) => /^Google: /.test(t)), 'the Stock screen has a line starting Meta: and one starting Google: (' + lines(o).join(' | ') + ')');
    ok(lines(o).join(' | ') === 'Meta: switched off | Google: switched off', 'both start switched off');
    const chanBox = q('#viewStock .chan') && q('#viewStock .chan').closest('.sec'), firstProduct = qa('#viewStock .line')[0];
    ok(!!chanBox && !!firstProduct && !!(chanBox.compareDocumentPosition(firstProduct) & o.win.Node.DOCUMENT_POSITION_FOLLOWING), 'the Meta and Google block sits above the item rows');
    ok(!!btnIn(o, 'Meta', /^Test with Original$/) && !!btnIn(o, 'Google', /^Test with Original$/), 'the owner sees Test with Original on each line');
    ok(!byText('#viewStock button', /^Switch on all four$/) && !byText('#viewStock button', /^Set up Google$/), 'no Switch on all four before a matching test, and no Set up Google once Google is set up');
    const tw = btnIn(o, 'Meta', /^Test with Original$/); if (tw) click(tw);
    // Test with Original pushes Original first, then reads it back (the practice Meta shows a push at once)
    const tested = /^Meta: matches, checked \d\d:\d\d$/;
    await until(() => tested.test(lineOf(o, 'Meta')), 5000, 'the test result').catch(() => {});
    ok(tested.test(lineOf(o, 'Meta')) && !!btnIn(o, 'Meta', /^Switch on all four$/), 'after Test with Original (a push, then a matching read) the Meta line says matches, with a time, and offers Switch on all four (' + lineOf(o, 'Meta') + ')');
    ok(/^Testing with Original\. Meta: /.test(text(q('#toast'))), 'a toast gives the result (' + text(q('#toast')) + ')');
    const cn = btnIn(o, 'Meta', /^Check now$/); if (cn) click(cn);
    await until(() => /^Meta: matches, checked \d\d:\d\d$/.test(lineOf(o, 'Meta')) && /\. Google: /.test(text(q('#toast'))), 5000, 'Meta to match').catch(() => {});
    ok(/^Meta: matches, checked \d\d:\d\d$/.test(lineOf(o, 'Meta')), 'Check now reads it back: Meta: matches, checked HH:MM (' + lineOf(o, 'Meta') + ')');
    ok(/^Meta: matches, checked \d\d:\d\d\. Google: switched off$/.test(text(q('#toast'))), 'Check now toasts both lines (' + text(q('#toast')) + ')');
    const st = await api('/admin/api/channels');
    const ist = st.channels?.meta?.checkedAt ? new Date(Date.parse(st.channels.meta.checkedAt) + 5.5 * 3600000).toISOString().slice(11, 16) : 'no time';
    ok(lineOf(o, 'Meta').endsWith(ist), 'the time is Indian time, HH:MM (' + ist + ')');
    ok(!!btnIn(o, 'Meta', /^Switch on all four$/) && !!btnIn(o, 'Meta', /^Check now$/) && !!btnIn(o, 'Meta', /^Switch off$/) && !btnIn(o, 'Meta', /^Test with Original$/), 'once the test matches: Switch on all four, Check now and Switch off');
    const so = btnIn(o, 'Meta', /^Switch off$/); if (so) click(so); await until(() => lineOf(o, 'Meta') === 'Meta: switched off', 4000, 'Meta off').catch(() => {});
    ok(lineOf(o, 'Meta') === 'Meta: switched off' && (await api('/admin/api/channels')).channels?.meta?.mode === 'off', 'Switch off puts Meta back to off');
    // a stock change goes out about 3 s later: the line redraws by itself, so it never keeps saying "matches" after a Pause
    await api('/admin/api/channels/mode', { channel: 'meta', mode: 'all' }); await api('/admin/api/channels/check', {});   // all four read back and matching
    click(byText('#tabs .tab', /^Orders$/)); click(byText('#tabs .tab', /^Stock$/));
    await until(() => /^Meta: matches/.test(lineOf(o, 'Meta')), 4000, 'Meta on').catch(() => {});
    const before = lineOf(o, 'Meta');
    const kes = qa('#viewStock .line').find((l) => /^Atta Kesari/.test(text(l))), pause = kes && Array.from(kes.querySelectorAll('button')).find((b) => /^Pause selling$/.test(text(b)));
    if (pause) click(pause);
    await until(() => /^Meta: waiting for Meta to update \(pushed \d\d:\d\d\)$/.test(lineOf(o, 'Meta')), 9000, 'the line to redraw').catch(() => {});
    ok(/^Meta: matches/.test(before) && /^Meta: waiting for Meta to update \(pushed \d\d:\d\d\)$/.test(lineOf(o, 'Meta')), 'after Pause selling the Meta line redraws from matches to waiting, with the push time (' + before + ' -> ' + lineOf(o, 'Meta') + ')');
    await api('/admin/api/inventory/pause', { slug: 'atta-kesari', paused: false }); await api('/admin/api/channels/mode', { channel: 'meta', mode: 'off' });
    ok(o.errors.length === 0, 'no page errors on the channel lines (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();

    const s = await openAdmin('staff', { width: 375 });
    s.click(s.byText('#tabs .tab', /^Stock$/)); await until(() => lines(s).length === 2, 4000, 'the lines for staff').catch(() => {});
    ok(lines(s).length === 2 && s.qa('#viewStock .chan button').length === 0 && !s.byText('#viewStock button', /^Test with Original$/), 'staff see both lines but no buttons (' + lines(s).join(' | ') + ')');
    s.close();

    // Set up Google: the button shows only while Google is not set up, and opens the steps
    await dev({ notSetUp: true });
    const g = await openAdmin('owner', { width: 375 });
    g.click(g.byText('#tabs .tab', /^Stock$/)); await until(() => lines(g).length === 2, 4000, 'the lines').catch(() => {});
    ok(lineOf(g, 'Google') === 'Google: not set up' && !!btnIn(g, 'Google', /^Set up Google$/) && !btnIn(g, 'Meta', /^Set up Google$/), 'Google not set up: the owner gets Set up Google on the Google line only');
    const sg = btnIn(g, 'Google', /^Set up Google$/); if (sg) g.click(sg); await until(() => g.qa('#viewStock .setup li').length > 0, 5000, 'the set-up steps').catch(() => {});
    ok(g.qa('#viewStock .setup li').length === 4 && /Found 4 of 4 products/.test(g.text(g.q('#viewStock .setup'))) && lineOf(g, 'Google') === 'Google: switched off', 'the set-up panel lists the steps, and Google is now just switched off');
    g.close();

    // a fake problem: Google keeps showing Kesari out of stock for over 30 minutes while the admin says in stock
    await dev({ stuck: { google: { 'atta-kesari': 'out of stock' } } });
    await api('/admin/api/channels/mode', { channel: 'google', mode: 'all' });
    await dev({ minutesLater: 31 });
    await api('/admin/api/channels/check', {});   // read back: what took the push now matches; Kesari still does not
    const p = await openAdmin('owner', { width: 375 });
    await until(() => p.qa('#needs .need').some((c) => /does not match the admin/.test(p.text(c))), 5000, 'the Needs card').catch(() => {});
    const need = p.qa('#needs .need').find((c) => /does not match the admin/.test(p.text(c)));
    ok(!!need && /Google does not match the admin: tap to see/.test(p.text(need)) && need.classList.contains('hot') && !p.qa('#needs .need').some((c) => /Meta does not match/.test(p.text(c))), 'a problem on Google makes a red Needs card: ' + (need ? p.text(need) : p.qa('#needs .need').map((c) => p.text(c)).join(' | ')));
    if (need) { p.click(need); await until(() => lines(p).length === 2, 4000, 'the Stock screen').catch(() => {}); }
    const red = row(p, 'Google') && row(p, 'Google').querySelector('.chantx');
    ok(!p.q('#viewStock').hidden && /^Google: Atta Kesari shows out of stock; the admin says in stock$/.test(lineOf(p, 'Google')) && !!red && red.classList.contains('bad'), 'tapping it opens Stock, where the Google line is red: ' + lineOf(p, 'Google'));
    ok(p.errors.length === 0, 'no page errors with a channel problem (' + p.errors.join(' | ').slice(0, 200) + ')');
    p.close();

    // a key not on Render: the line says so, and there is nothing to press
    await dev({ reset: true }); await dev({ noKey: ['meta'] });
    const k = await openAdmin('owner', { width: 375 });
    k.click(k.byText('#tabs .tab', /^Stock$/)); await until(() => lines(k).length === 2, 4000, 'the lines').catch(() => {});
    ok(lines(k).join(' | ') === 'Meta sync off: token not set | Google: switched off' && row(k, 'Meta') && row(k, 'Meta').querySelectorAll('button').length === 0, 'no Meta token: "Meta sync off: token not set", with no buttons (' + lines(k).join(' | ') + ')');
    k.close();

    // a malformed saved row: the bad entry is dropped, so both lines still show (T-a)
    await dev({ reset: true }); await dev({ broken: true });
    const mb = await openAdmin('owner', { width: 375 });
    mb.click(mb.byText('#tabs .tab', /^Stock$/)); await until(() => lines(mb).length === 2, 4000, 'the lines').catch(() => {});
    ok(lines(mb).join(' | ') === 'Meta: switched off | Google: switched off' && mb.errors.length === 0, 'a malformed saved row still shows both lines (' + lines(mb).join(' | ') + ')');
    mb.close();

    // the channel status cannot be read at all: the Stock screen still shows the stock
    await dev({ reset: true }); await dev({ statusFails: true });
    const b = await openAdmin('owner', { width: 375 });
    b.click(b.byText('#tabs .tab', /^Stock$/)); await until(() => b.qa('#viewStock .line').length >= 4, 4000, 'the stock list').catch(() => {});
    ok(b.qa('#viewStock .line').length >= 4 && b.qa('#viewStock .chan').length === 0 && /Could not read Meta and Google/.test(b.text(b.q('#viewStock'))) && b.errors.length === 0, 'when Meta and Google cannot be read, the Stock screen still lists the stock and says so');
    b.close();
    await dev({ reset: true });
  });

  // Meta and Google: what the owner is told when a try fails, a set-up that misses a product, the switched-off copy, and other days
  list.push(async () => {
    const dev = async (b) => (await fetch(BASE + '/dev/channels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json().catch(() => ({}));
    await dev({ reset: true });
    const o = await openAdmin('owner', { width: 375 });
    const token = o.win.localStorage.getItem('mngAdminToken');
    const api = async (p, body) => (await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined })).json().catch(() => ({}));
    const lines = (w) => w.qa('#viewStock .chan .chantx').map((e) => w.text(e));
    const row = (w, L) => w.qa('#viewStock .chan').find((r) => new RegExp('^' + L + '\\b').test(w.text(r.querySelector('.chantx'))));
    const btnIn = (w, L, re) => { const r = row(w, L); return r ? Array.from(r.querySelectorAll('button')).find((b) => re.test(w.text(b))) : null; };
    const lineOf = (w, L) => { const r = row(w, L); return r ? w.text(r.querySelector('.chantx')) : ''; };
    const subOf = (w, L) => { const r = row(w, L); const m = r && r.querySelector('.muted'); return m ? w.text(m) : ''; };
    const toastOf = (w) => w.text(w.q('#toast'));
    const toStock = async (w) => { w.click(w.byText('#tabs .tab', /^Stock$/)); await until(() => lines(w).length === 2, 4000, 'the lines').catch(() => {}); };
    const press = (w, L, re) => { const b = btnIn(w, L, re); if (b) w.click(b); return !!b; };

    // switched off before anything was sent: Google shows the sheet (I7)
    await toStock(o);
    ok(subOf(o, 'Google') === 'Nothing is sent. Google shows the Google sheet.', 'Google switched off, nothing sent yet: it shows the Google sheet (' + subOf(o, 'Google') + ')');
    // a refused test push: the line and the toast say so at once, and Switch on all four waits (I1, I2)
    await dev({ failPush: { meta: 'Invalid OAuth access token' } });
    press(o, 'Meta', /^Test with Original$/);
    await until(() => /did not accept/.test(lineOf(o, 'Meta')), 5000, 'the refusal').catch(() => {});
    const refused = row(o, 'Meta') && row(o, 'Meta').querySelector('.chantx');
    ok(lineOf(o, 'Meta') === 'Meta did not accept the change: Invalid OAuth access token' && !!refused && refused.classList.contains('bad'), 'a refused test push shows at once, in red: ' + lineOf(o, 'Meta'));
    ok(toastOf(o) === 'Testing with Original. Meta did not accept the change: Invalid OAuth access token', 'the toast says what failed: ' + toastOf(o));
    ok(!btnIn(o, 'Meta', /^Switch on all four$/) && !!btnIn(o, 'Meta', /^Test with Original$/), 'no Switch on all four; Test with Original can be tried again');
    await dev({ failPush: { meta: null } });
    press(o, 'Meta', /^Test with Original$/);
    await until(() => /^Meta: matches/.test(lineOf(o, 'Meta')), 5000, 'the retry').catch(() => {});
    ok(/^Meta: matches, checked \d\d:\d\d$/.test(lineOf(o, 'Meta')) && !!btnIn(o, 'Meta', /^Switch on all four$/), 'tried again once Meta takes it: matches, and Switch on all four is offered (' + lineOf(o, 'Meta') + ')');
    // switched off after a push: honest about what Google keeps (I7)
    press(o, 'Google', /^Test with Original$/);
    await until(() => /^Google: (matches|waiting)/.test(lineOf(o, 'Google')), 5000, 'the Google test').catch(() => {});
    press(o, 'Google', /^Switch off$/);
    await until(() => lineOf(o, 'Google') === 'Google: switched off', 5000, 'Google off').catch(() => {});
    ok(subOf(o, 'Google') === 'Nothing is sent. Google keeps the last stock and prices sent from here, ahead of the Google sheet.', 'Google switched off after a push says what Google keeps (' + subOf(o, 'Google') + ')');
    press(o, 'Meta', /^Switch off$/);
    await until(() => lineOf(o, 'Meta') === 'Meta: switched off', 5000, 'Meta off').catch(() => {});
    ok(/^Nothing is sent\. Meta keeps the last stock and prices sent from here/.test(subOf(o, 'Meta')), 'Meta switched off after a push says the same (' + subOf(o, 'Meta') + ')');
    ok(o.errors.length === 0, 'no page errors (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();

    // refused three times: the problem line keeps the message whole, even a first word with a colon (M3)
    await dev({ reset: true }); await dev({ failPush: { meta: 'invalid: price field' } });
    await api('/admin/api/channels/mode', { channel: 'meta', mode: 'all' });
    await api('/admin/api/inventory/pause', { slug: 'atta-kesari', paused: true });
    for (let i = 0; i < 3; i++) await api('/admin/api/channels/check', {});
    const m = await openAdmin('owner', { width: 375 }); await toStock(m);
    const reds = row(m, 'Meta') ? Array.from(row(m, 'Meta').querySelectorAll('.bad')).map((e) => m.text(e)) : [];
    ok(reds.includes('Meta: did not accept the change to Atta Kesari: invalid: price field'), 'a refused change keeps the whole message: ' + JSON.stringify(reds));
    m.close();
    await api('/admin/api/inventory/pause', { slug: 'atta-kesari', paused: false });

    // a set-up that misses an offer id says so, and offers Set up Google again until it is fixed (I3, M4)
    await dev({ reset: true }); await dev({ notSetUp: true }); await dev({ setupMissing: ['MNG-LITE-250'] });
    const g = await openAdmin('owner', { width: 375 }); await toStock(g);
    press(g, 'Google', /^Set up Google$/);
    await until(() => g.qa('#viewStock .setup li').length > 0, 5000, 'the set-up steps').catch(() => {});
    ok(toastOf(g) === 'Google is set up, but 1 product was not found; see below.', 'the set-up toast says a product was not found: ' + toastOf(g));
    ok(/Not found in Merchant Center: MNG-LITE-250/.test(g.q('#viewStock .setup') ? g.text(g.q('#viewStock .setup')) : ''), 'and the set-up panel names it');
    ok(!!btnIn(g, 'Google', /^Set up Google again$/), 'the Google line offers Set up Google again while an offer id is missing');
    ok(/^Not found in Merchant Center: MNG-LITE-250\. Fix the offer ID in the Google sheet, then tap Set up Google again\./.test(subOf(g, 'Google')), 'and says which one, and what to do (' + subOf(g, 'Google') + ')');
    await dev({ setupMissing: [] });
    press(g, 'Google', /^Set up Google again$/);
    await until(() => /Found 4 of 4 products/.test(g.q('#viewStock .setup') ? g.text(g.q('#viewStock .setup')) : ''), 5000, 'the second set-up').catch(() => {});
    ok(toastOf(g) === 'Google is set up. Now tap Test with Original.' && !btnIn(g, 'Google', /^Set up Google again$/), 'set up again once fixed: the usual toast, and no Set up Google again (' + toastOf(g) + ')');
    ok(g.errors.length === 0, 'no page errors in set-up (' + g.errors.join(' | ').slice(0, 200) + ')');
    g.close();

    // a check from another day carries the day: "yesterday 10:42", then "1 Nov 10:42" (M1, Indian time)
    const IST = 5.5 * 3600000, MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const ist = (iso) => new Date(Date.parse(iso) + IST).toISOString();
    await dev({ reset: true }); await dev({ minutesLater: -1440 });
    await api('/admin/api/channels/mode', { channel: 'meta', mode: 'test' });
    await dev({ minutesLater: 0 });
    const y = await openAdmin('owner', { width: 375 }); await toStock(y);
    const yAt = (await api('/admin/api/channels')).channels?.meta?.checkedAt;
    ok(!!yAt && lineOf(y, 'Meta') === 'Meta: matches, checked yesterday ' + ist(yAt).slice(11, 16), 'a check made yesterday reads "checked yesterday HH:MM": ' + lineOf(y, 'Meta'));
    y.close();
    await dev({ minutesLater: -2880 }); await api('/admin/api/channels/check', {}); await dev({ minutesLater: 0 });
    const d2 = await openAdmin('owner', { width: 375 }); await toStock(d2);
    const dAt = (await api('/admin/api/channels')).channels?.meta?.checkedAt;
    const dl = dAt ? Number(ist(dAt).slice(8, 10)) + ' ' + MON[Number(ist(dAt).slice(5, 7)) - 1] + ' ' + ist(dAt).slice(11, 16) : 'no time';
    ok(lineOf(d2, 'Meta') === 'Meta: matches, checked ' + dl, 'an older check gives the date (' + dl + '): ' + lineOf(d2, 'Meta'));
    d2.close();
    await dev({ reset: true });
  });


  // Task 6b: packaging is a hand-kept list (8 Nov 2026)
  list.push(async () => {
    const IST = 5.5 * 3600000, MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const todayWords = () => { const d = new Date(Date.now() + IST); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; };
    const o = await openAdmin('owner', { width: 375 }); const { q, qa, text, click } = o;
    click(o.byText('#tabs .tab', /^Stock$/)); await until(() => qa('#viewStock .line').length >= 4, 4000, 'the stock page');
    const view = () => text(q('#viewStock'));
    const rowOf = (re) => qa('#viewStock .line').find((l) => re.test(text(l)));
    const btnsOf = (re) => Array.from((rowOf(re) || o.doc.createElement('i')).querySelectorAll('button')).map((b) => text(b));
    ok(!!o.byText('#viewStock h3', /^Packaging \(counted by hand\)$/), 'Stock has a section "Packaging (counted by hand)"');
    ok(!o.byText('#viewStock h3', /Packaging and supplies/), 'the old "Packaging and supplies" section is gone');
    const sec = o.byText('#viewStock .sec', /^Packaging \(counted by hand\)/);
    const packRows = sec ? Array.from(sec.querySelectorAll('.line')) : [];
    ok(packRows.length >= 3 && packRows.every((l) => /no count/.test(text(l))), 'every packaging row says "no count" at the start (' + packRows.map((l) => text(l).slice(0, 40)).join(' | ') + ')');
    ok(packRows.every((l) => !/Not counted yet|OK|LOW|OUT/.test(Array.from(l.querySelectorAll('.badge')).map((b) => text(b)).join('|'))), 'no alert badge on a packaging row with no count');
    const tape = btnsOf(/Mono carton: Kesari/);
    ok(tape.includes('Set count') && tape.includes('Remove') && tape.some((b) => /^Low level/.test(b)) && !tape.includes('Receive') && !tape.includes('Take out'), 'the owner sees Set count, Low level and Remove on a packaging row (' + tape.join(',') + ')');
    ok(!!o.byText('#viewStock button', /^Add packaging item$/) && !o.byText('#viewStock button', /^Add item$/), 'the owner has Add packaging item');
    const prods = btnsOf(/Atta Kesari/);
    ok(prods.includes('Receive') && prods.includes('Count'), 'a biscuit row is unchanged (' + prods.join(',') + ')');
    // biscuits only arrive through New delivery, and it lists the four biscuits only (Task 11 changed this check: it was the Receive stock picker)
    click(o.byText('#viewStock button', /^New delivery$/)); await until(() => qa('#viewStock .dlrow').length === 4, 4000, 'New delivery');
    const picks = qa('#viewStock .dlrow h3').map((b) => text(b));
    ok(picks.length === 4 && picks.every((t) => /^Atta /.test(t)) && !/Mono carton: Kesari|Mono carton|Stamp/.test(picks.join('|')), 'New delivery lists the four biscuits only (' + picks.join(' | ') + ')');
    click(o.byText('#viewStock button', /^Back to Stock$/)); await until(() => qa('#viewStock .line').length >= 4, 3000, 'back');
    // Set count
    click(Array.from(rowOf(/Mono carton: Kesari/).querySelectorAll('button')).find((b) => /^Set count$/.test(text(b))));
    await until(() => /Count: Mono carton: Kesari/.test(view()), 3000, 'the count form');
    ok(/No count yet/.test(view()), 'the count form says there is no count yet');
    const inp = qa('#viewStock input')[0]; o.set(inp, '40');
    click(o.byText('#viewStock button', /^Save count$/));
    await until(() => /40/.test(text(rowOf(/Mono carton: Kesari/) || o.doc.createElement('i'))) && /counted/.test(text(rowOf(/Mono carton: Kesari/) || o.doc.createElement('i'))), 4000, 'the new count on the row');
    ok(new RegExp('40.*counted ' + todayWords()).test(text(rowOf(/Mono carton: Kesari/))), 'the row shows the count and the IST day it was counted: ' + text(rowOf(/Mono carton: Kesari/)).slice(0, 80));
    ok(!/no count/.test(text(rowOf(/Mono carton: Kesari/))) && /no count/.test(text(rowOf(/Mono carton: Original/))), 'only the counted row lost "no count"');
    // Remove (confirm first)
    let asked = ''; o.win.confirm = (m) => { asked = m; return true; };
    click(Array.from(rowOf(/Mono carton: Kesari/).querySelectorAll('button')).find((b) => /^Remove$/.test(text(b))));
    await until(() => !rowOf(/Mono carton: Kesari/), 4000, 'the removed row to go');
    ok(asked === 'Remove Mono carton: Kesari from the list? Its history is kept.', 'Remove asks first, in plain words (' + asked + ')');
    ok(!/Mono carton: Kesari/.test(view()), 'the removed item is off the screen');
    // add it back
    const answers = ['mono carton: kesari', 'cartons']; o.win.prompt = () => answers.shift();
    click(o.byText('#viewStock button', /^Add packaging item$/));
    await until(() => !!rowOf(/Mono carton: Kesari/), 4000, 'the item to come back');
    ok(/40/.test(text(rowOf(/Mono carton: Kesari/))) && /counted/.test(text(rowOf(/Mono carton: Kesari/))), 'adding the same name brings the item back with its count (' + text(rowOf(/Mono carton: Kesari/)).slice(0, 80) + ')');
    ok(qa('#viewStock .line').filter((l) => /Mono carton: Kesari/i.test(text(l))).length === 1 && !/Mono carton Kesari/.test(view()), 'it came back as the same row, not a second one');
    // a count of 0 is recorded too
    click(Array.from(rowOf(/Stamp \/ batch labels/).querySelectorAll('button')).find((b) => /^Set count$/.test(text(b))));
    await until(() => /Count: Stamp/.test(view()), 3000, 'the count form for labels');
    o.set(qa('#viewStock input')[0], '0'); click(o.byText('#viewStock button', /^Save count$/));
    await until(() => /counted/.test(text(rowOf(/Stamp \/ batch labels/) || o.doc.createElement('i'))), 4000, 'the 0 count on the row');
    ok(new RegExp('0 labels, counted ' + todayWords()).test(text(rowOf(/Stamp \/ batch labels/))) && !/no count/.test(text(rowOf(/Stamp \/ batch labels/))), 'a first count of 0 shows "0 labels, counted today": ' + text(rowOf(/Stamp \/ batch labels/)).slice(0, 80));
    ok(/^Count saved: 0 labels/.test(text(q('#toast'))), 'the toast gives the saved result (' + text(q('#toast')) + ')');
    ok(o.errors.length === 0, 'no page errors (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
    // staff: Set count yes, owner-only controls no
    const s = await openAdmin('staff', { width: 375 });
    click(s.byText('#tabs .tab', /^Stock$/)); await until(() => s.qa('#viewStock .line').length >= 4, 4000, 'the stock page for staff');
    const sb = Array.from((s.qa('#viewStock .line').find((l) => /Mono carton: Kesari/.test(s.text(l))) || s.doc.createElement('i')).querySelectorAll('button')).map((b) => s.text(b));
    ok(sb.includes('Set count') && !sb.includes('Remove') && !sb.some((b) => /Low level/.test(b)), 'staff see Set count only (' + sb.join(',') + ')');
    ok(!s.byText('#viewStock button', /^Add packaging item$/), 'staff have no Add packaging item');
    ok(s.errors.length === 0, 'no page errors for staff (' + s.errors.join(' | ').slice(0, 200) + ')');
    s.close();
  });

  // Task 11: New delivery on the phone (375 px): one screen, a review with every warning ticked, one Save, and the form kept on the
  // phone when the signal drops (receipt id: a resend never saves twice).
  list.push(async () => {
    const IST = 330 * 60000, MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const istDay = (n) => new Date(Date.now() + IST - n * 86400000).toISOString().slice(0, 10);
    const words = (iso) => Number(iso.slice(8, 10)) + ' ' + MON[Number(iso.slice(5, 7)) - 1] + ' ' + iso.slice(0, 4);
    const yymmdd = (iso) => iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);
    const BAKE1 = istDay(10), BAKE2 = istDay(1);
    const BILL = 'T11-' + String(Date.now()).slice(-7);
    const NOSIG = 'Not sent. Saved on this phone. Tap Send when you have signal.';
    const KEY = 'mngDeliveryDraft';
    const SLUGS = ['atta-original', 'atta-kesari', 'atta-ajwain', 'atta-lite-sugar'];
    const JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64');
    // jsdom draws nothing, so "no horizontal scroll" is checked by what could cause it: no fixed width or grid track wider than the
    // 343 px between the 16 px gutters, and no long text that may not wrap. The real 375 px page is measured in the browser (task report).
    const tooWide = (w) => {
      const bad = [];
      w.qa('#viewStock *').forEach((el) => {
        const cs = w.win.getComputedStyle(el), name = el.id || el.className || el.tagName;
        for (const p of ['width', 'minWidth']) { const m = /^([\d.]+)px$/.exec(cs[p] || ''); if (m && Number(m[1]) > 343) bad.push(name + ' ' + p + ' ' + cs[p]); }
        if (/grid/.test(cs.display) && !/minmax\(0/.test(cs.gridTemplateColumns || '')) bad.push(name + ' grid ' + cs.gridTemplateColumns);
        if (cs.whiteSpace === 'nowrap' && w.text(el).length > 24) bad.push(name + ' nowrap ' + w.text(el).slice(0, 30));
      });
      return bad;
    };
    const rowOf = (w, slug, i) => w.qa('#viewStock .dlrow[data-slug="' + slug + '"]')[i || 0];
    const fieldOf = (w, slug, f, i) => (rowOf(w, slug, i) || w.doc.createElement('i')).querySelector('[data-f="' + f + '"]');
    const review = (w) => w.text(w.q('#dlReview'));
    const addPhoto = (w, input) => {
      w.win.__shrinkPhoto = () => Promise.resolve(JPEG);   // jsdom has no canvas; the server still checks the photo
      Object.defineProperty(input, 'files', { value: [new w.win.File(['x'], 'broken.jpg', { type: 'image/jpeg' })], configurable: true });
      input.dispatchEvent(new w.win.Event('change', { bubbles: true }));
    };
    const toNew = async (w) => {
      w.click(w.byText('#tabs .tab', /^Stock$/)); await until(() => w.qa('#viewStock .line').length >= 4, 4000, 'the stock page');
      w.click(w.byText('#viewStock button', /^New delivery$/));
    };

    const s = await openAdmin('staff', { width: 375 }); const { q, qa, text, click, byText, set } = s;
    const token = s.win.localStorage.getItem('mngAdminToken');
    const apiGet = async (p) => (await (await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + token } })).json());
    click(byText('#tabs .tab', /^Stock$/)); await until(() => qa('#viewStock .line').length >= 4, 4000, 'the stock page');
    ok(!!byText('#viewStock button', /^New delivery$/), 'staff have a New delivery button at the top of Stock');
    const kes = qa('#viewStock .line').find((l) => /Atta Kesari/.test(text(l)));
    click(Array.from(kes.querySelectorAll('button')).find((b) => /^Receive$/.test(text(b))));
    await until(() => qa('#viewStock .dlrow').length === 4, 4000, 'New delivery from a biscuit\'s Receive');
    ok(/^New delivery/.test(text(q('#viewStock .pagehead'))), 'a biscuit\'s Receive opens New delivery');
    await until(() => fieldOf(s, 'atta-original', 'rateRupees').value !== '', 4000, 'the prefilled rates').catch(() => {});
    ok(SLUGS.map((x) => fieldOf(s, x, 'rateRupees').value).join('/') === '85/100/85/125', 'rates are prefilled 85/100/85/125 (' + SLUGS.map((x) => fieldOf(s, x, 'rateRupees').value).join('/') + ')');
    ok([q('#dl-busPerCarton').value, q('#dl-delhiPerCarton').value, q('#dl-porter').value, q('#dl-other').value].join('/') === '0/20/2000/0', 'freight is prefilled: bus 0, Delhi Rs 20 a carton, porter Rs 2,000, other 0 (' + [q('#dl-busPerCarton').value, q('#dl-delhiPerCarton').value, q('#dl-porter').value, q('#dl-other').value].join('/') + ')');
    ok(q('#dl-supplier').value === 'Krazy Bakers' && q('#dl-arrivedOn').value === istDay(0) && q('#dl-bakeDate').value === '', 'Krazy Bakers, arrived today, bake date empty');
    ok(!!q('#dl-gstRupees') && /GST on the bill \(Rs, 0 if none\)/.test(text(q('#viewStock'))), 'the top block has "GST on the bill (Rs, 0 if none)"');
    ok(['invoiceBoxes', 'counted', 'broken'].every((f) => qa('#viewStock .dlrow [data-f="' + f + '"]').every((i) => i.getAttribute('inputmode') === 'numeric'))
      && qa('#viewStock .dlrow [data-f="rateRupees"]').every((i) => i.getAttribute('inputmode') === 'decimal') && ['invoiceRupees', 'gstRupees', 'porter'].every((k) => q('#dl-' + k).getAttribute('inputmode') === 'decimal') && q('#dl-cartons').getAttribute('inputmode') === 'numeric', 'number fields open the number keypad');
    ok(qa('#viewStock .dlrow h3').map((h) => text(h)).join('|') === 'Atta Original|Atta Kesari|Atta Ajwain|Atta Sugar-Lite', 'four flavour rows');
    let bad = tooWide(s); ok(bad.length === 0, 'the form has nothing wider than the phone (' + bad.slice(0, 4).join(' | ') + ')');
    // the Review button names the first thing missing
    set(q('#dl-billNo'), BILL);
    ok(review(s) === 'Enter the bake date' && q('#dlReview').disabled, 'bake date empty: the Review button says "Enter the bake date" (' + review(s) + ')');
    set(q('#dl-bakeDate'), BAKE1); set(q('#dl-cartons'), '4'); set(q('#dl-invoiceRupees'), '7800');   // the rates make 7,900: Rs 100 off
    for (const x of SLUGS) { set(fieldOf(s, x, 'invoiceBoxes'), '20'); set(fieldOf(s, x, 'counted'), '20'); }
    ok(review(s) === 'Review' && !q('#dlReview').disabled, 'with everything entered the button says Review (' + review(s) + ')');
    const bk = rowOf(s, 'atta-original').querySelector('.dlbroken');
    ok(!!bk && bk.hidden, 'no broken boxes: the broken-box questions are hidden');
    set(fieldOf(s, 'atta-original', 'broken'), '2');
    ok(!bk.hidden && /Why did they break\?/.test(text(bk)) && /On the bus/.test(text(bk)) && /At the bakery/.test(text(bk)) && /Photo of the broken boxes/.test(text(bk)), 'broken 2: why did they break (on the bus / at the bakery) and the photo appear');
    click(Array.from(bk.querySelectorAll('button')).find((b) => /^On the bus$/.test(text(b))));
    ok(review(s) === 'Atta Original: add a photo of the broken boxes' && q('#dlReview').disabled, 'broken 2 with no photo: the photo is required (' + review(s) + ')');
    addPhoto(s, fieldOf(s, 'atta-original', 'brokenPhoto'));
    await until(() => /Photo added/.test(text(bk)), 4000, 'the photo to upload').catch(() => {});
    ok(/Photo added/.test(text(bk)) && review(s) === 'Review', 'the photo is shrunk, sent and noted (' + text(bk).slice(-40) + ' / ' + review(s) + ')');
    const df = rowOf(s, 'atta-kesari').querySelector('.dldiff');
    ok(!!df && df.hidden, 'counted = bill: no reason asked');
    set(fieldOf(s, 'atta-kesari', 'counted'), '19');
    ok(!df.hidden && /Why is the count different from the bill\?/.test(text(df)) && review(s) === 'Atta Kesari: say why the count is different from the bill', 'counted 19 against 20: the reason is asked (' + review(s) + ')');
    set(fieldOf(s, 'atta-kesari', 'diffReason'), 'one box short');
    const d0 = JSON.parse(s.win.localStorage.getItem(KEY) || '{}');
    ok(/^d-[0-9a-z]+-[0-9a-z]{6}$/.test(d0.id || '') && d0.form && d0.form.billNo === BILL && d0.form.rows.find((r) => r.slug === 'atta-kesari').diffReason === 'one box short' && /^\d{4}\/\d{2}\/[0-9a-f]{16}\.jpg$/.test(d0.form.rows[0].brokenPhoto || ''), 'every entry is kept on the phone with one receipt id (' + (d0.id || 'none') + ')');
    ok(!!d0.author && d0.author.email === 'staff@example.com' && d0.author.name === 'Staff', 'the draft records who started it (' + JSON.stringify(d0.author) + ')');
    // review
    click(q('#dlReview'));
    await until(() => qa('#viewStock .dllot').length === 4, 5000, 'the review screen').catch(() => {});
    ok(/^Check and save/.test(text(q('#viewStock .pagehead'))) && qa('#viewStock .dllot').length === 4, 'Review lists four lots');
    const codes = qa('#viewStock .dllot .dlcode').map((c) => text(c));
    ok(codes.length === 4 && codes.every((c, i) => c === 'MNG' + 'OKAL'[i] + '-' + yymmdd(BAKE1) + '-01'), 'each lot shows its code (' + codes.join(', ') + ')');
    const lot0 = text(qa('#viewStock .dllot')[0]);
    ok(/Atta Original/.test(lot0) && /18 good boxes/.test(lot0), 'Original: 18 good boxes (20 counted, 2 broken)');
    ok(/Baked/.test(lot0) && lot0.includes(words(BAKE1)) && /Website stops/.test(lot0) && /Last ship/.test(lot0) && /Best before/.test(lot0) && /\d+ [A-Z][a-z]{2} 20\d\d/.test(lot0), 'the four dates, in words (' + lot0.slice(0, 160) + ')');
    ok(/Cost per good box Rs \d+\.\d\d/.test(lot0), 'cost per good box in rupees with paise (' + (lot0.match(/Cost per good box[^·]*/) || [''])[0] + ')');
    const ticks = qa('#viewStock .dlwarn input[type=checkbox]');
    const keys = ticks.map((t) => t.getAttribute('data-key')).sort().join(',');
    ok(keys === 'invoice_mismatch,old_bake', 'two warnings to tick: the old bake and the bill total (' + keys + ')');
    ok(q('#dlSave') && q('#dlSave').disabled, 'Save is disabled until every warning is ticked');
    click(ticks.find((t) => t.getAttribute('data-key') === 'invoice_mismatch'));
    ok(q('#dlSave').disabled, 'one of two ticked: Save still disabled');
    click(ticks.find((t) => t.getAttribute('data-key') === 'old_bake'));
    ok(!!q('#dlOldReason') && !q('#dlOldReason').closest('[hidden]') && q('#dlSave').disabled, 'ticking the old bake asks for a reason, and Save waits for it');
    set(q('#dlOldReason'), 'Bus strike in Bikaner');
    ok(!q('#dlSave').disabled, 'every warning ticked and the reason given: Save is enabled');
    bad = tooWide(s); ok(bad.length === 0, 'the review screen has nothing wider than the phone (' + bad.slice(0, 4).join(' | ') + ')');
    // no signal: the save never reaches the server
    const real = s.win.fetch; let dropped = 0;
    s.win.fetch = (u, o) => { if (!dropped && /\/admin\/api\/stock\/deliveries$/.test(String(u)) && o && o.method === 'POST') { dropped++; return Promise.reject(new TypeError('Failed to fetch')); } return real(u, o); };
    click(q('#dlSave'));
    await until(() => !!q('#dlNosig'), 4000, 'the no-signal line').catch(() => {});
    ok(dropped === 1 && text(q('#dlNosig')) === NOSIG && !!byText('#viewStock button', /^Send$/), 'no signal: "' + NOSIG + '" and a Send button (' + text(q('#dlNosig')) + ')');
    const kept = s.win.localStorage.getItem(KEY);
    ok(!!kept && JSON.parse(kept).id === d0.id && JSON.parse(kept).pending && JSON.parse(kept).pending.id === d0.id, 'the delivery stays on the phone with the same receipt id');
    ok(s.errors.length === 0, 'no page errors on the form and review (' + s.errors.join(' | ').slice(0, 200) + ')');
    s.close();
    // the owner signs in on the same phone: the staff member's delivery is not restored silently
    const ow = await openAdmin('owner', { width: 375 });
    ow.win.localStorage.setItem(KEY, kept);
    await toNew(ow);
    await until(() => !!ow.q('#dlOthers'), 4000, 'the started-by notice').catch(() => {});
    const carry = ow.byText('#viewStock button', /^Carry on \(it will be saved under your name\)$/), fresh = ow.byText('#viewStock button', /^Start a new one$/);
    ok(/^Started by Staff on this phone\./.test(ow.text(ow.q('#dlOthers'))) && !!carry && !!fresh, 'a draft started by staff, opened by the owner: "Started by Staff on this phone." with Carry on and Start a new one (' + ow.text(ow.q('#dlOthers')) + ')');
    ok(!ow.q('#viewStock .dlrow') && !ow.q('#viewStock .dllot') && !ow.q('#dlNosig') && !ow.q('#dlSend'), 'nothing of it is restored until the owner chooses');
    let askedO = ''; ow.win.confirm = (m) => { askedO = m; return false; };
    if (fresh) ow.click(fresh);
    ok(/Throw away/.test(askedO) && !!ow.q('#dlOthers') && ow.win.localStorage.getItem(KEY) === kept, 'Start a new one asks first; No keeps the delivery and the notice');
    ow.win.confirm = () => true;
    if (carry) ow.click(carry);
    await until(() => !!ow.q('#dlNosig'), 4000, 'the restored delivery').catch(() => {});
    const owDraft = JSON.parse(ow.win.localStorage.getItem(KEY) || '{}');
    ok(!!ow.q('#dlNosig') && !ow.q('#dlOthers') && owDraft.id === d0.id && owDraft.author && owDraft.author.email === 'owner@example.com', 'Carry on restores it (same receipt id) and it is now the owner\'s (' + JSON.stringify(owDraft.author) + ')');
    ok(ow.errors.length === 0, 'no page errors on the started-by notice (' + ow.errors.join(' | ').slice(0, 200) + ')');
    ow.close();
    // the phone reloads the page: the same delivery, Send saves it once
    const r = await openAdmin('staff', { width: 375 });
    r.win.localStorage.setItem(KEY, kept);
    await toNew(r);
    await until(() => !!r.q('#dlNosig'), 4000, 'the restored delivery').catch(() => {});
    ok(r.text(r.q('#dlNosig')) === NOSIG && !!r.byText('#viewStock button', /^Send$/), 'after a reload the page still says not sent and offers Send');
    r.click(r.byText('#viewStock button', /^Edit$/)); await until(() => r.qa('#viewStock .dlrow').length === 4, 3000, 'the form').catch(() => {});
    ok(r.q('#dl-billNo').value === BILL && r.q('#dl-bakeDate').value === BAKE1 && r.q('#dl-cartons').value === '4' && r.q('#dl-invoiceRupees').value === '7800'
      && fieldOf(r, 'atta-kesari', 'counted').value === '19' && fieldOf(r, 'atta-original', 'broken').value === '2' && fieldOf(r, 'atta-kesari', 'diffReason').value === 'one box short' && /Photo added/.test(r.text(rowOf(r, 'atta-original'))), 'the reload restores every typed value from the phone');
    let asked = ''; r.win.confirm = (m) => { asked = m; return false; };
    r.click(r.byText('#viewStock button', /^Start a new one$/));
    ok(/Throw away/.test(asked) && r.q('#dl-billNo').value === BILL, 'Start a new one asks first, and No keeps the delivery (' + asked + ')');
    r.win.confirm = () => true;
    ok(r.text(r.q('#dlNosig')) === NOSIG, 'the form says it is not sent yet');
    r.click(r.byText('#viewStock button', /^Send$/));
    await until(() => /^Delivery /.test(r.text(r.q('#viewStock .pagehead'))) && r.qa('#viewStock .dlotline').length === 4, 5000, 'the delivery page').catch(() => {});
    const lotLines = r.qa('#viewStock .dlotline');
    ok(new RegExp('^Delivery ' + BILL).test(r.text(r.q('#viewStock .pagehead'))) && lotLines.length === 4 && lotLines.every((l) => /On hold/.test(r.text(l.querySelector('.badge')))), 'Send saves it and opens the delivery page with 4 lots On hold (' + lotLines.map((l) => r.text(l).slice(0, 50)).join(' | ') + ')');
    ok(/To raise with Krazy Bakers/.test(r.text(r.q('#viewStock'))) && /Atta Kesari: bill 20, counted 19/.test(r.text(r.q('#viewStock'))), 'the delivery page lists what to raise with Krazy Bakers');
    ok(/Send the bus company a written note of the breakage/.test(r.text(r.q('#viewStock'))), 'and the note for the bus company');
    ok(r.win.localStorage.getItem(KEY) === null, 'the saved delivery is cleared from the phone');
    const mine = ((await apiGet('/admin/api/stock/lots')).lots || []).filter((l) => (l.code || '').includes('-' + yymmdd(BAKE1) + '-'));
    ok(mine.length === 4 && mine.every((l) => l.status === 'hold'), 'exactly one delivery was saved: 4 lots, not 8 (' + mine.map((l) => l.code).join(',') + ')');
    r.click(r.byText('#viewStock button', /^Back to Stock$/)); await until(() => !!r.byText('#viewStock button', /^New delivery$/), 4000, 'back to Stock').catch(() => {});
    r.click(r.byText('#viewStock button', /^New delivery$/)); await until(() => r.qa('#viewStock .dlrow').length === 4, 4000, 'a fresh form').catch(() => {});
    ok(r.q('#dl-billNo').value === '' && !r.q('#dlNosig') && !r.byText('#viewStock button', /^Start a new one$/), 'after the save, the next New delivery on this phone starts empty');
    ok(r.errors.length === 0, 'no page errors after the reload (' + r.errors.join(' | ').slice(0, 200) + ')');
    r.close();

    // a second delivery: the server's refusal on the form, a warning that comes back at Save, a reply lost on the way back
    const t = await openAdmin('staff', { width: 375 });
    await toNew(t); await until(() => t.qa('#viewStock .dlrow').length === 4 && fieldOf(t, 'atta-original', 'rateRupees').value !== '', 4000, 'a fresh form');
    t.set(t.q('#dl-billNo'), BILL); t.set(t.q('#dl-bakeDate'), BAKE2); t.set(t.q('#dl-cartons'), '1'); t.set(t.q('#dl-invoiceRupees'), '100');
    t.set(fieldOf(t, 'atta-original', 'invoiceBoxes'), '1'); t.set(fieldOf(t, 'atta-original', 'counted'), '1'); t.set(fieldOf(t, 'atta-original', 'rateRupees'), '100');
    t.click(t.q('#dlReview'));
    await until(() => /already saved/.test(t.text(t.q('#dlErr'))), 4000, 'the refusal').catch(() => {});
    ok(new RegExp('^Bill ' + BILL + ' part 1 is already saved .*Tap "Add part 2" if this is the rest\\.$').test(t.text(t.q('#dlErr'))) && t.qa('#viewStock .dlrow').length === 4, 'a refusal from the server shows its message on the form (' + t.text(t.q('#dlErr')) + ')');
    t.click(t.q('#dl-addPart'));
    t.click(t.q('#dlReview'));
    await until(() => t.qa('#viewStock .dllot').length === 1, 4000, 'the review of part 2').catch(() => {});
    ok(t.qa('#viewStock .dllot').length === 1 && /part 2/.test(t.text(t.q('#viewStock'))), 'Add part 2 to an earlier bill: the review is for part 2');
    const tickAll = () => t.qa('#viewStock .dlwarn input[type=checkbox]').forEach((c) => { if (!c.checked) t.click(c); });
    tickAll();
    const realT = t.win.fetch; let step = 0, pageDropped = 0;
    t.win.fetch = async (u, o) => {
      if (!pageDropped && /\/admin\/api\/stock\/deliveries\/d-/.test(String(u)) && (!o || !o.method || o.method === 'GET')) { pageDropped++; throw new TypeError('Failed to fetch'); }   // the delivery page cannot load after the save
      if (/\/admin\/api\/stock\/deliveries$/.test(String(u)) && o && o.method === 'POST') {
        step++;
        if (step === 1) return new Response(JSON.stringify({ ok: false, error: 'Check these before saving', warnings: [{ key: 'large', text: 'Practice: a warning that appeared after the review.' }] }), { status: 409, headers: { 'Content-Type': 'application/json' } });
        if (step === 2) { await realT(u, o); throw new TypeError('Failed to fetch'); }   // it reached the server; the reply was lost
      }
      return realT(u, o);
    };
    t.click(t.q('#dlSave'));
    await until(() => /a warning that appeared after the review/.test(t.text(t.q('#viewStock'))), 4000, 'the warning from Save').catch(() => {});
    const late = t.qa('#viewStock .dlwarn input[type=checkbox]').find((c) => c.getAttribute('data-key') === 'large');
    ok(!!late && !late.checked && t.qa('#viewStock .dllot').length === 1 && t.q('#dlSave').disabled, 'a 409 at Save brings the review back with the new warning to tick, Save disabled');
    t.click(late); ok(!t.q('#dlSave').disabled, 'ticked: Save is enabled again');
    t.click(t.q('#dlSave'));
    await until(() => !!t.q('#dlNosig'), 4000, 'the lost reply').catch(() => {});
    ok(t.text(t.q('#dlNosig')) === NOSIG, 'a lost reply also says not sent');
    t.click(t.byText('#viewStock button', /^Send$/));
    // Send is answered with the first save, and then the delivery page itself cannot load (signal drops again)
    await until(() => /Open it again from Stock when you have signal\./.test(t.text(t.q('#dlSavedNote'))), 5000, 'the saved page').catch(() => {});
    ok(pageDropped === 1 && /^Saved$/.test(t.text(t.q('#viewStock .pagehead'))) && /part 2/.test(t.text(t.q('#viewStock'))) && t.qa('#viewStock .dlsavedline').length === 1 && /^MNGO-\d{6}-\d{2}/.test(t.text(t.q('#viewStock .dlsavedline'))), 'Send after a lost reply: the saved page comes from the save itself, with its lot (' + t.text(t.q('#viewStock')).slice(0, 160) + ')');
    ok(t.text(t.q('#dlSavedNote')) === 'Open it again from Stock when you have signal.', 'the delivery page could not load: the saved page stays and says so');
    ok(!t.byText('#viewStock button', /^(Edit|Send|Save delivery)$/) && !/Saving/.test(t.text(t.q('#viewStock'))), 'nothing of the review is left on screen');
    ok(t.win.localStorage.getItem(KEY) === null, 'and the delivery is cleared from the phone');
    ok(t.errors.length === 0, 'no page errors when the delivery page cannot load (' + t.errors.join(' | ').slice(0, 200) + ')');
    t.click(t.byText('#viewStock button', /^Back to Stock$/));
    await until(() => !!t.byText('#viewStock button', /^New delivery$/) && t.qa('#viewStock .line').length >= 4, 4000, 'back to Stock').catch(() => {});
    ok(!!t.byText('#viewStock button', /^New delivery$/), 'Back to Stock works from the saved page');
    const mine2 = ((await apiGet('/admin/api/stock/lots')).lots || []).filter((l) => (l.code || '').includes('-' + yymmdd(BAKE2) + '-'));
    ok(mine2.length === 1, 'the resend saved nothing twice: 1 lot, not 2 (' + mine2.map((l) => l.code).join(',') + ')');
    ok(t.errors.length === 0, 'no page errors on the second delivery (' + t.errors.join(' | ').slice(0, 200) + ')');
    t.close();
  });

  // Task 12: the delivery page (Release, photos, Correct), Lots and the lot page with its buttons, the Release and Fix lot forms, the
  // Packed refusal with the owner's Pack anyway, Assign lot, and the stock items in Needs attention. Phone width 375 px. Lots are made
  // the real way (deliveries saved by staff through the API); bake dates are counted back from today's IST date, never fixed.
  list.push(async () => {
    const IST = 330 * 60000;
    const istDay = (n) => new Date(Date.now() + IST - n * 86400000).toISOString().slice(0, 10);
    const yymmdd = (iso) => iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);
    const stamp = String(Date.now()).slice(-7);
    const JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64');
    // the same proxy for "no horizontal scroll" as the Task 11 check (jsdom draws nothing; the browser QA measures the real page)
    const tooWide = (w) => {
      const bad = [];
      w.qa('#viewStock *').forEach((el) => {
        const cs = w.win.getComputedStyle(el), name = el.id || el.className || el.tagName;
        for (const p of ['width', 'minWidth']) { const m = /^([\d.]+)px$/.exec(cs[p] || ''); if (m && Number(m[1]) > 343) bad.push(name + ' ' + p + ' ' + cs[p]); }
        if (/grid/.test(cs.display) && !/minmax\(0/.test(cs.gridTemplateColumns || '')) bad.push(name + ' grid ' + cs.gridTemplateColumns);
        if (cs.whiteSpace === 'nowrap' && w.text(el).length > 24) bad.push(name + ' nowrap ' + w.text(el).slice(0, 30));
      });
      return bad;
    };
    const o = await openAdmin('owner', { width: 375 }), s = await openAdmin('staff', { width: 375 });
    const tok = { o: o.win.localStorage.getItem('mngAdminToken'), s: s.win.localStorage.getItem('mngAdminToken') };
    const api = async (p, who, body) => { const r = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
    const CONFIRM = ['cost_jump', 'invoice_mismatch', 'stop_soon', 'no_freight', 'large'];
    let seq = 0;
    const deliver = async (rows, extra) => {
      const id = 'practice-t12-' + (++seq) + '-' + stamp, bill = 'T12-' + seq + '-' + stamp;
      const r = await api('/admin/api/stock/deliveries', 's', { id, billNo: bill, bakeDate: istDay(1), cartons: 1, invoiceRupees: 1, freight: { porter: 100 }, confirm: CONFIRM, rows, ...(extra || {}) });
      return { id, bill, r, code: (slug) => ((r.j.lots || []).find((l) => l.slug === slug) || {}).code };
    };
    const none = (w) => w.doc.createElement('i');
    const page = (w) => w.text(w.q('#viewStock .pagehead'));
    const btn = (w, re, root) => Array.from((root || w.q('#viewStock')).querySelectorAll('button')).find((b) => re.test(w.text(b)));
    const toStock = async (w) => { w.q('#viewStock').textContent = ''; w.click(w.byText('#tabs .tab', /^Stock$/)); await until(() => page(w) === 'Stock' && !!btn(w, /^Lots$/), 5000, 'the stock page'); };
    const toLots = async (w) => { await toStock(w); w.click(btn(w, /^Lots$/)); await until(() => page(w) === 'Lots' && w.qa('#viewStock .lotcard').length > 0, 5000, 'the Lots list'); };
    const openLotCard = async (w, code) => { await toLots(w); w.click(w.qa('#viewStock .lotcard').find((x) => x.getAttribute('data-code') === code)); await until(() => page(w) === code, 5000, 'the lot page of ' + code); };
    const rowText = (w, name) => { const l = w.qa('#viewStock .line').find((x) => w.text(x).indexOf(name) === 0); return l ? w.text(l) : ''; };
    const webOf = (w, name) => { const t = rowText(w, name), m = /Website: (\d+) can still be ordered/.exec(t); return m ? Number(m[1]) : /Website: sold out/.test(t) ? 0 : null; };
    const heldOf = (w, name) => { const m = /(\d+) box(?:es)? on hold/.exec(rowText(w, name)); return m ? Number(m[1]) : 0; };
    const num = (w, label) => { const d = w.qa('#viewStock .lotnums div').find((x) => w.text(x.querySelector('span')) === label); return d ? Number(w.text(d.querySelector('b'))) : null; };
    const cardOf = (w, id) => w.qa('#list .card').find((c) => w.text(c).includes(id));
    const devStock = (b) => fetch(BASE + '/dev/stock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    let v, bad;

    // ── Lots, search and the lot page of the old shared lot 15OCT26 (owner) ──
    await toLots(o);
    const kc = o.qa('#viewStock .lotcard').find((c) => c.getAttribute('data-code') === '15OCT26' && c.getAttribute('data-slug') === 'atta-kesari');
    ok(!!kc && /Atta Kesari/.test(o.text(kc)) && /Released/.test(o.text(kc)) && /\d+ on hand/.test(o.text(kc)) && /website stops in \d+ days/.test(o.text(kc)), 'a lot card shows the code, flavour, chip, boxes on hand and days to the website stop (' + (kc ? o.text(kc) : 'missing') + ')');
    ok(!!o.q('#lotQ') && !!btn(o, /^Find$/) && !!btn(o, /^Throw away expired$/), 'the Lots page has the search box, Find and (owner) Throw away expired');
    bad = tooWide(o); ok(bad.length === 0, 'the Lots list has nothing wider than the phone (' + bad.slice(0, 4).join(' | ') + ')');
    o.set(o.q('#lotQ'), 'MNGK-261016-01'); o.click(btn(o, /^Find$/));
    await until(() => page(o) === '15OCT26', 5000, 'the lot page').catch(() => {});
    v = o.text(o.q('#viewStock'));
    ok(page(o) === '15OCT26' && /Atta Kesari/.test(o.text(o.q('#lotHead'))), 'search MNGK-261016-01 opens the 15OCT26 lot page of Kesari (' + page(o) + ')');
    ok(/Sticker code MNGK-261016-01/.test(v) && /Released/.test(o.text(o.q('#lotHead'))), 'it shows the sticker code and the Released chip');
    ok(['Baked', 'Website stops', 'Last ship', 'Best before'].every((x) => v.includes(x)) && ['Received', 'Broken', 'Good', 'On hand', 'Website', 'Offline', 'Fairs', 'Gifts', 'Samples', 'Damaged', 'Returned', 'Expired'].every((x) => num(o, x) != null), 'the four dates and the twelve numbers');
    ok(/Website buyers/.test(v), 'the website buyers section');
    ok(!!btn(o, /^Hold this lot$/) && !!btn(o, /^Fix lot$/) && !!btn(o, /^Broken while cartoning$/) && !!btn(o, /^Print stickers$/) && !!btn(o, /^Copy buyer list$/) && !btn(o, /^Release$/) && !btn(o, /^Reject$/), 'a released lot: the owner has Hold this lot, Fix lot, Broken while cartoning, Print stickers and Copy buyer list; no Release or Reject');
    bad = tooWide(o); ok(bad.length === 0, 'the lot page has nothing wider than the phone (' + bad.slice(0, 4).join(' | ') + ')');
    o.click(btn(o, /^Print stickers$/));
    ok(/This lot has no sticker code\. Fix the lot first\./.test(o.text(o.q('#viewStock'))), 'an old lot with no MNG code says it has no sticker code');
    const got = []; o.win.HTMLAnchorElement.prototype.click = function () { got.push(this.getAttribute('download') || ''); };
    o.click(btn(o, /^Copy buyer list$/)); await until(() => got.length > 0, 5000, 'the buyer list').catch(() => {});
    ok(got.length === 1 && /\.csv$/.test(got[0]), 'Copy buyer list downloads a file whose name ends in .csv (' + got.join(',') + ')');
    await toLots(o); o.set(o.q('#lotQ'), '15OCT26'); o.click(btn(o, /^Find$/));
    await until(() => !!btn(o, /^Atta Original$/), 5000, 'the flavour picker').catch(() => {});
    ok(['Atta Original', 'Atta Kesari', 'Atta Ajwain', 'Atta Sugar-Lite'].every((n) => !!btn(o, new RegExp('^' + n + '$'))), 'a code on four flavours asks which one');
    if (btn(o, /^Atta Original$/)) o.click(btn(o, /^Atta Original$/));
    await until(() => page(o) === '15OCT26' && /Atta Original/.test(o.text(o.q('#lotHead'))), 5000, 'the Original lot page').catch(() => {});
    ok(page(o) === '15OCT26' && /Atta Original/.test(o.text(o.q('#lotHead'))), 'choosing Original opens its lot page');
    await toLots(o); o.set(o.q('#lotQ'), 'ZZ-NOTHING'); o.click(btn(o, /^Find$/));
    await until(() => /Nothing found for ZZ-NOTHING\./.test(o.text(o.q('#viewStock'))), 5000, 'the empty answer').catch(() => {});
    ok(/Nothing found for ZZ-NOTHING\./.test(o.text(o.q('#viewStock'))), 'a search that finds nothing says so');

    // ── two deliveries saved by staff: all four flavours with a bill photo (D), and one Original box (C, corrected later) ──
    const ph = await api('/admin/api/stock/photo', 's', { dataUrl: JPEG });
    const D = await deliver([{ slug: 'atta-ajwain', invoiceBoxes: 10, counted: 10, rateRupees: 85 }, { slug: 'atta-kesari', invoiceBoxes: 10, counted: 10, rateRupees: 100 }, { slug: 'atta-original', invoiceBoxes: 6, counted: 6, rateRupees: 85 }, { slug: 'atta-lite-sugar', invoiceBoxes: 4, counted: 4, rateRupees: 125 }], { photos: [ph.j.path], cartons: 2 });
    const C = await deliver([{ slug: 'atta-original', invoiceBoxes: 1, counted: 1, rateRupees: 85 }]);
    const KA = D.code('atta-ajwain'), KK = D.code('atta-kesari'), KO = D.code('atta-original'), KL = D.code('atta-lite-sugar'), KC = C.code('atta-original');
    ok(D.r.j.ok && C.r.j.ok && [KA, KK, KO, KL, KC].every((c) => /^MNG[OKAL]-\d{6}-\d{2}$/.test(c || '')), 'setup: staff save two deliveries through the API (' + JSON.stringify([D.r.s, D.r.j.error, C.r.s, C.r.j.error]) + ')');

    // ── owner: Release from the delivery page (tick, 252 g); the chip turns Released and the Website line counts the boxes ──
    await toStock(o);
    const webA0 = webOf(o, 'Atta Ajwain'), heldA0 = heldOf(o, 'Atta Ajwain');
    ok(webA0 != null && heldA0 >= 10, 'setup: the Stock screen shows Ajwain\'s website number and its boxes on hold (' + webA0 + ', ' + heldA0 + ' on hold: ' + rowText(o, 'Atta Ajwain').slice(0, 200) + ')');
    ok(o.qa('#needs .need, #stockNeeds .need').some((b) => /\d+\s*lots? on hold/.test(o.text(b))), 'Needs attention counts the lots on hold');
    await openLotCard(o, KA);
    v = o.text(o.q('#viewStock'));
    ok(/On hold/.test(o.text(o.q('#lotHead'))) && !!btn(o, /^Release$/) && !!btn(o, /^Reject$/) && !!btn(o, /^Fix lot$/) && !btn(o, /^Hold this lot$/), 'a held lot (owner): On hold, with Release, Reject and Fix lot; no Hold');
    ok(v.includes('Bill ' + D.bill) && !!btn(o, /^Open the delivery$/), 'the lot page names its delivery and links to it');
    o.click(btn(o, /^Open the delivery$/));
    await until(() => page(o).indexOf('Delivery ' + D.bill) === 0 && o.qa('#viewStock .dlotline').length === 4, 5000, 'the delivery page').catch(() => {});
    let lines = o.qa('#viewStock .dlotline');
    ok(lines.length === 4 && lines.every((l) => /On hold/.test(o.text(l.querySelector('.badge'))) && !!btn(o, /^Release$/, l)), 'the delivery page: four lots On hold, each with Release (' + lines.map((l) => o.text(l).slice(0, 40)).join(' | ') + ')');
    await until(() => o.qa('#viewStock img.dlthumb').some((i) => /^data:image\/jpeg/.test(i.getAttribute('src') || '')), 4000, 'the photo').catch(() => {});
    ok(o.qa('#viewStock img.dlthumb').some((i) => /^data:image\/jpeg/.test(i.getAttribute('src') || '')), 'the bill photo is shown through its signed link');
    ok(!!btn(o, /^Correct whole delivery$/), 'Correct whole delivery is offered while every lot is on hold');
    o.click(btn(o, /^Release$/, lines.find((l) => l.getAttribute('data-code') === KA)));
    await until(() => !!o.q('#rel-go'), 4000, 'the release form');
    ok(page(o) === 'Release ' + KA && o.q('#rel-go').disabled, 'the Release form opens, and Release waits for the tick and the weight');
    ok(!/packaging|mono carton|stamp label/i.test(o.text(o.q('#viewStock'))), 'the Release form has no packaging lines (packaging is a hand-kept list)');
    o.click(o.q('#rel-tasted')); ok(o.q('#rel-go').disabled, 'ticked but no weight: still disabled');
    o.set(o.q('#rel-weight'), '252'); ok(!o.q('#rel-go').disabled && o.q('#rel-wwarn').hidden, 'tick and 252 g: Release is enabled, no weight warning');
    bad = tooWide(o); ok(bad.length === 0, 'the Release form has nothing wider than the phone (' + bad.slice(0, 4).join(' | ') + ')');
    o.click(o.q('#rel-go'));
    ok(!o.q('#rel-go') || o.q('#rel-go').disabled, 'Release disables itself while sending');
    const lineOf = (w, code) => w.qa('#viewStock .dlotline').find((l) => l.getAttribute('data-code') === code);
    await until(() => page(o).indexOf('Delivery ') === 0 && /Released/.test(o.text((lineOf(o, KA) || none(o)).querySelector('.badge') || none(o))), 5000, 'the delivery page again').catch(() => {});
    const la = lineOf(o, KA);
    ok(!!la && /^Released$/.test(o.text(la.querySelector('.badge'))) && !btn(o, /^Release$/, la), 'the chip turns Released and its Release button goes');
    await toStock(o);
    await until(() => webOf(o, 'Atta Ajwain') === webA0 + 10, 4000, 'the website count').catch(() => {});
    ok(webOf(o, 'Atta Ajwain') === webA0 + 10 && heldOf(o, 'Atta Ajwain') === heldA0 - 10, 'the Stock screen\'s Website line counts the 10 boxes, and 10 fewer are on hold (' + webA0 + ' -> ' + webOf(o, 'Atta Ajwain') + '; ' + heldA0 + ' -> ' + heldOf(o, 'Atta Ajwain') + ')');

    // ── staff: Release (staff may release) shows the server's under-250 g warning; no owner buttons anywhere ──
    await toLots(s);
    ok(!btn(s, /^Throw away expired$/), 'staff have no Throw away expired');
    await openLotCard(s, KO);
    ok(!!btn(s, /^Release$/) && !!btn(s, /^Print stickers$/) && !btn(s, /^Reject$/) && !btn(s, /^Hold this lot$/) && !btn(s, /^Fix lot$/) && !btn(s, /^Broken while cartoning$/), 'staff on a held lot: Release and Print stickers; no Reject, Hold or Fix lot, and no Broken while cartoning (held boxes are not cartoned; the server refuses it)');
    s.click(btn(s, /^Release$/)); await until(() => !!s.q('#rel-go'), 4000, 'the release form');
    s.click(s.q('#rel-tasted')); s.set(s.q('#rel-weight'), '245');
    ok(!s.q('#rel-wwarn').hidden && !s.q('#rel-go').disabled, 'under 250 g the form warns, and Release can still be sent');
    const realS = s.win.fetch; let once = 0;
    s.win.fetch = (u, opt) => { if (!once && /\/release$/.test(String(u)) && opt && opt.method === 'POST') { once++; return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'Practice: the server said no.' }), { status: 400, headers: { 'Content-Type': 'application/json' } })); } return realS(u, opt); };
    s.click(s.q('#rel-go'));
    await until(() => /Practice: the server said no\./.test(s.text(s.q('#rel-err'))), 4000, 'the refusal').catch(() => {});
    ok(/Practice: the server said no\./.test(s.text(s.q('#rel-err'))) && !s.q('#rel-go').disabled, 'a refused Release shows the reason and the button comes back');
    s.win.fetch = realS;
    s.click(s.q('#rel-go'));
    await until(() => page(s) === KO && /Released/.test(s.text(s.q('#lotHead'))), 5000, 'the released lot').catch(() => {});
    ok(/One box weighed 245 g, under the 250 g on the pack\. Weigh a second box\./.test(s.text(s.q('#viewStock'))) && /Released/.test(s.text(s.q('#lotHead'))), 'staff release with 245 g: Released, with the server\'s warning on the lot page');
    ok(!btn(s, /^Hold this lot$/) && !btn(s, /^Fix lot$/) && !btn(s, /^Release$/) && !!btn(s, /^Broken while cartoning$/), 'staff on a released lot: Broken while cartoning, and no Hold this lot or Fix lot');
    s.click(btn(s, /^Broken while cartoning$/)); await until(() => !!s.q('#bk-go'), 4000, 'the broken form');
    s.set(s.q('#bk-qty'), '1'); s.set(s.q('#bk-note'), 'dropped while cartoning');
    s.win.__shrinkPhoto = () => Promise.resolve(JPEG);   // jsdom has no canvas; the server still checks the photo
    const bf = s.q('#bk-photo'); Object.defineProperty(bf, 'files', { value: [new s.win.File(['x'], 'b.jpg', { type: 'image/jpeg' })], configurable: true }); bf.dispatchEvent(new s.win.Event('change', { bubbles: true }));
    await until(() => /Photo added/.test(s.text(s.q('#viewStock'))), 4000, 'the photo').catch(() => {});
    ok(/Photo added/.test(s.text(s.q('#viewStock'))), 'the photo of the broken box goes through the same shrink and upload as New delivery');
    s.click(s.q('#bk-go'));
    await until(() => page(s) === KO && num(s, 'Damaged') === 1, 5000, 'the lot page').catch(() => {});
    ok(num(s, 'Damaged') === 1 && num(s, 'On hand') === 5, 'Broken while cartoning: 1 damaged, 5 on hand (' + num(s, 'Damaged') + ', ' + num(s, 'On hand') + ')');
    s.click(btn(s, /^Print stickers$/));
    ok(s.text(s.q('#lotCmd')).indexOf('python3 make_stamp_labels.py --lot ' + KO + ' --qty original=5 --cols 3') === 0 && !!btn(s, /^Copy$/), 'Print stickers shows the command for this lot with a Copy button (' + s.text(s.q('#lotCmd')) + ')');

    // ── owner: Hold this lot, Fix lot, Reject ──
    await openLotCard(o, KO);
    o.click(btn(o, /^Hold this lot$/)); await until(() => !!o.q('#lr-go'), 4000, 'the hold form');
    o.click(o.q('#lr-go')); ok(/Add a reason/.test(o.text(o.q('#lr-err'))), 'Hold needs a reason');
    o.set(o.q('#lr-reason'), 'a customer complaint'); o.click(o.q('#lr-go'));
    await until(() => page(o) === KO && /On hold/.test(o.text(o.q('#lotHead'))), 5000, 'the held lot').catch(() => {});
    ok(/On hold/.test(o.text(o.q('#lotHead'))) && /a customer complaint/.test(o.text(o.q('#viewStock'))) && !!btn(o, /^Release$/), 'Hold this lot: On hold with the reason, and Release to undo it');
    o.click(btn(o, /^Fix lot$/)); await until(() => !!o.q('#fx-go'), 4000, 'the Fix lot form');
    bad = tooWide(o); ok(bad.length === 0, 'the Fix lot form has nothing wider than the phone (' + bad.slice(0, 4).join(' | ') + ')');
    o.set(o.q('#fx-bake'), istDay(2)); o.click(o.q('#fx-go'));
    await until(() => /^MNGO-/.test(page(o)) && page(o) !== KO, 5000, 'the fixed lot').catch(() => {});
    v = o.text(o.q('#viewStock'));
    ok(page(o).indexOf('MNGO-' + yymmdd(istDay(2)) + '-') === 0 && /Stickers already printed carry the old code or date: reprint them\./.test(v) && v.includes('Sticker code ' + KO), 'Fix lot: a new code from the new bake date, the reprint warning, and the old code kept (' + page(o) + ')');
    await openLotCard(o, KL);
    o.click(btn(o, /^Reject$/)); await until(() => !!o.q('#lr-go'), 4000, 'the reject form');
    o.set(o.q('#lr-reason'), 'stale smell'); o.click(o.q('#lr-go'));
    await until(() => page(o) === KL && /Rejected/.test(o.text(o.q('#lotHead'))), 5000, 'the rejected lot').catch(() => {});
    ok(/Rejected/.test(o.text(o.q('#lotHead'))) && /stale smell/.test(o.text(o.q('#viewStock'))) && !btn(o, /^Release$/) && !btn(o, /^Reject$/) && !btn(o, /^Hold this lot$/), 'Reject: Rejected with the reason; no Release, Reject or Hold');

    // ── the Packed refusal: Kesari is made short the real way (the shippable Kesari is taken out; lot KK stays on hold) ──
    const k0 = ((await api('/admin/api/inventory', 'o')).j.items || []).find((i) => i.slug === 'atta-kesari');
    if (k0 && k0.usable > 0) ok((await api('/admin/api/inventory/take', 'o', { slug: 'atta-kesari', qty: k0.usable, type: 'SAMPLE', note: 'practice: no shippable Kesari left' })).j.ok, 'setup: the shippable Kesari is taken out (' + k0.usable + ')');
    const kesariIn = (x) => x.items.some((i) => /Kesari/.test(i.name + ' ' + (i.contents || '')));
    let orders = (await api('/admin/api/orders', 'o')).j.orders || [];
    const trios = orders.filter((x) => x.state === 'topack' && x.items.length === 1 && x.items[0].qty === 1 && x.boxes === 3 && kesariIn(x));
    const plain = orders.filter((x) => x.state === 'topack' && !kesariIn(x));
    ok(trios.length >= 2, 'setup: practice orders to pack with one Kesari box each (' + trios.map((x) => x.id).join(',') + ')');
    const G1 = (trios[0] || {}).id, G2 = (trios[1] || {}).id;
    const SHORT = /Kesari: 1 box short\. Lot MNGK-\d{6}-\d{2} is on hold \(release it\), or receive the delivery first\./;
    s.click(s.byText('#tabs .tab', /^Orders$/)); s.click(s.q('#reload')); await sleep(400);
    s.click(s.byText('#flow .step', /To pack/)); await until(() => !!cardOf(s, G1), 4000, 'the staff order list');
    s.click(btn(s, /^Mark packed$/, cardOf(s, G1)));
    await until(() => !!(cardOf(s, G1) || none(s)).querySelector('.refuse'), 5000, 'the refusal').catch(() => {});
    let rf = (cardOf(s, G1) || none(s)).querySelector('.refuse');
    ok(!!rf && /Not packed\./.test(s.text(rf)) && SHORT.test(s.text(rf)), 'staff: Mark packed on a short order shows the refusal on the card (' + (rf ? s.text(rf) : 'none') + ')');
    ok(!!rf && !btn(s, /Pack anyway/, rf) && !rf.querySelector('input') && /Only the owner can pack anyway/.test(s.text(rf)), 'staff see no Pack anyway');
    ok((await api('/admin/api/orders/' + G1, 'o')).j.order.state === 'topack', 'the refused order stays To pack');
    // owner, in the order sheet: Pack anyway with a note
    o.click(o.byText('#tabs .tab', /^Orders$/)); o.click(o.q('#reload')); await sleep(400);
    o.click(o.byText('#flow .step', /To pack/)); await until(() => !!cardOf(o, G1), 4000, 'the owner order list');
    o.click(cardOf(o, G1)); await until(() => !!o.q('#sheet.on') && !!btn(o, /^Mark packed$/, o.q('#panel')), 4000, 'the order sheet');
    o.click(btn(o, /^Mark packed$/, o.q('#panel')));
    await until(() => !!o.q('#panel .refuse'), 5000, 'the refusal in the sheet').catch(() => {});
    rf = o.q('#panel .refuse');
    const go = rf && btn(o, /^Pack anyway$/, rf), nt = rf && rf.querySelector('.pknote');
    ok(!!rf && SHORT.test(o.text(rf)) && !!go && !!nt && go.disabled, 'owner: the refusal in the order sheet, with a note box and Pack anyway, disabled until the note (' + (rf ? o.text(rf) : 'none') + ')');
    if (nt) { o.set(nt, 'ab'); ok(go.disabled, 'a 2-letter note is not enough'); o.set(nt, 'fair stock'); ok(!go.disabled, 'with the note "fair stock" Pack anyway is enabled'); }
    if (go) { o.click(go); ok(go.disabled, 'Pack anyway disables itself while sending'); }
    await until(async () => (await api('/admin/api/orders/' + G1, 'o')).j.order.state === 'packed', 5000, 'the order to be packed').catch(() => {});
    ok((await api('/admin/api/orders/' + G1, 'o')).j.order.state === 'packed', 'Pack anyway with a note moves the order to Packed');
    await until(() => /Packed anyway: fair stock/.test(o.text(o.q('#panel'))), 4000, 'the sheet to redraw').catch(() => {});
    ok(/Packed anyway: fair stock/.test(o.text(o.q('#panel'))), 'the timeline says it was packed anyway, with the note');
    if (btn(o, /^Close$/, o.q('#panel'))) o.click(btn(o, /^Close$/, o.q('#panel')));
    await until(() => o.qa('#needs .need').some((b) => /1\s*box packed without a lot/.test(o.text(b))), 5000, 'Needs you now').catch(() => {});
    const nb = o.qa('#needs .need').find((b) => /1\s*box packed without a lot/.test(o.text(b)));
    ok(!!nb && /tap to assign/.test(o.text(nb)), 'Needs attention then shows 1 box packed without a lot: tap to assign (' + o.qa('#needs .need').map((b) => o.text(b)).join(' | ') + ')');
    // bulk Mark packed lists each refused order with its reason
    s.click(s.q('#reload')); await sleep(400); s.click(s.byText('#flow .step', /To pack/)); await until(() => !!cardOf(s, G2), 4000, 'the list');
    s.click(cardOf(s, G2).querySelector('input[type=checkbox]')); if (plain[0] && cardOf(s, plain[0].id)) s.click(cardOf(s, plain[0].id).querySelector('input[type=checkbox]'));
    s.click(s.byText('#bulk button', /^Mark \d+ packed$/));
    await until(() => /not packed/i.test(s.text(s.q('#panel'))) && !!s.q('#sheet.on'), 5000, 'the bulk result').catch(() => {});
    v = s.text(s.q('#panel'));
    ok(!!s.q('#sheet.on') && v.includes(G2) && SHORT.test(v) && (!plain[0] || /1 packed/.test(v)), 'bulk Mark packed lists the refused order with its reason (' + v.slice(0, 260) + ')');
    if (btn(s, /^Close$/, s.q('#panel'))) s.click(btn(s, /^Close$/, s.q('#panel')));

    // ── Needs attention (stock): staff see the line but cannot assign; the owner releases KK, then Assign lot ──
    if (nb) o.click(nb);
    await until(() => page(o) === 'Needs attention' && !!o.q('#viewStock .nlline'), 5000, 'the stock Needs attention page').catch(() => {});
    let ln = o.qa('#viewStock .nlline').find((l) => l.getAttribute('data-order') === G1);
    ok(!!ln && /Atta Kesari/.test(o.text(ln)) && /1 box/.test(o.text(ln)) && /No Atta Kesari lot that can ship has 1 box/.test(o.text(ln)), 'the line for ' + G1 + ' says no Kesari lot can ship it yet (' + (ln ? o.text(ln) : 'none') + ')');
    ok(o.qa('#viewStock .heldlot').some((c) => c.getAttribute('data-code') === KK), 'Lots on hold lists ' + KK);
    bad = tooWide(o); ok(bad.length === 0, 'the Needs attention page has nothing wider than the phone (' + bad.slice(0, 4).join(' | ') + ')');
    await toStock(s);
    // Final review I4 changed this lookup (and the two below) to wait: the strip now fills in when needs-lot answers, after the screen is drawn
    await until(() => s.qa('#stockNeeds .need').some((b) => /box packed without a lot/.test(s.text(b))), 5000, 'the strip').catch(() => {});
    const sn0 = s.qa('#stockNeeds .need').find((b) => /box packed without a lot/.test(s.text(b)));
    ok(!!sn0, 'the Stock screen shows the stock items of Needs attention too (staff)');
    if (sn0) s.click(sn0);
    await until(() => page(s) === 'Needs attention' && !!s.q('#viewStock .nlline'), 5000, 'the staff attention page').catch(() => {});
    const sl = s.qa('#viewStock .nlline').find((l) => l.getAttribute('data-order') === G1);
    ok(!!sl && !sl.querySelector('select') && !btn(s, /^Assign lot$/, sl) && /Only the owner can assign a lot\./.test(s.text(sl)), 'staff see the line, with no Assign lot');
    const hk = o.qa('#viewStock .heldlot').find((c) => c.getAttribute('data-code') === KK);
    if (hk) o.click(hk);
    await until(() => page(o) === KK && !!btn(o, /^Release$/), 5000, 'the Kesari lot').catch(() => {});
    o.click(btn(o, /^Release$/)); await until(() => !!o.q('#rel-go'), 4000, 'the release form');
    o.click(o.q('#rel-tasted')); o.set(o.q('#rel-weight'), '252'); o.click(o.q('#rel-go'));
    await until(() => page(o) === KK && /Released/.test(o.text(o.q('#lotHead'))), 5000, 'released').catch(() => {});
    await toStock(o);
    await until(() => o.qa('#stockNeeds .need').some((b) => /box packed without a lot/.test(o.text(b))), 5000, 'the strip').catch(() => {});   // I4: see above
    const sn = o.qa('#stockNeeds .need').find((b) => /box packed without a lot/.test(o.text(b)));
    if (sn) o.click(sn);
    await until(() => page(o) === 'Needs attention' && !!o.q('#viewStock .nlline select'), 5000, 'the attention page with a lot to choose').catch(() => {});
    ln = o.qa('#viewStock .nlline').find((l) => l.getAttribute('data-order') === G1);
    const pick = ln && ln.querySelector('select.nlpick'), as = ln && btn(o, /^Assign lot$/, ln);
    ok(!!pick && Array.from(pick.options).some((x) => x.value === KK) && !!as, 'once ' + KK + ' is released, Assign lot offers it (' + (pick ? Array.from(pick.options).map((x) => x.value).join(',') : 'no choice') + ')');
    if (pick) o.set(pick, KK);
    if (as) { o.click(as); ok(as.disabled, 'Assign lot disables itself while sending'); }
    await until(() => page(o) === 'Needs attention' && !o.qa('#viewStock .nlline').some((l) => l.getAttribute('data-order') === G1), 5000, 'the line to go').catch(() => {});
    ok(page(o) === 'Needs attention' && !o.qa('#viewStock .nlline').some((l) => l.getAttribute('data-order') === G1), 'Assign lot: the line leaves the list');
    await toLots(o); o.set(o.q('#lotQ'), G1); o.click(btn(o, /^Find$/));
    await until(() => o.qa('#lotFound .lotcard').length > 0, 5000, 'the order\'s lots').catch(() => {});
    ok(o.qa('#lotFound .lotcard').some((c) => c.getAttribute('data-code') === KK), 'search by the order ID lists its lots, ' + KK + ' among them');

    // ── a pack whose lots could not be checked: listed, staff cannot clear it, the owner marks it checked ──
    orders = (await api('/admin/api/orders', 'o')).j.orders || [];
    const U = (orders.find((x) => x.state === 'topack' && x.id !== G2) || {}).id;
    await devStock({ planFails: true });
    const up = U ? await api('/admin/api/orders/' + U + '/advance', 's', { to: 'packed' }) : { j: {} };
    await devStock({ planFails: false });
    ok(!!U && up.j.ok, 'setup: ' + U + ' packs while the lot check fails');
    await toStock(s);
    await until(() => s.qa('#stockNeeds .need').some((b) => /1\s*pack was not checked against lots/.test(s.text(b))), 5000, 'the strip').catch(() => {});   // I4: see above
    const sn2 = s.qa('#stockNeeds .need').find((b) => /1\s*pack was not checked against lots/.test(s.text(b)));
    ok(!!sn2, 'the Stock screen counts 1 pack not checked against lots (' + s.qa('#stockNeeds .need').map((b) => s.text(b)).join(' | ') + ')');
    if (sn2) s.click(sn2);
    await until(() => page(s) === 'Needs attention' && !!s.q('#viewStock .upline'), 5000, 'the staff attention page').catch(() => {});
    const su = s.qa('#viewStock .upline').find((l) => l.getAttribute('data-order') === U);
    ok(!!su && /Packed without checking lots: check which lot the boxes came from\./.test(s.text(su)) && !btn(s, /^Mark checked$/, su), 'staff see the pack in plain words, and no Mark checked (' + (su ? s.text(su) : 'none') + ')');
    o.click(o.byText('#tabs .tab', /^Orders$/)); o.click(o.q('#reload'));
    await until(() => o.qa('#needs .need').some((b) => /1\s*pack was not checked against lots/.test(o.text(b))), 5000, 'Needs you now').catch(() => {});
    const nu = o.qa('#needs .need').find((b) => /1\s*pack was not checked against lots/.test(o.text(b)));
    ok(!!nu, 'Needs you now shows 1 pack was not checked against lots');
    if (nu) o.click(nu);
    await until(() => page(o) === 'Needs attention' && !!o.q('#viewStock .upline'), 5000, 'the owner attention page').catch(() => {});
    const ou = o.qa('#viewStock .upline').find((l) => l.getAttribute('data-order') === U), mc = ou && btn(o, /^Mark checked$/, ou);
    ok(!!mc, 'the owner has Mark checked');
    if (mc) { o.click(mc); ok(mc.disabled, 'Mark checked disables itself while sending'); }
    await until(() => page(o) === 'Needs attention' && !o.qa('#viewStock .upline').some((l) => l.getAttribute('data-order') === U), 5000, 'the pack to leave').catch(() => {});
    ok(!o.qa('#viewStock .upline').some((l) => l.getAttribute('data-order') === U), 'Mark checked: the pack leaves the list');
    o.click(o.byText('#tabs .tab', /^Orders$/)); o.click(o.byText('#flow .step', /Packed/)); await until(() => !!cardOf(o, U), 4000, 'the packed card').catch(() => {});
    if (cardOf(o, U)) o.click(cardOf(o, U));
    await until(() => !!o.q('#sheet.on') && /Timeline/.test(o.text(o.q('#panel'))) && o.text(o.q('#panel')).includes(U), 4000, 'the order sheet').catch(() => {});
    v = o.text(o.q('#panel'));
    ok(/Stock not checked at packing: Packed without checking lots: check which lot the boxes came from\./.test(v) && /Stock checked by owner@example\.com/.test(v) && !!btn(o, /^Open Needs attention$/, o.q('#panel')), 'the timeline gives the reason, points at Needs attention and says who checked it');
    if (btn(o, /^Close$/, o.q('#panel'))) o.click(btn(o, /^Close$/, o.q('#panel')));

    // ── staff correct their own delivery while it is on hold: New delivery opens filled in, with a fresh receipt id ──
    await openLotCard(s, KC);
    s.click(btn(s, /^Open the delivery$/)); await until(() => page(s).indexOf('Delivery ' + C.bill) === 0, 5000, 'the delivery page').catch(() => {});
    const cw = btn(s, /^Correct whole delivery$/);
    ok(!!cw, 'staff who saved it see Correct whole delivery');
    if (cw) s.click(cw);
    await until(() => !!s.q('#dc-go'), 3000, 'the reason box').catch(() => {});
    s.click(s.q('#dc-go')); ok(/Add a reason/.test(s.text(s.q('#dc-err'))), 'Correct needs a reason');
    s.set(s.q('#dc-reason'), 'typed the wrong count'); s.click(s.q('#dc-go'));
    await until(() => s.qa('#viewStock .dlrow').length === 4 && !!s.q('#dl-billNo') && s.q('#dl-billNo').value === C.bill, 5000, 'New delivery, filled in').catch(() => {});
    const dr = JSON.parse(s.win.localStorage.getItem('mngDeliveryDraft') || '{}');
    const cnt = s.q('.dlrow[data-slug="atta-original"] [data-f="counted"]');
    ok(!!s.q('#dl-billNo') && s.q('#dl-billNo').value === C.bill && !!cnt && cnt.value === '1' && !!dr.id && dr.id !== C.id, 'Correct whole delivery opens New delivery filled in, with a fresh receipt id (' + dr.id + ')');
    ok(((await api('/admin/api/stock/lots/' + encodeURIComponent(KC), 's')).j.lot || {}).status === 'void', 'the corrected delivery\'s lot no longer counts');

    // ── owner: Throw away expired asks first, naming the lots, then says which lots and how many boxes ──
    const E = await deliver([{ slug: 'atta-original', invoiceBoxes: 2, counted: 2, rateRupees: 85 }], { bakeDate: istDay(100), oldBakeReason: 'practice: an old lot', confirm: CONFIRM.concat(['old_bake']) });
    const KE = E.code('atta-original');
    ok(E.r.j.ok && !!KE, 'setup: a lot baked 100 days ago, past its best before (' + E.r.s + ' ' + E.r.j.error + ')');
    await toLots(o);
    const asked = []; o.win.confirm = (m) => { asked.push(m); return true; };
    o.click(btn(o, /^Throw away expired$/));
    await until(() => /Thrown away/.test(o.text(o.q('#viewStock'))), 5000, 'the result').catch(() => {});
    ok(asked.length === 1 && asked[0].includes(KE), 'Throw away expired asks first, naming the lots past best before (' + asked.join(' / ') + ')');
    ok(new RegExp('Thrown away: ' + KE + ' \\(Atta Original\\), 2 boxes').test(o.text(o.q('#viewStock'))), 'then says which lots and how many boxes (' + o.text(o.q('#lotExpired') || none(o)) + ')');
    o.win.confirm = () => true;

    ok(o.errors.length === 0, 'no page errors for the owner (' + o.errors.join(' | ').slice(0, 300) + ')');
    ok(s.errors.length === 0, 'no page errors for staff (' + s.errors.join(' | ').slice(0, 300) + ')');
    o.close(); s.close();
  });

  // Task 13: an email link opens the delivery or the lot after sign-in, then clears the hash
  list.push(async () => {
    const page = (w) => w.text(w.q('#viewStock .pagehead'));
    const KA = '15OCT26';
    const lot = await openAdmin('owner', { hash: '#lot=' + encodeURIComponent(KA) + '&slug=atta-kesari' });
    await until(() => page(lot) === KA, 8000, 'the lot page from an email link');
    ok(!lot.q('#viewStock').hidden && lot.win.location.hash === '', 'a lot link opens the lot page on the Stock tab and clears the hash');
    ok(lot.errors.length === 0, 'no page errors from a lot link (' + lot.errors.join(' | ').slice(0, 200) + ')');
    lot.close();
    const bad = await openAdmin('owner', { hash: '#delivery=no-such-delivery' });
    await until(() => bad.q('#toast').style.display === 'block' && bad.text(bad.q('#toast')).length > 0, 8000, 'a refusal toast for an unknown delivery');
    ok(bad.win.location.hash === '' && !/^\s*$/.test(bad.text(bad.q('#toast'))), 'an unknown delivery link shows a refusal (' + bad.text(bad.q('#toast')) + ') and clears the hash');
    bad.close();
    const odd = await openAdmin('owner', { hash: '#something-else' });
    ok(odd.win.location.hash === '#something-else' && !odd.q('#viewOrders').hidden, 'an unknown hash is ignored and Orders stays first');
    odd.close();
  });

  // Final review I2: a lot the owner put on hold (recall, complaint) is shown as "Held by the owner" with no Release for staff; the
  // staff "lots on hold" count is new deliveries only; the owner sees both, labelled.
  list.push(async () => {
    const page = (w) => w.text(w.q('#viewStock .pagehead'));
    const btn = (w, re, root) => Array.from((root || w.q('#viewStock')).querySelectorAll('button')).find((b) => re.test(w.text(b)));
    const istDay = (n) => new Date(Date.now() + 330 * 60000 - n * 86400000).toISOString().slice(0, 10);
    const stamp = String(Date.now()).slice(-7);
    const o = await openAdmin('owner', { width: 375 }), s = await openAdmin('staff', { width: 375 });
    const tok = { o: o.win.localStorage.getItem('mngAdminToken'), s: s.win.localStorage.getItem('mngAdminToken') };
    const api = async (p, who, body) => { const r = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
    const d = await api('/admin/api/stock/deliveries', 's', { id: 'practice-i2-' + stamp, billNo: 'I2-' + stamp, bakeDate: istDay(2), cartons: 1, invoiceRupees: 1, freight: { porter: 100 }, confirm: ['invoice_mismatch', 'no_freight', 'cost_jump', 'stop_soon', 'old_bake', 'large'], rows: [{ slug: 'atta-ajwain', invoiceBoxes: 5, counted: 5, rateRupees: 85 }] });
    const K = d.j.ok ? d.j.lots[0].code : null;
    const rl = K ? await api('/admin/api/stock/lots/' + encodeURIComponent(K) + '/release', 's', { slug: 'atta-ajwain', tasted: true, weightG: 258 }) : { j: {} };
    const hd = K ? await api('/admin/api/stock/lots/' + encodeURIComponent(K) + '/hold', 'o', { slug: 'atta-ajwain', reason: 'recall test' }) : { j: {} };
    ok(!!K && rl.j.ok && hd.j.ok, 'setup: staff save and release an Ajwain lot, the owner holds it (' + JSON.stringify([d.s, d.j.error, rl.j.error, hd.j.error]) + ')');
    const openLotOf = async (w) => { w.q('#viewStock').textContent = ''; w.click(w.byText('#tabs .tab', /^Stock$/)); await until(() => page(w) === 'Stock' && !!btn(w, /^Lots$/), 5000, 'the stock page'); w.click(btn(w, /^Lots$/)); await until(() => w.qa('#viewStock .lotcard').some((c) => c.getAttribute('data-code') === K), 5000, 'the Lots list'); w.click(w.qa('#viewStock .lotcard').find((c) => c.getAttribute('data-code') === K)); await until(() => page(w) === K, 5000, 'the lot page'); };
    await openLotOf(s);
    let v = s.text(s.q('#viewStock'));
    ok(/Held by the owner: recall test\. Only the owner can release it\./.test(v) && !btn(s, /^Release$/), 'staff: the lot page says Held by the owner with the reason, and has no Release (' + v.slice(0, 200) + ')');
    await openLotOf(o);
    v = o.text(o.q('#viewStock'));
    ok(/Held by the owner: recall test/.test(v) && !/Only the owner can release it/.test(v) && !!btn(o, /^Release$/), 'owner: the same line, and Release');
    // Needs attention: the held lot is listed apart, with its reason; staff get no Release there either
    s.q('#viewStock').textContent = ''; s.click(s.byText('#tabs .tab', /^Stock$/)); await until(() => page(s) === 'Stock', 5000, 'stock');
    await new Promise((r) => setTimeout(r, 400));   // let the needs strip fill in
    ok(!s.qa('#needs .need, #stockNeeds .need').some((b) => /you put on hold/.test(s.text(b))), 'staff never see the owner\'s held-lots card (' + s.qa('#needs .need, #stockNeeds .need').map((b) => s.text(b)).join(' | ') + ')');
    o.q('#viewStock').textContent = ''; o.click(o.byText('#tabs .tab', /^Stock$/)); await until(() => page(o) === 'Stock', 5000, 'stock');
    await until(() => o.qa('#needs .need, #stockNeeds .need').some((b) => /\d+\s*lots? you put on hold: tap to see/.test(o.text(b))), 5000, 'the owner card').catch(() => {});
    const oc = o.qa('#stockNeeds .need, #needs .need').find((b) => /\d+\s*lots? you put on hold: tap to see/.test(o.text(b)));
    ok(!!oc, 'the owner sees a labelled card for the lots they put on hold (' + o.qa('#needs .need, #stockNeeds .need').map((b) => o.text(b)).join(' | ') + ')');
    if (oc) o.click(oc);
    await until(() => page(o) === 'Needs attention', 5000, 'the owner attention page').catch(() => {});
    const card = o.qa('#viewStock .ownerheld').find((c) => c.getAttribute('data-code') === K);
    ok(!!card && /Held by the owner: recall test/.test(o.text(card)) && !o.qa('#viewStock .heldlot').some((c) => c.getAttribute('data-code') === K), 'Needs attention lists it under Held by the owner with the reason, not under Lots on hold');
    // the server agrees: staff release is refused
    const sr = await api('/admin/api/stock/lots/' + encodeURIComponent(K) + '/release', 's', { slug: 'atta-ajwain', tasted: true, weightG: 258 });
    ok(sr.s === 403 && sr.j.error === 'This lot was put on hold by the owner. Only the owner can release it.', 'and the server refuses a staff release (' + sr.s + ' ' + sr.j.error + ')');
    ok(o.errors.length === 0 && s.errors.length === 0, 'no page errors (' + o.errors.concat(s.errors).join(' | ').slice(0, 300) + ')');
    await api('/admin/api/stock/lots/' + encodeURIComponent(K) + '/release', 'o', { slug: 'atta-ajwain', tasted: true, weightG: 258 });   // leave the practice stock as it was
    o.close(); s.close();
  });

  // Final review I3: the biscuit count form asks for the lot only when the count is higher than on hand, prefilled with the oldest lot
  // that can still ship; the extra boxes go to that lot.
  list.push(async () => {
    const page = (w) => w.text(w.q('#viewStock .pagehead'));
    const o = await openAdmin('owner', { width: 375 });
    const token = o.win.localStorage.getItem('mngAdminToken');
    const apiGet = async (p) => (await (await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + token } })).json());
    o.click(o.byText('#tabs .tab', /^Stock$/)); await until(() => page(o) === 'Stock' && o.qa('#viewStock .line').length >= 4, 5000, 'the stock page');
    const row = o.qa('#viewStock .line').find((l) => o.text(l).indexOf('Atta Ajwain') === 0);
    const inv0 = (await apiGet('/admin/api/inventory')).items.find((i) => i.slug === 'atta-ajwain');
    const lots = ((await apiGet('/admin/api/stock/lots')).lots || []).filter((l) => l.code && l.slug === 'atta-ajwain' && l.status !== 'rejected' && l.status !== 'void').sort((a, b) => String(a.bestBefore || '9').localeCompare(String(b.bestBefore || '9')));
    const want = (lots.find((l) => l.canShip) || lots[0] || {}).code;
    o.click(Array.from(row.querySelectorAll('button')).find((b) => /^Count$/.test(o.text(b))));
    await until(() => /^Count: Atta Ajwain/.test(page(o)) && o.q('#cnt-lot') && o.q('#cnt-lot').options.length > 0 && o.q('#cnt-lot').value !== '', 5000, 'the count form with its lots').catch(() => {});
    const box = o.q('#cnt-lotbox'), sel = o.q('#cnt-lot'), num = o.qa('#viewStock input')[0];
    ok(!!box && box.hidden, 'the lot picker is hidden until the count is higher than on hand');
    o.set(num, String(Math.max(0, inv0.on_hand - 1)));
    ok(box && box.hidden, 'a lower count shows no lot picker');
    o.set(num, String(inv0.on_hand + 1));
    ok(box && !box.hidden && sel.value === want && Array.from(sel.options).every((x) => lots.some((l) => l.code === x.value)), 'a higher count shows the lot picker, prefilled with the oldest lot that can still ship (' + (sel ? sel.value + ' of ' + Array.from(sel.options).map((x) => x.value).join(',') : 'none') + ', want ' + want + ')');
    o.set(o.qa('#viewStock input')[1], 'found one behind the shelf');
    o.click(o.byText('#viewStock button', /^Save count$/));
    await until(async () => (await apiGet('/admin/api/inventory')).items.find((i) => i.slug === 'atta-ajwain').on_hand === inv0.on_hand + 1, 5000, 'the count to save').catch(() => {});
    const h1 = ((await apiGet('/admin/api/inventory/history?slug=atta-ajwain&limit=1')).movements || [])[0] || {};
    ok(h1.type === 'COUNT_FIX' && h1.qty === 1 && h1.lot_code === want, 'saving puts the extra box in that lot (' + JSON.stringify([h1.type, h1.qty, h1.lot_code]) + ')');
    await until(() => /in lot /.test(o.text(o.q('#toast'))), 3000, 'the toast').catch(() => {});
    ok(new RegExp('^Fixed by \\+1 in lot ' + want).test(o.text(o.q('#toast'))), 'the toast names the lot (' + o.text(o.q('#toast')) + ')');
    ok(o.errors.length === 0, 'no page errors on the count form (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Final review I4: one stock action reads /inventory and needs-lot once each (not twice), and the Stock screen is drawn from /inventory
  // without waiting for needs-lot (a slow Needs attention read never delays it); the strip fills in when needs-lot answers.
  list.push(async () => {
    const page = (w) => w.text(w.q('#viewStock .pagehead'));
    const devStock = (b) => fetch(BASE + '/dev/stock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    const o = await openAdmin('owner', { width: 375 });
    const seen = []; const f0 = o.win.fetch;
    o.win.fetch = (u, opt) => { seen.push({ u: String(u), m: (opt && opt.method) || 'GET', t: Date.now() }); return f0(u, opt); };
    o.click(o.byText('#tabs .tab', /^Stock$/)); await until(() => page(o) === 'Stock' && o.qa('#viewStock .line').length >= 4, 5000, 'the stock page');
    await new Promise((r) => setTimeout(r, 500));
    const kes = () => o.qa('#viewStock .line').find((l) => o.text(l).indexOf('Atta Kesari') === 0);
    const lowBtn = () => Array.from(kes().querySelectorAll('button')).find((b) => /^(Mark low|Clear low flag)$/.test(o.text(b)));
    const was = o.text(lowBtn());
    seen.length = 0;
    o.click(lowBtn());
    await until(() => o.text(lowBtn() || o.doc.createElement('i')) !== was, 5000, 'the low flag to change').catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    const gets = (re) => seen.filter((x) => x.m === 'GET' && re.test(x.u)).length;
    ok(gets(/\/admin\/api\/inventory$/) === 1 && gets(/\/admin\/api\/stock\/needs-lot$/) === 1, 'one stock action reads /inventory once and needs-lot once (' + seen.map((x) => x.m + ' ' + x.u.replace(/^.*\/admin\/api/, '')).join(', ') + ')');
    o.click(lowBtn()); await new Promise((r) => setTimeout(r, 600));   // put the flag back
    // a slow needs-lot: the Stock screen is drawn first, the strip fills in later
    await devStock({ slowNeedsMs: 2500 });
    o.q('#viewStock').textContent = '';
    const t0 = Date.now(); o.click(o.byText('#tabs .tab', /^Orders$/)); o.click(o.byText('#tabs .tab', /^Stock$/));
    let drawn = null; await until(() => (page(o) === 'Stock' && o.qa('#viewStock .line').length >= 4 ? (drawn = Date.now()) : null), 5000, 'the stock page while needs-lot is slow').catch(() => {});
    ok(drawn != null && drawn - t0 < 1500, 'the Stock screen is drawn without waiting for a slow needs-lot (' + (drawn == null ? 'not drawn' : (drawn - t0) + ' ms') + ')');
    const nlAt = () => seen.filter((x) => /needs-lot$/.test(x.u) && x.t >= t0).length;
    await until(() => nlAt() >= 1, 4000, 'the needs-lot request').catch(() => {});
    ok(nlAt() >= 1 && page(o) === 'Stock', 'needs-lot was asked for, and the page did not wait for it');
    await new Promise((r) => setTimeout(r, 3000));
    ok(page(o) === 'Stock' && !!o.q('#stockNeeds') && o.errors.length === 0, 'when it answers, the strip is filled in place and the page stays (' + o.errors.join(' | ').slice(0, 200) + ')');
    await devStock({ slowNeedsMs: 0 });
    o.close();
  });

  // Prices screen: box prices are shown, read-only, with the rule in plain words
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click } = o;
    click(o.byText('#tabs .tab', /^More$/)); await sleep(200);
    click(o.byText('#viewMore .morebtn', /^Prices/));
    await until(() => /Prices/.test(text(q('#panel'))) && qa('#panel input').length > 0, 4000, 'the Prices screen');
    const panel = text(q('#panel'));
    ok(panel.includes('Set by the box rule (3 Flavors: 8% off singles; all 4: 12.5% off)'), 'the Prices screen shows the box rule text');
    const cards = qa('#panel .sw'); const set = (re) => cards.find((c) => re.test(text(c.querySelector('b'))));
    const trio = set(/Trio/), full = set(/Full Range/), single = set(/Original/);
    ok(trio && full && trio.querySelectorAll('input').length === 0 && full.querySelectorAll('input').length === 0 && trio.querySelectorAll('button').length === 0, 'the two set rows have no editable input and no Save button');
    ok(single && single.querySelectorAll('input').length === 2, 'a single box still has its price and MRP inputs');
    ok(/From ₹\d+/.test(text(trio)) && (text(trio).match(/ ₹\d+/g) || []).length >= 4 && /₹\d+/.test(text(full)), 'the set rows show the derived prices (Trio from the lowest mix with all four mixes, Full Range one price): ' + text(trio) + ' | ' + text(full));
    // Mix labels use the Flavor names (Original, Kesari, Sugar-Lite, Ajwain in that order) joined by " + ", prices in en-IN
    const mixes = text(trio.querySelector('small'));
    const token = o.win.localStorage.getItem('mngAdminToken');
    const book = (await (await fetch(BASE + '/admin/api/prices', { headers: { Authorization: 'Bearer ' + token } })).json()).rows; const tb = book.find((r) => r.slug === 'trio-gift-set'), fb = book.find((r) => r.slug === 'full-range-set');
    const inrIN = (n) => '₹' + Number(n).toLocaleString('en-IN');
    const want = [['ajwain-kesari-original', 'Original + Kesari + Ajwain'], ['ajwain-lite-sugar-original', 'Original + Sugar-Lite + Ajwain'], ['kesari-lite-sugar-original', 'Original + Kesari + Sugar-Lite'], ['ajwain-kesari-lite-sugar', 'Kesari + Sugar-Lite + Ajwain']];
    ok(want.every(([k, label]) => mixes.includes(label + ' ' + inrIN(tb.byMix[k]))), 'mix labels read like "Original + Kesari + Sugar-Lite ₹809": ' + mixes);
    ok(!/Lite Sugar|Ajwain Kesari Original/.test(text(trio)), 'no "Lite Sugar" or space-joined tokens: ' + text(trio));
    ok(text(trio).includes('From ' + inrIN(tb.price)) && text(full).includes(inrIN(fb.price)) && (fb.price < 1000 || /₹\d,\d{3}/.test(text(full))), 'From and Full Range prices in en-IN (₹1,129 style): ' + text(trio).slice(0, 40) + ' | ' + text(full));
    ok(!/₹null|₹undefined/.test(text(q('#panel'))), 'no ₹null on the Prices screen');
    ok(o.errors.length === 0, 'no page errors on the Prices screen (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Lots search as you type (9 Nov 2026): partial answers are lot cards, never auto-opened; the sticker code shows on every lot card
  list.push(async () => {
    const o = await openAdmin('owner', { width: 375 });
    const page = (w) => w.text(w.q('#viewStock .pagehead'));
    const btn = (w, re) => Array.from(w.q('#viewStock').querySelectorAll('button')).find((b) => re.test(w.text(b)));
    const toLots = async (w) => { w.q('#viewStock').textContent = ''; w.click(w.byText('#tabs .tab', /^Stock$/)); await until(() => page(w) === 'Stock' && !!btn(w, /^Lots$/), 5000, 'the stock page'); w.click(btn(w, /^Lots$/)); await until(() => page(w) === 'Lots' && w.qa('#viewStock .lotcard').length > 0, 5000, 'the Lots list'); };
    const found = () => o.qa('#lotFound .lotcard'), foundText = () => o.text(o.q('#lotFound'));
    const searches = []; const f0 = o.win.fetch; let stub = null;   // stub(q) -> { body, delay } or null to go through
    o.win.fetch = (u, opt) => {
      const m = /\/stock\/search\?q=([^&]*)/.exec(String(u));
      if (m) { const q = decodeURIComponent(m[1]); searches.push(q); const r = stub && stub(q); if (r) return new Promise((res) => setTimeout(() => res({ status: 200, json: async () => r.body }), r.delay || 0)); }
      return f0(u, opt);
    };
    await toLots(o);
    // the Lots list cards show the sticker code next to the admin code
    const lc = o.qa('#viewStock .lotcard').find((c) => c.getAttribute('data-code') === '15OCT26' && c.getAttribute('data-slug') === 'atta-lite-sugar');
    ok(!!lc && /15OCT26 · sticker MNGL-261016-01/.test(o.text(lc)), 'the Lots list card of Sugar-Lite 15OCT26 shows "15OCT26 · sticker MNGL-261016-01" (' + (lc ? o.text(lc) : 'no card') + ')');
    // typing mngl, one letter at a time: one request after the pause, a list with the Sugar-Lite card and its sticker code
    searches.length = 0;
    for (const v of ['m', 'mn', 'mng', 'mngl']) { o.set(o.q('#lotQ'), v); await sleep(40); }
    ok(searches.length === 0, 'nothing is sent while the keys are still going (' + searches.join(',') + ')');
    await until(() => found().length > 0, 4000, 'the partial list');
    ok(searches.length === 1 && searches[0] === 'mngl', 'one request per pause, for what was typed last (' + searches.join(',') + ')');
    const sl = found().find((c) => c.getAttribute('data-code') === '15OCT26' && c.getAttribute('data-slug') === 'atta-lite-sugar');
    ok(!!sl && /sticker MNGL-261016-01/.test(o.text(sl)) && /Released/.test(o.text(sl)) && /\d+ on hand/.test(o.text(sl)), 'typing mngl lists the Sugar-Lite lot-1 card with its sticker code, chip and boxes (' + (sl ? o.text(sl) : foundText().slice(0, 120)) + ')');
    ok(page(o) === 'Lots', 'a partial answer never opens a lot');
    // one card is still a list
    o.set(o.q('#lotQ'), 'mngl-26101'); await until(() => found().length === 1 && /MNGL-261016-01/.test(foundText()), 4000, 'a one-card list');
    await sleep(300);
    ok(page(o) === 'Lots' && found().length === 1, 'one match is still a list of one card, not an auto-open');
    // an exact code opens the lot, by typing alone
    o.set(o.q('#lotQ'), 'MNGK-261016-01'); await until(() => page(o) === '15OCT26', 4000, 'the exact code to open its lot');
    ok(/Atta Kesari/.test(o.text(o.q('#lotHead'))), 'an exact code opens its lot page');
    // one character clears; Enter and Find search at once
    await toLots(o);
    o.set(o.q('#lotQ'), 'mngl'); await until(() => found().length > 0, 4000, 'the list');
    o.set(o.q('#lotQ'), 'm'); await until(() => found().length > 1 && /Showing the first 50: type more to narrow\./.test(foundText()), 4000, 'the one-character list');
    ok(found().length > 1 && searches[searches.length - 1] === 'm', 'one character searches too, like a regular search box (' + found().length + ' cards)');
    o.set(o.q('#lotQ'), ''); await sleep(40);
    ok(found().length === 0 && foundText() === '', 'an empty box clears the results');
    searches.length = 0;
    o.set(o.q('#lotQ'), 'mngk-26101'); o.q('#lotQ').dispatchEvent(new o.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await until(() => found().length > 0, 1500, 'Enter to search at once');
    ok(found().some((c) => c.getAttribute('data-slug') === 'atta-kesari'), 'Enter searches at once, without the pause');
    await sleep(400);
    ok(searches.length === 1, 'the pause does not search again after Enter (' + searches.join(',') + ')');
    o.set(o.q('#lotQ'), 'mngo-26101'); o.click(btn(o, /^Find$/)); await until(() => found().some((c) => c.getAttribute('data-slug') === 'atta-original'), 1500, 'Find to search at once');
    ok(true, 'Find searches at once');
    // a stale answer never overwrites a newer one
    const card = (code, extra) => Object.assign({ code, slug: 'atta-original', name: 'Atta Original', status: 'released', onHand: 5, bakeDate: '2026-10-16', websiteStop: null, daysToStop: null, aliases: [], supplierBatch: null }, extra || {});
    stub = (q) => (q === 'slow' ? { delay: 900, body: { ok: true, lots: [card('STALE-ONE')], more: false } } : q === 'fast' ? { delay: 10, body: { ok: true, lots: [card('FRESH-ONE')], more: false } } : null);
    o.set(o.q('#lotQ'), 'slow'); await sleep(350);   // the slow request is on its way
    o.set(o.q('#lotQ'), 'fast'); await until(() => /FRESH-ONE/.test(foundText()), 3000, 'the newer answer');
    await sleep(1100);
    ok(/FRESH-ONE/.test(foundText()) && !/STALE-ONE/.test(foundText()), 'an older request finishing late does not overwrite the newer result (' + foundText().slice(0, 80) + ')');
    // clearing while a request is out: its answer is ignored too
    o.set(o.q('#lotQ'), 'slow'); await sleep(350); o.set(o.q('#lotQ'), ''); await sleep(1100);
    ok(foundText() === '', 'an answer that comes back after the box was cleared is dropped (' + foundText().slice(0, 60) + ')');
    // order hits, sticker codes, the cap line and the empty-but-capped answer
    stub = (q) => (q === 'orders' ? { body: { ok: true, more: true, lots: [card('MNGO-261016-01', { orderId: 'MNG-AAAA-1010', boxes: 3, aliases: [] }), card('15OCT26', { slug: 'atta-kesari', name: 'Atta Kesari', aliases: ['MNGK-261016-01', 'MNGK-261017-01', 'OLD1'], status: 'hold', onHand: 0 })] } }
      : q === 'capped' ? { body: { ok: true, lots: [], more: true } } : null);
    o.set(o.q('#lotQ'), 'orders'); await until(() => found().length === 2, 3000, 'the order-hit cards');
    const [c1, c2] = found();
    ok(/3 boxes in MNG-AAAA-1010/.test(o.text(c1)), 'an order-hit card says how many boxes are in the order (' + o.text(c1) + ')');
    ok(!/sticker/.test(o.text(c1)), 'a lot whose own code is an MNG sticker code shows no "sticker" part (' + o.text(c1) + ')');
    ok(/15OCT26 · sticker MNGK-261016-01, MNGK-261017-01/.test(o.text(c2)) && !/OLD1/.test(o.text(c2)), 'several sticker codes are joined with ", " (' + o.text(c2) + ')');
    ok(/On hold/.test(o.text(c2)) && /0 on hand/.test(o.text(c2)), 'the card is marked On hold and says 0 on hand (' + o.text(c2) + ')');
    ok(/Showing the first 50: type more to narrow\./.test(foundText()) && foundText().indexOf('Showing the first 50') > foundText().indexOf('0 on hand'), 'when more is true the line sits under the cards');
    o.set(o.q('#lotQ'), 'capped'); await until(() => found().length === 0 && /Showing the first 50/.test(foundText()), 3000, 'the capped empty answer');
    ok(found().length === 0 && !/Nothing found/.test(foundText()), 'an empty but capped answer says to type more, not "Nothing found"');
    stub = null;
    o.set(o.q('#lotQ'), 'zzqq'); await until(() => /Nothing found for zzqq/.test(foundText()), 3000, 'the empty answer');
    ok(/Nothing found for zzqq/.test(foundText()), 'a search with no hit says "Nothing found"');
    ok(/\.lotcode\{white-space:nowrap/.test(await (await fetch(BASE + '/admin')).text()), 'long codes do not break at their hyphens (the lotcode rule)');
    ok(o.errors.length === 0, 'no page errors in the Lots search (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  return list;
};
