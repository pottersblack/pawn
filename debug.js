export const LOG_CAP = 500;

// Inert unless enabled. Never writes to the console and never starts network calls.
export function createDebug({ enabled = false, initial = [], cap = LOG_CAP, persist, onLog } = {}) {
  const on = !!enabled;
  const buffer = on ? initial.slice(-cap) : [];
  function log(type, data) {
    if (!on) return;
    const entry = { t: Date.now(), type, data: data === undefined ? null : data };
    buffer.push(entry);
    const dropped = [];
    while (buffer.length > cap) dropped.push(buffer.shift());
    if (persist) persist(entry, dropped);
    if (onLog) onLog(entry);
  }
  return {
    enabled: on,
    log,
    dump() { return JSON.stringify(on ? buffer : []); },
    clear() {
      if (!on) return;
      buffer.length = 0;
      if (persist) persist(null, 'clear');
    },
    state() { return { enabled: on, count: on ? buffer.length : 0, cap }; },
  };
}
