# Contributing to NetPhantom

## Getting started

```bash
git clone https://github.com/forge-veil/netphantom.git
cd netphantom
node tools/build-geoip.js   # generate the bundled geo database
```

Load the extension in Chrome: `chrome://extensions` → Developer mode → Load unpacked → select the repo root.

## Project layout

```
background/       service worker — message routing, mock rules
content/          interceptor — wraps fetch / XHR / WebSocket
devtools/         devtools page (captures network events) + panel UI
  panel/
    panel.js      main controller
    graph.js      3D force-directed canvas renderer
    worldmap.js   equirectangular canvas map
    annotations.js  AI anomaly detection
tools/            build scripts (not shipped in the extension)
tests/            node:test unit tests
docs/             GitHub Pages site
```

## Making changes

The panel reloads when you edit source files — go to `chrome://extensions` and click the refresh icon on the NetPhantom card, then close and reopen DevTools.

Version cache-busters (e.g. `panel.js?v=45`) are in `panel.html`. Bump the number when you change a file so Chrome doesn't serve a stale cached version during development.

## Tests

```bash
make test
```

Tests cover `geoLookup` (binary search correctness) and `NetworkAnalyzer` (all anomaly-detection branches + HAR export). If you change either file, update the corresponding test.

## Geo database

`devtools/panel/geoip-data.js` is generated and gitignored. Regenerate it with:

```bash
node tools/build-geoip.js
```

Do not commit the generated file — CI builds it fresh from the DB-IP Lite source.

## Pull requests

- Keep PRs focused: one feature or fix per PR.
- Run `make test` before opening a PR.
- If you add a permission to `manifest.json`, explain why in the PR description. NetPhantom intentionally requests no host permissions — keep it that way.
- No new runtime dependencies — the extension ships with zero `node_modules`.

## Reporting bugs

Open an issue and include the Chrome version, the URL of the inspected page (if shareable), and the DevTools console output from the NetPhantom panel.
