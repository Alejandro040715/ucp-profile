// Procedural geometry for the XF-41 Corvus. Shapes are authored as data:
// fuselage = lofted cross-sections (spline-interpolated key stations with a
// sharp forebody chine that grows into the LERX), caret intakes, airfoil panels
// (wings, flaps, stabs, fins, rudders) with real NACA thickness, bubble canopy,
// nozzle petals. Body frame: x right, y up, z aft (metres).

import { BufferAttribute, BufferGeometry, Vector3 } from 'three';

// ---------------------------------------------------------------------------
// fuselage key stations
interface Station {
  z: number;
  cy: number; // section centre height
  w: number; // half width at the chine
  ht: number; // height above centre (top)
  hb: number; // depth below centre (bottom)
  chineY: number; // chine height relative to centre
  k2: number; // upper-side x factor (small = thin flange/LERX)
  k4: number; // lower-side x factor
  sharp: number; // 0 round .. 1 knife-edge chine
  shoulder: number; // top roundness (0.5 pointed .. 0.8 boxy)
}

export const Z_NOSE = -9.0;
export const Z_TAIL = 7.25;

const KEYS: Station[] = [
  { z: -9.0, cy: 0.0, w: 0.015, ht: 0.015, hb: 0.015, chineY: 0, k2: 0.9, k4: 0.9, sharp: 0, shoulder: 0.7 },
  { z: -8.75, cy: 0.0, w: 0.16, ht: 0.15, hb: 0.14, chineY: 0, k2: 0.9, k4: 0.9, sharp: 0, shoulder: 0.7 },
  { z: -8.2, cy: 0.01, w: 0.33, ht: 0.31, hb: 0.28, chineY: -0.02, k2: 0.88, k4: 0.88, sharp: 0.15, shoulder: 0.68 },
  { z: -7.3, cy: 0.05, w: 0.55, ht: 0.48, hb: 0.46, chineY: -0.06, k2: 0.82, k4: 0.85, sharp: 0.55, shoulder: 0.66 },
  { z: -6.3, cy: 0.1, w: 0.7, ht: 0.55, hb: 0.6, chineY: -0.1, k2: 0.78, k4: 0.82, sharp: 0.75, shoulder: 0.68 },
  { z: -5.4, cy: 0.15, w: 0.8, ht: 0.52, hb: 0.72, chineY: -0.14, k2: 0.76, k4: 0.8, sharp: 0.8, shoulder: 0.74 },
  { z: -4.3, cy: 0.2, w: 0.9, ht: 0.46, hb: 0.82, chineY: -0.16, k2: 0.75, k4: 0.8, sharp: 0.85, shoulder: 0.78 },
  { z: -3.2, cy: 0.22, w: 1.08, ht: 0.5, hb: 0.92, chineY: -0.18, k2: 0.72, k4: 0.76, sharp: 0.9, shoulder: 0.78 },
  { z: -2.45, cy: 0.22, w: 1.3, ht: 0.92, hb: 0.97, chineY: -0.2, k2: 0.67, k4: 0.74, sharp: 0.95, shoulder: 0.62 },
  { z: -1.0, cy: 0.2, w: 1.58, ht: 0.93, hb: 1.0, chineY: -0.2, k2: 0.66, k4: 0.78, sharp: 0.9, shoulder: 0.66 },
  { z: 0.6, cy: 0.18, w: 1.6, ht: 0.9, hb: 0.98, chineY: -0.2, k2: 0.72, k4: 0.82, sharp: 0.8, shoulder: 0.72 },
  { z: 2.2, cy: 0.16, w: 1.5, ht: 0.86, hb: 0.92, chineY: -0.18, k2: 0.76, k4: 0.84, sharp: 0.7, shoulder: 0.76 },
  { z: 3.8, cy: 0.14, w: 1.34, ht: 0.8, hb: 0.84, chineY: -0.16, k2: 0.8, k4: 0.86, sharp: 0.55, shoulder: 0.78 },
  { z: 5.2, cy: 0.12, w: 1.06, ht: 0.72, hb: 0.72, chineY: -0.12, k2: 0.86, k4: 0.88, sharp: 0.35, shoulder: 0.74 },
  { z: 6.3, cy: 0.1, w: 0.8, ht: 0.64, hb: 0.62, chineY: -0.06, k2: 0.9, k4: 0.9, sharp: 0.15, shoulder: 0.72 },
  { z: 7.0, cy: 0.08, w: 0.66, ht: 0.6, hb: 0.58, chineY: -0.02, k2: 0.92, k4: 0.92, sharp: 0.05, shoulder: 0.71 },
  { z: 7.25, cy: 0.08, w: 0.63, ht: 0.58, hb: 0.56, chineY: 0, k2: 0.92, k4: 0.92, sharp: 0, shoulder: 0.71 },
];

/** cockpit opening in the fuselage skin */
export const COCKPIT = { z0: -5.58, z1: -2.88, halfWidth: 0.48, sillY: 0.62 };

/** design eye point (body frame) */
export const EYE = { x: 0, y: 0.96, z: -4.2 };

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

export function stationAt(z: number): Station {
  let i = 0;
  while (i < KEYS.length - 2 && z > KEYS[i + 1].z) i++;
  const a = KEYS[Math.max(0, i - 1)], b = KEYS[i], c = KEYS[i + 1], d = KEYS[Math.min(KEYS.length - 1, i + 2)];
  const t = Math.max(0, Math.min(1, (z - b.z) / (c.z - b.z)));
  const out = { z } as Station;
  for (const k of ['cy', 'w', 'ht', 'hb', 'chineY', 'k2', 'k4', 'sharp', 'shoulder'] as const) {
    out[k] = catmull(a[k], b[k], c[k], d[k], t);
  }
  // keep monotonic positive sizes
  out.w = Math.max(out.w, 0.005);
  out.ht = Math.max(out.ht, 0.005);
  out.hb = Math.max(out.hb, 0.005);
  return out;
}

/**
 * Closed section loop (clockwise seen from the front, starting at top centre).
 * Returns `n` points (x, y) — n must be a multiple of 12.
 */
export function sectionLoop(s: Station, n: number): [number, number][] {
  const { w, ht, hb, chineY, k2, k4, shoulder } = s;
  // right half control points, top -> bottom
  const half: [number, number][] = [
    [0, ht],
    [w * shoulder * 0.78, ht * 0.9],
    [w * k2, chineY + (ht - chineY) * 0.32],
    [w, chineY],
    [w * k4, chineY - (chineY + hb) * 0.4],
    [w * 0.48, -hb * 0.95],
    [0, -hb],
  ];
  const ctrl: [number, number][] = [...half];
  for (let i = half.length - 2; i >= 1; i--) ctrl.push([-half[i][0], half[i][1]]);
  const m = ctrl.length; // 12
  const per = n / m;
  const pts: [number, number][] = [];
  const sharpIdx = new Set([3, 9]);
  for (let i = 0; i < m; i++) {
    const p0 = ctrl[(i - 1 + m) % m], p1 = ctrl[i], p2 = ctrl[(i + 1) % m], p3 = ctrl[(i + 2) % m];
    // tangent scaling at the chine (sharp corner when s.sharp -> 1)
    const s1 = sharpIdx.has(i) ? 1 - s.sharp : 1;
    const s2 = sharpIdx.has((i + 1) % m) ? 1 - s.sharp : 1;
    for (let k = 0; k < per; k++) {
      const t = k / per;
      // Hermite with scaled Catmull-Rom tangents
      const m1x = 0.5 * (p2[0] - p0[0]) * s1, m1y = 0.5 * (p2[1] - p0[1]) * s1;
      const m2x = 0.5 * (p3[0] - p1[0]) * s2, m2y = 0.5 * (p3[1] - p1[1]) * s2;
      const t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      pts.push([h00 * p1[0] + h10 * m1x + h01 * p2[0] + h11 * m2x, h00 * p1[1] + h10 * m1y + h01 * p2[1] + h11 * m2y + s.cy]);
    }
  }
  return pts;
}

export interface FuselageResult {
  geometry: BufferGeometry;
  /** perimeter (m) as a function of z, for texture painting */
  perimeter: (z: number) => number;
  zs: number[];
  around: number;
}

/** Non-uniform z stations: dense at the nose, cockpit and tail. */
function stationZs(): number[] {
  const zs: number[] = [];
  const segs: [number, number, number][] = [
    [Z_NOSE, -8.2, 14],
    [-8.2, -5.6, 18],
    [-5.6, -2.85, 26],
    [-2.85, 5.0, 40],
    [5.0, Z_TAIL, 16],
  ];
  for (const [a, b, n] of segs) for (let i = 0; i < n; i++) zs.push(a + ((b - a) * i) / n);
  zs.push(Z_TAIL);
  return zs;
}

export function buildFuselage(around = 72): FuselageResult {
  const zs = stationZs();
  const nz = zs.length;
  const pos = new Float32Array(nz * (around + 1) * 3);
  const uv = new Float32Array(nz * (around + 1) * 2);
  const open = new Uint8Array(nz * (around + 1));
  const perims: number[] = [];
  for (let j = 0; j < nz; j++) {
    const z = zs[j];
    const st = stationAt(z);
    const loop = sectionLoop(st, around);
    // cockpit opening: flatten the top arc down to the sill and mark it open
    const inCockpit = z > COCKPIT.z0 && z < COCKPIT.z1;
    let per = 0;
    for (let i = 0; i <= around; i++) {
      const [x0, y0] = loop[i % around];
      let x = x0, y = y0;
      if (inCockpit && Math.abs(x) < COCKPIT.halfWidth && y > COCKPIT.sillY) {
        y = COCKPIT.sillY;
        open[j * (around + 1) + i] = 1;
      }
      const k = (j * (around + 1) + i) * 3;
      pos[k] = x;
      pos[k + 1] = y;
      pos[k + 2] = z;
      if (i > 0) {
        const pk = k - 3;
        per += Math.hypot(x - pos[pk], y - pos[pk + 1]);
      }
      uv[(j * (around + 1) + i) * 2] = (z - Z_NOSE) / (Z_TAIL - Z_NOSE);
      uv[(j * (around + 1) + i) * 2 + 1] = i / around;
    }
    perims.push(per);
  }
  const idx: number[] = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < around; i++) {
      const a = j * (around + 1) + i, b = a + 1, c = a + around + 1, d = c + 1;
      if (open[a] && open[b] && open[c] && open[d]) continue;
      idx.push(a, c, b, b, c, d);
    }
  }
  // tail cap ring is open (nozzle covers it); nose is a point
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return {
    geometry: g,
    perimeter: (z: number) => {
      let i = 0;
      while (i < nz - 2 && z > zs[i + 1]) i++;
      const t = (z - zs[i]) / (zs[i + 1] - zs[i]);
      return perims[i] + (perims[i + 1] - perims[i]) * Math.max(0, Math.min(1, t));
    },
    zs,
    around,
  };
}

// ---------------------------------------------------------------------------
// caret intakes (one side): outer shell + dark duct interior
export function buildIntake(side: 1 | -1): { outer: BufferGeometry; inner: BufferGeometry; face: BufferGeometry } {
  const nz = 18, na = 40;
  const z0 = -3.05, z1 = -0.2;
  const outerPos: number[] = [];
  const innerPos: number[] = [];
  const outerUv: number[] = [];
  for (let j = 0; j <= nz; j++) {
    const t = j / nz;
    const z = z0 + (z1 - z0) * t;
    // duct section: rounded trapezoid, blends into the fuselage side (moves inward)
    const cx = side * (1.2 - 0.12 * t * t);
    const cy = -0.32 + 0.04 * t;
    const hw = 0.33 - 0.04 * t;
    const hh = 0.5 - 0.05 * t;
    for (let i = 0; i <= na; i++) {
      const a = (i / na) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      // superellipse (boxy)
      const ex = Math.sign(ca) * Math.pow(Math.abs(ca), 0.55);
      const ey = Math.sign(sa) * Math.pow(Math.abs(sa), 0.55);
      // caret lip: the opening plane is swept back at the top and outboard edge
      const lipSweep = j === 0 ? 0.42 * ((ey + 1) / 2) + 0.22 * ((ex * side + 1) / 2) : 0;
      const zz = z + lipSweep * (1 - t);
      const thick = 0.035 + 0.02 * t;
      outerPos.push(cx + ex * (hw + thick), cy + ey * (hh + thick), zz);
      innerPos.push(cx + ex * hw, cy + ey * hh, zz + 0.002);
      outerUv.push((zz + 9) / 16.25, i / na);
    }
  }
  const quadIdx = (flip: boolean) => {
    const idx: number[] = [];
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < na; i++) {
        const a = j * (na + 1) + i, b = a + 1, c = a + na + 1, d = c + 1;
        if (flip) idx.push(a, c, b, b, c, d);
        else idx.push(a, b, c, b, d, c);
      }
    return idx;
  };
  const outer = new BufferGeometry();
  outer.setAttribute('position', new BufferAttribute(new Float32Array(outerPos), 3));
  outer.setAttribute('uv', new BufferAttribute(new Float32Array(outerUv), 2));
  outer.setIndex(quadIdx(false));
  outer.computeVertexNormals();
  const inner = new BufferGeometry();
  inner.setAttribute('position', new BufferAttribute(new Float32Array(innerPos), 3));
  inner.setIndex(quadIdx(true));
  inner.computeVertexNormals();
  // lip ring (front face between inner and outer at j = 0) for a solid edge
  const lip: number[] = [];
  for (let i = 0; i < na; i++) {
    const o0 = outerPos.slice(i * 3, i * 3 + 3), o1 = outerPos.slice((i + 1) * 3, (i + 1) * 3 + 3);
    const i0 = innerPos.slice(i * 3, i * 3 + 3), i1 = innerPos.slice((i + 1) * 3, (i + 1) * 3 + 3);
    lip.push(...o0, ...i0, ...o1, ...o1, ...i0, ...i1);
  }
  // compressor face deep in the duct
  const face = new BufferGeometry();
  const fpos: number[] = [];
  const cxF = side * 1.08, cyF = -0.28;
  for (let i = 0; i < na; i++) {
    const a0 = (i / na) * Math.PI * 2, a1 = ((i + 1) / na) * Math.PI * 2;
    fpos.push(cxF, cyF, z1 - 0.1, cxF + Math.cos(a0) * 0.3, cyF + Math.sin(a0) * 0.45, z1 - 0.1, cxF + Math.cos(a1) * 0.3, cyF + Math.sin(a1) * 0.45, z1 - 0.1);
  }
  fpos.push(...lip);
  face.setAttribute('position', new BufferAttribute(new Float32Array(fpos), 3));
  face.computeVertexNormals();
  return { outer, inner, face };
}

// ---------------------------------------------------------------------------
// airfoil panels
export interface PanelSpec {
  /** root and tip leading edge points (x, y, z) and chords along +z */
  rootLE: [number, number, number];
  tipLE: [number, number, number];
  rootChord: number;
  tipChord: number;
  thickRoot: number; // t/c
  thickTip: number;
  /** chord fraction range to build (for control surfaces) */
  c0: number;
  c1: number;
  /** span fraction range */
  s0: number;
  s1: number;
  nSpan?: number;
  nChord?: number;
  /** if set, panel lies in a plane rotated by this cant (fins): span direction defined by root/tip */
  uvRect?: [number, number, number, number]; // u0, v0, u1, v1 in atlas
}

function naca(t: number, x: number): number {
  // NACA 4-digit symmetric half thickness (x in 0..1), closed TE
  return 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x);
}

/**
 * Builds a closed airfoil-section panel between span fractions s0..s1 and
 * chord fractions c0..c1. Thickness direction is perpendicular to the span
 * and chord directions (works for canted fins).
 */
export function buildPanel(p: PanelSpec): BufferGeometry {
  const nS = p.nSpan ?? 10, nC = p.nChord ?? 16;
  const rl = new Vector3(...p.rootLE), tl = new Vector3(...p.tipLE);
  const chordDir = new Vector3(0, 0, 1);
  const spanVec = new Vector3().subVectors(tl, rl);
  // thickness axis: perpendicular to span (projected) and chord
  const thickAxis = new Vector3().crossVectors(chordDir, spanVec).normalize();
  const negated = thickAxis.y < 0;
  if (negated) thickAxis.negate();
  const pos: number[] = [];
  const uv: number[] = [];
  const [u0, v0, u1, v1] = p.uvRect ?? [0, 0, 1, 1];
  const ring = (s: number, upper: boolean) => {
    const le = new Vector3().lerpVectors(rl, tl, s);
    const chord = p.rootChord + (p.tipChord - p.rootChord) * s;
    const tc = p.thickRoot + (p.thickTip - p.thickRoot) * s;
    const out: Vector3[] = [];
    for (let k = 0; k <= nC; k++) {
      // cosine spacing for nicer leading edges
      const f = p.c0 + (p.c1 - p.c0) * (0.5 - 0.5 * Math.cos((k / nC) * Math.PI));
      const ht = naca(tc, Math.max(f, 1e-4)) * chord;
      const pt = le.clone().addScaledVector(chordDir, f * chord).addScaledVector(thickAxis, upper ? ht : -ht);
      out.push(pt);
    }
    return out;
  };
  const sCount = nS + 1;
  const rowsU: Vector3[][] = [], rowsL: Vector3[][] = [];
  for (let i = 0; i < sCount; i++) {
    const s = p.s0 + ((p.s1 - p.s0) * i) / nS;
    rowsU.push(ring(s, true));
    rowsL.push(ring(s, false));
  }
  const idx: number[] = [];
  const push = (v: Vector3, uu: number, vv: number) => {
    pos.push(v.x, v.y, v.z);
    uv.push(uu, vv);
    return pos.length / 3 - 1;
  };
  const planUV = (v: Vector3, lower: boolean): [number, number] => {
    // planform mapping into the atlas rect: u along span (projected), v along chord (z)
    const s = new Vector3().subVectors(v, rl).dot(spanVec) / spanVec.lengthSq();
    const zN = (v.z - Math.min(rl.z, tl.z)) / (Math.max(rl.z + p.rootChord, tl.z + p.tipChord) - Math.min(rl.z, tl.z));
    const uu = u0 + (u1 - u0) * (lower ? 0.5 + s * 0.5 : s * 0.5);
    return [uu, v0 + (v1 - v0) * zN];
  };
  // surfaces
  for (const [rows, lower] of [[rowsU, false], [rowsL, true]] as const) {
    const base = pos.length / 3;
    for (let i = 0; i < sCount; i++) for (let k = 0; k <= nC; k++) push(rows[i][k], ...planUV(rows[i][k], lower));
    for (let i = 0; i < nS; i++)
      for (let k = 0; k < nC; k++) {
        const a = base + i * (nC + 1) + k, b = a + 1, c = a + nC + 1, d = c + 1;
        if (!lower) idx.push(a, b, c, b, d, c);
        else idx.push(a, c, b, b, c, d);
      }
  }
  // end caps (root and tip ribs)
  for (const i of [0, nS]) {
    const base = pos.length / 3;
    for (let k = 0; k <= nC; k++) {
      push(rowsU[i][k], 0.995, 0.995);
      push(rowsL[i][k], 0.995, 0.995);
    }
    for (let k = 0; k < nC; k++) {
      const a = base + k * 2, b = a + 1, c = a + 2, d = a + 3;
      if (i === 0) idx.push(a, b, c, c, b, d);
      else idx.push(a, c, b, c, d, b);
    }
  }
  // front / back spar faces when the panel is cut chordwise
  for (const k of [0, nC]) {
    if ((k === 0 && p.c0 <= 0.001) || (k === nC && p.c1 >= 0.999)) continue;
    const base = pos.length / 3;
    for (let i = 0; i < sCount; i++) {
      push(rowsU[i][k], 0.995, 0.995);
      push(rowsL[i][k], 0.995, 0.995);
    }
    for (let i = 0; i < nS; i++) {
      const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
      if (k === 0) idx.push(a, c, b, c, d, b);
      else idx.push(a, b, c, c, b, d);
    }
  }
  if (negated) {
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = t;
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Hinge line (point + axis) at a chord fraction of a panel spec. */
export function hingeOf(p: PanelSpec, c: number, s0: number, s1: number): { origin: Vector3; axis: Vector3 } {
  const rl = new Vector3(...p.rootLE), tl = new Vector3(...p.tipLE);
  const a = new Vector3().lerpVectors(rl, tl, s0);
  const b = new Vector3().lerpVectors(rl, tl, s1);
  const ca = p.rootChord + (p.tipChord - p.rootChord) * s0;
  const cb = p.rootChord + (p.tipChord - p.rootChord) * s1;
  a.z += ca * c;
  b.z += cb * c;
  return { origin: a, axis: new Vector3().subVectors(b, a).normalize() };
}

// ---------------------------------------------------------------------------
// canopy bubble (hinged at the rear)
export const CANOPY_HINGE = new Vector3(0, 0.66, -2.9);

/** canopy crown height (y) along its length, t = 0 front .. 1 rear */
export function canopyTop(t: number): number {
  const front = Math.min(1, t / 0.36);
  const rise = Math.sin(front * Math.PI * 0.5);
  const fall = Math.max(0, (t - 0.55) / 0.45);
  return COCKPIT.sillY + 0.02 + rise * 0.72 - 0.2 * fall * fall;
}
export function canopyHalfWidth(t: number): number {
  return 0.47 * (0.6 + 0.4 * Math.sin(Math.min(1, t / 0.42) * Math.PI * 0.5)) * (1 - 0.12 * Math.max(0, (t - 0.72) / 0.28));
}
export const CANOPY_Z0 = -5.62;
export const CANOPY_Z1 = -2.9;

export function buildCanopy(): { glass: BufferGeometry; frame: BufferGeometry } {
  const nz = 36, na = 36;
  const z0 = CANOPY_Z0, z1 = CANOPY_Z1;
  const pos: number[] = [];
  const uv: number[] = [];
  for (let j = 0; j <= nz; j++) {
    const t = j / nz;
    const z = z0 + (z1 - z0) * t;
    const hw = canopyHalfWidth(t);
    const ytop = canopyTop(t);
    for (let i = 0; i <= na; i++) {
      const a = (i / na) * Math.PI; // 0 = right sill, PI = left sill
      const x = Math.cos(a) * hw;
      const y = COCKPIT.sillY - 0.01 + Math.pow(Math.sin(a), 0.7) * (ytop - COCKPIT.sillY);
      pos.push(x, y, z);
      uv.push(t, i / na);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < na; i++) {
      const a = j * (na + 1) + i, b = a + 1, c = a + na + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  const glass = new BufferGeometry();
  glass.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  glass.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  glass.setIndex(idx);
  glass.computeVertexNormals();
  // frame: sill rails + rear arch + thin front bow
  const fpos: number[] = [];
  const addBox = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number) => {
    const v = [
      [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
    ].map(([x, y, zz]) => [cx + x * sx, cy + y * sy, cz + zz * sz]);
    const faces = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];
    for (const f of faces) fpos.push(...v[f[0]], ...v[f[2]], ...v[f[1]], ...v[f[0]], ...v[f[3]], ...v[f[2]]);
  };
  // sill rails following the canopy edge
  for (let j = 0; j < nz; j++) {
    const ta = j / nz, tb = (j + 1) / nz;
    const za = z0 + (z1 - z0) * ta, zb = z0 + (z1 - z0) * tb;
    for (const s of [-1, 1]) {
      const xa = s * canopyHalfWidth(ta), xb = s * canopyHalfWidth(tb);
      addBox((xa + xb) / 2, COCKPIT.sillY - 0.0, (za + zb) / 2, 0.028, 0.03, Math.abs(zb - za) / 2 + 0.005);
    }
  }
  // arches: rear (heavy) and a slim bow where the windscreen meets the canopy
  const arch = (t: number, thick: number, depth: number) => {
    const z = z0 + (z1 - z0) * t;
    const hw = canopyHalfWidth(t), yt = canopyTop(t);
    for (let i = 0; i < na; i++) {
      const a0 = (i / na) * Math.PI, a1 = ((i + 1) / na) * Math.PI;
      const x0 = Math.cos(a0) * hw, y0 = COCKPIT.sillY + Math.pow(Math.sin(a0), 0.7) * (yt - COCKPIT.sillY);
      const x1 = Math.cos(a1) * hw, y1 = COCKPIT.sillY + Math.pow(Math.sin(a1), 0.7) * (yt - COCKPIT.sillY);
      addBox((x0 + x1) / 2, (y0 + y1) / 2, z, Math.abs(x1 - x0) / 2 + thick, Math.abs(y1 - y0) / 2 + thick, depth);
    }
  };
  arch(1, 0.035, 0.05);
  arch(0.985, 0.03, 0.03);
  const frame = new BufferGeometry();
  frame.setAttribute('position', new BufferAttribute(new Float32Array(fpos), 3));
  frame.computeVertexNormals();
  return { glass, frame };
}

// ---------------------------------------------------------------------------
// nozzle: one petal (instanced around the axis) and the inner liner
export const NOZZLE = { z0: 7.05, length: 1.05, rootR: 0.6, petals: 18 };

export function buildNozzlePetal(): BufferGeometry {
  // petal lies along +z from the hinge ring, outer surface at radius 1 (scaled at runtime)
  const w = (2 * Math.PI) / NOZZLE.petals / 2 * 1.04;
  const pos: number[] = [];
  const segs = 6;
  for (let i = 0; i < segs; i++) {
    const a0 = -w + (2 * w * i) / segs, a1 = -w + (2 * w * (i + 1)) / segs;
    for (const [r, z0, z1] of [[1, 0, 1]] as const) {
      const p = (a: number, z: number, rr: number) => [Math.sin(a) * rr, Math.cos(a) * rr, z];
      const v00 = p(a0, z0, r), v10 = p(a1, z0, r), v01 = p(a0, z1, r), v11 = p(a1, z1, r);
      pos.push(...v00, ...v10, ...v01, ...v10, ...v11, ...v01);
      // inner face (slightly smaller radius)
      const i00 = p(a0, z0, r - 0.05), i10 = p(a1, z0, r - 0.05), i01 = p(a0, z1, r - 0.05), i11 = p(a1, z1, r - 0.05);
      pos.push(...i00, ...i01, ...i10, ...i10, ...i01, ...i11);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  const uv = new Float32Array((pos.length / 3) * 2);
  for (let i = 0; i < pos.length / 3; i++) {
    uv[i * 2] = pos[i * 3 + 2];
    uv[i * 2 + 1] = Math.atan2(pos[i * 3], pos[i * 3 + 1]) / w * 0.5 + 0.5;
  }
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** Simple revolve helper (profile in (r, z)). */
export function revolve(profile: [number, number][], segs: number, axisY = 0, axisX = 0): BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  for (let j = 0; j < profile.length; j++) {
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pos.push(axisX + Math.sin(a) * profile[j][0], axisY + Math.cos(a) * profile[j][0], profile[j][1]);
      uv.push(j / (profile.length - 1), i / segs);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < profile.length - 1; j++)
    for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i, b = a + 1, c = a + segs + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// panel specs (shared by geometry + painter)
const W_ROOT_X = 1.38;
export const WING: PanelSpec = {
  rootLE: [W_ROOT_X, -0.02, -1.6],
  tipLE: [5.35, -0.17, 2.05],
  rootChord: 6.1,
  tipChord: 1.55,
  thickRoot: 0.048,
  thickTip: 0.034,
  c0: 0,
  c1: 1,
  s0: 0,
  s1: 1,
  nSpan: 12,
  nChord: 22,
  uvRect: [0, 0, 1, 1],
};
export const STAB: PanelSpec = {
  rootLE: [0.95, -0.06, 4.85],
  tipLE: [3.15, -0.1, 6.35],
  rootChord: 2.55,
  tipChord: 1.0,
  thickRoot: 0.04,
  thickTip: 0.03,
  c0: 0,
  c1: 1,
  s0: 0,
  s1: 1,
  nSpan: 6,
  nChord: 14,
};
const FIN_CANT = (24 * Math.PI) / 180;
export const FIN: PanelSpec = {
  rootLE: [0.92, 0.72, 3.55],
  tipLE: [0.92 + Math.sin(FIN_CANT) * 2.35, 0.72 + Math.cos(FIN_CANT) * 2.35, 5.55],
  rootChord: 3.05,
  tipChord: 1.3,
  thickRoot: 0.042,
  thickTip: 0.032,
  c0: 0,
  c1: 1,
  s0: 0,
  s1: 1,
  nSpan: 8,
  nChord: 14,
};

export function mirrorSpec(p: PanelSpec): PanelSpec {
  return { ...p, rootLE: [-p.rootLE[0], p.rootLE[1], p.rootLE[2]], tipLE: [-p.tipLE[0], p.tipLE[1], p.tipLE[2]] };
}

/** Reverse triangle winding (for mirrored geometry). */
export function flipWinding(g: BufferGeometry): BufferGeometry {
  const idx = g.index;
  if (idx) {
    const a = idx.array as Uint16Array | Uint32Array;
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1];
      a[i + 1] = a[i + 2];
      a[i + 2] = t;
    }
    idx.needsUpdate = true;
  } else {
    const p = g.attributes.position.array as Float32Array;
    for (let i = 0; i < p.length; i += 9) {
      for (let k = 0; k < 3; k++) {
        const t = p[i + 3 + k];
        p[i + 3 + k] = p[i + 6 + k];
        p[i + 6 + k] = t;
      }
    }
  }
  g.computeVertexNormals();
  return g;
}
