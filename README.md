# PawnPrice

Offline pawn-shop pricing tool. It is a static PWA: screenshots are read in the browser with self-hosted Tesseract.js (`vendor/` and `lang/`), and prices are computed locally.

Start a batch, price each item, then attach a customer. History is grouped by date. Developer logging stays off unless `?debug=1` is used; see `DEBUG.md`.

Live site: https://pottersblack.github.io/pawn/
