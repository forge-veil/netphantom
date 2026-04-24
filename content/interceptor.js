// NetPhantom Content Script Interceptor
// Wraps fetch and XHR to capture real-time network events with page-level timing

(function () {
  'use strict';

  if (window.__netphantom_injected__) return;
  window.__netphantom_injected__ = true;

  let reqCounter = 0;

  function genId() {
    return `np-${Date.now()}-${++reqCounter}`;
  }

  function sendToBackground(data) {
    try {
      chrome.runtime.sendMessage({ type: 'CONTENT_REQUEST', data });
    } catch {}
  }

  async function checkMock(url) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'CHECK_MOCK', url });
      return res?.mock || null;
    } catch {
      return null;
    }
  }

  // ── Fetch wrapper ──────────────────────────────────────────────────────────

  const origFetch = window.fetch.bind(window);

  window.fetch = async function (input, init = {}) {
    const id = genId();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method || (input?.method) || 'GET').toUpperCase();
    const startTime = performance.now();

    sendToBackground({
      id, url, method,
      type: 'fetch',
      phase: 'start',
      timestamp: Date.now(),
    });

    // Check mock
    const mock = await checkMock(url);
    if (mock) {
      const duration = performance.now() - startTime;
      sendToBackground({
        id, url, method,
        type: 'fetch',
        phase: 'complete',
        status: mock.status || 200,
        statusText: mock.statusText || 'OK (mocked)',
        duration: Math.round(duration),
        size: JSON.stringify(mock.body || {}).length,
        mimeType: 'application/json',
        mocked: true,
        timestamp: Date.now(),
      });

      return new Response(JSON.stringify(mock.body), {
        status: mock.status || 200,
        statusText: mock.statusText || 'OK',
        headers: { 'Content-Type': 'application/json', ...mock.headers },
      });
    }

    try {
      const response = await origFetch(input, init);
      const duration = performance.now() - startTime;
      const clone = response.clone();

      clone.blob().then(blob => {
        sendToBackground({
          id, url, method,
          type: 'fetch',
          phase: 'complete',
          status: response.status,
          statusText: response.statusText,
          duration: Math.round(duration),
          size: blob.size,
          mimeType: response.headers.get('content-type') || 'unknown',
          timestamp: Date.now(),
        });
      }).catch(() => {
        sendToBackground({
          id, url, method,
          type: 'fetch',
          phase: 'complete',
          status: response.status,
          statusText: response.statusText,
          duration: Math.round(duration),
          size: -1,
          mimeType: response.headers.get('content-type') || 'unknown',
          timestamp: Date.now(),
        });
      });

      return response;
    } catch (err) {
      const duration = performance.now() - startTime;
      sendToBackground({
        id, url, method,
        type: 'fetch',
        phase: 'error',
        error: err.message,
        duration: Math.round(duration),
        timestamp: Date.now(),
      });
      throw err;
    }
  };

  // ── XHR wrapper ────────────────────────────────────────────────────────────

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__np_id__ = genId();
    this.__np_url__ = url;
    this.__np_method__ = method.toUpperCase();
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const id = this.__np_id__;
    const url = this.__np_url__;
    const method = this.__np_method__ || 'GET';
    const startTime = performance.now();

    sendToBackground({
      id, url, method,
      type: 'xhr',
      phase: 'start',
      timestamp: Date.now(),
    });

    this.addEventListener('loadend', () => {
      const duration = performance.now() - startTime;
      sendToBackground({
        id, url, method,
        type: 'xhr',
        phase: 'complete',
        status: this.status,
        statusText: this.statusText,
        duration: Math.round(duration),
        size: this.responseText?.length || 0,
        mimeType: this.getResponseHeader('content-type') || 'unknown',
        timestamp: Date.now(),
      });
    });

    this.addEventListener('error', () => {
      sendToBackground({
        id, url, method,
        type: 'xhr',
        phase: 'error',
        duration: Math.round(performance.now() - startTime),
        timestamp: Date.now(),
      });
    });

    return origSend.call(this, body);
  };

  // ── WebSocket tracker ──────────────────────────────────────────────────────

  const OrigWebSocket = window.WebSocket;

  window.WebSocket = function (url, protocols) {
    const ws = protocols ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
    const id = genId();

    sendToBackground({
      id, url,
      method: 'WS',
      type: 'websocket',
      phase: 'connect',
      timestamp: Date.now(),
    });

    ws.addEventListener('open', () => {
      sendToBackground({ id, url, method: 'WS', type: 'websocket', phase: 'open', timestamp: Date.now() });
    });

    ws.addEventListener('close', e => {
      sendToBackground({ id, url, method: 'WS', type: 'websocket', phase: 'close', code: e.code, timestamp: Date.now() });
    });

    ws.addEventListener('message', e => {
      sendToBackground({
        id, url, method: 'WS', type: 'websocket', phase: 'message',
        size: typeof e.data === 'string' ? e.data.length : e.data.byteLength || 0,
        timestamp: Date.now(),
      });
    });

    ws.addEventListener('error', () => {
      sendToBackground({ id, url, method: 'WS', type: 'websocket', phase: 'error', timestamp: Date.now() });
    });

    return ws;
  };

  window.WebSocket.prototype = OrigWebSocket.prototype;
  Object.defineProperties(window.WebSocket, Object.getOwnPropertyDescriptors(OrigWebSocket));
})();
