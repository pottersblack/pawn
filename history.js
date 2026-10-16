const finite = (n) => n != null && n !== '' && Number.isFinite(+n);

export function dayKey(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function labelForKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Spent is the sum of amount paid. Gain is resale minus paid, or market value minus paid when resale is missing.
export function summarizeItems(items) {
  let spent = 0, gain = 0;
  for (const item of items || []) {
    if (!item) continue;
    const paid = finite(item.amountPaid) ? +item.amountPaid : 0;
    const basis = finite(item.resalePrice) ? +item.resalePrice : (finite(item.marketValue) ? +item.marketValue : 0);
    spent += paid;
    gain += basis - paid;
  }
  return { spent, gain };
}

export function buildHistory(customers, batches, items) {
  const names = new Map((customers || []).map((c) => [c.id, c.name || 'Customer']));
  const byDay = new Map();
  for (const b of batches || []) {
    if (!b || b.draft || b.date == null || b.customerId == null) continue;
    const key = dayKey(b.date);
    if (!byDay.has(key)) byDay.set(key, { key, label: labelForKey(key), batches: [] });
    const its = (items || []).filter((i) => i.batchId === b.id).sort((a, c) => (a.created || 0) - (c.created || 0));
    byDay.get(key).batches.push({
      batchId: b.id,
      date: b.date,
      customerId: b.customerId,
      customerName: names.get(b.customerId) || 'Customer',
      items: its,
    });
  }
  const days = [...byDay.values()].sort((a, b) => b.key.localeCompare(a.key));
  for (const day of days) {
    day.batches.sort((a, b) => b.date - a.date);
    const totals = summarizeItems(day.batches.flatMap((b) => b.items));
    day.spent = totals.spent;
    day.gain = totals.gain;
    day.itemCount = day.batches.reduce((n, b) => n + b.items.length, 0);
  }
  return days;
}

export function filterBatches(batches, query) {
  const q = String(query || '').trim().toLowerCase();
  const copy = (batches || []).map((b) => ({ ...b, items: [...(b.items || [])] }));
  if (!q) return copy;
  return copy.map((b) => {
    if ((b.customerName || '').toLowerCase().includes(q)) return b;
    return { ...b, items: b.items.filter((i) => (i.name || '').toLowerCase().includes(q)) };
  }).filter((b) => b.items.length > 0 || (b.customerName || '').toLowerCase().includes(q));
}

export function filterCustomers(customers, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [...(customers || [])];
  return (customers || []).filter((c) => (c.name || '').toLowerCase().includes(q));
}
