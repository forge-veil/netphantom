'use strict';

// WorldMap — equirectangular canvas world map with geolocated request dots.
// Topology is fetched from jsDelivr (world-atlas TopoJSON) on first init.

class WorldMap {
  constructor(canvas) {
    this.canvas   = canvas;
    this.ctx      = canvas.getContext('2d');
    this._dpr     = Math.min(window.devicePixelRatio || 1, 2);
    this._lw      = 0;
    this._lh      = 0;
    this._arcs    = null;
    this._topo    = null;
    this._paths   = null;
    this._dots    = [];
    this._idx     = new Map(); // "round(lat),round(lng)" → dot
    this._edges   = [];        // { lat1, lng1, lat2, lng2, status }
    this._edgeIdx = new Set(); // dedup key
    this._sources = [];        // { lat, lng, hostname }
    this._hovered = null;      // dot or source currently under the pointer
    this._raf     = null;
  }

  // Kick off background topology fetch. Safe to call before resize().
  init() {
    console.log('[WorldMap] init — fetching topology');
    const CDN = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';
    fetch(CDN)
      .then(r => r.json())
      .then(topo => {
        console.log('[WorldMap] topology loaded, arcs:', topo.arcs.length);
        this._decode(topo); this._schedule();
      })
      .catch(e => {
        console.warn('[WorldMap] topology fetch failed', e);
        this._schedule();
      });
  }

  resize(lw, lh) {
    if (!lw || !lh || (lw === this._lw && lh === this._lh)) return;
    console.log('[WorldMap] resize', lw, lh);
    this._lw = lw; this._lh = lh;
    const dpr = this._dpr;
    this.canvas.width  = Math.round(lw * dpr);
    this.canvas.height = Math.round(lh * dpr);
    this.canvas.style.width  = lw + 'px';
    this.canvas.style.height = lh + 'px';
    this._paths = null; // projected coords are stale — rebuild on next draw
    this._schedule();
  }

  // Add or update a dot. Dots within 1° of each other are clustered.
  addDot(lat, lng, status, hostname) {
    const key = `${Math.round(lat)},${Math.round(lng)}`;
    if (this._idx.has(key)) {
      const d = this._idx.get(key);
      d.count++;
      if (this._sev(status) > this._sev(d.status)) d.status = status;
      if (hostname && !d.hostnames.includes(hostname)) d.hostnames.push(hostname);
    } else {
      const d = { lat, lng, status, count: 1, hostnames: hostname ? [hostname] : [] };
      this._dots.push(d);
      this._idx.set(key, d);
    }
    this._schedule();
  }

  // Add a directed edge from (lat1,lng1) to (lat2,lng2), deduped to 1°.
  addEdge(lat1, lng1, lat2, lng2, status) {
    const key = `${Math.round(lat1)},${Math.round(lng1)}→${Math.round(lat2)},${Math.round(lng2)}`;
    if (this._edgeIdx.has(key)) return;
    this._edgeIdx.add(key);
    this._edges.push({ lat1, lng1, lat2, lng2, status });
    this._schedule();
  }

  // Mark a node as a page-origin source (drawn with a ring instead of a filled dot).
  addSource(lat, lng, hostname) {
    this._sources.push({ lat, lng, hostname: hostname || null, count: 1 });
    this._schedule();
  }

  // Return the dot or source node closest to logical canvas coords (lx, ly), or null.
  hitTest(lx, ly) {
    const HIT2 = 16 * 16; // 16 px hit radius, squared
    for (const s of this._sources) {
      const [px, py] = this._proj(s.lng, s.lat);
      if ((px - lx) ** 2 + (py - ly) ** 2 <= HIT2) return s;
    }
    for (const d of this._dots) {
      const [px, py] = this._proj(d.lng, d.lat);
      if ((px - lx) ** 2 + (py - ly) ** 2 <= HIT2) return d;
    }
    return null;
  }

  // Highlight a node on hover (pass null to clear).
  setHover(node) {
    if (this._hovered === node) return;
    this._hovered = node;
    this._schedule();
  }

  clear() {
    this._dots    = [];
    this._edges   = [];
    this._sources = [];
    this._idx.clear();
    this._edgeIdx.clear();
    this._schedule();
  }

  // ── TopoJSON decoding ─────────────────────────────────────────────────────

  _decode(topo) {
    const [sx, sy] = topo.transform.scale;
    const [tx, ty] = topo.transform.translate;
    // Arcs are stored as delta-encoded integers; decode to absolute lng/lat.
    this._arcs = topo.arcs.map(arc => {
      let x = 0, y = 0;
      return arc.map(([dx, dy]) => {
        x += dx; y += dy;
        return [x * sx + tx, y * sy + ty]; // [longitude, latitude]
      });
    });
    this._topo  = topo;
    this._paths = null;
  }

  _buildPaths() {
    const paths = [];
    for (const geo of this._topo.objects.countries.geometries) {
      const path  = new Path2D();
      const polys = geo.type === 'Polygon' ? [geo.arcs] : geo.arcs;
      for (const rings of polys) {
        for (const ring of rings) {
          let first = true;
          for (const i of ring) {
            // Positive index → forward arc; negative → reversed arc (~i)
            const arc = i >= 0 ? this._arcs[i] : [...this._arcs[~i]].reverse();
            for (const [lng, lat] of arc) {
              const [x, y] = this._proj(lng, lat);
              if (first) { path.moveTo(x, y); first = false; }
              else         path.lineTo(x, y);
            }
          }
          path.closePath();
        }
      }
      paths.push(path);
    }
    this._paths = paths;
  }

  // Equirectangular projection → logical pixel coordinates.
  // Maintains the 2:1 natural aspect ratio with letterboxing so the map never
  // appears stretched regardless of the canvas dimensions.
  _proj(lng, lat) {
    const W = this._lw, H = this._lh;
    let pw, ph, ox, oy;
    if (W / H >= 2) {          // canvas wider than 2:1 — pad left/right
      ph = H; pw = H * 2; ox = (W - pw) / 2; oy = 0;
    } else {                   // canvas taller than 2:1 — pad top/bottom
      pw = W; ph = W / 2; ox = 0; oy = (H - ph) / 2;
    }
    return [ox + (lng + 180) / 360 * pw, oy + (90 - lat) / 180 * ph];
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this._draw(); });
  }

  _draw() {
    const { ctx, _lw: W, _lh: H, _dpr: dpr } = this;
    if (!W || !H) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    // ── Ocean background ───────────────────────────────────────────────────
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#05070e');
    bg.addColorStop(1, '#070f1c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // ── Graticule ─────────────────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(255,255,255,0.028)';
    ctx.lineWidth   = 0.5;
    for (let lat = -60; lat <= 60; lat += 30) {
      const [, py] = this._proj(0, lat);
      ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(W, py); ctx.stroke();
    }
    for (let lng = -120; lng <= 180; lng += 60) {
      const [px] = this._proj(lng, 0);
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
    }

    // ── Country fills + borders ───────────────────────────────────────────
    if (!this._paths && this._arcs) this._buildPaths();
    if (this._paths) {
      ctx.fillStyle = '#0c1626';
      for (const p of this._paths) ctx.fill(p);
      ctx.strokeStyle = 'rgba(50,105,200,0.2)';
      ctx.lineWidth   = 0.4;
      for (const p of this._paths) ctx.stroke(p);
    }

    // ── Equator dashes ────────────────────────────────────────────────────
    {
      const [, eq] = this._proj(0, 0);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth   = 0.8;
      ctx.setLineDash([3, 8]);
      ctx.beginPath(); ctx.moveTo(0, eq); ctx.lineTo(W, eq); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // ── Edges ─────────────────────────────────────────────────────────────
    for (const e of this._edges) {
      const [x1, y1] = this._proj(e.lng1, e.lat1);
      const [x2, y2] = this._proj(e.lng2, e.lat2);
      const dx   = x2 - x1;
      const dist = Math.sqrt(dx * dx + (y2 - y1) ** 2);
      const mx   = (x1 + x2) / 2;
      const my   = (y1 + y2) / 2 - dist * 0.22; // arc toward north
      ctx.save();
      ctx.strokeStyle = this._color(e.status);
      ctx.globalAlpha = 0.28;
      ctx.lineWidth   = 0.85;
      ctx.shadowBlur  = 5;
      ctx.shadowColor = this._color(e.status);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.quadraticCurveTo(mx, my, x2, y2);
      ctx.stroke();
      ctx.restore();
    }

    // ── Request dots ──────────────────────────────────────────────────────
    for (const d of this._dots) {
      const [px, py] = this._proj(d.lng, d.lat);
      if (px < -14 || px > W + 14 || py < -14 || py > H + 14) continue;
      this._drawDot(ctx, px, py, d.count, d.status, d === this._hovered);
    }

    // ── Source nodes (page origin) ─────────────────────────────────────────
    for (const s of this._sources) {
      const [px, py] = this._proj(s.lng, s.lat);
      const hov = s === this._hovered;
      // Outer glow ring
      ctx.save();
      ctx.strokeStyle = '#a78bfa';
      ctx.globalAlpha = hov ? 1.0 : 0.85;
      ctx.lineWidth   = hov ? 2   : 1.5;
      ctx.shadowBlur  = hov ? 22  : 14;
      ctx.shadowColor = '#a78bfa';
      ctx.beginPath(); ctx.arc(px, py, hov ? 10 : 7, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      // Core dot
      ctx.save();
      ctx.fillStyle   = '#fff';
      ctx.globalAlpha = 0.95;
      ctx.shadowBlur  = 6;
      ctx.shadowColor = '#fff';
      ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }

  _drawDot(ctx, px, py, count, status, hovered) {
    const color = this._color(status);
    const r     = Math.min(9, 2.5 + Math.log2(count + 1));

    // Hover highlight ring
    if (hovered) {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth   = 1.5;
      ctx.shadowBlur  = 16;
      ctx.shadowColor = color;
      ctx.beginPath(); ctx.arc(px, py, r + 5, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    // Ambient glow (large, very transparent)
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.shadowBlur  = 24;
    ctx.shadowColor = color;
    ctx.fillStyle   = color;
    ctx.beginPath(); ctx.arc(px, py, r * 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // Halo
    ctx.save();
    ctx.shadowBlur  = 10;
    ctx.shadowColor = color;
    ctx.fillStyle   = color;
    ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // Bright core
    ctx.save();
    ctx.shadowBlur  = 4;
    ctx.shadowColor = '#fff';
    ctx.fillStyle   = '#fff';
    ctx.globalAlpha = 0.88;
    ctx.beginPath(); ctx.arc(px - r * 0.12, py - r * 0.18, r * 0.40, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  _color(status) {
    if (!status || status === 0 || status >= 500) return '#ff453a';
    if (status >= 400) return '#ff9f0a';
    if (status >= 300) return '#5ac8fa';
    return '#34c759';
  }

  _sev(status) {
    if (!status || status === 0 || status >= 500) return 3;
    if (status >= 400) return 2;
    if (status >= 300) return 1;
    return 0;
  }
}
