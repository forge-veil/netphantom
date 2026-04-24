'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));

// NetworkAnalyzer is a plain class. vm.runInThisContext runs it as a top-level
// script so the class declaration lands on the global scope (unlike eval in ESM
// where class declarations are block-scoped to the eval call).
const src = readFileSync(join(__dirname, '../devtools/panel/annotations.js'), 'utf8');
vm.runInThisContext(src);

// ── helpers ───────────────────────────────────────────────────────────────────

function makeNode(overrides = {}) {
  return {
    id:            'example.com',
    label:         'example.com',
    kind:          'domain',
    requestCount:  1,
    totalDuration: 200,
    serverErrors:  0,
    clientErrors:  0,
    hasWS:         false,
    requests:      [],
    ...overrides,
  };
}

function analyze(nodeList) {
  const map = new Map(nodeList.map(n => [n.id, n]));
  return new NetworkAnalyzer().analyze(map);
}

function severities(insights) {
  return insights.map(i => i.severity);
}

// ── slow endpoint ─────────────────────────────────────────────────────────────

test('no insight when avg < 2000 ms', () => {
  const ins = analyze([makeNode({ totalDuration: 1999, requestCount: 1 })]);
  assert.equal(ins.filter(i => i.icon === '⚡').length, 0);
});

test('slow endpoint insight when avg > 2000 ms', () => {
  const ins = analyze([makeNode({ totalDuration: 6000, requestCount: 2 })]);
  const slow = ins.find(i => i.icon === '⚡');
  assert.ok(slow, 'expected slow-endpoint insight');
  assert.equal(slow.severity, 'warning');
  assert.match(slow.detail, /3000ms/);
});

test('slow insight detail shows request count', () => {
  const ins = analyze([makeNode({ totalDuration: 9000, requestCount: 3 })]);
  const slow = ins.find(i => i.icon === '⚡');
  assert.match(slow.detail, /3 requests/);
});

test('single slow request uses singular "request"', () => {
  const ins = analyze([makeNode({ totalDuration: 5000, requestCount: 1 })]);
  const slow = ins.find(i => i.icon === '⚡');
  assert.match(slow.detail, /1 request[^s]/);
});

// ── server errors ─────────────────────────────────────────────────────────────

test('no insight when error rate ≤ 30%', () => {
  const ins = analyze([makeNode({ serverErrors: 1, requestCount: 4 })]);  // 25%
  assert.equal(ins.filter(i => i.icon === '🔴').length, 0);
});

test('server error insight when rate > 30%', () => {
  const ins = analyze([makeNode({ serverErrors: 2, clientErrors: 0, requestCount: 4 })]);  // 50%
  const err = ins.find(i => i.icon === '🔴');
  assert.ok(err, 'expected server-error insight');
  assert.equal(err.severity, 'error');
  assert.match(err.detail, /50%/);
});

test('no server error insight when serverErrors is 0', () => {
  const ins = analyze([makeNode({ serverErrors: 0, requestCount: 1 })]);
  assert.equal(ins.filter(i => i.icon === '🔴').length, 0);
});

// ── rate limiting ─────────────────────────────────────────────────────────────

test('no rate-limit insight when no 429s', () => {
  const node = makeNode({ requests: [{ status: 200 }, { status: 404 }] });
  const ins  = analyze([node]);
  assert.equal(ins.filter(i => i.icon === '🚦').length, 0);
});

test('rate-limit insight on 429 response', () => {
  const node = makeNode({ requests: [{ status: 429 }] });
  const ins  = analyze([node]);
  const rl   = ins.find(i => i.icon === '🚦');
  assert.ok(rl, 'expected rate-limit insight');
  assert.equal(rl.severity, 'warning');
  assert.match(rl.detail, /429/);
});

// ── client errors ─────────────────────────────────────────────────────────────

test('no client-error insight for ≤ 2 errors', () => {
  const node = makeNode({ requests: [{ status: 401 }, { status: 403 }] });
  const ins  = analyze([node]);
  assert.equal(ins.filter(i => i.icon === '⚠️').length, 0);
});

test('client-error insight when > 2 non-429 4xx responses', () => {
  const node = makeNode({
    requests: [{ status: 401 }, { status: 403 }, { status: 404 }],
  });
  const ins = analyze([node]);
  const ce  = ins.find(i => i.icon === '⚠️');
  assert.ok(ce, 'expected client-error insight');
  assert.equal(ce.severity, 'info');
  assert.match(ce.detail, /3 4xx/);
});

test('429s are not counted as generic client errors', () => {
  const node = makeNode({
    requests: [{ status: 429 }, { status: 429 }, { status: 429 }],
  });
  const ins = analyze([node]);
  assert.equal(ins.filter(i => i.icon === '⚠️').length, 0);
});

// ── large responses ───────────────────────────────────────────────────────────

test('no large-response insight below 1 MB', () => {
  const node = makeNode({ requests: [{ size: 999_999 }] });
  const ins  = analyze([node]);
  assert.equal(ins.filter(i => i.icon === '📦').length, 0);
});

test('large-response insight above 1 MB', () => {
  const node = makeNode({ requests: [{ size: 2_500_000 }] });
  const ins  = analyze([node]);
  const lg   = ins.find(i => i.icon === '📦');
  assert.ok(lg, 'expected large-response insight');
  assert.equal(lg.severity, 'info');
  assert.match(lg.detail, /2441 KB/);
});

test('large-response detail shows the maximum size', () => {
  const node = makeNode({ requests: [{ size: 1_100_000 }, { size: 3_000_000 }] });
  const ins  = analyze([node]);
  const lg   = ins.find(i => i.icon === '📦');
  const expectedKB = Math.round(3_000_000 / 1024);
  assert.match(lg.detail, new RegExp(`${expectedKB} KB`));
});

// ── high traffic ──────────────────────────────────────────────────────────────

test('no high-traffic insight at 30 requests', () => {
  const ins = analyze([makeNode({ requestCount: 30 })]);
  assert.equal(ins.filter(i => i.icon === '🔁').length, 0);
});

test('high-traffic insight above 30 requests', () => {
  const ins = analyze([makeNode({ requestCount: 31 })]);
  const ht  = ins.find(i => i.icon === '🔁');
  assert.ok(ht, 'expected high-traffic insight');
  assert.equal(ht.severity, 'info');
  assert.match(ht.detail, /31 requests/);
});

// ── websocket ─────────────────────────────────────────────────────────────────

test('no WebSocket insight when hasWS is false', () => {
  const ins = analyze([makeNode({ hasWS: false })]);
  assert.equal(ins.filter(i => i.icon === '🔌').length, 0);
});

test('WebSocket insight when hasWS is true', () => {
  const ins = analyze([makeNode({ hasWS: true })]);
  const ws  = ins.find(i => i.icon === '🔌');
  assert.ok(ws, 'expected websocket insight');
  assert.equal(ws.severity, 'ok');
});

// ── page nodes are skipped ────────────────────────────────────────────────────

test('page nodes produce no insights', () => {
  const ins = analyze([makeNode({
    kind: 'page', requestCount: 100, totalDuration: 999_999, serverErrors: 50,
  })]);
  assert.equal(ins.length, 0);
});

test('zero-request nodes produce no insights', () => {
  const ins = analyze([makeNode({ requestCount: 0, totalDuration: 0 })]);
  assert.equal(ins.length, 0);
});

// ── cross-origin count ────────────────────────────────────────────────────────

test('no cross-origin insight with ≤ 10 domains', () => {
  const nodes = Array.from({ length: 10 }, (_, i) =>
    makeNode({ id: `d${i}.com`, label: `d${i}.com` })
  );
  const ins = analyze(nodes);
  assert.equal(ins.filter(i => i.icon === '🌐').length, 0);
});

test('cross-origin insight with > 10 domains', () => {
  const nodes = Array.from({ length: 11 }, (_, i) =>
    makeNode({ id: `d${i}.com`, label: `d${i}.com` })
  );
  const ins = analyze(nodes);
  const co  = ins.find(i => i.icon === '🌐');
  assert.ok(co, 'expected cross-origin insight');
  assert.match(co.title, /11 third-party origins/);
  assert.equal(co.nodeId, null);
});

// ── HAR export ────────────────────────────────────────────────────────────────

test('exportHAR returns valid HAR skeleton', () => {
  const node = makeNode({
    requests: [{
      url: 'https://example.com/api',
      method: 'GET',
      status: 200,
      statusText: 'OK',
      duration: 42,
      size: 512,
      mimeType: 'application/json',
      timestamp: 1_700_000_000_000,
      requestHeaders: [],
      responseHeaders: [],
      timings: { send: 1, wait: 40, receive: 1 },
    }],
  });
  const har = new NetworkAnalyzer().exportHAR(
    new Map([[node.id, node]]),
    'https://example.com'
  );
  assert.equal(har.log.version, '1.2');
  assert.equal(har.log.entries.length, 1);
  const e = har.log.entries[0];
  assert.equal(e.request.url,    'https://example.com/api');
  assert.equal(e.response.status, 200);
  assert.equal(e.time,            42);
});

test('exportHAR skips page nodes', () => {
  const page = makeNode({ kind: 'page', requests: [{ url: 'https://x.com' }] });
  const har  = new NetworkAnalyzer().exportHAR(new Map([[page.id, page]]), 'https://example.com');
  assert.equal(har.log.entries.length, 0);
});

test('exportHAR uses raw _har entry when present', () => {
  const raw  = { _raw: true, startedDateTime: '2024-01-01T00:00:00Z' };
  const node = makeNode({ requests: [{ _har: raw }] });
  const har  = new NetworkAnalyzer().exportHAR(new Map([[node.id, node]]), 'https://example.com');
  assert.deepEqual(har.log.entries[0], raw);
});
