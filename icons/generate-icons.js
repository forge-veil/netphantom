// Run with: node generate-icons.js
// Generates icon PNGs for the Chrome extension using the Canvas API in Node.js
// Requires: npm install canvas

const { createCanvas } = require('canvas');
const fs = require('fs');

function drawIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx    = canvas.getContext('2d');
  const s      = size / 20; // scale factor

  // Background
  const bg = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  bg.addColorStop(0, '#1a1040');
  bg.addColorStop(1, '#090914');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  // Node positions (scaled)
  const nodes = [
    { x: 10, y: 10, r: 3.5, color: '#9f7aea' }, // center
    { x:  3, y:  5, r: 2,   color: '#00ff88' }, // top-left
    { x: 17, y:  5, r: 2,   color: '#00ff88' }, // top-right
    { x:  3, y: 15, r: 2,   color: '#00ccff' }, // bottom-left
    { x: 17, y: 15, r: 2,   color: '#ffbb00' }, // bottom-right
  ];

  // Draw edges
  const center = nodes[0];
  for (let i = 1; i < nodes.length; i++) {
    ctx.beginPath();
    ctx.moveTo(center.x * s, center.y * s);
    ctx.lineTo(nodes[i].x * s, nodes[i].y * s);
    ctx.strokeStyle = '#7c3aed80';
    ctx.lineWidth   = 1.2 * s;
    ctx.stroke();
  }

  // Draw nodes with glow
  for (const n of nodes) {
    const grd = ctx.createRadialGradient(n.x*s, n.y*s, 0, n.x*s, n.y*s, n.r*s*3);
    grd.addColorStop(0, n.color + '60');
    grd.addColorStop(1, 'transparent');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(n.x*s, n.y*s, n.r*s*3, 0, Math.PI*2);
    ctx.fill();

    ctx.fillStyle = n.color;
    ctx.beginPath();
    ctx.arc(n.x*s, n.y*s, n.r*s, 0, Math.PI*2);
    ctx.fill();
  }

  return canvas.toBuffer('image/png');
}

for (const size of [16, 48, 128]) {
  fs.writeFileSync(`icon${size}.png`, drawIcon(size));
  console.log(`✓ icon${size}.png`);
}
