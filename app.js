import { parseScreenshot, mergeScreenshots, value, offers } from './logic.js';

// ---------- tiny IndexedDB layer ----------
const dbP = new Promise((res, rej) => {
  const r = indexedDB.open('pawnprice', 1);
  r.onupgradeneeded = () => { const d = r.result;
    d.createObjectStore('customers', { keyPath: 'id', autoIncrement: true });
    d.createObjectStore('batches', { keyPath: 'id', autoIncrement: true }).createIndex('customerId', 'customerId');
    d.createObjectStore('items', { keyPath: 'id', autoIncrement: true }).createIndex('batchId', 'batchId');
    d.createObjectStore('shots', { keyPath: 'id', autoIncrement: true }).createIndex('itemId', 'itemId'); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function st(name, mode = 'readonly') { return (await dbP).transaction(name, mode).objectStore(name); }
const db = {
  all: async (s) => req((await st(s)).getAll()),
  by: async (s, idx, v) => req((await st(s)).index(idx).getAll(v)),
  get: async (s, id) => req((await st(s)).get(id)),
  put: async (s, o) => req((await st(s, 'readwrite')).put(o)),
  del: async (s, id) => req((await st(s, 'readwrite')).delete(id)),
};
async function delItem(id) { for (const s of await db.by('shots', 'itemId', id)) await db.del('shots', s.id); await db.del('items', id); }
async function delBatch(id) { for (const i of await db.by('items', 'batchId', id)) await delItem(i.id); await db.del('batches', id); }
async function delCustomer(id) { for (const b of await db.by('batches', 'customerId', id)) await delBatch(b.id); await db.del('customers', id); }

// ---------- settings ----------
const settings = {
  get spread() { const v = parseFloat(localStorage.spread); return v >= 0 ? v : 40; },
  set spread(v) { localStorage.spread = v; },
  get divisors() { const l = (localStorage.div || '2,2.3,2.5').split(',').map(Number).filter((d) => d > 0); return l.length ? l : [2, 2.3, 2.5]; },
  set divisors(l) { localStorage.div = l.join(','); },
};

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dollars = (v) => '$' + Math.round(v).toLocaleString('en-US');
const fmtDate = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const titleKey = (t, p) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 40) + '|' + p.toFixed(2);

// ---------- OCR (Tesseract.js, self-hosted, offline after first load) ----------
let workerP = null;
function getWorker() {
  const abs = (p) => new URL(p, location.href).href;
  workerP ??= Tesseract.createWorker('eng', 1, { workerPath: abs('vendor/worker.min.js'), corePath: abs('vendor/'), langPath: abs('lang'), gzip: true, workerBlobURL: false })
    .then(async (w) => { await w.setParameters({ tessedit_pageseg_mode: '4' }); return w; });
  return workerP;
}
async function preprocess(blob) { // grayscale, invert if dark mode screenshot, 2x upscale
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = bmp.width * 2; c.height = bmp.height * 2;
  const x = c.getContext('2d', { willReadFrequently: true }); x.imageSmoothingQuality = 'high'; x.drawImage(bmp, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height), p = d.data; let sum = 0;
  for (let i = 0; i < p.length; i += 4) { const g = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]; p[i] = g; sum += g; }
  const inv = sum / (p.length / 4) < 128;
  for (let i = 0; i < p.length; i += 4) { const g = inv ? 255 - p[i] : p[i]; p[i] = p[i + 1] = p[i + 2] = g; }
  x.putImageData(d, 0, 0); return c;
}

// ---------- session ----------
const S = { shots: [], rows: [], name: '', busy: false, msg: '', editing: null, progress: '' };
let tab = 'price', hist = { cust: null, batch: null, item: null };

async function importFiles(files) {
  files = [...files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(f.name || ''));
  if (!files.length) return;
  tab = 'price'; S.busy = true; S.msg = ''; render();
  const per = [], errs = [];
  try {
    const w = await getWorker();
    for (let i = 0; i < files.length; i++) {
      S.progress = `Reading screenshot ${i + 1} of ${files.length}…`; render();
      try {
        const { data } = await w.recognize(await preprocess(files[i]));
        const found = parseScreenshot(data.text); S.shots.push(files[i]); per.push(found);
        if (!found.length) errs.push(`No sold prices found in ${files[i].name || 'a screenshot'}`);
      } catch (e) { errs.push(`Couldn't read ${files[i].name || 'an image'}: ${e.message || e}`); }
    }
  } catch (e) { errs.push('Text recognition failed to start: ' + (e.message || e)); }
  const merged = mergeScreenshots(per);
  const have = S.rows.filter((r) => !r.manual).map((r) => titleKey(r.title, r.price));
  for (const l of merged) {
    const k = titleKey(l.title, l.price), at = have.indexOf(k);
    if (l.title && at >= 0) { have.splice(at, 1); continue; }
    S.rows.push({ price: l.price, title: l.title || '(no title read)', included: true });
  }
  if (!S.name) S.name = merged.find((l) => l.title)?.title || '';
  S.busy = false; S.progress = ''; S.msg = [...new Set(errs)].join('\n'); render();
}
const clearSession = () => Object.assign(S, { shots: [], rows: [], name: '', msg: '', editing: null });

function valuation() {
  const inc = S.rows.map((r, i) => [r, i]).filter(([r]) => r.included);
  const v = value(inc.map(([r]) => r.price), settings.spread);
  const cl = new Set(v ? [...v.clusterIdx].map((k) => inc[k][1]) : []);
  return { v, inc, cl };
}

// ---------- views ----------
function renderPrice() {
  const { v, inc, cl } = valuation();
  $('#view').innerHTML = `
  <div class="row"><label class="btn grow" style="text-align:center">Add screenshots<input id="file" type="file" accept="image/*" multiple hidden></label>
  <button class="btn alt" id="new">New</button></div>
  ${S.editing ? `<p class="muted">Editing saved item: ${esc(S.editing.name)}</p>` : ''}
  ${S.busy ? `<p>${esc(S.progress || 'Loading text recognition…')}</p><progress></progress>` : ''}
  ${S.msg ? `<p class="err">${esc(S.msg)}</p>` : ''}
  ${S.shots.length ? `<p class="muted">${S.shots.length} screenshot(s) • ${S.rows.length} price(s) found</p>` : ''}
  <div class="card"><div class="label">MARKET VALUE</div><div class="big" id="mv">${v ? money(v.value) : '—'}</div>
   ${v ? `<div class="muted">${v.usedCluster ? `Median of ${v.clusterIdx.size} of ${inc.length} prices within ${dollars(settings.spread)}` : 'Plain median (fewer than 3 prices)'}</div>` : ''}
   <div class="offers">${settings.divisors.map((d) => `<div class="offer"><span class="muted">÷ ${d}</span><b>${v ? dollars(offers(v.value, [d])[0][1]) : '—'}</b></div>`).join('')}</div></div>
  <div class="row"><input id="manual" type="number" inputmode="decimal" step="0.01" placeholder="Add price manually"><button class="btn" id="add">Add</button></div>
  <p class="muted">Tap a price to exclude/include it. Green = in the cluster used for value.</p>
  <div id="prices">${S.rows.map((r, i) => `<div class="price ${!r.included ? 'off' : cl.has(i) ? 'in' : ''}" data-p="${i}">
     <input type="checkbox" ${r.included ? 'checked' : ''} tabindex="-1"><div class="grow"><div class="amt">${money(r.price)}</div><div class="t">${esc(r.title)}</div></div>
     ${r.manual ? `<button class="chip" data-rm="${i}">Remove</button>` : ''}</div>`).join('')}</div>
  <input id="name" type="text" placeholder="Item name" value="${esc(S.name)}" style="margin-top:10px">
  <button class="btn" id="save" style="width:100%;margin-top:12px" ${v ? '' : 'disabled'}>${S.editing ? 'Update saved item' : 'Save to customer…'}</button>`;
  $('#file').onchange = (e) => importFiles(e.target.files);
  $('#new').onclick = () => { clearSession(); render(); };
  $('#add').onclick = () => { const p = parseFloat($('#manual').value); if (p > 0) S.rows.push({ price: p, title: 'Manual', included: true, manual: true }); render(); };
  $('#name').oninput = (e) => (S.name = e.target.value);
  $('#prices').onclick = (e) => {
    const rm = e.target.closest('[data-rm]'); if (rm) { S.rows.splice(+rm.dataset.rm, 1); return render(); }
    const row = e.target.closest('.price'); if (row) { const r = S.rows[+row.dataset.p]; r.included = !r.included; render(); }
  };
  $('#save').onclick = () => (S.editing ? persist(S.editing.batchId) : saveDialog());
}

async function persist(batchId) {
  const { v } = valuation(); if (!v) return;
  const prices = S.rows.map((r) => ({ price: r.price, included: r.included, title: r.title }));
  let item = S.editing ? { ...S.editing } : { batchId, notes: '', amountPaid: null, offerDivisor: null, resalePrice: v.value, created: Date.now() };
  Object.assign(item, { name: S.name || 'Item', prices, marketValue: v.value });
  const id = await db.put('items', item);
  if (S.editing) for (const s of await db.by('shots', 'itemId', id)) await db.del('shots', s.id);
  for (const b of S.shots) await db.put('shots', { itemId: id, blob: b, name: b.name || 'screenshot' });
  clearSession(); const b = await db.get('batches', batchId); hist = { cust: await db.get('customers', b.customerId), batch: b, item: null }; tab = 'history'; render();
}

async function saveDialog() {
  const dlg = document.createElement('dialog'); document.body.append(dlg);
  const close = () => { dlg.close(); dlg.remove(); };
  async function step1() {
    const cs = (await db.all('customers')).sort((a, b) => a.name.localeCompare(b.name));
    dlg.innerHTML = `<h2>Which customer?</h2><div class="row"><input id="nc" type="text" placeholder="New customer name"><button class="btn" id="addc">Add</button></div>
      <div class="list">${cs.map((c) => `<button class="item" data-c="${c.id}">${esc(c.name)}</button>`).join('')}</div><button class="btn alt" id="x" style="margin-top:8px">Cancel</button>`;
    dlg.querySelector('#x').onclick = close;
    dlg.querySelector('#addc').onclick = async () => { const n = dlg.querySelector('#nc').value.trim(); if (n) step2({ id: await db.put('customers', { name: n, created: Date.now() }), name: n }); };
    dlg.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => step2(cs.find((c) => c.id === +b.dataset.c))));
  }
  async function step2(c) {
    const bs = (await db.by('batches', 'customerId', c.id)).sort((a, b) => b.date - a.date);
    dlg.innerHTML = `<h2>Which visit for ${esc(c.name)}?</h2><button class="btn" id="nb" style="width:100%">New visit today</button>
      <div class="list">${bs.map((b) => `<button class="item" data-b="${b.id}">Visit ${fmtDate(b.date)}</button>`).join('')}</div><button class="btn alt" id="x" style="margin-top:8px">Cancel</button>`;
    dlg.querySelector('#x').onclick = close;
    dlg.querySelector('#nb').onclick = async () => { close(); persist(await db.put('batches', { customerId: c.id, date: Date.now() })); };
    dlg.querySelectorAll('[data-b]').forEach((b) => (b.onclick = () => { close(); persist(+b.dataset.b); }));
  }
  await step1(); dlg.showModal();
}

async function renderHistory() {
  const { cust, batch, item } = hist; const v = $('#view');
  const back = cust ? `<button class="btn alt" id="back">‹ Back</button>` : '';
  if (item) {
    const shots = await db.by('shots', 'itemId', item.id);
    v.innerHTML = `<div class="row">${back}<h2 class="grow">${esc(item.name)}</h2></div>
    <div class="card"><div class="label">MARKET VALUE</div><div class="big">${money(item.marketValue)}</div></div>
    <p>Offer taken:</p><div class="chips">${settings.divisors.map((d) => `<button class="chip ${item.offerDivisor === d ? 'on' : ''}" data-d="${d}">÷${d} ${dollars(offers(item.marketValue, [d])[0][1])}</button>`).join('')}</div>
    <p><label>Amount paid<input id="paid" type="number" inputmode="decimal" value="${item.amountPaid ?? ''}"></label></p>
    <p><label>Resale / list price<input id="resale" type="number" inputmode="decimal" step="0.01" value="${(item.resalePrice ?? item.marketValue).toFixed(2)}"></label></p>
    <p><label>Name<input id="iname" type="text" value="${esc(item.name)}"></label></p>
    <p><label>Notes<textarea id="notes" rows="3">${esc(item.notes)}</textarea></label></p>
    <button class="btn" id="isave" style="width:100%">Save</button>
    <button class="btn alt" id="recheck" style="width:100%;margin-top:8px">Re-check prices / add screenshots</button>
    <p class="muted">Prices: ${item.prices.map((p) => (p.included ? money(p.price) : `(${money(p.price)})`)).join('  ')}</p>
    ${shots.map((s) => `<img class="shot" src="${URL.createObjectURL(s.blob)}" alt="screenshot">`).join('')}
    <button class="btn alt" id="idel" style="color:var(--err);margin-top:10px">Delete item</button>`;
    let div = item.offerDivisor;
    v.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => { div = +b.dataset.d; v.querySelector('#paid').value = offers(item.marketValue, [div])[0][1]; v.querySelectorAll('[data-d]').forEach((x) => x.classList.toggle('on', x === b)); }));
    v.querySelector('#isave').onclick = async () => {
      const num = (id) => { const n = parseFloat(v.querySelector(id).value); return Number.isFinite(n) ? n : null; };
      Object.assign(item, { name: v.querySelector('#iname').value || 'Item', notes: v.querySelector('#notes').value, amountPaid: num('#paid'), resalePrice: num('#resale'), offerDivisor: div });
      await db.put('items', item); hist.item = null; render();
    };
    v.querySelector('#recheck').onclick = () => { clearSession(); S.editing = item; S.name = item.name; S.shots = shots.map((s) => s.blob); S.rows = item.prices.map((p) => ({ ...p, title: p.title || 'saved' })); tab = 'price'; hist.item = null; render(); };
    v.querySelector('#idel').onclick = async () => { if (confirm('Delete this item?')) { await delItem(item.id); hist.item = null; render(); } };
  } else if (batch) {
    const items = (await db.by('items', 'batchId', batch.id)).sort((a, b) => a.created - b.created);
    v.innerHTML = `<div class="row">${back}<h2 class="grow">${esc(cust.name)} • ${fmtDate(batch.date)}</h2></div>
    <div class="list">${items.map((x) => `<button class="item" data-i="${x.id}">${esc(x.name)}<div class="muted">Value ${money(x.marketValue)} • Paid ${x.amountPaid != null ? dollars(x.amountPaid) : '—'} • List ${x.resalePrice != null ? money(x.resalePrice) : '—'}</div></button>`).join('') || '<p class="muted">No items yet.</p>'}</div>
    <button class="btn alt" id="bdel" style="color:var(--err);margin-top:10px">Delete this visit</button>`;
    v.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => { hist.item = items.find((i) => i.id === +b.dataset.i); render(); }));
    v.querySelector('#bdel').onclick = async () => { if (confirm('Delete this visit and its items?')) { await delBatch(batch.id); hist.batch = null; render(); } };
  } else if (cust) {
    const bs = (await db.by('batches', 'customerId', cust.id)).sort((a, b) => b.date - a.date);
    v.innerHTML = `<div class="row">${back}<h2 class="grow">${esc(cust.name)}</h2></div>
    <div class="list">${bs.map((b) => `<button class="item" data-b="${b.id}">Visit ${fmtDate(b.date)}</button>`).join('')}</div>
    <button class="btn alt" id="cdel" style="color:var(--err);margin-top:10px">Delete customer</button>`;
    v.querySelectorAll('[data-b]').forEach((b) => (b.onclick = () => { hist.batch = bs.find((x) => x.id === +b.dataset.b); render(); }));
    v.querySelector('#cdel').onclick = async () => { if (confirm('Delete customer and all their items?')) { await delCustomer(cust.id); hist.cust = null; render(); } };
  } else {
    const cs = (await db.all('customers')).sort((a, b) => a.name.localeCompare(b.name));
    v.innerHTML = `<div class="row"><h2 class="grow">Customers</h2><button class="btn alt" id="csv">Export CSV</button></div>
    <input id="q" type="text" placeholder="Search customers">
    <div class="list" id="cl">${cs.map((c) => `<button class="item" data-c="${c.id}">${esc(c.name)}</button>`).join('') || '<p class="muted">Save an item from the Price tab to create a customer.</p>'}</div>`;
    v.querySelector('#q').oninput = (e) => v.querySelectorAll('[data-c]').forEach((b) => (b.hidden = !b.textContent.toLowerCase().includes(e.target.value.toLowerCase())));
    v.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => { hist.cust = cs.find((c) => c.id === +b.dataset.c); render(); }));
    v.querySelector('#csv').onclick = exportCsv;
  }
  v.querySelector('#back')?.addEventListener('click', () => { if (hist.item) hist.item = null; else if (hist.batch) hist.batch = null; else hist.cust = null; render(); });
}

export async function buildCsv() {
  const cs = new Map((await db.all('customers')).map((c) => [c.id, c])), bs = new Map((await db.all('batches')).map((b) => [b.id, b]));
  const shots = await db.all('shots'), q = (s) => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  const rows = (await db.all('items')).map((i) => ({ i, b: bs.get(i.batchId) })).filter((x) => x.b).sort((a, b) => a.b.date - b.b.date || a.i.created - b.i.created);
  let out = 'customer,visit_date,item,notes,market_value,offer_divisor,amount_paid,resale_price,prices_included,prices_excluded,screenshots\n';
  for (const { i, b } of rows) out += [cs.get(b.customerId)?.name ?? '', fmtDate(b.date), i.name, i.notes, i.marketValue.toFixed(2), i.offerDivisor ?? '', i.amountPaid ?? '',
    i.resalePrice != null ? i.resalePrice.toFixed(2) : '', i.prices.filter((p) => p.included).map((p) => p.price.toFixed(2)).join(' '),
    i.prices.filter((p) => !p.included).map((p) => p.price.toFixed(2)).join(' '), shots.filter((s) => s.itemId === i.id).length].map((x) => q(String(x))).join(',') + '\n';
  return out;
}
async function exportCsv() {
  const file = new File([await buildCsv()], 'pawnprice_items.csv', { type: 'text/csv' });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: 'PawnPrice items' }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: file.name }); document.body.append(a); a.click(); a.remove();
}

function renderSettings() {
  $('#view').innerHTML = `<h2>Settings</h2>
  <p><label>Cluster spread ($) — prices within this of each other count as one group<input id="sp" type="number" inputmode="decimal" value="${settings.spread}"></label></p>
  <p><label>Offer divisors (comma separated)<input id="dv" type="text" value="${settings.divisors.join(', ')}"></label></p>
  <p class="muted">All data stays on this device (IndexedDB). No accounts, no analytics. Text recognition runs in the browser and works offline after the first load.</p>`;
  $('#sp').oninput = (e) => { const v = parseFloat(e.target.value); if (v >= 0) settings.spread = v; };
  $('#dv').oninput = (e) => { const l = e.target.value.split(',').map(Number).filter((d) => d > 0); if (l.length) settings.divisors = l; };
}

function render() {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  ({ price: renderPrice, history: renderHistory, settings: renderSettings })[tab]();
}
document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; if (tab === 'history') hist = { cust: null, batch: null, item: null }; render(); }));

// Web Share Target: service worker stashes shared files in a cache, then redirects here with ?shared=N
async function takeShared() {
  const n = +new URLSearchParams(location.search).get('shared'); if (!n) return;
  history.replaceState(null, '', location.pathname);
  const c = await caches.open('pp-shared'), files = [];
  for (let i = 0; i < n; i++) { const r = await c.match(`shared/${i}`); if (r) files.push(new File([await r.blob()], decodeURIComponent(r.headers.get('x-name') || '') || `shared-${i}.jpg`, { type: r.headers.get('content-type') || 'image/jpeg' })); await c.delete(`shared/${i}`); }
  importFiles(files);
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').then(() => (window.__swReady = true)).catch((e) => console.warn('SW', e));
window.__pp = { buildCsv, importFiles, S };
render(); takeShared();
