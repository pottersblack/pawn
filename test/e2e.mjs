import test from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.gz': 'application/octet-stream',
  '.wasm': 'application/wasm',
};

function serve() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
    const path = join(root, rel === '' ? 'index.html' : rel);
    if (!path.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/` }));
  });
}

test('batch intake, date history, and hidden debug flag', async (t) => {
  let chromium;
  try {
    ({ chromium } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core'));
  } catch {
    t.skip('playwright-core is not installed');
    return;
  }
  const { server, base } = await serve();
  const outDir = process.env.PP_SHOTS || '';
  let browser;
  const errors = [];
  function fail(msg) { throw new Error(msg); }
  async function shot(page, name) {
    if (outDir) await page.screenshot({ path: `${outDir}/${name}.png` });
  }
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, colorScheme: 'light' });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.route('**/app.js', (r) => r.abort());
    await page.route('**/sw.js', (r) => r.abort());
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await new Promise((res, rej) => {
        const r = indexedDB.deleteDatabase('pawnprice');
        r.onsuccess = () => res();
        r.onerror = () => rej(r.error);
        r.onblocked = () => res();
      });
    });
    const seeded = await page.evaluate(() => new Promise((res, rej) => {
      const open = indexedDB.open('pawnprice', 1);
      open.onupgradeneeded = () => {
        const d = open.result;
        if (!d.objectStoreNames.contains('customers')) d.createObjectStore('customers', { keyPath: 'id', autoIncrement: true });
        if (!d.objectStoreNames.contains('batches')) d.createObjectStore('batches', { keyPath: 'id', autoIncrement: true }).createIndex('customerId', 'customerId');
        if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id', autoIncrement: true }).createIndex('batchId', 'batchId');
        if (!d.objectStoreNames.contains('shots')) d.createObjectStore('shots', { keyPath: 'id', autoIncrement: true }).createIndex('itemId', 'itemId');
      };
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['customers', 'batches', 'items'], 'readwrite');
        tx.objectStore('customers').put({ id: 1, name: 'Old Pat', created: Date.UTC(2026, 9, 1) });
        tx.objectStore('batches').put({ id: 1, customerId: 1, date: Date.UTC(2026, 9, 10, 15) });
        tx.objectStore('items').put({
          id: 1, batchId: 1, name: 'Legacy drill', notes: 'from v1', amountPaid: 20, offerDivisor: null,
          resalePrice: 50, marketValue: 40, created: Date.UTC(2026, 9, 10, 16),
          prices: [{ price: 40, included: true, title: 'drill' }],
        });
        tx.oncomplete = () => { db.close(); res('ok'); };
        tx.onerror = () => rej(tx.error);
      };
      open.onerror = () => rej(open.error);
    }));
    if (seeded !== 'ok') fail('seed ' + seeded);
    await page.unroute('**/app.js');
    await page.unroute('**/sw.js');
    await page.reload({ waitUntil: 'domcontentloaded' });
    errors.length = 0;
    await page.getByRole('button', { name: 'Start batch' }).waitFor();
    if (await page.locator('#pp-debug-toggle').count()) fail('debug visible while off');
    const off = await page.evaluate(() => window.__pp.debug.state());
    if (off.enabled) fail('debug enabled by default');
    if (await page.evaluate(() => window.__pp.debug.dump()) !== '[]') fail('dump not empty while off');
    await shot(page, 'step_start');

    await page.getByRole('button', { name: 'Start batch' }).click();
    await page.locator('#manual').fill('100');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.locator('#name').fill('Camera');
    await page.locator('#mv').waitFor();
    if (!(await page.locator('#mv').innerText()).includes('100')) fail('market value');
    if (!(await page.locator('.offer.rec').innerText()).toLowerCase().includes('suggested')) fail('no suggested offer');
    if (!(await page.getByText(/price to buy/i).count())) fail('buy price missing');
    if (!(await page.getByText('How this was calculated').count())) fail('breakdown missing');
    await shot(page, 'step_item_priced');

    await page.getByRole('button', { name: 'Next item' }).click();
    await page.getByText('Adding 1 item').first().waitFor();
    if (!(await page.locator('main').innerText()).includes('Camera')) fail('saved item missing');
    await shot(page, 'step_adding');

    await page.locator('#manual').fill('80');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.locator('#name').fill('Lens');
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('heading', { name: 'Who is this for?' }).waitFor();
    await page.locator('#cq').fill('pat');
    await page.getByRole('button', { name: 'Old Pat' }).waitFor();
    await page.locator('#cq').fill('zzz');
    if (await page.getByRole('button', { name: 'Old Pat' }).count()) fail('search did not hide Old Pat');
    await page.locator('#cq').fill('');
    await shot(page, 'step_picker');
    await page.getByRole('button', { name: 'New customer' }).click();
    await page.locator('#nc').fill('Ada');
    await page.locator('#nc').press('Enter');
    await page.getByText('$180.00 gain').waitFor();
    const dayText = await page.locator('main').innerText();
    if (!/ada/i.test(dayText) || !dayText.includes('Camera') || !dayText.includes('Lens') || !dayText.includes('$0.00')) fail('day totals\n' + dayText);
    await shot(page, 'step_day');
    await page.locator('#q').fill('lens');
    if (await page.getByRole('button', { name: /Camera/ }).count()) fail('item search kept Camera');
    await page.locator('#q').fill('');
    await page.getByRole('button', { name: /Lens/ }).click();
    await page.locator('#paid').waitFor();
    await shot(page, 'step_item');
    await page.locator('#paid').fill('40');
    await page.getByRole('button', { name: 'Save item' }).click();
    await page.getByText('Paid $40.00').waitFor();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('heading', { name: 'History' }).waitFor();
    const listText = await page.locator('main').innerText();
    if (!listText.includes('Spent $40.00') || !listText.includes('$140.00')) fail('date list totals\n' + listText);
    await shot(page, 'step_dates');
    const days = page.locator('[data-day]');
    if (await days.count() < 2) fail('legacy day missing from history');
    await days.nth(1).click();
    await page.getByText('Old Pat').waitFor();
    await page.getByText('Legacy drill').waitFor();
    const version = await page.evaluate(() => new Promise((res, rej) => {
      const r = indexedDB.open('pawnprice');
      r.onsuccess = () => { res({ v: r.result.version, stores: [...r.result.objectStoreNames] }); r.result.close(); };
      r.onerror = () => rej(r.error);
    }));
    if (version.v !== 2 || !version.stores.includes('logs') || !version.stores.includes('customers')) fail('migration ' + JSON.stringify(version));
    if (errors.length) fail('errors ' + errors.join('\n'));
    await context.close();

    const dark = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, colorScheme: 'dark' });
    const dpage = await dark.newPage();
    dpage.setDefaultTimeout(20000);
    const derrors = [];
    dpage.on('pageerror', (e) => derrors.push(String(e)));
    await dpage.goto(base + '?debug=1', { waitUntil: 'domcontentloaded' });
    try {
      await dpage.getByRole('button', { name: 'Start batch' }).waitFor();
    } catch (err) {
      const text = await dpage.locator('body').innerText().catch(() => '');
      fail('debug page missing Start batch\n' + text.slice(0, 500) + '\n' + derrors.join('\n') + '\n' + err.message);
    }
    const st = await dpage.evaluate(() => window.__pp.debug.state());
    if (!st.enabled || st.sw !== 'pp-v4') fail('debug state ' + JSON.stringify(st));
    await dpage.getByRole('button', { name: 'Start batch' }).click();
    await dpage.getByRole('button', { name: 'Debug' }).click();
    await dpage.getByRole('button', { name: 'Export JSON' }).waitFor();
    await shot(dpage, 'step_debug');
    const dump = JSON.parse(await dpage.evaluate(() => window.__pp.debug.dump()));
    if (!dump.some((e) => e.type === 'batch' && e.data && e.data.event === 'start')) fail('dump missing start ' + JSON.stringify(dump.map((e) => e.type)));
    await dpage.goto(base + '?debug=0', { waitUntil: 'domcontentloaded' });
    await dpage.getByRole('heading', { name: 'Item 1' }).waitFor();
    if (await dpage.locator('#pp-debug-panel').count()) fail('debug panel stayed mounted');
    if (await dpage.locator('#pp-debug-toggle').count()) fail('debug stayed on');
    if (await dpage.evaluate(() => window.__pp.debug.dump()) !== '[]') fail('dump after off');
    if ((await dpage.evaluate(() => window.__pp.debug.state())).enabled) fail('flag stayed on');
    await dark.close();
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
