// NetPhantom Panel — v23
// Per-page sessions: each navigation archives the current page into its own tab.
// The graph + table always show only the selected page's traffic.
// "Session" tab aggregates everything on-demand.

'use strict';

(() => {
  // ── Session state ──────────────────────────────────────────────────────────
  //
  // allRequests          — every request seen since DevTools opened (for Session tab)
  // currentPageRequests  — requests for the page currently loading
  // currentPageUrl       — URL/origin of the page currently loading
  // archivedPages        — array of { id, url, requests[] } — one per past navigation
  // activeTabId          — 'current' | 'session' | archived-page id

  let allRequests            = [];
  let currentPageRequests    = [];
  let currentPageUrl         = '';
  let currentPageRefreshCount = 0;
  let archivedPages          = [];
  let activeTabId            = 'current';

  // Other panel state
  let paused       = false;
  let selectedReq  = null;
  let filterDomain = null;
  let sidebarMode  = 'placeholder';

  const analyzer = new NetworkAnalyzer();

  // ── Graph ──────────────────────────────────────────────────────────────────

  const canvas = document.getElementById('graph-canvas');
  const wrap   = document.getElementById('canvas-wrap');
  const graph  = new ForceGraph3D(canvas);

  // ── World map ──────────────────────────────────────────────────────────────

  const mapPanelEl      = document.getElementById('map-panel');
  const mapResizeHandle = document.getElementById('map-resize-handle');
  const worldMap        = new WorldMap(document.getElementById('map-canvas'));
  let   mapVisible      = true; // on by default

  // Fetch world topology immediately in the background.
  worldMap.init();

  // Open the map on first paint — rAF ensures the panel has layout dimensions.
  requestAnimationFrame(() => {
    mapPanelEl.classList.add('visible');
    mapResizeHandle.classList.add('visible');
    document.getElementById('btn-map').classList.add('active');
    worldMap.resize(mapPanelEl.clientWidth, mapPanelEl.clientHeight);
    resizeCanvas(); // re-fit graph canvas to its now-narrower width
  });

  new ResizeObserver(() => {
    if (mapVisible) worldMap.resize(mapPanelEl.clientWidth, mapPanelEl.clientHeight);
  }).observe(mapPanelEl);

  function rebuildMap() {
    if (!mapVisible) return;
    worldMap.clear();
    const reqs = baseRequests();
    let hasDots = false;

    // Page-origin source node
    const pageKey   = geoHostKey(currentPageUrl);
    const sourceGeo = pageKey ? geoCache.get(pageKey) : null;
    if (sourceGeo) { worldMap.addSource(sourceGeo.lat, sourceGeo.lng, pageKey); hasDots = true; }

    const seenEdge = new Set();
    for (const req of reqs) {
      const key = geoHostKey(req.url);
      const geo = key ? geoCache.get(key) : null;
      if (!geo) continue;
      worldMap.addDot(geo.lat, geo.lng, req.status, key);
      hasDots = true;

      if (sourceGeo) {
        const ek = `${Math.round(sourceGeo.lat)},${Math.round(sourceGeo.lng)}→${Math.round(geo.lat)},${Math.round(geo.lng)}`;
        if (!seenEdge.has(ek) && !(sourceGeo.lat === geo.lat && sourceGeo.lng === geo.lng)) {
          seenEdge.add(ek);
          worldMap.addEdge(sourceGeo.lat, sourceGeo.lng, geo.lat, geo.lng, req.status);
        }
      }
    }
    const emptyEl = document.getElementById('map-empty');
    if (emptyEl) emptyEl.style.display = hasDots ? 'none' : '';
  }

  document.getElementById('btn-map').addEventListener('click', () => {
    mapVisible = !mapVisible;
    mapPanelEl.classList.toggle('visible', mapVisible);
    mapResizeHandle.classList.toggle('visible', mapVisible);
    document.getElementById('btn-map').classList.toggle('active', mapVisible);
    if (mapVisible) {
      requestAnimationFrame(() => {
        worldMap.resize(mapPanelEl.clientWidth, mapPanelEl.clientHeight);
        rebuildMap();
      });
    }
    resizeCanvas();
  });

  // Drag the handle between graph and map to resize the map panel
  let mapDragging = false;
  mapResizeHandle.addEventListener('mousedown', e => {
    mapDragging = true; mapResizeHandle.classList.add('dragging'); e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!mapDragging) return;
    const upperRect = document.getElementById('upper').getBoundingClientRect();
    const newW = Math.max(260, Math.min(upperRect.width * 0.65, upperRect.right - e.clientX));
    mapPanelEl.style.width = newW + 'px';
    worldMap.resize(mapPanelEl.clientWidth, mapPanelEl.clientHeight);
  });
  document.addEventListener('mouseup', () => {
    if (!mapDragging) return;
    mapDragging = false; mapResizeHandle.classList.remove('dragging');
  });

  // ── Map interaction (hover tooltip + click-to-filter) ──────────────────────

  const mapCanvas  = document.getElementById('map-canvas');
  const mapTooltip = document.getElementById('map-tooltip');

  mapCanvas.addEventListener('mousemove', e => {
    const rect = mapCanvas.getBoundingClientRect();
    const lx   = e.clientX - rect.left;
    const ly   = e.clientY - rect.top;
    const hit  = worldMap.hitTest(lx, ly);

    if (hit) {
      mapCanvas.style.cursor = 'pointer';
      worldMap.setHover(hit);

      const isSource  = !!hit.hostname && !hit.hostnames;
      const hostnames = hit.hostnames ?? (hit.hostname ? [hit.hostname] : []);
      const firstHost = hostnames[0] || '';
      const geo       = firstHost ? geoCache.get(firstHost) : null;
      const loc       = geo ? [geo.city, geo.country].filter(Boolean).join(', ') : '';

      const hostHTML  = hostnames.length > 1
        ? hostnames.slice(0, 3).join('<br>') + (hostnames.length > 3 ? `<br><span style="color:var(--text-3)">+${hostnames.length - 3} more</span>` : '')
        : firstHost || '—';

      const reqs = baseRequests().filter(r => hostnames.includes(geoHostKey(r.url)));
      const errs = reqs.filter(r => !r.status || r.status >= 400).length;
      const avgMs = reqs.length
        ? Math.round(reqs.reduce((s, r) => s + (r.duration || 0), 0) / reqs.length)
        : 0;

      mapTooltip.innerHTML = `
        <div class="mtt-host">${hostHTML}</div>
        ${loc ? `<div class="mtt-loc">${loc}</div>` : ''}
        <div class="mtt-stats">
          <span>Requests</span><span>${hit.count}</span>
          ${avgMs ? `<span>Avg</span><span>${avgMs}ms</span>` : ''}
          ${errs  ? `<span style="color:var(--red)">Errors</span><span style="color:var(--red)">${errs}</span>` : ''}
        </div>
        ${firstHost ? '<div class="mtt-hint">Click to filter requests</div>' : ''}
      `;

      // Position relative to #map-panel
      const panelRect = mapPanelEl.getBoundingClientRect();
      let tx = e.clientX - panelRect.left + 14;
      let ty = e.clientY - panelRect.top  - 10;
      if (tx + 230 > panelRect.width)  tx = e.clientX - panelRect.left - 230 - 14;
      if (ty + mapTooltip.offsetHeight > panelRect.height) ty = panelRect.height - mapTooltip.offsetHeight - 4;
      if (ty < 4) ty = 4;
      mapTooltip.style.left    = tx + 'px';
      mapTooltip.style.top     = ty + 'px';
      mapTooltip.style.display = 'block';
    } else {
      mapCanvas.style.cursor   = '';
      worldMap.setHover(null);
      mapTooltip.style.display = 'none';
    }
  });

  mapCanvas.addEventListener('mouseleave', () => {
    mapCanvas.style.cursor   = '';
    worldMap.setHover(null);
    mapTooltip.style.display = 'none';
  });

  mapCanvas.addEventListener('click', e => {
    const rect = mapCanvas.getBoundingClientRect();
    const hit  = worldMap.hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    const hostnames = hit.hostnames ?? (hit.hostname ? [hit.hostname] : []);
    const host = hostnames[0];
    if (!host) return;
    // Toggle filter: clicking same host again clears it
    if (filterDomain === host) {
      graph.deselect();
      setFilterDomain(null);
    } else {
      setFilterDomain(host);
    }
  });

  // ── Section close / restore ────────────────────────────────────────────────

  const upperEl        = document.getElementById('upper');
  const requestsBarEl  = document.getElementById('requests-bar');
  const tableWrapEl    = document.getElementById('req-bar-table-wrap');
  const searchRowEl    = document.getElementById('req-bar-search-row');
  const graphRestoreEl = document.getElementById('graph-restore-bar');
  const tableRestoreEl = document.getElementById('table-restore-bar');

  function setGraphVisible(visible) {
    upperEl.style.display = visible ? '' : 'none';
    // hResizeHandle is declared later in the resize section — look it up directly
    const hRH = document.getElementById('h-resize-handle');
    if (hRH) hRH.style.display = visible ? '' : 'none';
    graphRestoreEl.classList.toggle('visible', !visible);
    if (visible) resizeCanvas();
  }

  function setTableVisible(visible) {
    tableWrapEl.style.display  = visible ? '' : 'none';
    searchRowEl.style.display  = visible ? '' : 'none';
    tableRestoreEl.classList.toggle('visible', !visible);
  }

  document.getElementById('close-graph-btn').addEventListener('click', () => setGraphVisible(false));
  document.getElementById('restore-graph-btn').addEventListener('click', () => setGraphVisible(true));

  document.getElementById('close-table-btn').addEventListener('click', () => setTableVisible(false));
  document.getElementById('restore-table-btn').addEventListener('click', () => setTableVisible(true));

  document.getElementById('close-map-btn').addEventListener('click', () => {
    // reuse the same toggle logic as the toolbar ◉ Map button
    document.getElementById('btn-map').click();
  });

  document.getElementById('close-sidebar-btn').addEventListener('click', () => {
    setSidebarMode('placeholder');
  });

  // ── IP geolocation ─────────────────────────────────────────────────────────
  //
  // Uses the bundled geoip-data.js (DB-IP Lite, CC BY 4.0) for offline lookup.
  // geoLookup(ip) is synchronous; no network calls, no privacy side-channel.
  // Cache key = hostname (one entry per unique domain).

  const geoCache = new Map(); // hostname → { lat, lng, country, city } | null

  function geoHostKey(url) {
    try { return new URL(url).hostname; } catch { return null; }
  }

  function queueGeo(req) {
    const key = geoHostKey(req.url);
    if (!key || geoCache.has(key)) return;
    const ip = req.serverIP && !isPrivateIP(req.serverIP) ? req.serverIP : null;
    if (!ip) return;
    const geo = (typeof geoLookup === 'function') ? geoLookup(ip) : null;
    geoCache.set(key, geo);
    if (mapVisible) rebuildMap();
  }

  function isPrivateIP(ip) {
    return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|localhost)/i.test(ip);
  }

  function resizeCanvas() {
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (w > 0 && h > 0) graph.resize(w, h);
  }
  requestAnimationFrame(resizeCanvas);
  new ResizeObserver(resizeCanvas).observe(wrap);

  // ── Service-worker port ────────────────────────────────────────────────────

  let tabId = 0;
  try { tabId = chrome.devtools?.inspectedWindow?.tabId ?? 0; } catch (_) {}
  if (!tabId) tabId = parseInt(new URLSearchParams(location.search).get('tab'), 10) || 0;

  let swPort = null;

  function connectSW() {
    if (!tabId) return;
    try { swPort = chrome.runtime.connect({ name: `panel-${tabId}` }); } catch { return; }

    swPort.onMessage.addListener(msg => {
      if (msg.type === 'NETWORK_DATA') addRequest(msg.data);
      if (msg.type === 'NAVIGATED')    onNavigated(msg.url);
      if (msg.type === 'INIT_URL')     initUrl(msg.url);
    });

    swPort.onDisconnect.addListener(() => {
      swPort = null;
      const err = chrome.runtime.lastError?.message ?? '';
      if (err.includes('invalidated') || err.includes('unloaded')) return;
      setTimeout(connectSW, 200);
    });

  }
  connectSW();

  // ── Core data handlers ─────────────────────────────────────────────────────

  function addRequest(req) {
    if (paused) return;

    // Detect whether this is the first request we've ever seen for this page.
    const inferringUrl = !currentPageUrl && req.url;

    allRequests.push(req);
    currentPageRequests.push(req);
    updateCurrentTabCount();

    const hint = document.getElementById('empty-hint');
    if (hint) hint.style.display = 'none';

    // Infer the current page URL from the first request (DevTools opened on an
    // already-loaded page, so no onNavigated or INIT_URL arrived yet).
    if (inferringUrl) {
      try {
        const u = new URL(req.url);
        if (u.hostname && u.protocol !== 'data:' && !req.url.startsWith('chrome-extension:')) {
          currentPageUrl = req.url;
          document.getElementById('stat-page').textContent = req.url;
          // Push happened above, so rebuild sees this request.
          switchNavTab('current');
          return;
        }
      } catch {}
    }

    if (activeTabId === 'current' || activeTabId === 'session') {
      graph.addRequest(req);
      updateTable();
      updateStatusBar();
      scheduleInsightsRefresh();
    }

    // Queue geo lookup for every request — hostname is the dedup key
    queueGeo(req);
  }

  // Called once on panel attach with the URL of the already-open page.
  // Only sets currentPageUrl — never clears requests or archives anything.
  function initUrl(url) {
    if (currentPageUrl) return; // already populated (first request beat us here)
    try {
      const u = new URL(url);
      if (u.hostname && u.protocol !== 'data:' && !url.startsWith('chrome-extension:')) {
        currentPageUrl = url;
        document.getElementById('stat-page').textContent = url;
        switchNavTab('current'); // force focus onto the now-labeled tab
      }
    } catch {}
  }

  // On same-origin navigations (refreshes): reset in place, no new tab.
  // On cross-origin navigations: archive the current page, start fresh.
  function onNavigated(url) {
    document.getElementById('stat-page').textContent = url;

    let newHost = '', curHost = '';
    try { newHost = new URL(url).hostname; }          catch {}
    try { curHost = new URL(currentPageUrl).hostname; } catch {}

    const sameOrigin = newHost && curHost && newHost === curHost;

    if (sameOrigin) {
      // Reload of the same site — bump counter, reset requests, keep the tab
      currentPageRefreshCount++;
      currentPageRequests = [];
      currentPageUrl      = url;

      // Flash the current tab amber so the user knows something happened
      navCurrentTab.classList.remove('refreshed');
      void navCurrentTab.offsetWidth; // force reflow to restart the animation
      navCurrentTab.classList.add('refreshed');
    } else {
      // Navigated away — archive what we have, reset counter.
      // Determine the label for the archive: prefer currentPageUrl (set by a
      // previous nav event or inferred from the first request). Never fall back
      // to the NEW url — that's the bug that made the tab look one step behind.
      if (currentPageRequests.length > 0) {
        let archiveUrl = currentPageUrl;
        if (!archiveUrl) {
          try { archiveUrl = new URL(currentPageRequests[0].url).origin; } catch {}
        }
        if (archiveUrl) {
          archivedPages.push({
            id:           `page-${Date.now()}`,
            url:          archiveUrl,
            requests:     currentPageRequests.slice(),
            refreshCount: currentPageRefreshCount,
          });
        }
      }
      currentPageUrl          = url;
      currentPageRequests     = [];
      currentPageRefreshCount = 0;
    }

    activeTabId  = 'current';
    selectedReq  = null;
    filterDomain = null;
    filterPill.classList.remove('visible');

    graph.clear();
    if (mapVisible) worldMap.clear();
    setSidebarMode('placeholder');
    updateTable();
    updateStatusBar();
    renderNavBar();

    const hint = document.getElementById('empty-hint');
    if (hint) hint.style.display = '';
    const mapEmpty = document.getElementById('map-empty');
    if (mapEmpty && mapVisible) mapEmpty.style.display = '';
  }

  // ── "What requests are shown right now?" ───────────────────────────────────

  function baseRequests() {
    if (activeTabId === 'current') return currentPageRequests;
    if (activeTabId === 'session') return allRequests;
    const page = archivedPages.find(p => p.id === activeTabId);
    return page ? page.requests : [];
  }

  // ── Nav bar ────────────────────────────────────────────────────────────────

  const navPages      = document.getElementById('nav-pages');
  const navCurrentTab = document.getElementById('nav-current-tab');
  const navSessionTab = document.getElementById('nav-session-tab');

  navSessionTab.addEventListener('click', () => switchNavTab('session'));
  navCurrentTab.addEventListener('click', () => switchNavTab('current'));

  function renderNavBar() {
    navPages.innerHTML = '';

    // One button per archived page
    archivedPages.forEach((page, i) => {
      const btn   = document.createElement('button');
      btn.className = `nav-tab${activeTabId === page.id ? ' active' : ''}`;
      btn.title     = page.url;

      const label = document.createElement('span');
      label.className   = 'nav-tab-label';
      label.textContent = pageLabel(page.url);
      btn.appendChild(label);

      if (page.refreshCount > 0) {
        const rb = document.createElement('span');
        rb.className   = 'nav-refresh-badge';
        rb.textContent = `↺${page.refreshCount}`;
        btn.appendChild(rb);
      }

      const count = document.createElement('span');
      count.className   = 'nav-tab-count';
      count.textContent = page.requests.length;
      btn.appendChild(count);

      const close = document.createElement('button');
      close.className   = 'nav-tab-close';
      close.textContent = '✕';
      close.title       = 'Remove';
      close.addEventListener('click', e => {
        e.stopPropagation();
        archivedPages.splice(i, 1);
        if (activeTabId === page.id) switchNavTab('current');
        else renderNavBar();
      });
      btn.appendChild(close);

      btn.addEventListener('click', () => switchNavTab(page.id));
      navPages.appendChild(btn);
    });

    // Scroll archived tabs so the newest (rightmost) is visible after a nav
    navPages.scrollLeft = navPages.scrollWidth;

    // Current tab label, refresh badge, active state
    navCurrentTab.classList.toggle('active', activeTabId === 'current');
    document.getElementById('nav-current-label').textContent =
      currentPageUrl ? pageLabel(currentPageUrl) : '—';
    const rb = document.getElementById('nav-refresh-badge');
    if (currentPageRefreshCount > 0) {
      rb.textContent     = `↺${currentPageRefreshCount}`;
      rb.style.display   = '';
    } else {
      rb.style.display   = 'none';
    }
    updateCurrentTabCount();

    // Session tab active state
    navSessionTab.classList.toggle('active', activeTabId === 'session');
  }

  function updateCurrentTabCount() {
    document.getElementById('nav-current-count').textContent = currentPageRequests.length;
  }

  function pageLabel(url) {
    try { return new URL(url).hostname; }
    catch { return url.slice(0, 28); }
  }

  // ── Switch the displayed page ──────────────────────────────────────────────

  function switchNavTab(tabId) {
    activeTabId  = tabId;
    selectedReq  = null;
    filterDomain = null;
    typeFilter   = '';
    errorFilter  = false;
    document.querySelectorAll('.type-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.type === ''));
    filterPill.classList.remove('visible');

    graph.rebuild(baseRequests());

    setSidebarMode('placeholder');
    updateTable();
    updateStatusBar();
    renderNavBar();
    rebuildMap();

    const hint = document.getElementById('empty-hint');
    if (hint) hint.style.display = baseRequests().length === 0 ? '' : 'none';
  }

  // ── Sidebar mode ───────────────────────────────────────────────────────────

  function setSidebarMode(mode) {
    sidebarMode = mode;
    const isOpen = mode === 'request' || mode === 'insights';
    document.getElementById('sidebar').classList.toggle('open', isOpen);
    document.getElementById('resize-handle').classList.toggle('visible', isOpen);

    document.getElementById('sb-request').style.display =
      mode === 'request'  ? 'flex' : 'none';
    document.getElementById('sb-insights').style.display =
      mode === 'insights' ? 'flex' : 'none';
    document.getElementById('btn-insights').classList.toggle('active', mode === 'insights');
  }

  // ── Request selection ──────────────────────────────────────────────────────

  function selectRequest(req) {
    selectedReq = req;
    setSidebarMode('request');
    populateRequestHeader(req);

    // Default to Params tab when the request has a body or query params
    let hasParams = false;
    try { hasParams = new URL(req.url).searchParams.size > 0; } catch {}
    const defaultTab = (req.postData || hasParams) ? 'params' : 'headers';

    document.querySelectorAll('#sidebar-tabs .tab-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === defaultTab));
    document.querySelectorAll('#sb-request .tab-pane').forEach(p =>
      p.classList.toggle('active', p.id === `tab-${defaultTab}`));
    populateSidebarTab(defaultTab);

    document.querySelectorAll('#req-tbody tr').forEach(tr => {
      tr.classList.toggle('selected', tr._req === req);
    });
  }

  function populateRequestHeader(req) {
    const col = reqStatusColor(req);
    document.getElementById('rq-method').textContent = req.method || 'GET';
    const statusEl = document.getElementById('rq-status-text');
    statusEl.textContent = fmtStatus(req);
    statusEl.style.color = col;
    // Show path only — domain is already in rq-domain; query params go in Headers tab
    let displayPath = req.url;
    try { displayPath = new URL(req.url).pathname; } catch {}
    document.getElementById('rq-url').textContent    = displayPath;
    document.getElementById('rq-url').title          = req.url;
    document.getElementById('rq-domain').textContent = reqOrigin(req.url);
    document.getElementById('rq-size').textContent   = formatBytes(req.size);
    document.getElementById('rq-dur').textContent    = req.duration != null ? req.duration + 'ms' : '—';
  }

  // ── Sidebar tabs (Headers / Timing / SSL) ──────────────────────────────────

  function populateSidebarTab(tab) {
    if (!selectedReq) return;
    if (tab === 'params')  populateParamsTab(selectedReq);
    if (tab === 'headers') populateHeadersTab(selectedReq);
    if (tab === 'timing')  populateTimingTab(selectedReq);
    if (tab === 'security') populateSSLTab(selectedReq);
  }

  document.querySelectorAll('#sidebar-tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#sidebar-tabs .tab-btn').forEach(b =>
        b.classList.toggle('active', b === btn));
      document.querySelectorAll('#sb-request .tab-pane').forEach(p =>
        p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`));
      populateSidebarTab(btn.dataset.tab);
    });
  });

  // ── Domain filter pill ─────────────────────────────────────────────────────

  const filterPill  = document.getElementById('node-filter-pill');
  const filterLabel = document.getElementById('node-filter-label');

  function setFilterDomain(domain) {
    filterDomain = domain;
    if (domain) {
      filterLabel.textContent = domain;
      filterPill.classList.add('visible');
    } else {
      filterPill.classList.remove('visible');
    }
    updateTable();
    if (sidebarMode !== 'insights') {
      const filtered = getFilteredRequests();
      if (filtered.length > 0) selectRequest(filtered[filtered.length - 1]);
      else if (!domain) setSidebarMode(selectedReq ? 'request' : 'placeholder');
    }
  }

  document.getElementById('node-filter-clear').addEventListener('click', () => {
    graph.deselect();
    setFilterDomain(null);
  });

  // ── Graph node events ──────────────────────────────────────────────────────

  canvas.addEventListener('nodeSelected',  e  => setFilterDomain(e.detail.label));
  canvas.addEventListener('nodeDeselected', () => setFilterDomain(null));

  // ── Hover tooltip ──────────────────────────────────────────────────────────

  const tooltip   = document.getElementById('tooltip');
  let tooltipNode = null;

  canvas.addEventListener('mousemove', e => {
    if (!tooltipNode) return;
    const rect = wrap.getBoundingClientRect();
    const tx = e.clientX - rect.left + 14;
    const ty = e.clientY - rect.top  - 10;
    tooltip.style.left = Math.min(tx, rect.width  - tooltip.offsetWidth  - 10) + 'px';
    tooltip.style.top  = Math.min(ty, rect.height - tooltip.offsetHeight - 10) + 'px';
  });

  canvas.addEventListener('nodeHovered', e => {
    tooltipNode = e.detail;
    const node  = tooltipNode;
    const avg   = node.requestCount > 0 ? Math.round(node.totalDuration / node.requestCount) : 0;
    const errs  = node.serverErrors + node.clientErrors;
    const topTypes = Object.entries(node.types || {})
      .sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([k, v]) => `${k} ×${v}`).join('  ');

    tooltip.innerHTML = `
      <div style="color:var(--text);font-weight:600;margin-bottom:5px;word-break:break-all">${node.label}</div>
      <div style="color:var(--text-3);font-size:9px;letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px">${node.kind}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;font-size:9.5px">
        <span style="color:var(--text-2)">Requests</span><span style="color:var(--text)">${node.requestCount}</span>
        <span style="color:var(--text-2)">Avg latency</span><span style="color:var(--text)">${avg ? avg + 'ms' : '—'}</span>
        <span style="color:var(--text-2)">Errors</span><span style="color:${errs > 0 ? 'var(--red)' : 'var(--text)'}">${errs}</span>
        <span style="color:var(--text-2)">Success</span><span style="color:var(--green)">${node.successCount}</span>
      </div>
      ${topTypes ? `<div style="margin-top:6px;color:var(--text-3);font-size:9px">${topTypes}</div>` : ''}
    `;
    tooltip.style.display = 'block';
  });

  canvas.addEventListener('nodeUnhovered', () => {
    tooltipNode = null;
    tooltip.style.display = 'none';
  });

  // ── Request table: sort + resize ──────────────────────────────────────────

  const reqSearch = document.getElementById('req-search');
  reqSearch.addEventListener('input', updateTable);

  let typeFilter  = '';
  let errorFilter = false;

  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      typeFilter = btn.dataset.type;
      document.querySelectorAll('.type-btn').forEach(b =>
        b.classList.toggle('active', b === btn));
      updateTable();
    });
  });

  // ── Status bar click actions ───────────────────────────────────────────────

  function resetAllFilters() {
    typeFilter   = '';
    errorFilter  = false;
    filterDomain = null;
    reqSearch.value = '';
    filterPill.classList.remove('visible');
    graph.deselect();
    document.querySelectorAll('.type-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.type === ''));
    updateTable();
  }

  document.getElementById('stat-item-reqs').addEventListener('click', resetAllFilters);

  document.getElementById('stat-item-errors').addEventListener('click', () => {
    errorFilter = !errorFilter;
    updateTable();
  });

  document.getElementById('stat-item-avg').addEventListener('click', () => {
    // Shortcut: sort by duration, toggle asc/desc
    if (sortCol === 'ms') {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortCol = 'ms';
      sortDir = 'desc';
    }
    updateTable();
  });

  let sortCol = null;
  let sortDir = 'asc';

  function initTableHeaders() {
    const defs = [
      { sel: '.col-status', key: 'status' },
      { sel: '.col-method', key: 'method' },
      { sel: '.col-domain', key: 'domain' },
      { sel: '.col-path',   key: 'path'   },
      { sel: '.col-type',   key: 'type'   },
      { sel: '.col-size',   key: 'size'   },
      { sel: '.col-ms',     key: 'ms'     },
    ];

    defs.forEach(({ sel, key }) => {
      const th = document.querySelector(`.req-table thead ${sel}`);
      if (!th) return;
      th.dataset.col = key;

      const sortIcon = document.createElement('span');
      sortIcon.className = 'sort-icon';
      th.appendChild(sortIcon);

      const resizer = document.createElement('span');
      resizer.className = 'col-resizer';
      th.appendChild(resizer);

      th.addEventListener('click', e => {
        if (resizer.contains(e.target)) return;
        if (sortCol === key) {
          if (sortDir === 'asc') sortDir = 'desc';
          else { sortCol = null; sortDir = 'asc'; }
        } else {
          sortCol = key; sortDir = 'asc';
        }
        updateTable();
      });

      let startX, startW;
      resizer.addEventListener('mousedown', e => {
        e.preventDefault();
        e.stopPropagation();
        startX = e.clientX;
        startW = th.offsetWidth;
        resizer.classList.add('dragging');

        const onMove = ev => {
          const w = Math.max(36, startW + ev.clientX - startX);
          th.style.width = w + 'px';
        };
        const onUp = () => {
          resizer.classList.remove('dragging');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      resizer.addEventListener('dblclick', e => {
        e.preventDefault();
        e.stopPropagation();
        autoFitCol(th);
      });
    });

    // Fit every header to its own content width on first render
    requestAnimationFrame(() => {
      document.querySelectorAll('.req-table thead th[data-col]').forEach(th => {
        th.style.width = (th.scrollWidth + 2) + 'px';
      });
    });
  }

  function autoFitCol(th) {
    const colIdx = Array.from(th.closest('tr').children).indexOf(th);
    let maxW = th.scrollWidth;
    document.querySelectorAll('#req-tbody tr').forEach(row => {
      const td = row.children[colIdx];
      if (td) maxW = Math.max(maxW, td.scrollWidth);
    });
    th.style.width = Math.min(maxW + 2, 500) + 'px';
  }

  function getFilteredRequests() {
    const base = baseRequests();
    const text = reqSearch.value.toLowerCase();
    return base.filter(r => {
      if (filterDomain) {
        const host = reqOrigin(r.url);
        if (host !== filterDomain && !host.endsWith('.' + filterDomain)) return false;
      }
      if (typeFilter   && r.type !== typeFilter)   return false;
      if (errorFilter  && !(r.status >= 400))      return false;
      if (text && !(r.url || '').toLowerCase().includes(text)) return false;
      return true;
    });
  }

  function updateTable() {
    // Reflect active filter states on status-bar chips
    document.getElementById('stat-item-errors').classList.toggle('stat-active', errorFilter);
    document.getElementById('stat-item-avg').classList.toggle('stat-active', sortCol === 'ms');

    const filtered = getFilteredRequests();
    const tbody    = document.getElementById('req-tbody');
    tbody.innerHTML = '';

    document.getElementById('req-bar-count').textContent =
      `${filtered.length} request${filtered.length !== 1 ? 's' : ''}`;

    // Update sort indicators
    document.querySelectorAll('.req-table thead th[data-col]').forEach(th => {
      const icon = th.querySelector('.sort-icon');
      if (!icon) return;
      if (th.dataset.col === sortCol) {
        icon.textContent = sortDir === 'asc' ? ' ▲' : ' ▼';
        th.dataset.sortDir = sortDir;
      } else {
        icon.textContent = '';
        delete th.dataset.sortDir;
      }
    });

    // Build display list: sort if active, otherwise show newest first
    let rows = filtered.slice();
    if (sortCol) {
      rows.sort((a, b) => {
        let av, bv;
        switch (sortCol) {
          case 'status': av = a.status || 0;     bv = b.status || 0;     break;
          case 'method': av = a.method || '';    bv = b.method || '';    break;
          case 'domain': av = reqOrigin(a.url);  bv = reqOrigin(b.url);  break;
          case 'path':
            try { av = new URL(a.url).pathname; } catch { av = ''; }
            try { bv = new URL(b.url).pathname; } catch { bv = ''; }
            break;
          case 'type':   av = a.type || '';      bv = b.type || '';      break;
          case 'size':   av = a.size || 0;       bv = b.size || 0;       break;
          case 'ms':     av = a.duration ?? 0;   bv = b.duration ?? 0;   break;
          default: return 0;
        }
        const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
        return sortDir === 'asc' ? cmp : -cmp;
      });
    } else {
      rows.reverse();
    }

    rows.slice(0, 500).forEach(req => {
      const tr = document.createElement('tr');
      tr._req  = req;
      if (req === selectedReq) tr.classList.add('selected');

      const col  = reqStatusColor(req);
      let host = '', path = req.url, fullPath = req.url;
      try {
        const u = new URL(req.url);
        host     = u.host;
        path     = u.pathname;
        fullPath = u.pathname + u.search;
      } catch {}

      tr.innerHTML = `
        <td class="col-status" style="color:${col}">${fmtStatus(req)}</td>
        <td class="col-method" style="color:var(--accent-2)">${req.method || '—'}</td>
        <td class="col-domain" title="${host}">${host}</td>
        <td class="col-path"   title="${fullPath}">${path}</td>
        <td class="col-type"   style="color:var(--text-3)">${req.type || 'other'}</td>
        <td class="col-size">${req.size > 0 ? formatBytes(req.size) : '—'}</td>
        <td class="col-ms">${req.duration != null ? req.duration + 'ms' : '—'}</td>
      `;
      tr.addEventListener('click', () => selectRequest(req));
      tbody.appendChild(tr);
    });
  }

  // ── Toolbar buttons ────────────────────────────────────────────────────────

  const btnPause = document.getElementById('btn-pause');
  const liveDot  = document.querySelector('.nav-live-dot');

  btnPause.addEventListener('click', () => {
    paused = !paused;
    btnPause.textContent = paused ? '▶ Resume' : '⏸ Pause';
    btnPause.classList.toggle('active', paused);
    document.getElementById('rec-chip').style.display = paused ? 'none' : '';
    if (liveDot) liveDot.classList.toggle('paused', paused);
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    graph.clear();
    allRequests             = [];
    currentPageRequests     = [];
    currentPageUrl          = '';
    currentPageRefreshCount = 0;
    archivedPages           = [];
    activeTabId         = 'current';
    selectedReq         = null;
    filterDomain        = null;
    filterPill.classList.remove('visible');
    document.getElementById('insights-list').innerHTML = '';
    document.getElementById('insights-empty').style.display = '';
    document.getElementById('empty-hint').style.display = '';
    document.getElementById('stat-page').textContent = '';
    // Clear geo state
    geoCache.clear();
    worldMap.clear();
    const mapEmpty = document.getElementById('map-empty');
    if (mapEmpty && mapVisible) mapEmpty.style.display = '';
    setSidebarMode('placeholder');
    updateTable();
    updateStatusBar();
    renderNavBar();
  });

  document.getElementById('btn-insights').addEventListener('click', () => {
    if (sidebarMode === 'insights') {
      setSidebarMode(selectedReq ? 'request' : 'placeholder');
    } else {
      setSidebarMode('insights');
      refreshInsights();
    }
  });

  document.getElementById('btn-export').addEventListener('click', () => {
    const src  = baseRequests();
    const har  = analyzer.exportHAR(graph.getNodes(), document.getElementById('stat-page').textContent);
    const blob = new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `netphantom-${Date.now()}.har`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ── Copy as cURL ───────────────────────────────────────────────────────────

  document.getElementById('btn-curl').addEventListener('click', () => {
    if (!selectedReq) return;
    const btn = document.getElementById('btn-curl');
    navigator.clipboard.writeText(buildCurl(selectedReq)).then(() => {
      btn.textContent = '✓ Copied';
      setTimeout(() => { btn.textContent = '⧉ cURL'; }, 1800);
    }).catch(() => {});
  });

  function buildCurl(req) {
    const esc = s => s.replace(/'/g, "'\\''");
    const parts = [`curl '${esc(req.url)}'`];

    if (req.method && req.method !== 'GET') {
      parts.push(`-X ${req.method}`);
    }

    const skip = new Set([':method', ':path', ':scheme', ':authority', 'content-length']);
    for (const h of (req.requestHeaders || [])) {
      if (skip.has(h.name.toLowerCase())) continue;
      parts.push(`-H '${esc(h.name)}: ${esc(h.value)}'`);
    }

    const pd = req.postData;
    if (pd?.params?.length) {
      const encoded = pd.params.map(p =>
        `${encodeURIComponent(p.name)}=${encodeURIComponent(p.value)}`).join('&');
      parts.push(`--data-urlencode '${esc(encoded)}'`);
    } else if (pd?.text) {
      parts.push(`--data '${esc(pd.text)}'`);
    }

    return parts.join(' \\\n  ');
  }

  // ── Params tab ─────────────────────────────────────────────────────────────

  function populateParamsTab(req) {
    const container = document.getElementById('params-content');
    container.innerHTML = '';
    let hasContent = false;

    // ── Query parameters ──────────────────────────────────────────────────────
    const qparams = [];
    try {
      new URL(req.url).searchParams.forEach((v, k) => qparams.push({ name: k, value: v }));
    } catch {}

    if (qparams.length) {
      hasContent = true;
      container.appendChild(makeKVSection('Query Parameters', qparams));
    }

    // ── Request body ──────────────────────────────────────────────────────────
    const pd = req.postData;
    if (pd) {
      hasContent = true;
      if (pd.params?.length) {
        // URL-encoded form data — show as key-value pairs
        container.appendChild(makeKVSection('Form Data', pd.params));
      } else if (pd.text) {
        const sec = document.createElement('div');
        sec.className = 'hdr-section';
        const title = document.createElement('div');
        title.className = 'section-title';
        title.textContent = 'Request Body';
        if (pd.mimeType) {
          const mime = document.createElement('span');
          mime.style.cssText = 'float:right;font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-3)';
          mime.textContent = pd.mimeType.split(';')[0];
          title.appendChild(mime);
        }
        sec.appendChild(title);

        let displayText = pd.text;
        try { displayText = JSON.stringify(JSON.parse(pd.text), null, 2); } catch {}

        const pre = document.createElement('pre');
        pre.style.cssText = 'font-family:var(--font-mono);font-size:10px;color:var(--text-2);'
          + 'white-space:pre-wrap;word-break:break-all;margin:0;line-height:1.6;padding-top:4px';
        pre.textContent = displayText;
        sec.appendChild(pre);
        container.appendChild(sec);
      }
    }

    if (!hasContent) {
      container.innerHTML = '<div style="color:var(--text-3);font-size:11px;padding:4px 0">No parameters or body</div>';
    }
  }

  function makeKVSection(title, pairs) {
    const sec = document.createElement('div');
    sec.className = 'hdr-section';
    const t = document.createElement('div');
    t.className = 'section-title'; t.textContent = title;
    sec.appendChild(t);
    pairs.forEach(h => {
      const row = document.createElement('div');
      row.className = 'hdr-row';
      const k = document.createElement('span');
      k.className = 'hdr-key'; k.textContent = h.name;
      const v = document.createElement('span');
      v.className = 'hdr-val'; v.textContent = h.value;
      row.appendChild(k); row.appendChild(v);
      sec.appendChild(row);
    });
    return sec;
  }

  // ── Headers tab ────────────────────────────────────────────────────────────

  function populateHeadersTab(req) {
    const container = document.getElementById('headers-content');
    container.innerHTML = '';

    const appendSection = (title, hdrs) => {
      if (!hdrs?.length) return;
      const sec = document.createElement('div');
      sec.className = 'hdr-section';
      const t = document.createElement('div');
      t.className = 'section-title'; t.textContent = title;
      sec.appendChild(t);
      hdrs.forEach(h => {
        const row = document.createElement('div');
        row.className = 'hdr-row';
        const k = document.createElement('span');
        k.className = 'hdr-key'; k.textContent = h.name;
        const v = document.createElement('span');
        v.className = 'hdr-val'; v.textContent = h.value;
        row.appendChild(k); row.appendChild(v);
        sec.appendChild(row);
      });
      container.appendChild(sec);
    };

    appendSection('Request Headers',  req.requestHeaders);
    appendSection('Response Headers', req.responseHeaders);
  }

  // ── Timing tab ─────────────────────────────────────────────────────────────

  function populateTimingTab(req) {
    const container = document.getElementById('timing-content');
    container.innerHTML = '';

    const timings = req.timings;
    if (!timings) {
      container.innerHTML = '<div style="color:var(--text-3);font-size:11px;padding:8px">No timing data</div>';
      return;
    }

    const keys = [
      { key: 'blocked', label: 'Blocked', color: '#8a8a94' },
      { key: 'dns',     label: 'DNS',     color: '#57a6f6' },
      { key: 'connect', label: 'Connect', color: '#f5a623' },
      { key: 'ssl',     label: 'SSL/TLS', color: '#3dd68c' },
      { key: 'send',    label: 'Send',    color: '#5b6af0' },
      { key: 'wait',    label: 'Waiting', color: '#7b8af8' },
      { key: 'receive', label: 'Receive', color: '#e8692a' },
    ];

    const total = Math.max(1, req.duration || 1);

    keys.forEach(({ key, label, color }) => {
      const val = timings[key];
      if (val == null || val < 0) return;
      const pct = Math.min(100, (val / total) * 100);
      const row = document.createElement('div');
      row.className = 'timing-row';
      row.innerHTML = `
        <span class="timing-label">${label}</span>
        <div class="timing-bar-wrap">
          <div class="timing-bar" style="width:${pct}%;background:${color}"></div>
        </div>
        <span class="timing-val">${val ? Math.round(val) + 'ms' : '—'}</span>
      `;
      container.appendChild(row);
    });

    const totalRow = document.createElement('div');
    totalRow.className = 'timing-row';
    totalRow.style.marginTop = '6px';
    totalRow.style.borderTop = '1px solid var(--border-hi)';
    totalRow.innerHTML = `
      <span class="timing-label" style="color:var(--text)">Total</span>
      <div></div>
      <span class="timing-val" style="color:var(--text)">${req.duration != null ? req.duration + 'ms' : '—'}</span>
    `;
    container.appendChild(totalRow);
  }

  // ── SSL tab ────────────────────────────────────────────────────────────────

  const SEC_HEADERS = [
    { key: 'strict-transport-security',    label: 'HSTS',               critical: true  },
    { key: 'content-security-policy',      label: 'CSP',                critical: true  },
    { key: 'x-frame-options',              label: 'X-Frame-Options',    critical: true  },
    { key: 'x-content-type-options',       label: 'X-Content-Type',     critical: false },
    { key: 'referrer-policy',              label: 'Referrer-Policy',    critical: false },
    { key: 'permissions-policy',           label: 'Permissions-Policy', critical: false },
    { key: 'cross-origin-opener-policy',   label: 'COOP',               critical: false },
    { key: 'cross-origin-embedder-policy', label: 'COEP',               critical: false },
  ];

  function populateSSLTab(req) {
    const container = document.getElementById('ssl-inspector-content');
    container.innerHTML = '';

    const ssl     = req?.ssl;
    const isHttps = req?.isHttps || req?.url?.startsWith('https://');
    const headers = {};
    for (const h of (req?.responseHeaders || [])) headers[h.name.toLowerCase()] = h.value;

    const certRows = [];
    if (!isHttps) {
      certRows.push(makeSslRow('', 'HTTP — no TLS', 'err'));
    } else if (!ssl) {
      certRows.push(makeSslRow('', 'No certificate data — reload with DevTools open to capture handshake', ''));
    } else {
      if (ssl.subjectName) certRows.push(makeSslRow('Subject',    ssl.subjectName));
      if (ssl.issuer)      certRows.push(makeSslRow('Issuer',     ssl.issuer));
      if (ssl.validFrom)   certRows.push(makeSslRow('Valid From', new Date(ssl.validFrom * 1000).toLocaleDateString()));
      if (ssl.validTo) {
        const daysLeft = Math.floor((ssl.validTo * 1000 - Date.now()) / 86400000);
        const cls  = daysLeft < 0 ? 'err' : daysLeft < 14 ? 'warn' : 'ok';
        const note = daysLeft < 0 ? ' (expired)' : ` (${daysLeft}d remaining)`;
        certRows.push(makeSslRow('Valid To', new Date(ssl.validTo * 1000).toLocaleDateString() + note, cls));
      }
      if (ssl.sanList?.length) {
        const extra = ssl.sanList.length > 8 ? ` +${ssl.sanList.length - 8} more` : '';
        certRows.push(makeSslRow('SANs', ssl.sanList.slice(0, 8).join(', ') + extra));
      }
      certRows.push(makeSslRow('EV Cert', ssl.isEV ? 'Yes' : 'No', ssl.isEV ? 'ok' : ''));
      if (ssl.ct) certRows.push(makeSslRow('CT', ssl.ct));
    }
    container.appendChild(makeSslSection('Certificate', certRows));

    if (ssl?.protocol) {
      const protoCls = ssl.protocol === 'TLS 1.3' ? 'ok' : ssl.protocol === 'TLS 1.2' ? 'warn' : 'err';
      const tlsRows  = [];
      tlsRows.push(makeSslRow('Protocol', ssl.protocol, protoCls));
      if (ssl.cipher)           tlsRows.push(makeSslRow('Cipher',       ssl.cipher));
      if (ssl.keyExchange)      tlsRows.push(makeSslRow('Key Exchange', ssl.keyExchange));
      if (ssl.keyExchangeGroup) tlsRows.push(makeSslRow('Group',        ssl.keyExchangeGroup));
      container.appendChild(makeSslSection('TLS', tlsRows));
    }

    const shRows = SEC_HEADERS.map(h => {
      const val = headers[h.key];
      const row = document.createElement('div');
      row.className = 'ssl-check-row';
      const icon = document.createElement('span');
      icon.className = 'ssl-check-icon';
      icon.textContent = val ? '✓' : '✗';
      icon.style.color = val ? 'var(--green)' : (h.critical ? 'var(--red)' : 'var(--text-3)');
      const name = document.createElement('span');
      name.className = 'ssl-check-name'; name.textContent = h.label;
      name.style.color = val ? 'var(--text-2)' : 'var(--text-3)';
      const valSpan = document.createElement('span');
      valSpan.className = 'ssl-check-val';
      if (val) { valSpan.textContent = val.length > 40 ? val.slice(0, 38) + '…' : val; valSpan.style.color = 'var(--text-3)'; }
      else { valSpan.textContent = 'missing'; valSpan.style.color = h.critical ? 'var(--red)' : 'var(--text-3)'; }
      row.appendChild(icon); row.appendChild(name); row.appendChild(valSpan);
      return row;
    });
    container.appendChild(makeSslSection('Security Headers', shRows));
  }

  function makeSslSection(title, rows) {
    const sec = document.createElement('div');
    sec.className = 'ssl-section';
    const t = document.createElement('div');
    t.className = 'section-title'; t.textContent = title;
    sec.appendChild(t);
    rows.forEach(r => sec.appendChild(r));
    return sec;
  }

  function makeSslRow(key, val, cls = '') {
    const row = document.createElement('div');
    row.className = 'ssl-row';
    const k = document.createElement('div');
    k.className = 'ssl-row-key'; k.textContent = key;
    const v = document.createElement('div');
    v.className = `ssl-row-val${cls ? ' ' + cls : ''}`; v.textContent = val;
    row.appendChild(k); row.appendChild(v);
    return row;
  }

  // ── AI Insights ────────────────────────────────────────────────────────────

  let insightsTimeout = null;

  function scheduleInsightsRefresh() {
    clearTimeout(insightsTimeout);
    insightsTimeout = setTimeout(refreshInsights, 2000);
  }

  function refreshInsights() {
    const insights = analyzer.analyze(graph.getNodes());
    const list     = document.getElementById('insights-list');
    const empty    = document.getElementById('insights-empty');

    list.innerHTML = '';

    if (insights.length === 0) { empty.style.display = ''; return; }
    empty.style.display = 'none';

    const order = { error: 0, warning: 1, info: 2, ok: 3 };
    insights.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));

    insights.forEach(ins => {
      const card = document.createElement('div');
      card.className = `insight-card severity-${ins.severity}`;
      card.innerHTML = `
        <div class="insight-icon">${ins.icon}</div>
        <div class="insight-body">
          <div class="insight-title">${ins.title}</div>
          <div class="insight-detail">${ins.detail}</div>
        </div>
      `;
      if (ins.nodeId) {
        card.addEventListener('click', () => {
          setFilterDomain(ins.nodeId);
          if (sidebarMode === 'insights') setSidebarMode(selectedReq ? 'request' : 'placeholder');
        });
      }
      list.appendChild(card);
    });
  }

  // ── Status bar ─────────────────────────────────────────────────────────────

  function updateStatusBar() {
    const base    = baseRequests();
    const domains = Array.from(graph.getNodes().values()).filter(n => n.kind === 'domain').length;
    const errs    = base.filter(r => r.status >= 400).length;
    const totalMs = base.reduce((s, r) => s + (r.duration > 0 ? r.duration : 0), 0);
    const avg     = base.length > 0 ? Math.round(totalMs / base.length) : 0;

    document.getElementById('stat-reqs').textContent    = `${base.length} request${base.length !== 1 ? 's' : ''}`;
    document.getElementById('stat-domains').textContent = `${domains} origin${domains !== 1 ? 's' : ''}`;
    document.getElementById('stat-avg').textContent     = avg ? `avg ${avg}ms` : 'avg —';
    document.getElementById('stat-errors').textContent  = `${errs} error${errs !== 1 ? 's' : ''}`;
    document.getElementById('stat-errors').style.color  = errs > 0 ? 'var(--red)' : '';
  }

  // ── Resize: table height (horizontal handle) ───────────────────────────────

  const hResizeHandle = document.getElementById('h-resize-handle');
  const requestsBar   = document.getElementById('requests-bar');
  let hResizing = false;

  hResizeHandle.addEventListener('mousedown', e => {
    hResizing = true; hResizeHandle.classList.add('dragging'); e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!hResizing) return;
    const mainRect = document.getElementById('main').getBoundingClientRect();
    const newH = Math.max(100, Math.min(mainRect.height * 0.65, mainRect.bottom - e.clientY));
    requestsBar.style.height = newH + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!hResizing) return;
    hResizing = false; hResizeHandle.classList.remove('dragging');
  });

  // ── Resize: sidebar width (drag the handle between main-left and sidebar) ──────

  const resizeHandle = document.getElementById('resize-handle');
  const sidebarEl    = document.getElementById('sidebar');
  const mainEl       = document.getElementById('main');
  let resizing = false;

  resizeHandle.addEventListener('mousedown', e => {
    resizing = true; resizeHandle.classList.add('dragging'); e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!resizing) return;
    const rect = mainEl.getBoundingClientRect();
    const newW = Math.max(220, Math.min(600, rect.right - e.clientX));
    sidebarEl.style.width = newW + 'px';
    resizeCanvas();
  });

  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false; resizeHandle.classList.remove('dragging');
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  function statusColor(code) {
    if (code == null)              return 'var(--text-3)';
    if (code === 0 || code >= 500) return 'var(--red)';
    if (code >= 400)               return 'var(--amber)';
    if (code >= 200)               return 'var(--green)';
    return 'var(--text-3)';
  }

  function reqStatusColor(req) {
    if (req.error && /blocked/i.test(req.error)) return 'var(--orange)';
    return statusColor(req.status);
  }

  function fmtStatus(req) {
    if (req.type === 'websocket') return 'WS';
    if (req.status > 0)           return req.status;
    if (req.error && /blocked/i.test(req.error)) return 'BLOCKED';
    if (req.status === 0)         return 'ERR';
    return '?';
  }

  function formatBytes(bytes) {
    if (!bytes || bytes < 0) return '—';
    if (bytes < 1024)        return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function reqOrigin(url) {
    try { return new URL(url).host; } catch { return url; }
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  initTableHeaders();
  setSidebarMode('placeholder');
  renderNavBar();
})();
