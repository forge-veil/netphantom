// NetPhantom Service Worker
// Routes messages between devtools pages and panel pages; manages mock rules.
//
// Port naming convention:
//   devtools-{tabId}  opened by devtools.js
//   panel-{tabId}     opened by panel.js

const mockRules = new Map();
let nextRuleId = 1;

// Per-tab connection state
const conns = new Map(); // tabId (number) -> { devtools: Port|null, panel: Port|null, buffer: [] }

// ── webRequest status cache ───────────────────────────────────────────────────
// chrome.devtools.network.onRequestFinished reports status:0 for CORS-blocked and
// some other request types even though the server sent a real HTTP status code.
// chrome.webRequest.onCompleted fires earlier (on response headers) and always has
// the real statusCode. We cache it here and patch devtools entries before forwarding.
const webReqCache = new Map(); // `${tabId}|${method}|${url}` → statusCode

chrome.webRequest.onCompleted.addListener(
  details => {
    if (details.tabId < 0) return; // extension / background requests
    const key = `${details.tabId}|${details.method}|${details.url}`;
    webReqCache.set(key, details.statusCode);
    // Entries are consumed on first match; drop strays after 15 s
    setTimeout(() => webReqCache.delete(key), 15_000);
  },
  { urls: ['<all_urls>'] }
);

function getConn(tabId) {
  if (!conns.has(tabId)) conns.set(tabId, { devtools: null, panel: null, buffer: [] });
  return conns.get(tabId);
}

// ── Port management ───────────────────────────────────────────────────────────

chrome.runtime.onConnect.addListener(port => {
  if (port.name.startsWith('devtools-')) {
    const tabId = parseInt(port.name.slice('devtools-'.length), 10);
    const conn  = getConn(tabId);
    conn.devtools = port;

    port.onMessage.addListener(msg => {
      if (msg.type === 'NETWORK_DATA' || msg.type === 'NAVIGATED' || msg.type === 'INIT_URL') {
        // Patch status:0 on devtools entries using the webRequest cache.
        // onCompleted fires on response headers (before body load), so the cache
        // is already populated by the time onRequestFinished triggers this message.
        if (msg.type === 'NETWORK_DATA' && msg.data?.source === 'devtools' && !msg.data.status) {
          const key = `${tabId}|${msg.data.method}|${msg.data.url}`;
          const real = webReqCache.get(key);
          if (real > 0) {
            msg = { ...msg, data: { ...msg.data, status: real } };
            webReqCache.delete(key);
          }
        }
        if (conn.panel) {
          conn.panel.postMessage(msg);
        } else {
          // Panel not open yet — buffer up to 300 events
          if (conn.buffer.length < 300) conn.buffer.push(msg);
        }
      }
    });

    port.onDisconnect.addListener(() => {
      conn.devtools = null;
      // Clean up if both sides gone
      if (!conn.panel) conns.delete(tabId);
    });

  } else if (port.name.startsWith('panel-')) {
    const tabId = parseInt(port.name.slice('panel-'.length), 10);
    const conn  = getConn(tabId);
    conn.panel  = port;

    // Flush buffered events immediately
    for (const msg of conn.buffer) port.postMessage(msg);
    conn.buffer = [];

    port.onDisconnect.addListener(() => {
      conn.panel = null;
      if (!conn.devtools) conns.delete(tabId);
    });
  }
});

// ── one-shot messages (mock CRUD, content-script relay) ───────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    case 'CONTENT_REQUEST': {
      // Content script intercepted a request — forward to the panel for that tab
      const tabId = sender.tab?.id;
      if (tabId != null) {
        const conn = conns.get(tabId);
        const msg  = { type: 'NETWORK_DATA', tabId, data: { source: 'content', ...message.data } };
        if (conn?.panel) {
          conn.panel.postMessage(msg);
        } else if (conn) {
          if (conn.buffer.length < 300) conn.buffer.push(msg);
        }
      }
      sendResponse({ ok: true });
      return true;
    }

    case 'CHECK_MOCK':
      sendResponse({ mock: findMock(message.url) });
      return true;

    case 'SET_MOCK':
      sendResponse({ ok: true, id: saveMock(message.rule).id });
      return true;

    case 'REMOVE_MOCK':
      removeMock(message.id);
      sendResponse({ ok: true });
      return true;

    case 'GET_MOCKS':
      sendResponse({ mocks: getAllMocks() });
      return true;
  }
});

// ── Mock helpers ──────────────────────────────────────────────────────────────

function saveMock(rule) {
  const id    = nextRuleId++;
  const entry = { id, ...rule, createdAt: Date.now() };
  mockRules.set(id, entry);
  return entry;
}

function findMock(url) {
  for (const rule of mockRules.values()) {
    try {
      if (rule.urlPattern && new RegExp(rule.urlPattern).test(url)) return rule;
      if (rule.exactUrl   && rule.exactUrl === url)                  return rule;
    } catch {}
  }
  return null;
}

function removeMock(id)  { mockRules.delete(id); }
function getAllMocks()    { return Array.from(mockRules.values()); }
