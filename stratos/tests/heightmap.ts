// Renders a shaded relief map of the world to tests/output/heightmap.png (dev tool).
import { terrainHeight, landCover, surfaceAt, coastZ } from '../src/world/Heightfield.ts';
import { RUNWAYS, TOWNS } from '../src/world/WorldLayout.ts';
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
const N = Number(process.argv[2] ?? 512), SPAN = Number(process.argv[3] ?? 120000), CX = Number(process.argv[4] ?? 0), CZ = Number(process.argv[5] ?? -5000);
const img = Buffer.alloc(N * N * 3);
const t0 = performance.now();
let minH = 1e9, maxH = -1e9;
const H = new Float32Array(N * N);
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  const x = CX + (i / N - 0.5) * SPAN, z = CZ + (j / N - 0.5) * SPAN;
  const h = terrainHeight(x, z); H[j * N + i] = h; minH = Math.min(minH, h); maxH = Math.max(maxH, h);
}
const t1 = performance.now();
const lc = { forest: 0, farm: 0, urban: 0, rock: 0 };
const cell = SPAN / N;
for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) {
  const h = H[j * N + i];
  const dx = (H[j * N + i + 1] - H[j * N + i - 1]) / (2 * cell), dz = (H[(j + 1) * N + i] - H[(j - 1) * N + i]) / (2 * cell);
  const slope = Math.hypot(dx, dz);
  const shade = Math.max(0, Math.min(1, 0.6 + (-dx * 0.6 - dz * 0.6) * 1.5));
  const x = CX + (i / N - 0.5) * SPAN, z = CZ + (j / N - 0.5) * SPAN;
  landCover(x, z, h, slope, lc);
  const surf = surfaceAt(x, z, h, slope);
  let r, g, b;
  if (surf === 'water') { r = 30; g = 70; b = 130; }
  else if (surf === 'runway' || surf === 'taxiway') { r = 240; g = 240; b = 240; }
  else if (h > 2200) { r = 235; g = 235; b = 240; }
  else {
    r = 120 + h * 0.03; g = 140 - h * 0.01; b = 80;
    if (lc.forest > 0.3) { r = 40; g = 85; b = 40; }
    if (lc.farm > 0.4) { r = 170; g = 160; b = 90; }
    if (lc.urban > 0.4) { r = 150; g = 120; b = 120; }
    if (lc.rock > 0.5) { r = 130; g = 120; b = 110; }
  }
  const o = (j * N + i) * 3;
  img[o] = Math.min(255, r * shade); img[o + 1] = Math.min(255, g * shade); img[o + 2] = Math.min(255, b * shade);
}
function png(w: number, h: number, rgb: Buffer) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b: Buffer) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
mkdirSync('tests/output', { recursive: true });
writeFileSync('tests/output/heightmap.png', png(N, N, img));
console.log(`samples=${N * N} time=${(t1 - t0).toFixed(0)}ms per=${((t1 - t0) * 1000 / (N * N)).toFixed(2)}us min=${minH.toFixed(0)} max=${maxH.toFixed(0)}`);
