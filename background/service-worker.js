// NetPhantom Service Worker
// Routes messages between devtools pages and panel pages.
//
// Port naming convention:
//   devtools-{tabId}  opened by devtools.js
//   panel-{tabId}     opened by panel.js

// Per-tab connection state
const conns = new Map(); // tabId (number) -> { devtools: Port|null, panel: Port|null, buffer: [] }

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
