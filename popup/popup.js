const tips = [
  'Drag the graph to orbit in 3D. Scroll to zoom in/out.',
  'Click any node to see all requests, avg latency, and error rate.',
  'Use ⬡ Mock to intercept requests and return custom responses.',
  'Use ↓ HAR to export all captured traffic as a standard HAR file.',
  'WebSocket connections appear with a cyan WS badge on the node.',
  'Red nodes = high server error rate. Yellow = slow. Green = healthy.',
  'Flying particles show live requests in real-time.',
  'The AI Insights tab flags rate limits, slow endpoints, and large payloads.',
  '↻ Replay re-sends the last request from a selected domain.',
];

const tip = tips[Math.floor(Math.random() * tips.length)];
const box = document.getElementById('tip');
box.innerHTML = `<span class="tip-label">TIP</span>${tip}`;
