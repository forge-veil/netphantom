'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Polyfill browser globals used by geoip-data.js
globalThis.window  = {};
globalThis.atob    = b64 => Buffer.from(b64, 'base64').toString('binary');

const src = readFileSync(join(__dirname, '../devtools/panel/geoip-data.js'), 'utf8');
// eslint-disable-next-line no-eval
eval(src);
const geoLookup = globalThis.window.geoLookup;

// ── helpers ───────────────────────────────────────────────────────────────────

function assertGeo(ip, expectedCC) {
  const r = geoLookup(ip);
  assert.ok(r,                          `geoLookup(${ip}) returned null`);
  assert.equal(r.country, expectedCC,   `geoLookup(${ip}): expected ${expectedCC}, got ${r.country}`);
  assert.ok(typeof r.lat === 'number',  `geoLookup(${ip}): lat is not a number`);
  assert.ok(typeof r.lng === 'number',  `geoLookup(${ip}): lng is not a number`);
  assert.ok(r.lat >= -90 && r.lat <= 90,   `geoLookup(${ip}): lat out of range`);
  assert.ok(r.lng >= -180 && r.lng <= 180, `geoLookup(${ip}): lng out of range`);
}

// ── known allocations ─────────────────────────────────────────────────────────

test('Google DNS 8.8.8.8 → US', () => assertGeo('8.8.8.8', 'US'));
test('Google DNS 8.8.4.4 → US', () => assertGeo('8.8.4.4', 'US'));
test('Cloudflare 1.1.1.1 → AU (ARIN registration)', () => assertGeo('1.1.1.1', 'AU'));
test('OpenDNS 208.67.222.222 → US', () => assertGeo('208.67.222.222', 'US'));
test('GitHub 140.82.112.0 → US', () => assertGeo('140.82.112.0', 'US'));
test('Fastly 151.101.0.0 → CA (DB-IP registration)', () => assertGeo('151.101.0.0', 'CA'));
test('RIPE NCC 193.0.0.0 → NL', () => assertGeo('193.0.0.0', 'NL'));
test('Baidu 180.76.76.76 → CN', () => assertGeo('180.76.76.76', 'CN'));
test('NTT Japan 202.12.27.33 → JP', () => assertGeo('202.12.27.33', 'JP'));
test('Deutsche Telekom 80.152.0.0 → DE', () => assertGeo('80.152.0.0', 'DE'));
test('Amazon eu-west-1 54.72.0.0 → IE', () => assertGeo('54.72.0.0', 'IE'));

// ── result shape ──────────────────────────────────────────────────────────────

test('result has expected keys', () => {
  const r = geoLookup('8.8.8.8');
  assert.deepEqual(Object.keys(r).sort(), ['city', 'country', 'lat', 'lng']);
});

test('city is always a string', () => {
  const r = geoLookup('8.8.8.8');
  assert.equal(typeof r.city, 'string');
});

// ── edge cases ────────────────────────────────────────────────────────────────

test('private IP 10.0.0.1 → null', () => {
  assert.equal(geoLookup('10.0.0.1'), null);
});

test('private IP 192.168.1.1 → null', () => {
  assert.equal(geoLookup('192.168.1.1'), null);
});

test('localhost 127.0.0.1 → null', () => {
  assert.equal(geoLookup('127.0.0.1'), null);
});

test('broadcast 255.255.255.255 → null', () => {
  assert.equal(geoLookup('255.255.255.255'), null);
});

test('invalid input returns null', () => {
  assert.equal(geoLookup('not-an-ip'), null);
  assert.equal(geoLookup(''),          null);
  assert.equal(geoLookup('999.0.0.1'), null);
});

// ── binary search boundary correctness ───────────────────────────────────────

test('first IP in range resolves', () => {
  // 1.0.0.0 is first entry in DB-IP; should map to AU
  const r = geoLookup('1.0.0.0');
  assert.ok(r !== null, '1.0.0.0 should resolve');
});

test('repeated calls return consistent results (lazy-init only once)', () => {
  const a = geoLookup('8.8.8.8');
  const b = geoLookup('8.8.8.8');
  assert.deepEqual(a, b);
});
