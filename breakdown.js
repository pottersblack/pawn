import { value, offers } from './logic.js';

// Explains a priced item without changing valuation. Market value is the median of the
// chosen cluster (or a plain median when fewer than 3 prices qualify). Buy offers are
// that median divided by each divisor and rounded to the nearest dollar.
export function buildBreakdown(rows, spread = 40, divisors = [2, 2.3, 2.5]) {
  const list = (rows || []).map((r) => ({
    price: +r.price,
    title: r.title || '',
    included: r.included !== false,
  })).filter((r) => Number.isFinite(r.price));
  const includedAt = [];
  const prices = [];
  list.forEach((r, i) => {
    if (r.included) { includedAt.push(i); prices.push(r.price); }
  });
  const v = value(prices, spread);
  const cluster = new Set();
  if (v) for (const k of v.clusterIdx) cluster.add(includedAt[k]);
  const usedCluster = !!(v && v.usedCluster);
  const annotated = list.map((r, i) => {
    const inCluster = cluster.has(i);
    const status = !r.included ? 'excluded' : usedCluster ? (inCluster ? 'cluster' : 'left-out') : 'median';
    return { price: r.price, title: r.title, included: r.included, inCluster, status };
  });
  const marketValue = v ? v.value : null;
  const buy = marketValue == null ? [] : offers(marketValue, divisors).map(([divisor, amount]) => ({
    divisor,
    amount,
    quotient: marketValue / divisor,
  }));
  return {
    spread,
    marketValue,
    usedCluster,
    clusterCount: v ? v.clusterIdx.size : 0,
    includedCount: prices.length,
    prices: annotated,
    offers: buy,
  };
}
