// Analytic terrain: macro landforms + ridged mountains + carved river valley +
// lake basin + coastline + flattened air base and towns. Also classifies the
// surface (runway/grass/rock/water...) and land cover (forest/farm/urban).
// Pure and deterministic: evaluated identically by physics (main thread) and
// by the terrain/vegetation workers.

import { SimplexNoise } from '../core/Noise.ts';
import { clamp, lerp, smoothstep } from '../core/math.ts';
import { AIRPORT, AIRPORT_ELEVATION, LAKE, RIVER, ROADS, RUNWAYS, TOWNS, mainRwy } from './WorldLayout.ts';
import type { SurfaceType } from '../aircraft/PhysicsTypes.ts';

const noise = new SimplexNoise(20251007);
const noiseB = new SimplexNoise(9001);

// ---------- river spatial acceleration (uniform grid of segment indices) ----------
const RIVER_CELL = 2000;
const riverGrid = new Map<number, number[]>();
const riverSegLen: number[] = [];
const riverCum: number[] = [0];
function cellKey(cx: number, cz: number): number {
  return (cx + 4096) * 8192 + (cz + 4096);
}
{
  for (let i = 0; i < RIVER.length - 1; i++) {
    const a = RIVER[i], b = RIVER[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    riverSegLen.push(len);
    riverCum.push(riverCum[i] + len);
    const reach = 5000; // influence radius of the valley
    const minX = Math.floor((Math.min(a.x, b.x) - reach) / RIVER_CELL);
    const maxX = Math.floor((Math.max(a.x, b.x) + reach) / RIVER_CELL);
    const minZ = Math.floor((Math.min(a.z, b.z) - reach) / RIVER_CELL);
    const maxZ = Math.floor((Math.max(a.z, b.z) + reach) / RIVER_CELL);
    for (let cx = minX; cx <= maxX; cx++)
      for (let cz = minZ; cz <= maxZ; cz++) {
        const k = cellKey(cx, cz);
        let arr = riverGrid.get(k);
        if (!arr) riverGrid.set(k, (arr = []));
        arr.push(i);
      }
  }
}

export interface RiverQuery {
  dist: number; // distance to centreline
  bed: number; // bed elevation at closest point
  width: number;
  t: number; // 0..1 along river
}

const _rq: RiverQuery = { dist: 1e9, bed: 0, width: 0, t: 0 };

/** Closest point on the river polyline (meandered with noise). */
export function queryRiver(x: number, z: number, out: RiverQuery = _rq): RiverQuery {
  out.dist = 1e9;
  const segs = riverGrid.get(cellKey(Math.floor(x / RIVER_CELL), Math.floor(z / RIVER_CELL)));
  if (!segs) return out;
  // meander: displace query point with low-frequency noise
  const mx = x + 220 * noise.noise2(z / 2600, 7.1) + 60 * noise.noise2(z / 700, 3.3);
  const mz = z;
  for (const i of segs) {
    const a = RIVER[i], b = RIVER[i + 1];
    const abx = b.x - a.x, abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    let t = ((mx - a.x) * abx + (mz - a.z) * abz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a.x + abx * t, pz = a.z + abz * t;
    const d = Math.hypot(mx - px, mz - pz);
    if (d < out.dist) {
      out.dist = d;
      out.bed = lerp(a.bed, b.bed, t);
      out.width = lerp(a.width, b.width, t);
      out.t = (riverCum[i] + riverSegLen[i] * t) / riverCum[riverCum.length - 1];
    }
  }
  return out;
}

// ---------- precomputed pad frames ----------
const pads = AIRPORT.pads.map((p) => {
  const h = (p.heading * Math.PI) / 180;
  return { cx: p.center[0], cz: p.center[1], dx: Math.sin(h), dz: -Math.cos(h), hl: p.halfLength, hw: p.halfWidth };
});

function rectDistance(x: number, z: number, p: (typeof pads)[number]): number {
  const rx = x - p.cx, rz = z - p.cz;
  const u = Math.abs(rx * p.dx + rz * p.dz) - p.hl;
  const v = Math.abs(rx * -p.dz + rz * p.dx) - p.hw;
  const ox = Math.max(u, 0), oz = Math.max(v, 0);
  return Math.hypot(ox, oz) + Math.min(Math.max(u, v), 0);
}

/** 1 inside the air base, smooth falloff outside. */
export function airportMask(x: number, z: number): number {
  let d = 1e9;
  for (const p of pads) d = Math.min(d, rectDistance(x, z, p));
  return 1 - smoothstep(0, 650, d);
}

function lakeLocal(x: number, z: number): number {
  const r = (LAKE.rotation * Math.PI) / 180;
  const dx = x - LAKE.center[0], dz = z - LAKE.center[1];
  const u = (dx * Math.cos(r) + dz * Math.sin(r)) / LAKE.radii[0];
  const v = (-dx * Math.sin(r) + dz * Math.cos(r)) / LAKE.radii[1];
  const e = Math.sqrt(u * u + v * v);
  return e + 0.12 * noise.noise2(x / 1800, z / 1800) + 0.05 * noise.noise2(x / 500, z / 500);
}

export function townMask(x: number, z: number): number {
  let m = 0;
  for (const t of TOWNS) {
    const d = Math.hypot(x - t.center[0], z - t.center[1]);
    if (d > t.radius * 1.8) continue;
    const n = 0.18 * noise.noise2(x / 600, z / 600);
    m = Math.max(m, 1 - smoothstep(t.radius * (0.55 + n), t.radius * (1.05 + n), d));
  }
  return m;
}

/** coastline position (z, metres) for a given x */
export function coastZ(x: number): number {
  return 26500 + 2600 * noise.noise2(x / 16000, 9.1) + 900 * noise.noise2(x / 4500, 3.3) + 250 * noise.noise2(x / 1200, 1.7);
}

/** Large-scale (smooth) terrain without detail; used for town flattening. */
function macroHeight(x: number, z: number): number {
  const X = x / 1000, Z = z / 1000;
  return 140 + 55 * noise.fbm2(X / 20, Z / 20, 3) + 16 * noise.fbm2(X / 3.5, Z / 3.5, 2);
}

/** 0..1 how "mountainous" the region is (north belt + west uplands). */
export function mountainFactor(x: number, z: number): number {
  const X = x / 1000, Z = z / 1000;
  const mzKm = -Z - 11 + 5 * noise.noise2(X / 20, 0.37) + 2 * noise.noise2(X / 7, 5.2);
  return smoothstep(0, 16, mzKm);
}

/**
 * Terrain height in metres. `detail` = false skips the finest octaves
 * (used for distant LOD and far vegetation decisions).
 */
export function terrainHeight(x: number, z: number, detail = true): number {
  const X = x / 1000, Z = z / 1000;
  // domain warp for organic shapes
  const wx = X + 2.6 * noise.noise2(X / 12, Z / 12);
  const wz = Z + 2.6 * noise.noise2(X / 12 + 5.3, Z / 12 - 2.1);
  let h = macroHeight(x, z);
  // scattered low hills
  const hillMask = smoothstep(0.12, 0.5, noise.fbm2(X / 15 + 3.1, Z / 15 - 7.7, 2) + 0.18);
  h += hillMask * 240 * Math.pow(noise.ridged2(wx / 4.2, wz / 4.2, 4), 1.9);
  // northern mountain range: big ridges, sharp peaks, broad valleys
  const mtn = mountainFactor(x, z);
  if (mtn > 0) {
    const r = noise.ridged2(wx / 12 + 11, wz / 12 - 3, 7);
    const massif = 0.55 + 0.45 * noise.fbm2(X / 34, Z / 34, 2);
    h += mtn * (3300 * Math.pow(r, 2.5) * massif + 450 * mtn);
    if (detail) h += mtn * 60 * noise.ridged2(X * 1.3, Z * 1.3, 3);
  }
  // western uplands
  const west = smoothstep(-15, -32, X) * (1 - smoothstep(16, 28, Z));
  if (west > 0) h += west * 950 * Math.pow(noise.ridged2(wx / 7 - 4, wz / 7 + 2, 5), 2.0);

  // fine detail
  if (detail) {
    h += 4 * noise.fbm2(X * 4, Z * 4, 3) + 1.2 * noise.noise2(X * 22, Z * 22);
  }

  // ----- river valley carve
  const rq = queryRiver(x, z);
  if (rq.dist < 6000) {
    const above = h - rq.bed;
    if (above > 0) {
      // valley wider in soft lowlands, V-shaped canyon in the mountains
      const valleyHalf = 420 + Math.min(above, 1500) * 1.1;
      const chan = rq.width * 0.5;
      let f = smoothstep(chan, chan + valleyHalf, rq.dist);
      f = Math.pow(f, lerp(1.0, 0.65, mtn));
      const floor = rq.bed + 3 + 2 * smoothstep(chan, chan + 60, rq.dist);
      h = lerp(floor, h, f);
    }
    // the channel itself
    const chanF = 1 - smoothstep(rq.width * 0.35, rq.width * 0.62, rq.dist);
    if (chanF > 0) h = lerp(h, rq.bed - 2.5, chanF);
  }

  // ----- lake basin
  const le = lakeLocal(x, z);
  if (le < 1.6) {
    const shore = LAKE.level + 1.5;
    const toShore = smoothstep(1.55, 1.0, le);
    h = lerp(h, Math.min(h, shore + (le - 1) * 40), toShore);
    if (le < 1.0) h = lerp(LAKE.level + 0.5, LAKE.level - LAKE.depth, smoothstep(1.0, 0.45, le));
  }

  // ----- coast (sea to the south)
  const toSea = (z - coastZ(x)) / 1000;
  if (toSea > -4) {
    const beach = smoothstep(-4, 0.4, toSea);
    const seaFloor = -6 - 70 * smoothstep(0, 12, toSea);
    h = lerp(h, Math.min(h, 4 + toSea * -8), smoothstep(-4, -0.8, toSea) * 0.85);
    h = lerp(h, seaFloor, smoothstep(-0.25, 0.7, toSea) * beach);
  }

  // ----- towns: soften slopes
  const tm = townMask(x, z);
  if (tm > 0) h = lerp(h, macroHeight(x, z) + (h - macroHeight(x, z)) * 0.25, tm * 0.8);

  // ----- air base: perfectly flat paved area
  const am = airportMask(x, z);
  if (am > 0) h = lerp(h, AIRPORT_ELEVATION, smoothstep(0, 1, am));
  return h;
}

/** Analytic-ish normal by central differences. */
export function terrainNormal(x: number, z: number, out: { x: number; y: number; z: number }, eps = 1.5): typeof out {
  const hl = terrainHeight(x - eps, z), hr = terrainHeight(x + eps, z);
  const hd = terrainHeight(x, z - eps), hu = terrainHeight(x, z + eps);
  let nx = hl - hr, ny = 2 * eps, nz = hd - hu;
  const l = Math.hypot(nx, ny, nz);
  out.x = nx / l;
  out.y = ny / l;
  out.z = nz / l;
  return out;
}

// ---------- paved surfaces ----------
/** along-runway positions of the hardened aircraft shelters (east of the parallel taxiway) */
export const SHELTERS = [640, 790, 940, 1090, 1240];
const runwayFrames = RUNWAYS.map((r) => {
  const h = (r.heading * Math.PI) / 180;
  return { cx: r.center[0], cz: r.center[1], dx: Math.sin(h), dz: -Math.cos(h), hl: r.length / 2 + 60, hw: r.width / 2 + 3 };
});

export function isRunway(x: number, z: number): boolean {
  for (const f of runwayFrames) {
    const rx = x - f.cx, rz = z - f.cz;
    if (Math.abs(rx * f.dx + rz * f.dz) <= f.hl && Math.abs(-rx * f.dz + rz * f.dx) <= f.hw) return true;
  }
  return false;
}

/** Paved taxiways/apron in main-runway coordinates. */
export function isTaxiway(x: number, z: number): boolean {
  const h = (350 * Math.PI) / 180;
  const dx = Math.sin(h), dz = -Math.cos(h);
  const along = x * dx + z * dz;
  const across = x * -dz + z * dx;
  const off = AIRPORT.taxiwayOffset;
  // parallel taxiway
  if (Math.abs(across - off) < 12 && Math.abs(along) < 1500) return true;
  // stubs to runway at both ends and the middle
  for (const a of [-1450, -500, 500, 1450]) if (Math.abs(along - a) < 13 && across > 0 && across < off) return true;
  // apron + links
  const ap = AIRPORT.apron;
  if (Math.abs(along - ap.along) < ap.halfLength && Math.abs(across - ap.across) < ap.halfWidth) return true;
  for (const a of [-480, 180]) if (Math.abs(along - a) < 15 && across > off && across < ap.across) return true;
  // hardened aircraft shelter pads north of the apron
  for (const a of SHELTERS) if (Math.abs(along - a) < 11 && across > off && across < 318) return true;
  return false;
}

/** Water surface elevation at (x,z), or -Infinity when there is no water body there. */
export function waterLevelAt(x: number, z: number): number {
  if (z > coastZ(x) - 3000) return 0;
  if (lakeLocal(x, z) < 1.05) return LAKE.level;
  const rq = queryRiver(x, z);
  if (rq.dist < rq.width * 0.6) return rq.bed + 0.6;
  return -Infinity;
}

export function surfaceAt(x: number, z: number, h: number, slope: number): SurfaceType {
  if (isRunway(x, z)) return 'runway';
  if (isTaxiway(x, z)) return 'taxiway';
  if (h < 0.2 && z > coastZ(x) - 400) return 'water';
  const rq = queryRiver(x, z);
  if (rq.dist < rq.width * 0.45 && h < rq.bed + 1) return 'water';
  if (lakeLocal(x, z) < 1.0 && h < LAKE.level + 0.3) return 'water';
  if (h > 2300 && slope < 0.7) return 'snow';
  if (slope > 0.55) return 'rock';
  if (townMask(x, z) > 0.6) return 'dirt';
  return 'grass';
}

// ---------- land cover ----------
export interface LandCover {
  forest: number;
  farm: number;
  urban: number;
  rock: number;
}

const _roadSegs: { ax: number; az: number; bx: number; bz: number }[] = [];
for (const r of ROADS) for (let i = 0; i < r.length - 1; i++) _roadSegs.push({ ax: r[i][0], az: r[i][1], bx: r[i + 1][0], bz: r[i + 1][1] });

export function roadDistance(x: number, z: number): number {
  let d = 1e9;
  for (const s of _roadSegs) {
    const abx = s.bx - s.ax, abz = s.bz - s.az;
    let t = ((x - s.ax) * abx + (z - s.az) * abz) / (abx * abx + abz * abz);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - (s.ax + abx * t), dz = z - (s.az + abz * t);
    const dd = dx * dx + dz * dz;
    if (dd < d) d = dd;
  }
  return Math.sqrt(d);
}

export function landCover(x: number, z: number, h: number, slope: number, out: LandCover): LandCover {
  const X = x / 1000, Z = z / 1000;
  const am = airportMask(x, z);
  const tm = townMask(x, z);
  const water = h < 1 || (lakeLocal(x, z) < 1.03 && h < LAKE.level + 1);
  const rq = queryRiver(x, z);
  const nearRiver = rq.dist < rq.width * 0.7;
  // forest: patchy noise, treeline ~1900 m, avoids steep rock
  let f = noise.fbm2(X / 3.2 + 40, Z / 3.2 - 12, 4) * 0.9 + noiseB.noise2(X / 0.9, Z / 0.9) * 0.22;
  // hills and mountain flanks are wooded, lowland plains mostly farmed
  const mtnBoost = smoothstep(220, 800, h) * 0.38 + smoothstep(0.08, 0.3, slope) * 0.2;
  f = smoothstep(0.18 - mtnBoost, 0.42 - mtnBoost, f);
  f *= 1 - smoothstep(1650, 2000, h + 120 * noise.noise2(X * 2, Z * 2));
  f *= 1 - smoothstep(0.55, 0.85, slope);
  // farmland in flat lowlands
  let farm = smoothstep(0.16, 0.04, slope) * (1 - smoothstep(380, 560, h)) * smoothstep(-0.45, -0.1, noise.fbm2(X / 5 - 9, Z / 5 + 4, 3));
  farm *= 1 - smoothstep(0.1, 0.5, f);
  const exclusion = Math.max(am, water || nearRiver ? 1 : 0);
  f *= 1 - Math.max(exclusion, tm * 0.95);
  farm *= 1 - Math.max(exclusion, tm);
  // keep road corridors clear of trees
  const rd = roadDistance(x, z);
  f *= smoothstep(12, 28, rd);
  out.forest = clamp(f, 0, 1);
  out.farm = clamp(farm, 0, 1);
  out.urban = tm;
  out.rock = smoothstep(0.5, 0.8, slope) + smoothstep(1900, 2400, h) * 0.5;
  return out;
}

/** Quick height query used by gameplay for spawn points etc. */
export function airportSpawn(kind: 'parking' | 'runway' | 'hold'): { x: number; z: number; heading: number } {
  const p = kind === 'parking' ? AIRPORT.parking : kind === 'hold' ? AIRPORT.holdShort : AIRPORT.runwayStart;
  return { x: p.pos[0], z: p.pos[1], heading: p.heading };
}

export { mainRwy };
