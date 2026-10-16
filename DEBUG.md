# Debug mode

Debug mode is for developers and agents. Shop staff never see it unless someone turns it on in the address bar.

## Turn it on or off

Open the app once with a query param:

- On: `https://pottersblack.github.io/pawn/?debug=1`
- Off: `https://pottersblack.github.io/pawn/?debug=0`

The flag is stored on this device in `localStorage` under `pp_debug`. The param is removed from the address bar after it is read. Leave the flag off for normal use.

## When the flag is off

There is no debug panel, no console output from the app, no logging, and no network calls added for diagnostics. `window.__pp.debug.dump()` returns `[]`.

## When the flag is on

A **Debug** button appears in the app bar. It opens a small floating panel with the latest log lines, **Export JSON** (a file download on this device), and **Clear**.

The log is a ring buffer of about 500 entries, kept in memory and in an IndexedDB store named `logs` inside the existing `pawnprice` database. Nothing is sent off the device.

Entries include:

- OCR raw text and parsed prices
- Clustering inputs and outputs
- Batch and customer transitions
- IndexedDB writes and errors
- Service worker version
- `window.onerror` and unhandled promise rejections

## Console API

```js
window.__pp.debug.state()  // { enabled, count, cap, sw? }
window.__pp.debug.dump()   // JSON string of the buffer
window.__pp.debug.clear()
```

`dump()` is the same JSON the panel exports.
