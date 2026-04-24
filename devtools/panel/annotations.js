// NetPhantom AI Annotation Engine
// Pattern-based network analysis that surfaces real insights without an LLM call

class NetworkAnalyzer {
  analyze(nodes) {
    const insights = [];

    for (const node of nodes.values()) {
      if (node.kind === 'page' || node.requestCount === 0) continue;

      const total   = node.requestCount;
      const avgMs   = node.totalDuration / total;
      const errRate = (node.serverErrors + node.clientErrors) / total;

      // Slow endpoint
      if (avgMs > 2000) {
        insights.push({
          severity: 'warning',
          icon: '⚡',
          nodeId: node.id,
          title: `Slow endpoint: ${node.label}`,
          detail: `Avg ${Math.round(avgMs)}ms over ${total} request${total > 1 ? 's' : ''}. Consider caching or CDN.`,
        });
      }

      // High server error rate
      if (node.serverErrors > 0 && errRate > 0.3) {
        insights.push({
          severity: 'error',
          icon: '🔴',
          nodeId: node.id,
          title: `Server errors on ${node.label}`,
          detail: `${node.serverErrors} 5xx errors (${Math.round(errRate * 100)}% fail rate).`,
        });
      }

      // Rate limiting
      const rateLimited = node.requests.filter(r => r.status === 429).length;
      if (rateLimited > 0) {
        insights.push({
          severity: 'warning',
          icon: '🚦',
          nodeId: node.id,
          title: `Rate limit hit on ${node.label}`,
          detail: `${rateLimited} × 429 Too Many Requests. Back-off or cache responses.`,
        });
      }

      // Client errors (4xx) not 429
      const clientOther = node.requests.filter(r => r.status >= 400 && r.status < 500 && r.status !== 429).length;
      if (clientOther > 2) {
        insights.push({
          severity: 'info',
          icon: '⚠️',
          nodeId: node.id,
          title: `Client errors on ${node.label}`,
          detail: `${clientOther} 4xx responses. Check auth tokens or request format.`,
        });
      }

      // Large responses (> 1 MB)
      const largeReqs = node.requests.filter(r => r.size > 1_000_000);
      if (largeReqs.length > 0) {
        const maxKB = Math.round(Math.max(...largeReqs.map(r => r.size)) / 1024);
        insights.push({
          severity: 'info',
          icon: '📦',
          nodeId: node.id,
          title: `Large responses from ${node.label}`,
          detail: `Up to ${maxKB} KB payload. Consider compression or pagination.`,
        });
      }

      // High request volume
      if (total > 30) {
        insights.push({
          severity: 'info',
          icon: '🔁',
          nodeId: node.id,
          title: `High traffic to ${node.label}`,
          detail: `${total} requests so far. Check for polling loops or duplicate calls.`,
        });
      }

      // Active WebSocket
      if (node.hasWS) {
        insights.push({
          severity: 'ok',
          icon: '🔌',
          nodeId: node.id,
          title: `WebSocket active on ${node.label}`,
          detail: 'Real-time connection detected.',
        });
      }
    }

    // Cross-origin patterns
    const domainCount = Array.from(nodes.values()).filter(n => n.kind === 'domain').length;
    if (domainCount > 10) {
      insights.push({
        severity: 'info',
        icon: '🌐',
        nodeId: null,
        title: `${domainCount} third-party origins`,
        detail: 'High origin count can hurt performance. Audit for unnecessary requests.',
      });
    }

    return insights;
  }

  // Generate HAR-format export from collected requests
  exportHAR(nodes, pageUrl) {
    const entries = [];

    for (const node of nodes.values()) {
      if (node.kind === 'page') continue;
      for (const req of node.requests) {
        if (req._har) {
          // Use original HAR entry if available from devtools API
          entries.push(req._har);
          continue;
        }

        entries.push({
          startedDateTime: new Date(req.timestamp || Date.now()).toISOString(),
          time: req.duration || 0,
          request: {
            method: req.method || 'GET',
            url: req.url,
            httpVersion: 'HTTP/1.1',
            headers: req.requestHeaders || [],
            queryString: [],
            cookies: [],
            headersSize: -1,
            bodySize: 0,
          },
          response: {
            status: req.status || 0,
            statusText: req.statusText || '',
            httpVersion: 'HTTP/1.1',
            headers: req.responseHeaders || [],
            cookies: [],
            content: {
              size: req.size || 0,
              mimeType: req.mimeType || 'application/octet-stream',
            },
            redirectURL: '',
            headersSize: -1,
            bodySize: req.size || 0,
          },
          cache: {},
          timings: req.timings || { send: 0, wait: req.duration || 0, receive: 0 },
        });
      }
    }

    return {
      log: {
        version: '1.2',
        creator: { name: 'NetPhantom', version: '1.0.0' },
        pages: [{
          startedDateTime: new Date().toISOString(),
          id: 'page_1',
          title: pageUrl || document.title || 'NetPhantom Export',
          pageTimings: {},
        }],
        entries,
      },
    };
  }
}
