import { parseScreenshot, mergeScreenshots, value, offers } from './logic.js';
import { buildHistory, filterBatches, filterCustomers, dayKey } from './history.js';
import { createDebug, LOG_CAP } from './debug.js';

const SW_V = 'pp-v3';

function readDebugFlag() {
  const params = new URLSearchParams(location.search);
  if (params.get('debug') === '1') localStorage.setItem('pp_debug', '1');
  if (params.get('debug') === '0') localStorage.removeItem('pp_debug');
  const on = localStorage.getItem('pp_debug') === '1';
  if (params.has('debug')) {
    params.delete('debug');
    const q = params.toString();
    history.replaceState(null, '', location.pathname + (q ? `?${q}` : '') + location.hash);
  }
  return on;
}
const debugOn = readDebugFlag();
let debug = createDebug({ enabled: false });

// ---------- IndexedDB (v1 stores kept; v2 adds a local debug log) ----------
function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('pawnprice', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('customers')) d.createObjectStore('customers', { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('batches')) d.createObjectStore('batches', { keyPath: 'id', autoIncrement: true }).createIndex('customerId', 'customerId');
      if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id', autoIncrement: true }).createIndex('batchId', 'batchId');
      if (!d.objectStoreNames.contains('shots')) d.createObjectStore('shots', { keyPath: 'id', autoIncrement: true }).createIndex('itemId', 'itemId');
      if (!d.objectStoreNames.contains('logs')) d.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const dbP = openDb();
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
function run(store, mode, fn) {
  return dbP.then((d) => fn(d.transaction(store, mode).objectStore(store)));
}
const raw = {
  all: (s) => run(s, 'readonly', (st) => req(st.getAll())),
  by: (s, idx, v) => run(s, 'readonly', (st) => req(st.index(idx).getAll(v))),
  get: (s, id) => run(s, 'readonly', (st) => req(st.get(id))),
  put: (s, o) => run(s, 'readwrite', (st) => req(st.put(o))),
  del: (s, id) => run(s, 'readwrite', (st) => req(st.delete(id))),
  clear: (s) => run(s, 'readwrite', (st) => req(st.clear())),
};
async function traced(op, store, fn) {
  try {
    const result = await fn();
    if (store !== 'logs' && debug.enabled) debug.log('idb', { op, store, id: typeof result === 'number' ? result : undefined });
    return result;
  } catch (err) {
    if (store !== 'logs' && debug.enabled) debug.log('idb-error', { op, store, message: err && err.message ? err.message : String(err) });
    throw err;
  }
}
const db = {
  all: (s) => traced('all', s, () => raw.all(s)),
  by: (s, idx, v) => traced('by', s, () => raw.by(s, idx, v)),
  get: (s, id) => traced('get', s, () => raw.get(s, id)),
  put: (s, o) => traced('put', s, () => raw.put(s, o)),
  del: (s, id) => traced('del', s, () => raw.del(s, id)),
};
async function delItem(id) { for (const s of await db.by('shots', 'itemId', id)) await db.del('shots', s.id); await db.del('items', id); }
async function delBatch(id) { for (const i of await db.by('items', 'batchId', id)) await delItem(i.id); await db.del('batches', id); }

const settings = {
  get spread() { const v = parseFloat(localStorage.spread); return v >= 0 ? v : 40; },
  set spread(v) { localStorage.spread = v; },
  get divisors() { const l = (localStorage.div || '2,2.3,2.5').split(',').map(Number).filter((d) => d > 0); return l.length ? l : [2, 2.3, 2.5]; },
  set divisors(l) { localStorage.div = l.join(','); },
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dollars = (v) => '$' + Math.round(v).toLocaleString('en-US');
const signedMoney = (n) => (n < 0 ? '−' + money(Math.abs(n)) : money(n));
const fmtDate = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const titleKey = (t, p) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 40) + '|' + p.toFixed(2);
const finite = (n) => n != null && Number.isFinite(+n);
const moneyOr = (v) => (finite(v) ? money(+v) : '—');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const I = {
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.5 8 12l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10m0 0 4-4m-4 4-4-4M5 19h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5h3.2l1.4-2h6.8l1.4 2H20v9.5H4V8.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="13" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.25" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14M9.5 8V5.8h5V8M8.2 8l.7 11h6.2l.7-11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5.5 12.5 4 4L18.5 8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  dot: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="currentColor"/></svg>',
};
const AV = ['#0b5d3b', '#14624a', '#1a5d55', '#245c3e', '#0f6a45', '#3a5348'];
function avatarColor(name) { let h = 0; for (const ch of String(name)) h = (h * 33 + ch.charCodeAt(0)) >>> 0; return AV[h % AV.length]; }
function initials(name) { const parts = String(name).trim().split(/\s+/).filter(Boolean).slice(0, 2); return (parts.map((w) => w[0]).join('') || '?').toUpperCase(); }
function suggestedIndex(divs) {
  let best = 0, bestDist = Infinity;
  divs.forEach((d, i) => {
    const dist = Math.abs(d - 2.3);
    if (dist < bestDist - 1e-9 || (Math.abs(dist - bestDist) <= 1e-9 && d > divs[best])) { best = i; bestDist = dist; }
  });
  return best;
}
function jsonSafe(data) { try { return JSON.parse(JSON.stringify(data ?? null)); } catch { return { unserializable: true }; } }
function appBar({ title, sub = '', back = false, end = '' }) {
  const lead = back
    ? `<button type="button" class="iconbtn" id="back" aria-label="Back">${I.back}</button>`
    : '<span class="mark" aria-hidden="true">$</span>';
  return `<header class="appbar">${lead}<div class="appbar-text"><h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}</div>${end}${debugToggle()}</header>`;
}
const previewUrls = [];
function blobURLs(blobs) {
  previewUrls.forEach((u) => URL.revokeObjectURL(u));
  previewUrls.length = 0;
  for (const b of blobs) previewUrls.push(URL.createObjectURL(b));
  return previewUrls;
}
function thumbs(list) {
  if (!list.length) return '';
  return `<div class="thumbs">${list.map((src, i) => `<img src="${src}" alt="Screenshot ${i + 1}">`).join('')}</div>`;
}
function parseDivisors(text) {
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const list = [];
  for (const p of parts) {
    if (!/^\d+(\.\d+)?$/.test(p)) return null;
    const n = Number(p);
    if (!(n > 0)) return null;
    list.push(n);
  }
  return list;
}
function ask({ title, body, confirm = 'Delete', danger = true }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sheet';
    dlg.innerHTML = `<div class="grab"></div><h2>${esc(title)}</h2><p class="hint">${esc(body)}</p>
      <div class="row end"><button type="button" class="btn alt grow" id="no">Cancel</button>
      <button type="button" class="btn grow ${danger ? 'danger' : ''}" id="yes">${esc(confirm)}</button></div>`;
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.querySelector('#no').onclick = () => done(false);
    dlg.querySelector('#yes').onclick = () => done(true);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    document.body.append(dlg);
    dlg.showModal();
  });
}
function debugToggle() {
  return debug.enabled ? '<button type="button" class="iconbtn" id="pp-debug-toggle" aria-label="Debug">{}</button>' : '';
}

let workerP = null;
function getWorker() {
  const abs = (p) => new URL(p, location.href).href;
  workerP ??= Tesseract.createWorker('eng', 1, { workerPath: abs('vendor/worker.min.js'), corePath: abs('vendor/'), langPath: abs('lang'), gzip: true, workerBlobURL: false })
    .then(async (w) => { await w.setParameters({ tessedit_pageseg_mode: '4' }); return w; });
  return workerP;
}
async function preprocess(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = bmp.width * 2; c.height = bmp.height * 2;
  const x = c.getContext('2d', { willReadFrequently: true }); x.imageSmoothingQuality = 'high'; x.drawImage(bmp, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height), p = d.data; let sum = 0;
  for (let i = 0; i < p.length; i += 4) { const g = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]; p[i] = g; sum += g; }
  const inv = sum / (p.length / 4) < 128;
  for (let i = 0; i < p.length; i += 4) { const g = inv ? 255 - p[i] : p[i]; p[i] = p[i + 1] = p[i + 2] = g; }
  x.putImageData(d, 0, 0); return c;
}

const S = { shots: [], rows: [], name: '', busy: false, msg: '', editing: null, progress: '' };
let tab = 'price', hist = { day: null, item: null }, draft = null, token = 0, saving = false;
const clearSession = () => Object.assign(S, { shots: [], rows: [], name: '', msg: '', editing: null, progress: '', busy: false });

async function importFiles(files) {
  files = [...files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(f.name || ''));
  if (!files.length) return;
  if (!draft && !S.editing) await startBatch();
  tab = 'price'; S.busy = true; S.msg = ''; render();
  const per = [], errs = [];
  try {
    const w = await getWorker();
    for (let i = 0; i < files.length; i++) {
      S.progress = `Reading screenshot ${i + 1} of ${files.length}…`; render();
      try {
        const { data } = await w.recognize(await preprocess(files[i]));
        const found = parseScreenshot(data.text);
        S.shots.push(files[i]); per.push(found);
        if (debug.enabled) debug.log('ocr', { file: files[i].name || '', text: data.text, parsed: found });
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

function valuation() {
  const inc = S.rows.map((r, i) => [r, i]).filter(([r]) => r.included);
  const prices = inc.map(([r]) => r.price);
  const v = value(prices, settings.spread);
  const cl = new Set(v ? [...v.clusterIdx].map((k) => inc[k][1]) : []);
  const sig = prices.join(',') + '|' + settings.spread;
  if (debug.enabled && sig !== valuation.last) {
    valuation.last = sig;
    debug.log('cluster', { prices, spread: settings.spread, result: v ? { value: v.value, usedCluster: v.usedCluster, cluster: [...v.clusterIdx] } : null });
  }
  return { v, inc, cl };
}

async function startBatch() {
  if (draft) return draft;
  const id = await db.put('batches', { customerId: null, date: null, draft: true, created: Date.now() });
  draft = { id, items: [] };
  if (debug.enabled) debug.log('batch', { event: 'start', id });
  return draft;
}
async function loadDraft() {
  const batches = await db.all('batches');
  const open = batches.filter((b) => b.draft).sort((a, b) => b.id - a.id);
  if (!open.length) return null;
  const items = (await db.by('items', 'batchId', open[0].id)).sort((a, b) => (a.created || 0) - (b.created || 0));
  return { id: open[0].id, items };
}
async function saveCurrentItem() {
  const { v } = valuation();
  if (!v) return null;
  const prices = S.rows.map((r) => ({ price: r.price, included: r.included, title: r.title }));
  if (S.editing) {
    const item = { ...S.editing, name: S.name || 'Item', prices, marketValue: v.value };
    const id = await db.put('items', item);
    for (const s of await db.by('shots', 'itemId', id)) await db.del('shots', s.id);
    for (const b of S.shots) await db.put('shots', { itemId: id, blob: b, name: b.name || 'screenshot' });
    clearSession();
    return item;
  }
  if (!draft) await startBatch();
  const item = { batchId: draft.id, notes: '', amountPaid: null, offerDivisor: null, resalePrice: v.value, created: Date.now(), name: S.name || 'Item', prices, marketValue: v.value };
  item.id = await db.put('items', item);
  for (const b of S.shots) await db.put('shots', { itemId: item.id, blob: b, name: b.name || 'screenshot' });
  draft.items.push(item);
  clearSession();
  if (debug.enabled) debug.log('batch', { event: 'save-item', batchId: draft.id, itemId: item.id, name: item.name, marketValue: item.marketValue, count: draft.items.length });
  return item;
}

function offerCards(v) {
  const divs = settings.divisors, sug = suggestedIndex(divs);
  return `<div class="offers">${divs.map((d, i) => {
    const amt = dollars(offers(v.value, [d])[0][1]);
    const rec = i === sug;
    return `<div class="offer${rec ? ' rec' : ''}"><span class="tag">${rec ? 'Suggested' : 'Offer'}</span><span class="div">÷ ${d}</span><b>${amt}</b></div>`;
  }).join('')}</div>`;
}
function savedList() {
  if (!draft || !draft.items.length) return '';
  return `<div class="list">${draft.items.map((it) => `<div class="crow simple"><span class="crow-main"><span class="crow-name">${esc(it.name || 'Item')}</span><span class="crow-meta">Market ${moneyOr(it.marketValue)}</span></span></div>`).join('')}</div>`;
}

function renderStart() {
  $('#view').innerHTML = `${appBar({ title: 'Price', sub: 'One batch, then a customer' })}
    <div class="pad">
      <div class="empty"><div class="empty-ico">${I.camera}</div><h2>Start a batch for this customer</h2><p>Price each item from eBay sold screenshots. Attach the customer when the batch is done.</p></div>
      <button type="button" class="btn block" id="start">Start batch</button>
    </div>`;
  $('#start').onclick = async () => { await startBatch(); render(); };
}

function renderPrice() {
  if (!draft && !S.editing) return renderStart();
  const { v, inc, cl } = valuation();
  const nSaved = draft ? draft.items.length : 0;
  const showEmpty = !S.rows.length && !S.busy;
  const urls = blobURLs(S.shots);
  const explain = !v ? '' : v.usedCluster
    ? `Median of ${v.clusterIdx.size} of ${inc.length} prices within ${dollars(settings.spread)}`
    : `Median of ${plural(inc.length, 'price')}`;
  const title = S.editing ? 'Edit item' : `Item ${nSaved + 1}`;
  const sub = S.editing ? (S.editing.name || 'Saved item') : (nSaved ? `Adding ${plural(nSaved, 'item')}` : 'New batch');
  const actions = S.editing
    ? `<div class="savebar"><button type="button" class="btn block" id="save" ${v ? '' : 'disabled'}>Update saved item</button></div>`
    : (v
      ? `<div class="savebar row"><button type="button" class="btn alt" id="next">Next item</button><button type="button" class="btn" id="done">Done</button></div>`
      : (nSaved ? `<div class="savebar"><button type="button" class="btn block" id="done">Done</button></div>` : ''));
  $('#view').innerHTML = `${appBar({ title, sub })}
    <div class="pad">
    ${S.editing ? `<div class="banner">Updating ${esc(S.editing.name || 'a saved item')}.</div>` : savedList()}
    <label class="btn block addshot">${I.camera}<span>${S.shots.length ? 'Add more screenshots' : 'Add screenshots'}</span><input id="file" type="file" accept="image/*" multiple hidden></label>
    ${S.busy ? `<p class="status" role="status">${esc(S.progress || 'Loading text recognition…')}</p><div class="bar" aria-hidden="true"><i></i></div>` : ''}
    ${S.msg ? `<p class="err" role="alert">${esc(S.msg)}</p>` : ''}
    ${thumbs(urls)}
    ${(S.shots.length || S.rows.length) ? `<p class="countline">${plural(S.shots.length, 'screenshot')} · ${plural(S.rows.length, 'price')}</p>` : ''}
    ${showEmpty ? `<div class="empty"><div class="empty-ico">${I.camera}</div><h2>Share or add eBay sold screenshots</h2><p>Sold prices stay on this phone. Offers show up as soon as a price is in.</p></div>` : ''}
    ${v ? `<section class="valuecard"><div class="label">Market value</div><div class="big" id="mv">${money(v.value)}</div><p class="explain">${esc(explain)}</p>${offerCards(v)}</section>` : ''}
    ${S.rows.length && !v ? `<section class="valuecard"><div class="label">Market value</div><p class="explain">Include at least one price.</p></section>` : ''}
    <div class="row manual"><input id="manual" type="number" inputmode="decimal" step="0.01" min="0" placeholder="Add price manually" aria-label="Add price manually"><button type="button" class="btn" id="add">Add</button></div>
    ${S.rows.length ? `<div class="legend"><span><i class="sw in"></i>In cluster</span><span><i class="sw out"></i>Other price</span><span><i class="sw off"></i>Excluded</span></div>
      <p class="hint">Tap a price to include or exclude it.</p>
      <div id="prices">${S.rows.map((r, i) => {
        const state = !r.included ? 'off' : cl.has(i) ? 'in' : 'out';
        const label = !r.included ? 'Excluded' : cl.has(i) ? 'In cluster' : 'Other';
        const ic = !r.included ? I.minus : cl.has(i) ? I.check : I.dot;
        return `<div class="price ${state}"><button type="button" class="price-main" data-p="${i}" aria-pressed="${r.included}"><span class="pstat">${ic}</span><span class="grow"><span class="amt">${money(r.price)}</span><span class="t">${esc(r.title)}</span></span><span class="pill">${label}</span></button>${r.manual ? `<button type="button" class="iconbtn danger-quiet" data-rm="${i}" aria-label="Remove manual price">${I.trash}</button>` : ''}</div>`;
      }).join('')}</div>
      <label class="field" style="margin-top:14px"><span>Item name</span><input id="name" type="text" placeholder="What is it?" value="${esc(S.name)}" autocomplete="off"></label>` : ''}
    </div>${actions}`;
  $('#file').onchange = (e) => importFiles(e.target.files);
  $('#add').onclick = () => { const p = parseFloat($('#manual').value); if (p > 0) { S.rows.push({ price: p, title: 'Manual', included: true, manual: true }); render(); } };
  $('#manual').onkeydown = (e) => { if (e.key === 'Enter') $('#add').click(); };
  $('#name')?.addEventListener('input', (e) => (S.name = e.target.value));
  $('#prices')?.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]'); if (rm) { S.rows.splice(+rm.dataset.rm, 1); return render(); }
    const row = e.target.closest('[data-p]'); if (row) { S.rows[+row.dataset.p].included = !S.rows[+row.dataset.p].included; render(); }
  });
  $('#save')?.addEventListener('click', async () => { if (saving) return; saving = true; try { await saveCurrentItem(); tab = 'history'; } finally { saving = false; render(); } });
  $('#next')?.addEventListener('click', async () => { if (saving) return; saving = true; try { await saveCurrentItem(); } finally { saving = false; render(); } });
  $('#done')?.addEventListener('click', async () => { if (saving) return; saving = true; try { if (valuation().v) await saveCurrentItem(); if (draft && draft.items.length) openPicker(); } finally { saving = false; render(); } });
}

async function openPicker() {
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  document.body.append(dlg);
  const close = () => { dlg.close(); dlg.remove(); };
  const customers = (await db.all('customers')).sort((a, b) => a.name.localeCompare(b.name));
  dlg.innerHTML = `<div class="grab"></div><h2>Who is this for?</h2>
    <p class="hint">${plural(draft.items.length, 'item')} · today</p>
    <label class="search">${I.search}<input id="cq" type="search" placeholder="Search customers" autocomplete="off"></label>
    <div class="list" id="plist"></div>
    <button type="button" class="btn alt block" id="newc">New customer</button>
    <form id="newform" hidden>
      <div class="row"><input id="nc" type="text" name="name" placeholder="Customer name" autocomplete="name" enterkeyhint="done" required>
      <button type="submit" class="btn compact" id="addc">Create</button></div>
      <p class="fielderr" id="nc-err" hidden>Enter a name.</p>
    </form>
    <button type="button" class="btn alt block" id="x">Not yet</button>`;
  const paint = (q) => {
    const list = filterCustomers(customers, q);
    dlg.querySelector('#plist').innerHTML = list.map((c) => `<button type="button" class="pick" data-c="${c.id}"><span class="avatar" style="background:${avatarColor(c.name)}">${esc(initials(c.name))}</span>${esc(c.name)}</button>`).join('') || '<p class="hint">No matching customers.</p>';
    dlg.querySelectorAll('[data-c]').forEach((b) => (b.onclick = async () => {
      const c = customers.find((x) => x.id === +b.dataset.c);
      close();
      await attachCustomer(c);
    }));
  };
  paint('');
  dlg.querySelector('#cq').oninput = (e) => paint(e.target.value);
  dlg.querySelector('#newc').onclick = () => { const f = dlg.querySelector('#newform'); f.hidden = false; dlg.querySelector('#nc').focus(); };
  dlg.querySelector('#newform').onsubmit = async (e) => {
    e.preventDefault();
    const n = new FormData(e.target).get('name').trim();
    const err = dlg.querySelector('#nc-err');
    if (!n) { err.hidden = false; return; }
    err.hidden = true;
    const id = await db.put('customers', { name: n, created: Date.now() });
    if (debug.enabled) debug.log('customer', { event: 'create', id, name: n });
    close();
    await attachCustomer({ id, name: n });
  };
  dlg.querySelector('#x').onclick = close;
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.showModal();
  if (debug.enabled) debug.log('batch', { event: 'picker', items: draft.items.length });
}

async function attachCustomer(c) {
  if (!draft || !c) return;
  const b = await db.get('batches', draft.id);
  b.customerId = c.id;
  b.date = Date.now();
  b.draft = false;
  await db.put('batches', b);
  if (debug.enabled) debug.log('batch', { event: 'attach', batchId: b.id, customerId: c.id, name: c.name, items: draft.items.length, date: b.date });
  hist = { day: dayKey(b.date), item: null };
  draft = null;
  clearSession();
  tab = 'history';
  render();
}

function itemGain(item) {
  const paid = finite(item.amountPaid) ? +item.amountPaid : 0;
  const basis = finite(item.resalePrice) ? +item.resalePrice : (finite(item.marketValue) ? +item.marketValue : 0);
  return basis - paid;
}

async function renderHistory(my) {
  const v = $('#view');
  const customers = await db.all('customers');
  const batches = await db.all('batches');
  const items = await db.all('items');
  if (my !== token) return;
  const days = buildHistory(customers, batches, items);
  if (hist.item) {
    const item = items.find((i) => i.id === hist.item) || hist.itemObj;
    if (!item) { hist.item = null; return renderHistory(my); }
    const shots = await db.by('shots', 'itemId', item.id);
    if (my !== token) return;
    const urls = blobURLs(shots.map((s) => s.blob));
    const divs = settings.divisors, sug = suggestedIndex(divs);
    const prices = item.prices || [];
    v.innerHTML = `${appBar({ title: item.name || 'Item', back: true })}
      <div class="pad">
      <section class="valuecard"><div class="label">Market value</div><div class="big">${moneyOr(item.marketValue)}</div>
        ${finite(item.marketValue) ? `<div class="chips">${divs.map((d, i) => `<button type="button" class="chip ${item.offerDivisor === d ? 'on' : ''}" data-d="${d}"><span class="chip-k">${i === sug ? 'Suggested · ' : ''}÷ ${d}</span><span class="chip-v">${dollars(offers(item.marketValue, [d])[0][1])}</span></button>`).join('')}</div>` : ''}
      </section>
      <div class="stack">
        <label class="field">Amount paid<span class="inputwrap"><input id="paid" type="number" inputmode="decimal" step="0.01" value="${item.amountPaid ?? ''}"><span class="unit">$</span></span></label>
        <label class="field">Resale / list price<span class="inputwrap"><input id="resale" type="number" inputmode="decimal" step="0.01" value="${finite(item.resalePrice ?? item.marketValue) ? Number(item.resalePrice ?? item.marketValue).toFixed(2) : ''}"><span class="unit">$</span></span></label>
        <div class="profitline" id="profitline"></div>
        <label class="field">Name<input id="iname" type="text" value="${esc(item.name || '')}"></label>
        <label class="field">Notes<textarea id="notes" rows="3">${esc(item.notes || '')}</textarea></label>
        <div class="minichips">${prices.map((p) => `<span class="minichip ${p.included ? '' : 'off'}">${money(p.price)}</span>`).join('')}</div>
        ${urls.length ? thumbs(urls) : ''}
        <button type="button" class="btn alt block" id="recheck">Re-check prices / add screenshots</button>
        <button type="button" class="linkdanger" id="idel">${I.trash} Delete item</button>
      </div></div>
      <div class="savebar"><button type="button" class="btn block" id="isave">Save item</button></div>`;
    let div = item.offerDivisor;
    const num = (id) => { const n = parseFloat(v.querySelector(id).value); return Number.isFinite(n) ? n : null; };
    const paintProfit = () => {
      const paid = num('#paid'), resale = num('#resale');
      const basis = resale == null ? (finite(item.marketValue) ? item.marketValue : null) : resale;
      if (paid == null && basis == null) { v.querySelector('#profitline').innerHTML = '<span class="muted">Enter paid and resale to see profit.</span>'; return; }
      const gain = (basis || 0) - (paid || 0);
      v.querySelector('#profitline').innerHTML = `<span class="profit ${gain > 0 ? 'up' : gain < 0 ? 'down' : ''}">${signedMoney(gain)} potential gain</span>`;
    };
    paintProfit();
    v.querySelector('#paid').oninput = paintProfit;
    v.querySelector('#resale').oninput = paintProfit;
    v.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => {
      div = +b.dataset.d;
      v.querySelector('#paid').value = offers(item.marketValue, [div])[0][1];
      v.querySelectorAll('[data-d]').forEach((x) => x.classList.toggle('on', x === b));
      paintProfit();
    }));
    v.querySelector('#isave').onclick = async () => {
      Object.assign(item, { name: v.querySelector('#iname').value || 'Item', notes: v.querySelector('#notes').value, amountPaid: num('#paid'), resalePrice: num('#resale'), offerDivisor: div });
      await db.put('items', item);
      hist.item = null;
      render();
    };
    v.querySelector('#recheck').onclick = () => {
      clearSession();
      S.editing = item; S.name = item.name || '';
      S.shots = shots.map((s) => s.blob);
      S.rows = (item.prices || []).map((p) => ({ ...p, title: p.title || 'saved' }));
      tab = 'price'; hist.item = null; render();
    };
    v.querySelector('#idel').onclick = async () => {
      if (await ask({ title: 'Delete this item?', body: 'The item and its screenshots are removed from this day.' })) {
        await delItem(item.id); hist.item = null; render();
      }
    };
    return;
  }
  if (hist.day) {
    const day = days.find((d) => d.key === hist.day);
    if (!day) { hist.day = null; return renderHistory(my); }
    v.innerHTML = `${appBar({ title: day.label, sub: `${signedMoney(day.spent)} spent · ${signedMoney(day.gain)} gain`, back: true })}
      <div class="pad">
      <label class="search">${I.search}<input id="q" type="search" placeholder="Search item or customer" autocomplete="off"></label>
      <div id="daylist"></div>
      <p class="hint" id="noq" hidden>No matching items.</p>
      </div>`;
    const paint = (q) => {
      const batchesShown = filterBatches(day.batches, q);
      v.querySelector('#daylist').innerHTML = batchesShown.map((b) => `<h2 class="batch-name">${esc(b.customerName)}</h2><div class="list">${b.items.map((x) => {
        const gain = itemGain(x);
        return `<button type="button" class="crow simple" data-i="${x.id}"><span class="crow-main"><span class="crow-name">${esc(x.name || 'Item')}</span><span class="crow-meta">Value ${moneyOr(x.marketValue)} · Paid ${moneyOr(x.amountPaid)} · Resale ${moneyOr(x.resalePrice)}</span><span class="profit ${gain > 0 ? 'up' : gain < 0 ? 'down' : ''}">${signedMoney(gain)} gain</span></span>${I.chev}</button>`;
      }).join('') || '<p class="hint">No items in this batch.</p>'}</div>`).join('');
      v.querySelector('#noq').hidden = batchesShown.length > 0;
      v.querySelectorAll('[data-i]').forEach((btn) => (btn.onclick = () => { hist.item = +btn.dataset.i; render(); }));
    };
    paint('');
    v.querySelector('#q').oninput = (e) => paint(e.target.value);
    return;
  }
  v.innerHTML = `${appBar({ title: 'History', sub: days.length ? plural(days.length, 'day') : 'By date', end: `<button type="button" class="iconbtn" id="csv" aria-label="Export CSV">${I.download}</button>` })}
    <div class="pad">
    ${days.length ? '' : '<div class="empty"><div class="empty-ico">$</div><h2>No batches yet</h2><p>Finish a batch and attach a customer. Days show what you spent and the potential gain.</p></div>'}
    <div class="list">${days.map((d) => `<button type="button" class="crow" data-day="${d.key}"><span class="crow-main"><span class="crow-name">${esc(d.label)}</span><span class="crow-meta">${plural(d.batches.length, 'batch')} · ${plural(d.itemCount, 'item')}</span></span><span class="crow-money"><span>Spent ${signedMoney(d.spent)}</span><span class="profit ${d.gain > 0 ? 'up' : d.gain < 0 ? 'down' : ''}">Gain ${signedMoney(d.gain)}</span></span></button>`).join('')}</div>
    </div>`;
  v.querySelectorAll('[data-day]').forEach((b) => (b.onclick = () => { hist.day = b.dataset.day; render(); }));
  v.querySelector('#csv').onclick = exportCsv;
}

export async function buildCsv() {
  const cs = new Map((await db.all('customers')).map((c) => [c.id, c]));
  const bs = new Map((await db.all('batches')).map((b) => [b.id, b]));
  const shots = await db.all('shots');
  const q = (s) => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  const rows = (await db.all('items')).map((i) => ({ i, b: bs.get(i.batchId) })).filter((x) => x.b && x.b.date && !x.b.draft).sort((a, b) => a.b.date - b.b.date || a.i.created - b.i.created);
  let out = 'customer,visit_date,item,notes,market_value,offer_divisor,amount_paid,resale_price,prices_included,prices_excluded,screenshots\n';
  for (const { i, b } of rows) {
    const prices = i.prices || [];
    out += [cs.get(b.customerId)?.name ?? '', fmtDate(b.date), i.name, i.notes || '', finite(i.marketValue) ? i.marketValue.toFixed(2) : '', i.offerDivisor ?? '', i.amountPaid ?? '',
      i.resalePrice != null ? Number(i.resalePrice).toFixed(2) : '', prices.filter((p) => p.included).map((p) => p.price.toFixed(2)).join(' '),
      prices.filter((p) => !p.included).map((p) => p.price.toFixed(2)).join(' '), shots.filter((s) => s.itemId === i.id).length].map((x) => q(String(x))).join(',') + '\n';
  }
  return out;
}
async function exportCsv() {
  const file = new File([await buildCsv()], 'pawnprice_items.csv', { type: 'text/csv' });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: 'PawnPrice items' }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: file.name });
  document.body.append(a); a.click(); a.remove();
}

function paintDivisors() {
  const divs = settings.divisors, sug = suggestedIndex(divs);
  const host = $('#divchips'); if (!host) return;
  host.innerHTML = divs.map((d, i) => `<span class="${i === sug ? 'sug' : ''}">÷ ${d}${i === sug ? ' · suggested' : ''}</span>`).join('');
}
function renderSettings() {
  $('#view').innerHTML = `${appBar({ title: 'Settings', sub: 'Stored on this phone' })}
    <div class="pad stack">
    <label class="field" id="spread-field"><span>Cluster spread</span>
      <span class="hint">Prices within this many dollars of each other count as one group.</span>
      <span class="inputwrap"><input id="sp" type="number" inputmode="decimal" min="0" step="1" value="${settings.spread}" aria-describedby="sp-err"><span class="unit">$</span></span>
      <span class="fielderr" id="sp-err" hidden>Enter 0 or a positive dollar amount.</span></label>
    <label class="field" id="div-field"><span>Offer divisors</span>
      <span class="hint">Comma-separated numbers greater than 0. Market value is divided by each. The one closest to 2.3 is marked Suggested.</span>
      <input id="dv" type="text" inputmode="decimal" autocomplete="off" value="${esc(settings.divisors.join(', '))}" aria-describedby="dv-err">
      <span class="fielderr" id="dv-err" hidden>Use numbers greater than 0, separated by commas. Example: 2, 2.3, 2.5</span>
      <span class="divchips" id="divchips"></span></label>
    <p class="note">All data stays on this device (IndexedDB). No accounts, no analytics. Text recognition runs in the browser and works offline after the first load.</p>
    </div>`;
  paintDivisors();
  $('#sp').oninput = (e) => {
    const raw = e.target.value.trim();
    const n = parseFloat(raw);
    const ok = raw !== '' && n >= 0;
    $('#spread-field').classList.toggle('bad', !ok);
    $('#sp-err').hidden = ok;
    e.target.setAttribute('aria-invalid', ok ? 'false' : 'true');
    if (ok) settings.spread = n;
  };
  $('#dv').oninput = (e) => {
    const list = parseDivisors(e.target.value);
    const ok = !!list;
    $('#div-field').classList.toggle('bad', !ok);
    $('#dv-err').hidden = ok;
    e.target.setAttribute('aria-invalid', ok ? 'false' : 'true');
    if (ok) { settings.divisors = list; paintDivisors(); }
  };
}

function hasActionBar() {
  if (tab === 'history' && hist.item) return true;
  if (tab !== 'price') return false;
  if (S.editing) return true;
  if (!draft) return false;
  return !!valuation().v || draft.items.length > 0;
}
function render() {
  const my = ++token;
  document.body.classList.toggle('has-save', hasActionBar());
  document.querySelectorAll('nav button').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  if (tab === 'price') renderPrice();
  else if (tab === 'settings') renderSettings();
  else renderHistory(my);
  const toggle = $('#pp-debug-toggle');
  if (toggle) toggle.onclick = () => { const p = $('#pp-debug-panel'); p.hidden = !p.hidden; if (!p.hidden) paintDebug(); };
}
document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => {
  tab = b.dataset.tab;
  if (tab === 'history') hist = { day: null, item: null };
  render();
}));
$('#view').addEventListener('click', (e) => {
  if (e.target.closest('#back')) { if (hist.item) hist.item = null; else hist.day = null; render(); }
});

function paintDebug() {
  const pre = $('#pp-debug-log'); if (!pre) return;
  const rows = JSON.parse(debug.dump());
  $('#pp-debug-count').textContent = `${rows.length} / ${LOG_CAP}`;
  pre.textContent = rows.slice(-30).map((r) => `${new Date(r.t).toLocaleTimeString()}  ${r.type}  ${JSON.stringify(r.data)}`).join('\n') || 'No entries yet.';
}
function mountDebugPanel() {
  if ($('#pp-debug-panel')) return;
  const panel = document.createElement('div');
  panel.id = 'pp-debug-panel';
  panel.hidden = true;
  panel.innerHTML = `<header>Debug <span id="pp-debug-count"></span></header><pre id="pp-debug-log"></pre>
    <div class="row"><button type="button" class="btn grow" id="pp-debug-export">Export JSON</button><button type="button" class="btn alt grow" id="pp-debug-clear">Clear</button></div>`;
  document.body.append(panel);
  panel.querySelector('#pp-debug-export').onclick = () => {
    const file = new File([debug.dump()], 'pawnprice-debug.json', { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: file.name });
    document.body.append(a); a.click(); a.remove();
  };
  panel.querySelector('#pp-debug-clear').onclick = () => { debug.clear(); paintDebug(); };
}
async function persistLog(entry, extra) {
  try {
    if (extra === 'clear') { await raw.clear('logs'); return; }
    if (entry) {
      const id = await raw.put('logs', { t: entry.t, type: entry.type, data: jsonSafe(entry.data) });
      entry.id = id;
    }
    if (Array.isArray(extra)) for (const old of extra) if (old && old.id) await raw.del('logs', old.id);
  } catch { /* keep the memory buffer; never send logs anywhere */ }
}
async function initDebug(enabled) {
  let initial = [];
  if (enabled) {
    try {
      const all = (await raw.all('logs')).sort((a, b) => a.id - b.id);
      for (const old of all.slice(0, Math.max(0, all.length - LOG_CAP))) await raw.del('logs', old.id);
      initial = all.slice(-LOG_CAP);
    } catch { initial = []; }
    mountDebugPanel();
  }
  debug = createDebug({ enabled, initial, persist: enabled ? persistLog : undefined, onLog: enabled ? () => { if ($('#pp-debug-panel') && !$('#pp-debug-panel').hidden) paintDebug(); } : undefined });
  if (enabled) debug.log('boot', { sw: SW_V });
}
function expose() {
  window.__pp = {
    buildCsv, importFiles, S,
    get debug() {
      return {
        dump: () => debug.dump(),
        clear: () => { debug.clear(); paintDebug(); },
        state: () => ({ ...debug.state(), sw: debug.enabled ? SW_V : undefined }),
      };
    },
  };
}
expose();
async function takeShared() {
  const n = +new URLSearchParams(location.search).get('shared'); if (!n) return;
  history.replaceState(null, '', location.pathname);
  const c = await caches.open('pp-shared'), files = [];
  for (let i = 0; i < n; i++) {
    const r = await c.match(`shared/${i}`);
    if (r) files.push(new File([await r.blob()], decodeURIComponent(r.headers.get('x-name') || '') || `shared-${i}.jpg`, { type: r.headers.get('content-type') || 'image/jpeg' }));
    await c.delete(`shared/${i}`);
  }
  importFiles(files);
}
async function boot() {
  await initDebug(debugOn);
  if (debug.enabled) {
    window.addEventListener('error', (e) => debug.log('error', { message: e.message, source: e.filename, line: e.lineno }));
    window.addEventListener('unhandledrejection', (e) => debug.log('rejection', { message: e.reason && e.reason.message ? e.reason.message : String(e.reason) }));
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      window.__swReady = true;
      if (debug.enabled) debug.log('sw', { version: SW_V, scope: reg.scope });
    }).catch((e) => { if (debug.enabled) debug.log('sw-error', { message: String(e) }); });
  }
  expose();
  try { draft = await loadDraft(); } catch (err) { if (debug.enabled) debug.log('idb-error', { op: 'load-draft', message: String(err) }); }
  render();
  takeShared();
}
boot();
