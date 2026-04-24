#!/usr/bin/env node
'use strict';

// Build script: downloads DB-IP Lite country IPv4 CSV and converts it to a
// compact binary blob embedded in devtools/panel/geoip-data.js.
//
// Binary layout (per row, big-endian, rows sorted by start IP):
//   bytes 0-3 : uint32 range start
//   bytes 4-7 : uint32 range end
//   byte  8   : uint8  country-code index (into the cc[] array at top of output)
//
// Attribution: DB-IP Lite data — https://db-ip.com (CC BY 4.0)
// Distributed via: https://cdn.jsdelivr.net/npm/ip-location-db (sapics)

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { Buffer } = require('buffer');

const CSV_URL   = 'https://cdn.jsdelivr.net/npm/@ip-location-db/dbip-country/dbip-country-ipv4.csv';
const OUT_FILE  = path.join(__dirname, '..', 'devtools', 'panel', 'geoip-data.js');

// Country centroids (ISO 3166-1 alpha-2 → [lat, lng]).
// Sources: public-domain geographic centroid data.
const CENTROIDS = {
  AD:[42.546,1.602],AE:[23.424,53.848],AF:[33.939,67.710],AG:[17.061,-61.796],
  AI:[18.221,-63.069],AL:[41.153,20.168],AM:[40.069,45.038],AO:[-11.203,17.874],
  AQ:[-75.251,-0.071],AR:[-38.416,-63.617],AS:[-14.271,-170.132],AT:[47.516,14.550],
  AU:[-25.274,133.775],AW:[12.521,-69.968],AZ:[40.143,47.577],BA:[43.916,17.679],
  BB:[13.194,-59.543],BD:[23.685,90.356],BE:[50.504,4.470],BF:[12.365,-1.562],
  BG:[42.734,25.486],BH:[25.930,50.638],BI:[-3.373,29.919],BJ:[9.308,2.316],
  BM:[32.321,-64.757],BN:[4.535,114.728],BO:[-16.290,-63.589],BR:[-14.235,-51.925],
  BS:[25.034,-77.396],BT:[27.514,90.434],BW:[-22.328,24.685],BY:[53.710,27.953],
  BZ:[17.190,-88.498],CA:[56.130,-106.347],CC:[-12.164,96.871],CD:[-4.038,21.759],
  CF:[6.611,20.939],CG:[-0.228,15.828],CH:[46.818,8.228],CI:[7.540,-5.547],
  CK:[-21.237,-159.778],CL:[-35.675,-71.543],CM:[3.848,11.502],CN:[35.862,104.195],
  CO:[4.571,-74.297],CR:[9.749,-83.753],CU:[21.522,-77.781],CV:[16.002,-24.013],
  CX:[-10.448,105.690],CY:[35.126,33.430],CZ:[49.817,15.473],DE:[51.166,10.452],
  DJ:[11.825,42.590],DK:[56.264,9.502],DM:[15.415,-61.371],DO:[18.736,-70.163],
  DZ:[28.034,1.660],EC:[-1.831,-78.183],EE:[58.595,25.014],EG:[26.821,30.802],
  ER:[15.179,39.782],ES:[40.464,-3.749],ET:[9.145,40.490],FI:[61.924,25.748],
  FJ:[-16.578,179.414],FK:[-51.796,-59.524],FM:[7.426,150.551],FO:[61.893,-6.912],
  FR:[46.228,2.214],GA:[-0.804,11.609],GB:[55.378,-3.436],GD:[12.263,-61.604],
  GE:[42.315,43.357],GF:[3.934,-53.126],GG:[49.466,-2.585],GH:[7.947,-1.023],
  GI:[36.138,-5.345],GL:[71.707,-42.604],GM:[13.443,-15.310],GN:[9.946,-9.697],
  GP:[16.996,-62.068],GQ:[1.651,10.268],GR:[39.074,21.824],GT:[15.783,-90.231],
  GU:[13.444,144.794],GW:[11.804,-15.180],GY:[4.860,-58.930],HK:[22.396,114.109],
  HN:[15.200,-86.242],HR:[45.100,15.200],HT:[18.971,-72.285],HU:[47.162,19.503],
  ID:[-0.789,113.921],IE:[53.413,-8.244],IL:[31.046,34.852],IM:[54.236,-4.548],
  IN:[20.594,78.963],IQ:[33.223,43.679],IR:[32.428,53.688],IS:[64.963,-19.021],
  IT:[41.872,12.567],JM:[18.110,-77.298],JO:[30.585,36.238],JP:[36.205,138.253],
  KE:[-0.024,37.906],KG:[41.204,74.766],KH:[12.566,104.991],KI:[-3.370,-168.734],
  KM:[-11.875,43.872],KN:[17.358,-62.783],KP:[40.340,127.510],KR:[35.908,127.767],
  KW:[29.312,47.482],KY:[19.513,-80.567],KZ:[48.020,66.924],LA:[19.856,102.495],
  LB:[33.855,35.862],LC:[13.909,-60.979],LI:[47.166,9.555],LK:[7.873,80.772],
  LR:[6.428,-9.429],LS:[-29.610,28.234],LT:[55.169,23.881],LU:[49.815,6.130],
  LV:[56.880,24.603],LY:[26.335,17.228],MA:[31.792,-7.093],MC:[43.750,7.413],
  MD:[47.412,28.370],ME:[42.709,19.374],MG:[-18.767,46.869],MH:[7.131,171.184],
  MK:[41.609,21.745],ML:[17.571,-3.996],MM:[21.914,95.956],MN:[46.862,103.847],
  MO:[22.199,113.544],MP:[17.331,145.385],MQ:[14.642,-61.024],MR:[21.008,-10.941],
  MS:[16.742,-62.187],MT:[35.937,14.375],MU:[-20.348,57.552],MV:[3.203,73.221],
  MW:[-13.254,34.302],MX:[23.635,-102.553],MY:[4.210,101.976],MZ:[-18.666,35.530],
  NA:[-22.958,18.490],NC:[-20.904,165.618],NE:[17.608,8.082],NF:[-29.041,167.955],
  NG:[9.082,8.675],NI:[12.865,-85.207],NL:[52.133,5.291],NO:[60.472,8.469],
  NP:[28.395,84.124],NR:[-0.523,166.932],NU:[-19.054,-169.867],NZ:[-40.901,174.886],
  OM:[21.513,55.923],PA:[8.538,-80.782],PE:[-9.190,-75.015],PF:[-17.680,-149.407],
  PG:[-6.315,143.956],PH:[12.880,121.774],PK:[30.375,69.345],PL:[51.919,19.145],
  PM:[46.942,-56.271],PR:[18.221,-66.590],PS:[31.952,35.233],PT:[39.400,-8.224],
  PW:[7.515,134.583],PY:[-23.443,-58.444],QA:[25.355,51.184],RE:[-21.115,55.536],
  RO:[45.943,24.967],RS:[44.017,21.006],RU:[61.524,105.319],RW:[-1.940,29.874],
  SA:[23.886,45.079],SB:[-9.646,160.156],SC:[-4.680,55.492],SD:[12.863,30.218],
  SE:[60.128,18.644],SG:[1.352,103.820],SI:[46.151,14.995],SK:[48.669,19.699],
  SL:[8.461,-11.780],SM:[43.942,12.458],SN:[14.497,-14.452],SO:[5.152,46.200],
  SR:[3.919,-56.028],SS:[4.859,31.571],ST:[0.186,6.613],SV:[13.794,-88.897],
  SY:[34.802,38.997],SZ:[-26.523,31.466],TC:[21.694,-71.798],TD:[15.454,18.732],
  TG:[8.620,0.825],TH:[15.870,100.993],TJ:[38.861,71.276],TK:[-8.967,-171.856],
  TL:[-8.874,125.728],TM:[38.970,59.556],TN:[33.887,9.537],TO:[-21.179,-175.198],
  TR:[38.964,35.243],TT:[10.692,-61.223],TV:[-7.110,177.649],TW:[23.698,120.961],
  TZ:[-6.369,34.889],UA:[48.379,31.166],UG:[1.373,32.290],US:[37.090,-95.713],
  UY:[-32.523,-55.766],UZ:[41.377,64.585],VA:[41.903,12.453],VC:[12.984,-61.287],
  VE:[6.424,-66.590],VG:[18.421,-64.640],VI:[18.336,-64.896],VN:[14.058,108.277],
  VU:[-15.377,166.959],WF:[-13.769,-177.156],WS:[-13.759,-172.105],YE:[15.553,48.516],
  YT:[-12.828,45.166],ZA:[-30.559,22.938],ZM:[-13.134,27.849],ZW:[-19.015,29.155],
};

function ipToInt(s) {
  const p = s.split('.');
  return ((+p[0] << 24) | (+p[1] << 16) | (+p[2] << 8) | +p[3]) >>> 0;
}

function fetch_url(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects === 0) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        return resolve(fetch_url(res.headers.location, redirects - 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  console.log(`Downloading: ${CSV_URL}`);
  const raw = await fetch_url(CSV_URL);
  const csv = raw.toString('utf8');
  console.log(`Downloaded ${(raw.length / 1024 / 1024).toFixed(1)} MB`);

  // Parse CSV: range_start,range_end,country_code  (no header row)
  const lines = csv.split('\n');
  const rows  = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const [startStr, endStr, cc] = t.split(',');
    if (!startStr || !endStr || !cc || cc.length !== 2) continue;
    // Skip IPv6 rows (contain colons)
    if (startStr.includes(':')) continue;
    const start = ipToInt(startStr);
    const end   = ipToInt(endStr);
    rows.push({ start, end, cc: cc.toUpperCase() });
  }
  console.log(`Parsed ${rows.length} IPv4 ranges`);

  // Build unique country-code list (max 256 for uint8 index)
  const ccSet  = new Set(rows.map(r => r.cc));
  const ccArr  = Array.from(ccSet).sort();
  if (ccArr.length > 256) throw new Error(`Too many country codes: ${ccArr.length}`);
  const ccIdx  = new Map(ccArr.map((c, i) => [c, i]));
  console.log(`Unique country codes: ${ccArr.length}`);

  // Sort by start IP
  rows.sort((a, b) => (a.start >>> 0) - (b.start >>> 0));

  // Pack into binary: 9 bytes per row
  const buf = Buffer.allocUnsafe(rows.length * 9);
  for (let i = 0; i < rows.length; i++) {
    const off = i * 9;
    buf.writeUInt32BE(rows[i].start, off);
    buf.writeUInt32BE(rows[i].end,   off + 4);
    buf[off + 8] = ccIdx.get(rows[i].cc);
  }

  const b64 = buf.toString('base64');
  console.log(`Binary size: ${(buf.length / 1024 / 1024).toFixed(2)} MB → base64: ${(b64.length / 1024 / 1024).toFixed(2)} MB`);

  // Filter centroids to only the codes present in the data
  const llObj = {};
  for (const cc of ccArr) {
    const c = CENTROIDS[cc];
    if (c) llObj[cc] = c;
  }

  // Emit output JS
  const out = `// Auto-generated by tools/build-geoip.js — do not edit by hand.
// Data: DB-IP Lite (CC BY 4.0) via https://db-ip.com — https://cdn.jsdelivr.net/npm/ip-location-db
'use strict';
(function () {
  // Country codes indexed by uint8 value in the binary blob
  const CC = ${JSON.stringify(ccArr)};

  // Country centroids [lat, lng]
  const LL = ${JSON.stringify(llObj, null, 0)};

  // Binary blob: sorted IPv4 ranges, 9 bytes each (start u32 BE | end u32 BE | cc_idx u8)
  const B64 = '${b64}';

  let _S, _E, _I;   // lazy-decoded Uint32Array, Uint32Array, Uint8Array

  function _init() {
    const raw = atob(B64);
    const n   = raw.length / 9 | 0;
    const buf = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
    const dv = new DataView(buf.buffer);
    _S = new Uint32Array(n);
    _E = new Uint32Array(n);
    _I = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      _S[i] = dv.getUint32(i * 9,     false);
      _E[i] = dv.getUint32(i * 9 + 4, false);
      _I[i] = buf[i * 9 + 8];
    }
  }

  // Returns { lat, lng, country, city } or null.
  window.geoLookup = function geoLookup(ip) {
    if (!_S) _init();
    const p = ip.split('.');
    if (p.length !== 4) return null;
    const n = (((+p[0] << 24) | (+p[1] << 16) | (+p[2] << 8) | +p[3]) >>> 0);
    let lo = 0, hi = _S.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (_S[mid] <= n && n <= _E[mid]) {
        const cc = CC[_I[mid]];
        const ll = LL[cc];
        return ll ? { lat: ll[0], lng: ll[1], country: cc, city: '' } : null;
      }
      if (_S[mid] > n) hi = mid - 1; else lo = mid + 1;
    }
    return null;
  };
})();
`;

  fs.writeFileSync(OUT_FILE, out, 'utf8');
  console.log(`Written: ${OUT_FILE}  (${(out.length / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
