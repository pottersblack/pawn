import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBreakdown } from '../breakdown.js';

test('breakdown separates the cluster from prices left outside the spread', () => {
  const b = buildBreakdown([
    { price: 60, included: true, title: 'a' },
    { price: 70, included: true, title: 'b' },
    { price: 80, included: true, title: 'c' },
    { price: 200, included: true, title: 'd' },
    { price: 15, included: false, title: 'e' },
  ], 40, [2, 2.3, 2.5]);
  assert.equal(b.marketValue, 70);
  assert.equal(b.usedCluster, true);
  assert.equal(b.clusterCount, 3);
  assert.equal(b.spread, 40);
  assert.deepEqual(b.prices.map((p) => p.status), ['cluster', 'cluster', 'cluster', 'left-out', 'excluded']);
  assert.deepEqual(b.offers.map((o) => [o.divisor, o.amount]), [[2, 35], [2.3, 30], [2.5, 28]]);
  assert.ok(Math.abs(b.offers[1].quotient - 70 / 2.3) < 1e-9);
});

test('fewer than three prices stay a plain median and still produce buy offers', () => {
  const b = buildBreakdown([
    { price: 80, included: true },
    { price: 90, included: true },
  ], 40, [2, 2.3, 2.5]);
  assert.equal(b.usedCluster, false);
  assert.equal(b.marketValue, 85);
  assert.deepEqual(b.prices.map((p) => p.status), ['median', 'median']);
  assert.deepEqual(b.offers.map((o) => o.amount), [43, 37, 34]);
});

test('no included price has no market value and no buy offers', () => {
  const b = buildBreakdown([{ price: 40, included: false }], 40, [2, 2.3, 2.5]);
  assert.equal(b.marketValue, null);
  assert.deepEqual(b.offers, []);
  assert.equal(b.prices[0].status, 'excluded');
});
