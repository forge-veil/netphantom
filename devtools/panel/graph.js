// NetPhantom 3D Force-Directed Graph Engine
// Pure canvas — no dependencies. Full 3D with perspective projection, physics, particles.

class ForceGraph3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.dpr    = window.devicePixelRatio || 1;

    this.nodes     = new Map();  // id → NodeData
    this.edges     = new Map();  // 'src→tgt' → EdgeData
    this.particles = [];

    this.cam  = { rotX: 0.35, rotY: 0.2, zoom: 1, fov: 700 };
    this.drag = { active: false, lastX: 0, lastY: 0, dist: 0 };
    this.hovered  = null;
    this.selected = null;

    this.REPULSION  = 14000;
    this.ATTRACTION = 0.008;
    this.DAMPING    = 0.82;
    this.GRAVITY    = 0.012;
    this.IDEAL_DIST = 300;

    // Cooldown: skip simulate when settled
    this._simActive   = false;
    this._forceActive = 0;  // frames to force-simulate even after settled

    this._bindEvents();
    this._loop();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  addRequest(req) {
    const host = this._origin(req.url);
    if (!host) return;

    const regDomain = this._registrable(host);
    const isSub     = host !== regDomain;

    if (!this.nodes.has('__page__')) {
      this._addNode('__page__', { label: 'Page', kind: 'page' });
      const n = this.nodes.get('__page__');
      n.x = n.y = n.z = n.vx = n.vy = n.vz = 0;
      n.pinned = true;
    }

    if (!this.nodes.has(regDomain)) {
      this._addNode(regDomain, { label: regDomain, kind: 'domain' });
    }
    const parentEdge = this._ensureEdge('__page__', regDomain, 270);

    let statsNode;
    if (isSub) {
      if (!this.nodes.has(host)) {
        this._addNode(host, { label: host, kind: 'subdomain' });
        // Spawn in the cone direction of parent from page for faster settling
        const par  = this.nodes.get(regDomain);
        const pLen = Math.hypot(par.x, par.y, par.z) || 1;
        const sub  = this.nodes.get(host);
        sub.x = par.x + (par.x / pLen) * 50 + (Math.random() - 0.5) * 30;
        sub.y = par.y + (par.y / pLen) * 50 + (Math.random() - 0.5) * 30;
        sub.z = par.z + (par.z / pLen) * 50 + (Math.random() - 0.5) * 30;
      }
      this._ensureEdge(regDomain, host, 130);
      statsNode = this.nodes.get(host);
    } else {
      statsNode = this.nodes.get(regDomain);
    }

    statsNode.requestCount++;
    statsNode.totalDuration += req.duration || 0;
    if (req.status >= 500)       statsNode.serverErrors++;
    else if (req.status >= 400)  statsNode.clientErrors++;
    else if (req.status > 0)     statsNode.successCount++;
    if (req.type === 'websocket') statsNode.hasWS = true;
    if (req.isHttps  != null) statsNode.isHttps    = req.isHttps;
    if (req.ssl?.protocol)    statsNode.sslProtocol = req.ssl.protocol;

    statsNode.requests.unshift(req);
    if (statsNode.requests.length > 50) statsNode.requests.pop();
    statsNode.pulseAt = Date.now();

    // Type tracking
    const t = req.type || 'other';
    statsNode.types[t] = (statsNode.types[t] || 0) + 1;

    // Req/s tracking — keep a 5-second window
    const now = Date.now();
    statsNode.recentReqs.push(now);
    const cutoff = now - 5000;
    while (statsNode.recentReqs.length && statsNode.recentReqs[0] < cutoff)
      statsNode.recentReqs.shift();

    // Edge packet counts
    const leafKey  = isSub ? `${regDomain}→${host}` : `__page__→${regDomain}`;
    const leafEdge = this.edges.get(leafKey);
    if (leafEdge) {
      leafEdge.packets++;
      leafEdge.lastStatus   = req.status;
      leafEdge.lastDuration = req.duration || 0;
    }
    if (isSub) {
      parentEdge.packets++;
      parentEdge.lastStatus   = req.status;
      parentEdge.lastDuration = req.duration || 0;
    }

    this._spawnParticle('__page__', isSub ? host : regDomain, req);
    this._wake();
  }

  clear() {
    this.nodes.clear();
    this.edges.clear();
    this.particles  = [];
    this.hovered    = null;
    this.selected   = null;
    this._simActive   = false;
    this._forceActive = 0;
  }

  resize(w, h) {
    this.canvas.width  = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.ctx.scale(this.dpr, this.dpr);
    this._w     = w;
    this._h     = h;
    this._stars = null;  // regenerate star field for new dimensions
  }

  getSelectedNode() { return this.selected; }
  getNodes()        { return this.nodes; }

  // Replay a stored request array without spawning particles (history rebuild).
  // Suppressing particles avoids a storm of 1000+ animations all at once.
  rebuild(requests) {
    this.clear();
    this._rebuilding = true;
    for (const req of requests) this.addRequest(req);
    this._rebuilding = false;
    this._wake(120);
  }

  deselect() {
    if (!this.selected) return;
    this.selected = null;
    this.canvas.dispatchEvent(new CustomEvent('nodeDeselected', { bubbles: true }));
    this._wake(5);
  }

  // ── URL helpers ────────────────────────────────────────────────────────────

  _registrable(host) {
    const parts = host.split('.');
    return parts.length > 2 ? parts.slice(-2).join('.') : host;
  }

  _origin(url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'chrome-extension:') return null;
      return u.host || null;
    } catch { return null; }
  }

  // ── Node / edge creation ───────────────────────────────────────────────────

  _addNode(id, opts = {}) {
    const angle = Math.random() * Math.PI * 2;
    const elev  = (Math.random() - 0.5) * Math.PI * 0.8;
    const r     = 150 + Math.random() * 120;
    this.nodes.set(id, {
      id,
      label:         opts.label || id,
      kind:          opts.kind  || 'domain',
      x: Math.cos(angle) * Math.cos(elev) * r,
      y: Math.sin(elev) * r,
      z: Math.sin(angle) * Math.cos(elev) * r,
      vx: 0, vy: 0, vz: 0,
      pinned:        false,
      requestCount:  0,
      totalDuration: 0,
      successCount:  0,
      clientErrors:  0,
      serverErrors:  0,
      hasWS:         false,
      isHttps:       null,
      sslProtocol:   null,
      requests:      [],
      types:         {},
      recentReqs:    [],
      pulseAt:       0,
    });
  }

  _ensureEdge(srcId, tgtId, idealDist) {
    const key = `${srcId}→${tgtId}`;
    if (!this.edges.has(key)) {
      this.edges.set(key, {
        source: srcId, target: tgtId,
        packets: 0, lastStatus: 0, lastDuration: 0,
        idealDist: idealDist ?? this.IDEAL_DIST,
      });
    }
    return this.edges.get(key);
  }

  // ── Particles ──────────────────────────────────────────────────────────────

  _spawnParticle(srcId, tgtId, req) {
    if (this._rebuilding) return;
    const color = req.status >= 500      ? '#e5534b'
                : req.status >= 400      ? '#f5a623'
                : req.type === 'websocket' ? '#57a6f6'
                : '#3dd68c';
    this.particles.push({
      srcId, tgtId, t: 0,
      speed: 0.012 + Math.random() * 0.008,
      color,
      size: req.type === 'websocket' ? 3.5 : 2.5,
    });
  }

  // ── Physics ────────────────────────────────────────────────────────────────

  _wake(frames = 150) {
    this._forceActive = Math.max(this._forceActive, frames);
    this._simActive   = true;
  }

  _simulate() {
    const nodes = Array.from(this.nodes.values());
    for (const n of nodes) { n.fx = 0; n.fy = 0; n.fz = 0; }

    // Pairwise Coulomb repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const d2 = dx*dx + dy*dy + dz*dz + 1;
        const d  = Math.sqrt(d2);
        const f  = this.REPULSION / d2;
        const fx = dx/d*f, fy = dy/d*f, fz = dz/d*f;
        a.fx -= fx; a.fy -= fy; a.fz -= fz;
        b.fx += fx; b.fy += fy; b.fz += fz;
      }
    }

    // Hooke spring (per-edge ideal distance)
    for (const edge of this.edges.values()) {
      const src = this.nodes.get(edge.source);
      const tgt = this.nodes.get(edge.target);
      if (!src || !tgt) continue;
      const dx = tgt.x - src.x, dy = tgt.y - src.y, dz = tgt.z - src.z;
      const d  = Math.sqrt(dx*dx + dy*dy + dz*dz) + 0.01;
      const f  = this.ATTRACTION * (d - (edge.idealDist ?? this.IDEAL_DIST));
      const fx = dx/d*f, fy = dy/d*f, fz = dz/d*f;
      if (!src.pinned) { src.fx += fx; src.fy += fy; src.fz += fz; }
      if (!tgt.pinned) { tgt.fx -= fx; tgt.fy -= fy; tgt.fz -= fz; }
    }

    // Gravity toward world origin
    for (const n of nodes) {
      if (n.pinned) continue;
      n.fx -= n.x * this.GRAVITY;
      n.fy -= n.y * this.GRAVITY;
      n.fz -= n.z * this.GRAVITY;
    }

    // Integrate — track max velocity for cooldown
    let maxV = 0;
    for (const n of nodes) {
      if (n.pinned) continue;
      n.vx = (n.vx + n.fx) * this.DAMPING;
      n.vy = (n.vy + n.fy) * this.DAMPING;
      n.vz = (n.vz + n.fz) * this.DAMPING;
      n.x += n.vx; n.y += n.vy; n.z += n.vz;
      maxV = Math.max(maxV, Math.abs(n.vx) + Math.abs(n.vy) + Math.abs(n.vz));
    }
    this._simActive = maxV > 0.12;

    this.particles = this.particles.filter(p => { p.t += p.speed; return p.t < 1; });
  }

  // ── Projection ─────────────────────────────────────────────────────────────

  _project(x, y, z) {
    const { rotX, rotY, fov, zoom } = this.cam;
    const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
    const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
    const x1 =  x * cosY + z * sinY;
    const z1 = -x * sinY + z * cosY;
    const y2 =  y * cosX - z1 * sinX;
    const z2 =  y * sinX + z1 * cosX;
    const denom = fov + z2 + 200;
    const perspective = denom > 1 ? fov / denom : 0.01;
    const w = this._w || this.canvas.clientWidth  || 800;
    const h = this._h || this.canvas.clientHeight || 600;
    return {
      x:     w / 2 + x1 * perspective * zoom,
      y:     h / 2 + y2 * perspective * zoom,
      depth: z2,
      scale: Math.max(0.01, perspective * zoom),
    };
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  _draw() {
    const ctx = this.ctx;
    const w = this._w || this.canvas.clientWidth  || 800;
    const h = this._h || this.canvas.clientHeight || 600;

    // ── Deep-space background ─────────────────────────────────────────────────
    const bgGrad = ctx.createRadialGradient(w * 0.5, h * 0.42, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.8);
    bgGrad.addColorStop(0, '#13131f');
    bgGrad.addColorStop(1, '#07070c');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    this._drawStars(ctx, w, h);

    // Soft vignette to push focus to the centre
    const vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.22, w / 2, h / 2, Math.max(w, h) * 0.74);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.58)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);

    // Project all nodes
    const projected = [];
    let minDepth = Infinity, maxDepth = -Infinity;
    for (const node of this.nodes.values()) {
      const proj = this._project(node.x, node.y, node.z);
      projected.push({ node, proj });
      if (proj.depth < minDepth) minDepth = proj.depth;
      if (proj.depth > maxDepth) maxDepth = proj.depth;
    }
    const depthRange = (maxDepth - minDepth) || 1;

    // Build parent→children map for cluster halos
    const domainChildren = new Map();
    for (const { node, proj } of projected) {
      if (node.kind !== 'subdomain') continue;
      for (const edge of this.edges.values()) {
        if (edge.target === node.id && edge.source !== '__page__') {
          if (!domainChildren.has(edge.source)) domainChildren.set(edge.source, []);
          domainChildren.get(edge.source).push({ node, proj });
          break;
        }
      }
    }

    // ── Cluster halos ─────────────────────────────────────────────────────────
    for (const [domainId, children] of domainChildren) {
      const parentNode = this.nodes.get(domainId);
      if (!parentNode) continue;
      const parentProj = this._project(parentNode.x, parentNode.y, parentNode.z);
      const allProj    = [parentProj, ...children.map(c => c.proj)];
      let cx = 0, cy = 0;
      for (const p of allProj) { cx += p.x; cy += p.y; }
      cx /= allProj.length; cy /= allProj.length;
      let maxR = 0;
      for (const p of allProj) maxR = Math.max(maxR, Math.hypot(p.x - cx, p.y - cy));
      maxR = Math.max(28, maxR + 18 * parentProj.scale);
      ctx.beginPath();
      ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
      ctx.fillStyle   = 'rgba(91,106,240,0.03)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(91,106,240,0.08)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([3, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── Node drop shadows — drawn before edges so they sit deepest ────────────
    projected.sort((a, b) => a.proj.depth - b.proj.depth);
    for (const { node, proj } of projected) this._drawNodeShadow(ctx, node, proj);

    // ── Edges — glow bloom + main directional line + arrowhead ────────────────
    for (const edge of this.edges.values()) {
      const src = this.nodes.get(edge.source);
      const tgt = this.nodes.get(edge.target);
      if (!src || !tgt) continue;

      const sp = this._project(src.x, src.y, src.z);
      const tp = this._project(tgt.x, tgt.y, tgt.z);

      const edgeBase = edge.lastStatus >= 500    ? '#e5534b'
                     : edge.lastStatus >= 400    ? '#f5a623'
                     : edge.lastDuration > 2000  ? '#e8692a'
                     : '#5b6af0';

      const dx = tp.x - sp.x, dy = tp.y - sp.y;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      const ux = dx / len, uy = dy / len;
      const tgtR = this._nodeBaseRadius(tgt) * tp.scale;
      const ex = tp.x - ux * tgtR;
      const ey = tp.y - uy * tgtR;
      const lineW = Math.min(2.5, 0.5 + Math.log1p(edge.packets) * 0.35);

      // Soft bloom (wide, transparent glow around the line)
      const glowGrad = ctx.createLinearGradient(sp.x, sp.y, ex, ey);
      glowGrad.addColorStop(0, edgeBase + '00');
      glowGrad.addColorStop(1, edgeBase + '1e');
      ctx.beginPath();
      ctx.moveTo(sp.x, sp.y);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = glowGrad;
      ctx.lineWidth   = lineW * 6;
      ctx.stroke();

      // Main directional line
      const grad = ctx.createLinearGradient(sp.x, sp.y, ex, ey);
      grad.addColorStop(0, edgeBase + '0a');
      grad.addColorStop(1, edgeBase + '70');
      ctx.beginPath();
      ctx.moveTo(sp.x, sp.y);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = grad;
      ctx.lineWidth   = lineW;
      ctx.stroke();

      // Arrowhead
      const as = Math.max(4, 7 * tp.scale);
      const aw = Math.max(2, 3 * tp.scale);
      const px = -uy, py = ux;
      ctx.fillStyle = edgeBase + '80';
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - ux*as + px*aw, ey - uy*as + py*aw);
      ctx.lineTo(ex - ux*as - px*aw, ey - uy*as - py*aw);
      ctx.closePath();
      ctx.fill();
    }

    // ── Particles — halo + bright core ───────────────────────────────────────
    for (const p of this.particles) {
      const src = this.nodes.get(p.srcId);
      const tgt = this.nodes.get(p.tgtId);
      if (!src || !tgt) continue;
      const px = src.x + (tgt.x - src.x) * p.t;
      const py = src.y + (tgt.y - src.y) * p.t;
      const pz = src.z + (tgt.z - src.z) * p.t;
      const pp = this._project(px, py, pz);
      const pr = Math.max(1.5, p.size * pp.scale);

      const [pr_, pg_, pb_] = this._hexToRgb(p.color);
      const halo = ctx.createRadialGradient(pp.x, pp.y, 0, pp.x, pp.y, pr * 4);
      halo.addColorStop(0, `rgba(${pr_},${pg_},${pb_},0.55)`);
      halo.addColorStop(0.4, `rgba(${pr_},${pg_},${pb_},0.15)`);
      halo.addColorStop(1, `rgba(${pr_},${pg_},${pb_},0)`);
      ctx.beginPath();
      ctx.arc(pp.x, pp.y, pr * 4, 0, Math.PI * 2);
      ctx.fillStyle = halo;
      ctx.fill();

      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(pp.x, pp.y, pr, 0, Math.PI * 2);
      ctx.fill();

      // Bright white centre glint
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(pp.x, pp.y, pr * 0.38, 0, Math.PI * 2);
      ctx.fill();
    }

    // ── Nodes — far → near for correct overlap ────────────────────────────────
    // (already sorted above — reuse the sorted order)
    for (const { node, proj } of projected) {
      const depthT = (proj.depth - minDepth) / depthRange;
      ctx.globalAlpha = Math.max(0.38, 1 - depthT * 0.42);
      this._drawNode(ctx, node, proj);
      ctx.globalAlpha = 1;
    }
  }

  _drawStars(ctx, w, h) {
    if (!this._stars) {
      this._stars = Array.from({ length: 160 }, () => ({
        x:     Math.random() * w,
        y:     Math.random() * h,
        r:     Math.random() * 1.5 + 0.15,
        base:  Math.random() * 0.4 + 0.08,
        phase: Math.random() * Math.PI * 2,
        speed: 0.25 + Math.random() * 0.9,
      }));
    }
    const t = Date.now() / 1000;
    ctx.fillStyle = '#ffffff';
    for (const s of this._stars) {
      const alpha = s.base + Math.sin(t * s.speed + s.phase) * 0.13;
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      // Larger stars get a faint glow via shadowBlur
      if (s.r > 1.15) {
        ctx.shadowColor = 'rgba(190,215,255,0.6)';
        ctx.shadowBlur  = s.r * 2.5;
      }
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
      if (s.r > 1.15) {
        ctx.shadowBlur  = 0;
        ctx.shadowColor = 'transparent';
      }
    }
    ctx.globalAlpha = 1;
  }

  _drawNodeShadow(ctx, node, proj) {
    const baseR  = this._nodeBaseRadius(node) * proj.scale;
    if (!isFinite(baseR) || baseR <= 0) return;
    const sx = proj.x + baseR * 0.2;
    const sy = proj.y + baseR * 0.78;
    const sw = baseR * 1.15;
    const sh = baseR * 0.32;
    const shadowGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, sw);
    shadowGrad.addColorStop(0,   'rgba(0,0,0,0.52)');
    shadowGrad.addColorStop(0.5, 'rgba(0,0,0,0.18)');
    shadowGrad.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.ellipse(sx, sy, sw, sh, 0, 0, Math.PI * 2);
    ctx.fillStyle = shadowGrad;
    ctx.fill();
  }

  _drawNode(ctx, node, proj) {
    const isHovered  = node === this.hovered;
    const isSelected = node === this.selected;
    const color      = this._nodeColor(node);
    const baseR  = this._nodeBaseRadius(node) * proj.scale;
    const radius = baseR * this._pulseScale(node);
    if (!isFinite(radius) || radius <= 0) return;

    const [r, g, b] = this._hexToRgb(color);
    const bright = [Math.min(255, Math.round(r * 1.7)), Math.min(255, Math.round(g * 1.7)), Math.min(255, Math.round(b * 1.7))];
    const dark   = [Math.round(r * 0.15), Math.round(g * 0.15), Math.round(b * 0.15)];

    // ── 1. Ambient bloom glow ─────────────────────────────────────────────────
    const glowR = radius * (isSelected ? 4 : 2.8);
    const glow  = ctx.createRadialGradient(proj.x, proj.y, radius * 0.2, proj.x, proj.y, glowR);
    glow.addColorStop(0,   `rgba(${r},${g},${b},${isSelected ? 0.32 : 0.2})`);
    glow.addColorStop(0.5, `rgba(${r},${g},${b},0.05)`);
    glow.addColorStop(1,   `rgba(${r},${g},${b},0)`);
    ctx.beginPath();
    ctx.arc(proj.x, proj.y, glowR, 0, Math.PI * 2);
    ctx.fillStyle = glow;
    ctx.fill();

    // ── 2. Selection / hover rings ────────────────────────────────────────────
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(proj.x, proj.y, radius + 9.5 * proj.scale, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${r},${g},${b},0.25)`;
      ctx.lineWidth   = 0.8 * proj.scale;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(proj.x, proj.y, radius + 4.5 * proj.scale, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${r},${g},${b},0.9)`;
      ctx.lineWidth   = 1.5 * proj.scale;
      ctx.stroke();
    } else if (isHovered) {
      ctx.beginPath();
      ctx.arc(proj.x, proj.y, radius + 3.5 * proj.scale, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth   = 1 * proj.scale;
      ctx.stroke();
    }

    // ── 3. Sphere body — 3D radial gradient (lit from upper-left) ─────────────
    const lx = proj.x - radius * 0.3;
    const ly = proj.y - radius * 0.36;
    const sphere = ctx.createRadialGradient(lx, ly, 0, proj.x, proj.y, radius);
    sphere.addColorStop(0,    `rgba(${bright[0]},${bright[1]},${bright[2]},1)`);
    sphere.addColorStop(0.42, `rgba(${r},${g},${b},1)`);
    sphere.addColorStop(1,    `rgba(${dark[0]},${dark[1]},${dark[2]},1)`);
    ctx.beginPath();
    ctx.arc(proj.x, proj.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = sphere;
    ctx.fill();

    // ── 4. Specular highlight — sharp glint at upper-left ─────────────────────
    const specX = proj.x - radius * 0.36;
    const specY = proj.y - radius * 0.41;
    const specR = radius * 0.44;
    const spec  = ctx.createRadialGradient(specX, specY, 0, specX, specY, specR);
    spec.addColorStop(0,    'rgba(255,255,255,0.88)');
    spec.addColorStop(0.38, 'rgba(255,255,255,0.2)');
    spec.addColorStop(1,    'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.arc(proj.x, proj.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = spec;
    ctx.fill();

    // ── 5. Thin rim border ────────────────────────────────────────────────────
    ctx.beginPath();
    ctx.arc(proj.x, proj.y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = isSelected
      ? 'rgba(255,255,255,0.45)'
      : `rgba(${bright[0]},${bright[1]},${bright[2]},0.22)`;
    ctx.lineWidth   = (isSelected ? 1.2 : 0.7) * proj.scale;
    ctx.stroke();

    // ── WS badge ─────────────────────────────────────────────────────────────
    if (node.hasWS) {
      const bx = proj.x + radius * 0.65, by = proj.y - radius * 0.65;
      const br = radius * 0.35;
      ctx.fillStyle = '#57a6f6';
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle    = '#07070c';
      ctx.font         = `bold ${Math.max(6, 7 * proj.scale)}px monospace`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('WS', bx, by);
    }

    // ── Labels and stats ──────────────────────────────────────────────────────
    if (proj.scale > 0.45 || isHovered || isSelected) {
      const labelSize = Math.max(9, 11 * proj.scale);
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';

      let displayLabel;
      if (node.kind === 'subdomain') {
        const parts = node.label.split('.');
        displayLabel = parts.length > 2 ? parts[0] : node.label;
      } else {
        displayLabel = node.label.length > 22 ? node.label.slice(0, 20) + '…' : node.label;
      }

      // Text shadow for legibility against the dark background
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur  = 5;
      ctx.fillStyle   = isSelected ? '#f0f0f0' : '#8a8a94';
      ctx.font        = `${labelSize}px 'SF Mono','Fira Code',monospace`;
      ctx.fillText(displayLabel, proj.x, proj.y + radius + 5 * proj.scale);
      ctx.shadowBlur  = 0;
      ctx.shadowColor = 'transparent';

      let yOff = proj.y + radius + 5 * proj.scale + labelSize + 2;

      if (node.requestCount > 0) {
        const avg = Math.round(node.totalDuration / node.requestCount);
        ctx.fillStyle = '#46464e';
        ctx.font      = `${Math.max(8, 9 * proj.scale)}px monospace`;
        ctx.fillText(`${node.requestCount}req · ${avg}ms`, proj.x, yOff);
        yOff += Math.max(8, 9 * proj.scale) + 2;
      }

      if (node.recentReqs.length && proj.scale > 0.55) {
        const now    = Date.now();
        const perSec = node.recentReqs.filter(t => now - t < 1000).length;
        const lastAt = node.recentReqs[node.recentReqs.length - 1];
        const fade   = Math.max(0, 1 - (now - lastAt) / 2000);
        if (perSec > 0 && fade > 0) {
          const outerAlpha = ctx.globalAlpha;
          ctx.globalAlpha  = outerAlpha * fade;
          ctx.fillStyle    = '#3dd68c';
          ctx.font         = `bold ${Math.max(8, 9 * proj.scale)}px monospace`;
          ctx.fillText(`${perSec}/s`, proj.x, yOff);
          ctx.globalAlpha  = outerAlpha;
          yOff += Math.max(8, 9 * proj.scale) + 2;
        }
      }

      if ((isHovered || isSelected) && node.types) {
        const TYPE_COLOR = {
          fetch: '#5b6af0', script: '#f5a623', stylesheet: '#3dd68c',
          image: '#57a6f6', font: '#8a8a94', document: '#7b8af8',
          websocket: '#57a6f6', other: '#46464e',
        };
        const TYPE_LABEL = {
          fetch: 'XHR', script: 'JS', stylesheet: 'CSS',
          image: 'IMG', font: 'FONT', document: 'DOC',
          websocket: 'WS', other: '?',
        };
        const top    = Object.entries(node.types).sort((a, b) => b[1] - a[1]).slice(0, 3);
        const bSize  = Math.max(7, 8 * proj.scale);
        const bGap   = 24 * proj.scale;
        const bStart = proj.x - (top.length - 1) * bGap / 2;
        ctx.font = `${bSize}px monospace`;
        top.forEach(([type], i) => {
          ctx.fillStyle = TYPE_COLOR[type] || '#46464e';
          ctx.fillText(TYPE_LABEL[type] || type.slice(0, 3).toUpperCase(), bStart + i * bGap, yOff + 2);
        });
      }
    }

    // ── SSL indicator dot ─────────────────────────────────────────────────────
    if (node.kind !== 'page' && node.isHttps !== null) {
      const dotColor = !node.isHttps                    ? '#e5534b'
                     : node.sslProtocol === 'TLS 1.3'  ? '#3dd68c'
                     : '#f5a623';
      const dotR = Math.max(2.5, 3.5 * proj.scale);
      const dx   = proj.x + radius * 0.72;
      const dy   = proj.y + radius * 0.72;
      const [dr, dg, db] = this._hexToRgb(dotColor);
      const dotGlow = ctx.createRadialGradient(dx, dy, 0, dx, dy, dotR * 2.8);
      dotGlow.addColorStop(0, `rgba(${dr},${dg},${db},0.65)`);
      dotGlow.addColorStop(1, `rgba(${dr},${dg},${db},0)`);
      ctx.beginPath();
      ctx.arc(dx, dy, dotR * 2.8, 0, Math.PI * 2);
      ctx.fillStyle = dotGlow;
      ctx.fill();
      ctx.fillStyle   = dotColor;
      ctx.beginPath();
      ctx.arc(dx, dy, dotR, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#07070c';
      ctx.lineWidth   = 0.8;
      ctx.stroke();
    }

    ctx.textBaseline = 'alphabetic';
  }

  _hexToRgb(hex) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
  }

  _nodeBaseRadius(node) {
    if (node.kind === 'page') return 18;
    const min = node.kind === 'subdomain' ? 5 : 9;
    return min + Math.log1p(node.requestCount) * 3.2;
  }

  _nodeColor(node) {
    if (node.kind === 'page') return '#7b8af8';
    const total     = node.requestCount || 1;
    const errorRate = (node.serverErrors + node.clientErrors) / total;
    const avgMs     = node.totalDuration / total;
    if (node.serverErrors > 0 && errorRate > 0.4) return '#e5534b';
    if (node.clientErrors > 0 && errorRate > 0.5) return '#f5a623';
    if (avgMs > 3000) return '#e8692a';
    if (avgMs > 1000) return '#f5a623';
    return '#3dd68c';
  }

  _pulseScale(node) {
    const elapsed = Date.now() - node.pulseAt;
    if (elapsed > 600) return 1;
    const t = elapsed / 600;
    return 1 + 0.25 * Math.sin(t * Math.PI) * (1 - t);
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  _bindEvents() {
    const c = this.canvas;

    c.addEventListener('mousedown', e => {
      this.drag.active = true;
      this.drag.lastX  = e.clientX;
      this.drag.lastY  = e.clientY;
      this.drag.dist   = 0;
    });

    c.addEventListener('mousemove', e => {
      if (this.drag.active) {
        const dx = e.clientX - this.drag.lastX;
        const dy = e.clientY - this.drag.lastY;
        this.drag.dist  += Math.abs(dx) + Math.abs(dy);
        this.cam.rotY   += dx * 0.004;
        this.cam.rotX   += dy * 0.004;
        this.cam.rotX    = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.cam.rotX));
        this.drag.lastX  = e.clientX;
        this.drag.lastY  = e.clientY;
      } else {
        this._hitTest(e);
      }
    });

    c.addEventListener('mouseup', e => {
      if (this.drag.active && this.drag.dist < 5) this._handleClick(e);
      this.drag.active = false;
    });

    c.addEventListener('mouseleave', () => {
      this.drag.active = false;
      if (this.hovered) {
        this.hovered = null;
        c.dispatchEvent(new CustomEvent('nodeUnhovered', { bubbles: true }));
      }
      c.style.cursor = 'default';
    });

    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.cam.zoom *= e.deltaY > 0 ? 0.92 : 1.09;
      this.cam.zoom  = Math.max(0.2, Math.min(6, this.cam.zoom));
    }, { passive: false });

    // F — frame all nodes
    document.addEventListener('keydown', e => {
      if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey)
        this._frameAll();
    });
  }

  _hitTest(e) {
    const rect = this.canvas.getBoundingClientRect();
    const cx   = e.clientX - rect.left;
    const cy   = e.clientY - rect.top;
    const prev = this.hovered;

    this.hovered = null;
    let closest = Infinity;
    for (const node of this.nodes.values()) {
      const proj = this._project(node.x, node.y, node.z);
      const r    = this._nodeBaseRadius(node) * proj.scale + 6;
      const d    = Math.hypot(cx - proj.x, cy - proj.y);
      if (d < r && d < closest) { closest = d; this.hovered = node; }
    }

    this.canvas.style.cursor = this.hovered ? 'pointer' : 'grab';

    if (this.hovered !== prev) {
      if (this.hovered)
        this.canvas.dispatchEvent(new CustomEvent('nodeHovered', { detail: this.hovered, bubbles: true }));
      else
        this.canvas.dispatchEvent(new CustomEvent('nodeUnhovered', { bubbles: true }));
    }
  }

  _handleClick(e) {
    if (this.hovered) {
      this.selected = this.hovered;
      this.canvas.dispatchEvent(new CustomEvent('nodeSelected', { detail: this.selected, bubbles: true }));
    } else {
      this.selected = null;
      this.canvas.dispatchEvent(new CustomEvent('nodeDeselected', { bubbles: true }));
    }
  }

  _frameAll() {
    if (this.nodes.size === 0) return;
    let maxR = 0;
    for (const n of this.nodes.values()) maxR = Math.max(maxR, Math.hypot(n.x, n.y, n.z));
    this.cam.rotX = 0.35;
    this.cam.rotY = 0.2;
    this.cam.zoom = maxR > 0 ? Math.min(2, Math.max(0.3, 400 / maxR)) : 1;
  }

  // ── Animation loop ─────────────────────────────────────────────────────────

  _loop() {
    const needsSim = this._simActive || this._forceActive > 0 || this.particles.length > 0;
    if (needsSim) {
      this._simulate();
      if (this._forceActive > 0) this._forceActive--;
    }
    this._draw();
    requestAnimationFrame(() => this._loop());
  }
}
