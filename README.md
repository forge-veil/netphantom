# NetPhantom

A Chrome DevTools extension that visualises every network request a page makes as a live force-directed graph, a geolocated world map, and a filterable request table — all inside the browser's own DevTools panel.

---

## Features

| Feature | Details |
|---|---|
| **Live force-graph** | Nodes = origins, edges = cross-origin calls. Orbitable in 3D, zoomable, draggable. |
| **World map** | Geolocates server IPs to country-level dots with arced edges from the page origin. Hover for hostname / request stats. Click to filter. |
| **Request table** | Filterable by type (Fetch/XHR, JS, CSS, Image, WS, …) and URL substring. Click any row to open the detail sidebar. |
| **Detail sidebar** | Per-request tabs: Params, Headers, Timing waterfall, TLS/SSL certificate info. |
| **AI Insights** | Flags anomalies: rate limits, slow endpoints, large payloads, high error rates. |
| **HAR export** | Exports all captured traffic as a standard `.har` file. |
| **Request mocking** | Intercept requests matching a URL pattern and return a custom response. |
| **Offline geolocation** | IP → country lookup uses a bundled DB-IP Lite binary (no external API calls). |
| **Session tabs** | Preserves traffic snapshots per page navigation; "Session" tab shows all. |

---

## Architecture

```
Browser tab
  └─ content/interceptor.js      wraps fetch / XHR / WebSocket; fires CONTENT_REQUEST

DevTools page (devtools/devtools.js)
  └─ chrome.devtools.network     listens for onRequestFinished + onNavigated
  └─ chrome.devtools.panels      creates the NetPhantom panel

Service worker (background/service-worker.js)
  ├─ chrome.webRequest           caches real HTTP status codes (fixes devtools status:0 bug)
  ├─ Ports: devtools-{tabId}     receives events from devtools.js; buffers up to 300
  │         panel-{tabId}        forwards buffered events on panel connect
  └─ Mock rules                  CHECK_MOCK / SET_MOCK / REMOVE_MOCK / GET_MOCKS

Panel (devtools/panel/)
  ├─ panel.js                    main controller: graph, map, table, sidebar, filters
  ├─ graph.js                    3D force-directed canvas renderer
  ├─ worldmap.js                 equirectangular canvas map with TopoJSON country fills
  ├─ geoip-data.js               generated offline IP→country lookup (see Build)
  └─ annotations.js              AI anomaly detection logic
```

### Dual capture path

Requests arrive from two independent sources and are merged by `panel.js`:

1. **DevTools API** (`devtools.js`) — full headers, timing, TLS details, server IP. Fires *after* the response body is loaded.
2. **Content script** (`interceptor.js`) — fires at the start of each request (real-time), before the DevTools event. Used for the live particle animation.

---

## Project structure

```
netphantom/
├── manifest.json
├── background/
│   └── service-worker.js
├── content/
│   └── interceptor.js
├── devtools/
│   ├── devtools.html
│   ├── devtools.js
│   └── panel/
│       ├── panel.html
│       ├── panel.css
│       ├── panel.js
│       ├── graph.js
│       ├── worldmap.js
│       ├── annotations.js
│       └── geoip-data.js          ← generated (see Build)
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── tools/
    └── build-geoip.js             ← regenerates geoip-data.js
```

---

## Installation

1. Clone or download this repo.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repo root.
5. Open DevTools on any tab (`F12`) → **NetPhantom** tab.

---

## Build

`geoip-data.js` is generated from the [DB-IP Lite](https://db-ip.com) country CSV (CC BY 4.0) and is committed to the repo so no build step is required for normal use.

To regenerate it (e.g. to refresh the IP database):

```bash
node tools/build-geoip.js
```

Requires Node.js. Downloads ~10 MB from jsDelivr, writes `devtools/panel/geoip-data.js` (~4 MB). The output is a self-contained IIFE that exposes `window.geoLookup(ip)` — a synchronous binary-search over a packed `Uint32Array`.

---

## Data & Privacy

- **No data leaves the browser.** All processing is local.
- **No remote geo API.** Server IPs are resolved offline using the bundled DB-IP Lite database (country-level precision). The previous geojs.io integration was removed for this reason.
- **Content script scope.** `interceptor.js` runs in the page's context and can read request URLs and response sizes. It sends these to the service worker via `chrome.runtime.sendMessage` — nothing is sent to any external server.

---

## Permissions

| Permission | Why |
|---|---|
| `webRequest` | Cache real HTTP status codes before the DevTools event fires. |
| `tabs` | Associate DevTools panels with the correct inspected tab. |
| `scripting` | Content script injection. |
| `declarativeNetRequest` | Used by the mock-response feature. |
| `storage` | Persist mock rules across sessions. |
| `host_permissions: <all_urls>` | Capture requests to any origin. |

---

## Attribution

- **DB-IP Lite** — IP geolocation data, [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/). Distributed via [ip-location-db](https://github.com/sapics/ip-location-db).
- **world-atlas** — TopoJSON country boundaries, [BSD 3-Clause](https://github.com/topojson/world-atlas/blob/master/LICENSE). Fetched from jsDelivr at runtime for the map background.
