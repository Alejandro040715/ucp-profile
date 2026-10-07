// Procedural, tileable noise textures generated at startup (no image assets).
//  - 2D RGBA noise for terrain / material breakup
//  - 3D Perlin-Worley + Worley textures for volumetric clouds
//  - blue-noise-ish dither texture for ray-march jitter

import { Data3DTexture, DataTexture, LinearFilter, LinearMipmapLinearFilter, RedFormat, RGBAFormat, RepeatWrapping, UnsignedByteType, RGFormat } from 'three';
import { rng } from '../core/math.ts';

function hashP(x: number, y: number, z: number, p: number, seed: number): number {
  x = ((x % p) + p) % p;
  y = ((y % p) + p) % p;
  z = ((z % p) + p) % p;
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** periodic gradient-ish value noise in 3D, period p (integer lattice units) */
function pnoise3(x: number, y: number, z: number, p: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const w = zf * zf * zf * (zf * (zf * 6 - 15) + 10);
  const c = (dx: number, dy: number, dz: number) => hashP(xi + dx, yi + dy, zi + dz, p, seed);
  const x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * u;
  const x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * u;
  const x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * u;
  const x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}

function pfbm3(x: number, y: number, z: number, p: number, oct: number, seed: number): number {
  let s = 0, a = 0.5, n = 0, f = 1;
  for (let i = 0; i < oct; i++) {
    s += a * pnoise3(x * f, y * f, z * f, p * f, seed + i * 13);
    n += a;
    a *= 0.5;
    f *= 2;
  }
  return s / n;
}

/** periodic Worley (cellular) noise, returns 1 - F1 distance (0..1) */
function pworley3(x: number, y: number, z: number, p: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let md = 9;
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx, cy = yi + dy, cz = zi + dz;
        const px = cx + hashP(cx, cy, cz, p, seed);
        const py = cy + hashP(cx, cy, cz, p, seed + 1);
        const pz = cz + hashP(cx, cy, cz, p, seed + 2);
        const d = (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
        if (d < md) md = d;
      }
  return 1 - Math.min(1, Math.sqrt(md));
}

export function createNoise2D(size = 256): DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size, v = j / size;
      const o = (j * size + i) * 4;
      data[o] = pfbm3(u * 4, v * 4, 0.5, 4, 5, 11) * 255;
      data[o + 1] = pfbm3(u * 8, v * 8, 3.5, 8, 4, 29) * 255;
      data[o + 2] = pworley3(u * 10, v * 10, 0.5, 10, 7) * 255;
      data[o + 3] = pfbm3(u * 16, v * 16, 7.5, 16, 3, 53) * 255;
    }
  }
  // stretch contrast of the fbm channels
  for (const ch of [0, 1, 3]) {
    let mn = 255, mx = 0;
    for (let k = ch; k < data.length; k += 4) {
      mn = Math.min(mn, data[k]);
      mx = Math.max(mx, data[k]);
    }
    for (let k = ch; k < data.length; k += 4) data[k] = ((data[k] - mn) / Math.max(1, mx - mn)) * 255;
  }
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Cloud base-shape noise: R = Perlin-Worley, G/B/A = Worley at increasing
 * frequencies (FBM'd in the shader). Size^3 voxels.
 */
export function createCloudShapeNoise(size = 64): Data3DTexture {
  const data = new Uint8Array(size * size * size * 4);
  for (let k = 0; k < size; k++)
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++) {
        const x = i / size, y = j / size, z = k / size;
        const perlin = pfbm3(x * 4, y * 4, z * 4, 4, 4, 101);
        const w1 = pworley3(x * 4, y * 4, z * 4, 4, 202);
        const w2 = pworley3(x * 8, y * 8, z * 8, 8, 303);
        const w3 = pworley3(x * 16, y * 16, z * 16, 16, 404);
        const wf = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
        // Perlin-Worley: remap perlin with worley
        const pw = Math.min(1, Math.max(0, (perlin - (1 - wf)) / (1 - (1 - wf)) * 0.5 + perlin * 0.6));
        const o = ((k * size + j) * size + i) * 4;
        data[o] = pw * 255;
        data[o + 1] = w1 * 255;
        data[o + 2] = w2 * 255;
        data[o + 3] = w3 * 255;
      }
  const tex = new Data3DTexture(data, size, size, size);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/** Erosion detail noise (Worley FBM) for cloud edges. */
export function createCloudDetailNoise(size = 32): Data3DTexture {
  const data = new Uint8Array(size * size * size);
  for (let k = 0; k < size; k++)
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++) {
        const x = i / size, y = j / size, z = k / size;
        const v = pworley3(x * 4, y * 4, z * 4, 4, 505) * 0.625 + pworley3(x * 8, y * 8, z * 8, 8, 606) * 0.25 + pworley3(x * 16, y * 16, z * 16, 16, 707) * 0.125;
        data[(k * size + j) * size + i] = v * 255;
      }
  const tex = new Data3DTexture(data, size, size, size);
  tex.format = RedFormat;
  tex.type = UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Weather map: R = coverage noise (histogram-equalised so that a threshold of
 * 1 - c covers exactly a fraction c of the sky), G = cloud type variation.
 */
export function createWeatherNoise(size = 512): DataTexture {
  const n = size * size;
  const cov = new Float32Array(n);
  const typ = new Float32Array(n);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const u = i / size, v = j / size;
      cov[j * size + i] = pfbm3(u * 8, v * 8, 0.2, 8, 4, 909) * 0.75 + pworley3(u * 12, v * 12, 0.7, 12, 919) * 0.45;
      typ[j * size + i] = pfbm3(u * 3, v * 3, 2.2, 3, 3, 929);
    }
  // histogram equalisation of coverage
  const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => cov[a] - cov[b]);
  const data = new Uint8Array(n * 2);
  for (let r = 0; r < n; r++) data[order[r] * 2] = Math.floor((r / n) * 255.99);
  for (let k = 0; k < n; k++) data[k * 2 + 1] = typ[k] * 255;
  const tex = new DataTexture(data, size, size, RGFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/** Dither / blue-noise approximation (R2 sequence based) for jittering ray marches. */
export function createDitherTexture(size = 64): DataTexture {
  const data = new Uint8Array(size * size);
  const r = rng(77);
  // interleaved gradient noise + small white noise, decorrelated
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const ign = (52.9829189 * ((0.06711056 * i + 0.00583715 * j) % 1)) % 1;
      data[j * size + i] = Math.floor(((ign + r() * 0.15) % 1) * 255);
    }
  const tex = new DataTexture(data, size, size, RedFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/** Sample the CPU copy of the weather coverage (for physics/turbulence). */
export function sampleWeatherCPU(tex: DataTexture, u: number, v: number): number {
  const img = tex.image as { data: Uint8Array; width: number; height: number };
  const w = img.width, h = img.height;
  const x = (((u % 1) + 1) % 1) * w - 0.5, y = (((v % 1) + 1) % 1) * h - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const g = (xx: number, yy: number) => img.data[((((yy % h) + h) % h) * w + (((xx % w) + w) % w)) * 2] / 255;
  return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
}
