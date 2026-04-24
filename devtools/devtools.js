// NetPhantom DevTools Page
// Captures chrome.devtools.network events and forwards them to the service worker,
// which relays to the panel. Never touches panelWindow directly — avoids the
// cross-origin SecurityError that fires when the panel shows a chrome-error:// page.

const tabId = chrome.devtools.inspectedWindow.tabId;

// Long-lived port to service worker.
// Keeping it open prevents the SW from being terminated while DevTools is open.
let swPort = null;

function connectSW() {
  // If the extension was reloaded while DevTools was open, chrome.runtime APIs
  // throw "Extension context invalidated". Catch it and stop — there's no recovery
  // until the user closes and reopens DevTools.
  try {
    swPort = chrome.runtime.connect({ name: `devtools-${tabId}` });
  } catch (e) {
    return; // context gone — do not schedule a retry
  }

  swPort.onDisconnect.addListener(() => {
    swPort = null;
    // chrome.runtime.lastError is set when the disconnect was caused by the
    // extension being reloaded/unloaded. In that case retrying is pointless.
    const err = chrome.runtime.lastError?.message ?? '';
    if (err.includes('invalidated') || err.includes('unloaded')) return;
    setTimeout(connectSW, 200);
  });
}
connectSW();

// Immediately tell the panel what page is already open.
// chrome.devtools.inspectedWindow is guaranteed available in devtools.js (the
// DevTools page context). The panel itself may not have it, so we do it here
// and route the result through the SW → panel pipeline.
chrome.devtools.inspectedWindow.eval('location.href', (result, isException) => {
  if (!isException && result) {
    swPort?.postMessage({ type: 'INIT_URL', tabId, url: result });
  }
});

// Both paths are relative to the extension ROOT (not the devtools page directory).
// Our panel is at devtools/panel/panel.html; icons are at icons/icon16.png.
chrome.devtools.panels.create('NetPhantom', 'icons/icon16.png', 'devtools/panel/panel.html');

// ── SSL cache ──────────────────────────────────────────────────────────────────
// Chrome only provides _securityDetails when a new TLS handshake occurs (the very
// first connection to a host). HTTP/2 and HTTP/3 multiplex all subsequent requests
// over the same session — those entries have _securityDetails === null/undefined.
// We cache the details the first time we see them so all later requests for the
// same host can reuse the certificate information.
const sslCache = Object.create(null); // host → ssl object

// ── Forward DevTools network events → SW → panel ──────────────────────────────

chrome.devtools.network.onRequestFinished.addListener(entry => {
  const req = entry.request;
  const res = entry.response;

  let host = null;
  try { host = new URL(req.url).host; } catch {}

  // Build the ssl object from _securityDetails (Chrome HAR extension).
  // Fall back to the per-host cache for session-resumed connections.
  let ssl = null;
  const sd = entry._securityDetails ?? entry.response?._securityDetails;
  if (sd && (sd.protocol || sd.subjectName || sd.issuer || sd.cipher)) {
    ssl = {
      protocol:         sd.protocol         || null,
      cipher:           sd.cipher           || null,
      keyExchange:      sd.keyExchange       || null,
      keyExchangeGroup: sd.keyExchangeGroup  || null,
      subjectName:      sd.subjectName       || null,
      issuer:           sd.issuer            || null,
      validFrom:        sd.validFrom         ?? null,
      validTo:          sd.validTo           ?? null,
      sanList:          sd.sanList           || [],
      isEV:             sd.isEV              || false,
      ct:               sd.certificateTransparencyCompliance || null,
    };
    if (host) sslCache[host] = ssl;   // prime cache for future requests
  } else if (host && sslCache[host]) {
    ssl = sslCache[host];             // reuse cached handshake data
  }

  // Omit the raw _har entry (contains circular refs that break structured-clone).
  // The panel reconstructs HAR from the fields we pass.
  const data = {
    source:          'devtools',
    id:              `dv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    url:             req.url,
    method:          req.method,
    status:          res.status,
    statusText:      res.statusText,
    duration:        Math.round(entry.time),
    size:            res.bodySize > 0 ? res.bodySize : (res.content?.size ?? 0),
    mimeType:        res.content?.mimeType
                       || res.headers?.find(h => h.name.toLowerCase() === 'content-type')?.value
                       || '',
    type:            inferType(req.url, res.content?.mimeType || ''),
    timestamp:       new Date(entry.startedDateTime).getTime(),
    requestHeaders:  req.headers,
    responseHeaders: res.headers,
    postData:        req.postData ?? null,
    error:           entry._error ?? null,
    timings:         entry.timings,
    isHttps:         req.url.startsWith('https://') || req.url.startsWith('wss://'),
    ssl,
    serverIP:        entry.serverIPAddress || null,
  };

  swPort?.postMessage({ type: 'NETWORK_DATA', tabId, data });
});

// Let the panel clear the graph when the user navigates to a new page.
// Keep the SSL cache — certificate data is stable across navigations for
// the same host and reduces the window where cert data is missing.
chrome.devtools.network.onNavigated.addListener(url => {
  swPort?.postMessage({ type: 'NAVIGATED', tabId, url });
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function inferType(url, mimeType) {
  if (url.startsWith('ws://') || url.startsWith('wss://')) return 'websocket';
  if (mimeType.includes('json'))       return 'fetch';
  if (mimeType.includes('javascript')) return 'script';
  if (mimeType.includes('css'))        return 'stylesheet';
  if (mimeType.includes('image'))      return 'image';
  if (mimeType.includes('font'))       return 'font';
  if (mimeType.includes('html'))       return 'document';
  return 'other';
}
