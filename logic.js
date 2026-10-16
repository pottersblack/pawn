// Exact port of PriceParser / Valuer from the Kotlin app.
const PRICE = /(?<![\w.])\+?\s?(?:US\s?)?\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?(?!\d)/g;
const SOLD = /^\s*sold\s+([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/i;
const EXCLUDE_LINE = /(deliver|shipping|postage|\bship\b|\+\s?\$|\bwas\b|list price|original price|previous price|\bto\s+\$|\$[\d.,]+\s*(-|to)\s*\$|coupon|\boff\b|save\s|tax|import|\/ea|each|watching|bids?\b|\bfree\b)/i;
const NOISE_ONLY = /^\s*(or best offer|best offer accepted|buy it now|auction|pre-owned|brand new|new|used|open box|for parts.*|sponsored|.{0,3})\s*$/i;
// A line that is only a price (eBay's big sold price). OCR junk from product photos like "$7 mm! 1050 Ti" is not.
const STANDALONE = /^\s*(?:US\s?)?\$\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?\s*$/i;
const hasPrice = (s) => new RegExp(PRICE.source).test(s);

export function parseAmount(s) {
  const m = new RegExp(PRICE.source).exec(s); if (!m) return null;
  const whole = Number(m[1].replace(/,/g, '')); if (Number.isNaN(whole)) return null;
  return whole + (m[2] ? Number(m[2]) / 100 : 0);
}

export function pricesOnLine(line) {
  if (EXCLUDE_LINE.test(line)) return [];
  return [...line.matchAll(PRICE)].filter((m) => !m[0].trimStart().startsWith('+'))
    .map((m) => parseAmount(m[0])).filter((v) => v != null && v >= 0.5 && v <= 1_000_000);
}

const makeKey = (title, date, p) => title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 40) + '|' + date.toLowerCase() + '|' + p.toFixed(2);

export function parseScreenshot(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  if (lines.some((l) => SOLD.test(l))) {
    let i = 0;
    while (i < lines.length) {
      const m = SOLD.exec(lines[i]); if (!m) { i++; continue; }
      const date = m[1].replace(/\s+/g, ' ').replace(/,/g, '');
      let j = i + 1, title = '', price = null, loose = null;
      while (j < lines.length && !SOLD.test(lines[j])) {
        const l = lines[j];
        if (price == null) { const ps = pricesOnLine(l); if (ps.length) { if (STANDALONE.test(l)) price = ps[0]; else loose ??= ps[0]; } }
        if (!title && price == null && loose == null && !hasPrice(l) && !NOISE_ONLY.test(l) && l.length >= 6) title = l;
        j++;
      }
      price ??= loose;
      if (price != null) out.push({ price, title, soldDate: date, key: makeKey(title, date, price) });
      i = j;
    }
  } else {
    let last = '';
    for (const l of lines) {
      const ps = pricesOnLine(l);
      if (ps.length) out.push({ price: ps[0], title: last, soldDate: '', key: makeKey(last, '', ps[0]) });
      else if (!hasPrice(l) && !NOISE_ONLY.test(l) && l.length >= 6) last = l;
    }
  }
  return out;
}

export function mergeScreenshots(perShot) {
  const seen = new Map(), out = [];
  for (const shot of perShot) {
    const counts = new Map(); for (const l of shot) counts.set(l.key, (counts.get(l.key) || 0) + 1);
    for (const [k, c] of counts) {
      const already = seen.get(k) || 0;
      if (c > already) { const first = shot.find((l) => l.key === k); for (let n = 0; n < c - already; n++) out.push(first); seen.set(k, c); }
    }
  }
  return out;
}

export function median(xs) {
  if (!xs.length) throw new Error('empty'); const s = [...xs].sort((a, b) => a - b), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

export function value(prices, spread = 40) {
  if (!prices.length) return null;
  if (prices.length < 3) return { value: median(prices), clusterIdx: new Set(prices.map((_, i) => i)), usedCluster: false };
  const order = prices.map((_, i) => i).sort((a, b) => prices[a] - prices[b] || a - b);
  const s = order.map((i) => prices[i]);
  let bL = 0, bR = 0, l = 0;
  for (let r = 0; r < s.length; r++) {
    while (s[r] - s[l] > spread + 1e-9) l++;
    const size = r - l + 1, bsize = bR - bL + 1;
    if (size > bsize || (size === bsize && s[r] - s[l] < s[bR] - s[bL] - 1e-9)) { bL = l; bR = r; }
  }
  const idx = new Set(); for (let k = bL; k <= bR; k++) idx.add(order[k]);
  return { value: median([...idx].map((i) => prices[i])), clusterIdx: idx, usedCluster: true };
}

// Kotlin Math.round: floor(x + 0.5)
export const offers = (v, divisors) => divisors.map((d) => [d, Math.floor(v / d + 0.5)]);
