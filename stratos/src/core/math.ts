// Small numeric helpers shared by every system. Kept dependency-free so the
// flight model and world generation can run in Node and in Web Workers.

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const G0 = 9.80665;
export const KT = 0.514444; // m/s per knot
export const FT = 0.3048; // m per foot

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function saturate(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

export function remap(v: number, a0: number, a1: number, b0: number, b1: number): number {
  return lerp(b0, b1, saturate(invLerp(a0, a1, v)));
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach. `rate` is 1/time-constant. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

/** Move `current` towards `target` by at most `maxDelta`. */
export function approach(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

export function wrap360(deg: number): number {
  deg %= 360;
  return deg < 0 ? deg + 360 : deg;
}

export function sign(v: number): number {
  return v < 0 ? -1 : 1;
}

/** Piecewise-linear table lookup: xs ascending. */
export function table(xs: readonly number[], ys: readonly number[], x: number): number {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let i = 1;
  while (x > xs[i]) i++;
  const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
  return ys[i - 1] + (ys[i] - ys[i - 1]) * t;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash -> [0,1). */
export function hash2(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function hash1(x: number, seed = 0): number {
  return hash2(x, 7919, seed);
}

/** Second-order critically damped spring (for camera / head motion). */
export class Spring {
  value: number;
  velocity = 0;
  constructor(v = 0) {
    this.value = v;
  }
  update(target: number, omega: number, zeta: number, dt: number): number {
    // semi-implicit integration, sub-stepped for stability on long frames
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = omega * omega * (target - this.value) - 2 * zeta * omega * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }
}

/** Smoothed random signal (1D value noise over time), range ~[-1,1]. */
export class SmoothNoise {
  private t = 0;
  private a: number;
  private b: number;
  private r: () => number;
  constructor(seed: number) {
    this.r = rng(seed);
    this.a = this.r() * 2 - 1;
    this.b = this.r() * 2 - 1;
  }
  next(dt: number, freq: number): number {
    this.t += dt * freq;
    while (this.t >= 1) {
      this.t -= 1;
      this.a = this.b;
      this.b = this.r() * 2 - 1;
    }
    const s = this.t * this.t * (3 - 2 * this.t);
    return this.a + (this.b - this.a) * s;
  }
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.floor((s * 100) % 100);
  return `${m}:${ss.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`;
}
