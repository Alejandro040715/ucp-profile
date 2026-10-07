// Pure generation routines for terrain chunks and vegetation tiles. Runs inside
// Web Workers (async streaming) but can also run on the main thread as a
// fallback when workers are unavailable.

import { landCover, terrainHeight, surfaceAt, type LandCover, isRunway, isTaxiway, roadDistance, townMask, airportMask, mountainFactor } from './Heightfield.ts';
import { rng } from '../core/math.ts';

export interface ChunkRequest {
  type: 'chunk';
  id: number;
  cx: number;
  cz: number;
  size: number;
  res: number;
}

export interface ChunkResult {
  type: 'chunk';
  id: number;
  positions: Float32Array;
  normals: Int8Array;
  cover: Uint8Array;
  morph: Float32Array;
  minY: number;
  maxY: number;
}

export type VegKind = 'trees' | 'far' | 'grass' | 'rocks';

export interface VegRequest {
  type: 'veg';
  id: number;
  kind: VegKind;
  x0: number;
  z0: number;
  size: number;
  density: number; // quality multiplier
}

export interface VegResult {
  type: 'veg';
  id: number;
  kind: VegKind;
  /** per instance: x, y, z, scale, rotation, variant, colorJitter, shape */
  data: Float32Array;
  count: number;
}

export interface MapRequest {
  type: 'map';
  id: number;
  cx: number;
  cz: number;
  span: number;
  res: number;
}

export interface MapResult {
  type: 'map';
  id: number;
  rgba: Uint8ClampedArray;
  heights: Float32Array;
  res: number;
}

const lc: LandCover = { forest: 0, farm: 0, urban: 0, rock: 0 };

export function generateChunk(req: ChunkRequest): ChunkResult {
  const { cx, cz, size, res } = req;
  const n = res + 1;
  const step = size / res;
  const detail = size <= 8192;
  // heights with a 1-sample border for normals
  const g = n + 2;
  const H = new Float32Array(g * g);
  const x0 = cx - size / 2 - step;
  const z0 = cz - size / 2 - step;
  for (let j = 0; j < g; j++) {
    for (let i = 0; i < g; i++) {
      H[j * g + i] = terrainHeight(x0 + i * step, z0 + j * step, detail);
    }
  }
  const skirtCount = 4 * res;
  const total = n * n + skirtCount;
  const positions = new Float32Array(total * 3);
  const normals = new Int8Array(total * 4);
  const cover = new Uint8Array(total * 4);
  const morph = new Float32Array(total);
  let minY = 1e9, maxY = -1e9;
  const skirtDepth = Math.max(3, size * 0.02);

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const gi = (j + 1) * g + (i + 1);
      const h = H[gi];
      const v = j * n + i;
      const lx = -size / 2 + i * step;
      const lz = -size / 2 + j * step;
      positions[v * 3] = lx;
      positions[v * 3 + 1] = h;
      positions[v * 3 + 2] = lz;
      if (h < minY) minY = h;
      if (h > maxY) maxY = h;
      const dx = (H[gi + 1] - H[gi - 1]) / (2 * step);
      const dz = (H[gi + g] - H[gi - g]) / (2 * step);
      const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
      normals[v * 4] = Math.round(-dx * inv * 127);
      normals[v * 4 + 1] = Math.round(inv * 127);
      normals[v * 4 + 2] = Math.round(-dz * inv * 127);
      normals[v * 4 + 3] = 0;
      const slope = Math.sqrt(dx * dx + dz * dz);
      const wx = cx + lx, wz = cz + lz;
      landCover(wx, wz, h, slope, lc);
      cover[v * 4] = Math.round(lc.forest * 255);
      cover[v * 4 + 1] = Math.round(lc.farm * 255);
      cover[v * 4 + 2] = Math.round(lc.urban * 255);
      // alpha: rock exposure (paved surfaces are separate meshes)
      cover[v * 4 + 3] = Math.round(Math.min(1, lc.rock) * 255);
      // geomorph target: height interpolated from the half-resolution grid
      const oi = i & 1, oj = j & 1;
      let mh = h;
      if (oi || oj) {
        const ia = i - oi, ib = i + oi, ja = j - oj, jb = j + oj;
        const hA = H[(ja + 1) * g + (ia + 1)];
        const hB = H[(jb + 1) * g + (ib + 1)];
        if (oi && oj) {
          // diagonal (matches triangle split direction)
          mh = (hA + hB) * 0.5;
        } else mh = (hA + hB) * 0.5;
      }
      morph[v] = mh;
    }
  }
  // skirts: duplicate border vertices pushed down
  let s = n * n;
  const border: number[] = [];
  for (let i = 0; i < res; i++) border.push(i); // top edge j=0
  for (let j = 0; j < res; j++) border.push(j * n + res); // right edge
  for (let i = res; i > 0; i--) border.push(res * n + i); // bottom edge
  for (let j = res; j > 0; j--) border.push(j * n); // left edge
  for (const v of border) {
    positions[s * 3] = positions[v * 3];
    positions[s * 3 + 1] = positions[v * 3 + 1] - skirtDepth;
    positions[s * 3 + 2] = positions[v * 3 + 2];
    for (let k = 0; k < 4; k++) {
      normals[s * 4 + k] = normals[v * 4 + k];
      cover[s * 4 + k] = cover[v * 4 + k];
    }
    morph[s] = morph[v] - skirtDepth;
    s++;
  }
  return { type: 'chunk', id: req.id, positions, normals, cover, morph, minY, maxY };
}

/** Shared index buffer for a chunk resolution (grid + skirts). */
export function chunkIndices(res: number): Uint32Array {
  const n = res + 1;
  const idx: number[] = [];
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, c, d, a, d, b);
    }
  }
  // skirt quads following the border order used in generateChunk
  const border: number[] = [];
  for (let i = 0; i < res; i++) border.push(i);
  for (let j = 0; j < res; j++) border.push(j * n + res);
  for (let i = res; i > 0; i--) border.push(res * n + i);
  for (let j = res; j > 0; j--) border.push(j * n);
  const base = n * n;
  const m = border.length;
  for (let k = 0; k < m; k++) {
    const v0 = border[k], v1 = border[(k + 1) % m];
    const s0 = base + k, s1 = base + ((k + 1) % m);
    idx.push(v0, s0, v1, v1, s0, s1);
  }
  return new Uint32Array(idx);
}

const FLOATS_PER_INSTANCE = 8;

export function generateVegetation(req: VegRequest): VegResult {
  const { x0, z0, size, kind } = req;
  const seed = (Math.floor(x0 / 64) * 73856093) ^ (Math.floor(z0 / 64) * 19349663) ^ (kind.length * 83492791);
  const r = rng(seed >>> 0);
  // spacing per kind (m)
  const spacing = kind === 'trees' ? 8.5 / Math.sqrt(req.density) : kind === 'far' ? 24 / Math.sqrt(req.density) : kind === 'grass' ? 1.6 / Math.sqrt(req.density) : 18;
  const cells = Math.ceil(size / spacing);
  const out: number[] = [];
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const x = x0 + (i + r()) * spacing;
      const z = z0 + (j + r()) * spacing;
      const roll = r();
      const roll2 = r();
      if (kind === 'grass') {
        if (isRunway(x, z) || isTaxiway(x, z)) continue;
        const h = terrainHeight(x, z);
        if (h < 1.5) continue;
        const am = airportMask(x, z);
        // grass everywhere at the air base, thinner patches elsewhere
        const keep = am > 0.5 ? 0.85 : 0.45;
        if (roll > keep) continue;
        out.push(x, h, z, 0.6 + roll2 * 0.8, r() * Math.PI * 2, Math.floor(r() * 4), r(), am);
        continue;
      }
      const h = terrainHeight(x, z, kind !== 'far');
      if (h < 2) continue;
      const e = 3;
      const hx = terrainHeight(x + e, z, false) - terrainHeight(x - e, z, false);
      const hz = terrainHeight(x, z + e, false) - terrainHeight(x, z - e, false);
      const slope = Math.hypot(hx, hz) / (2 * e);
      if (kind === 'rocks') {
        const mtn = mountainFactor(x, z);
        const p = Math.min(1, slope * 1.2) * 0.5 + mtn * 0.35;
        if (roll > p || surfaceAt(x, z, h, slope) === 'water') continue;
        if (airportMask(x, z) > 0.01 || townMask(x, z) > 0.2) continue;
        out.push(x, h - 0.3, z, 0.5 + roll2 * roll2 * 3.5, r() * 6.28, Math.floor(r() * 3), r(), slope);
        continue;
      }
      landCover(x, z, h, slope, lc);
      let p = lc.forest;
      // sparse lone trees in fields / along roads and rivers
      p = Math.max(p, lc.farm > 0.3 ? 0.012 : 0.03 * (1 - lc.urban));
      if (lc.urban > 0.3) p = Math.max(p * 0.3, 0.06 * lc.urban);
      if (kind === 'far') p = lc.forest * 0.95;
      if (roll > p) continue;
      if (isRunway(x, z) || isTaxiway(x, z) || airportMask(x, z) > 0.2) continue;
      if (roadDistance(x, z) < 9) continue;
      // species: conifers at altitude and on slopes, broadleaf in lowlands
      const conifer = Math.min(1, Math.max(0, (h - 350) / 600 + (r() - 0.5) * 0.8 + slope * 0.6));
      const shape = conifer > 0.5 ? 1 : 0;
      const sc = (0.75 + roll2 * 0.6) * (shape ? 1.0 : 0.95) * (1 - Math.max(0, h - 1500) / 1200);
      out.push(x, h - 0.2, z, Math.max(0.35, sc), r() * Math.PI * 2, Math.floor(r() * 4), r(), shape);
    }
  }
  const data = new Float32Array(out);
  return { type: 'veg', id: req.id, kind, data, count: data.length / FLOATS_PER_INSTANCE };
}

export function generateMap(req: MapRequest): MapResult {
  const { cx, cz, span, res } = req;
  const rgba = new Uint8ClampedArray(res * res * 4);
  const heights = new Float32Array(res * res);
  const cell = span / res;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const x = cx + (i / res - 0.5) * span;
      const z = cz + (j / res - 0.5) * span;
      heights[j * res + i] = terrainHeight(x, z, false);
    }
  }
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const h = heights[j * res + i];
      const hx = heights[j * res + Math.min(res - 1, i + 1)] - heights[j * res + Math.max(0, i - 1)];
      const hz = heights[Math.min(res - 1, j + 1) * res + i] - heights[Math.max(0, j - 1) * res + i];
      const slope = Math.hypot(hx, hz) / (2 * cell);
      const x = cx + (i / res - 0.5) * span;
      const z = cz + (j / res - 0.5) * span;
      const surf = surfaceAt(x, z, h, slope);
      landCover(x, z, h, slope, lc);
      let r = 0, g = 0, b = 0;
      if (surf === 'water') { r = 16; g = 52; b = 86; }
      else if (surf === 'runway' || surf === 'taxiway') { r = 210; g = 210; b = 205; }
      else {
        const t = Math.min(1, Math.max(0, h / 2600));
        r = 60 + 120 * t; g = 82 + 80 * t; b = 50 + 120 * t;
        if (lc.forest > 0.4) { r *= 0.6; g *= 0.85; b *= 0.6; }
        if (lc.urban > 0.4) { r = 120; g = 110; b = 105; }
      }
      const shade = Math.max(0.45, Math.min(1.25, 0.9 + (-hx - hz) / (2 * cell) * 1.2));
      const o = (j * res + i) * 4;
      rgba[o] = r * shade;
      rgba[o + 1] = g * shade;
      rgba[o + 2] = b * shade;
      rgba[o + 3] = 255;
    }
  }
  return { type: 'map', id: req.id, rgba, heights, res };
}
