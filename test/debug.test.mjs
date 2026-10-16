import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebug, LOG_CAP } from '../debug.js';

function spyConsole() {
  const calls = [];
  const orig = {};
  for (const k of ['log', 'info', 'debug', 'warn', 'error']) {
    orig[k] = console[k];
    console[k] = (...args) => calls.push([k, args]);
  }
  return {
    calls,
    restore() { Object.assign(console, orig); },
  };
}

test('logger is inert when the flag is off', () => {
  const side = { persist: 0, onLog: 0 };
  const spy = spyConsole();
  try {
    const dbg = createDebug({
      enabled: false,
      persist: () => { side.persist++; },
      onLog: () => { side.onLog++; },
    });
    dbg.log('ocr', { text: 'Sold widget $120' });
    dbg.log('idb', { op: 'put', store: 'customers' });
    dbg.clear();
    assert.equal(dbg.enabled, false);
    assert.equal(dbg.dump(), '[]');
    assert.deepEqual(dbg.state(), { enabled: false, count: 0, cap: LOG_CAP });
    assert.equal(side.persist, 0);
    assert.equal(side.onLog, 0);
    assert.deepEqual(spy.calls, []);
  } finally {
    spy.restore();
  }
});

test('logger keeps a capped JSON buffer and does not touch the console', () => {
  const seen = [];
  const spy = spyConsole();
  try {
    const dbg = createDebug({
      enabled: true,
      cap: 3,
      persist: (entry, extra) => seen.push([entry && entry.type, extra === 'clear' ? 'clear' : (extra || []).length]),
    });
    dbg.log('a', 1);
    dbg.log('b', 2);
    dbg.log('c', 3);
    dbg.log('d', 4);
    const rows = JSON.parse(dbg.dump());
    assert.deepEqual(rows.map((r) => r.type), ['b', 'c', 'd']);
    assert.equal(dbg.state().count, 3);
    dbg.clear();
    assert.equal(dbg.dump(), '[]');
    assert.equal(seen.at(-1)[1], 'clear');
    assert.deepEqual(spy.calls, []);
  } finally {
    spy.restore();
  }
});
