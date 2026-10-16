import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistory, summarizeItems, filterBatches, filterCustomers, dayKey } from '../history.js';

test('date totals use paid, and market value when resale is missing', () => {
  const totals = summarizeItems([
    { amountPaid: 80, resalePrice: null, marketValue: 200 },
    { amountPaid: 40, resalePrice: 90, marketValue: 100 },
    { amountPaid: null, resalePrice: null, marketValue: 50 },
  ]);
  assert.equal(totals.spent, 120);
  assert.equal(totals.gain, (200 - 80) + (90 - 40) + (50 - 0));
});

test('history groups by local date, newest first, and skips drafts', () => {
  const older = Date.UTC(2026, 9, 10, 15);
  const newer = Date.UTC(2026, 9, 16, 15);
  const days = buildHistory(
    [{ id: 1, name: 'Ada' }, { id: 2, name: 'Bea' }],
    [
      { id: 10, customerId: 1, date: older, draft: false },
      { id: 11, customerId: 2, date: newer, draft: false },
      { id: 12, customerId: null, date: null, draft: true },
    ],
    [
      { id: 1, batchId: 10, name: 'Drill', amountPaid: 20, resalePrice: 50, marketValue: 40, created: 1 },
      { id: 2, batchId: 11, name: 'Camera', amountPaid: null, resalePrice: null, marketValue: 100, created: 1 },
      { id: 3, batchId: 11, name: 'Lens', amountPaid: 10, resalePrice: 30, marketValue: 25, created: 2 },
      { id: 4, batchId: 12, name: 'Unsaved', amountPaid: 5, resalePrice: 5, marketValue: 5, created: 1 },
    ],
  );
  assert.deepEqual(days.map((d) => d.key), [dayKey(newer), dayKey(older)]);
  assert.equal(days[0].itemCount, 2);
  assert.equal(days[0].spent, 10);
  assert.equal(days[0].gain, (100 - 0) + (30 - 10));
  assert.equal(days[1].spent, 20);
  assert.equal(days[1].gain, 30);
  assert.equal(days[0].batches[0].customerName, 'Bea');
  assert.ok(!JSON.stringify(days).includes('Unsaved'));
});

test('day search filters by item name or customer name', () => {
  const batches = [
    { batchId: 1, customerName: 'Ada', items: [{ name: 'Camera' }, { name: 'Lens' }] },
    { batchId: 2, customerName: 'Bea', items: [{ name: 'Drill' }] },
  ];
  assert.equal(filterBatches(batches, '  ').length, 2);
  assert.deepEqual(filterBatches(batches, 'len').map((b) => b.items.map((i) => i.name)), [['Lens']]);
  assert.deepEqual(filterBatches(batches, 'ADA').map((b) => b.items.map((i) => i.name)), [['Camera', 'Lens']]);
  assert.equal(filterBatches(batches, 'nope').length, 0);
  assert.deepEqual(filterCustomers([{ name: 'Ada' }, { name: 'Bea' }], 'be').map((c) => c.name), ['Bea']);
});
