// Procedural "texture painting" for the airframe: canvas-drawn albedo, height
// (-> normal map) and ORM maps with panel lines, rivets, fasteners, access
// panels, two-tone camouflage, fictional insignia and stencils, walkways,
// exhaust soot, grime streaks, scuffs and baked ambient occlusion.

import { CanvasTexture, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace, LinearSRGBColorSpace, type Texture } from 'three';
import { rng } from '../../core/math.ts';
import { COCKPIT, Z_NOSE, Z_TAIL, type PanelSpec } from './FighterGeometry.ts';
import { texImage, tileImage, type TexMap } from '../../assets/TextureLibrary.ts';

// ---------------------------------------------------------------------------
// real CC0 weathering masks (ambientCG scans, see public/textures/CREDITS.md)
// are converted once into tinted alpha stamps and tiled over the paint canvases
// at their physical scale. Missing images simply skip that layer.
const stampCache = new Map<string, HTMLCanvasElement>();

/** canvas whose alpha = mask (optionally inverted, contrast-shaped) and colour = tint */
function maskStamp(slug: string, map: TexMap, tint: [number, number, number], opts: { invert?: boolean; gamma?: number; lo?: number; hi?: number } = {}): HTMLCanvasElement | null {
  const key = `${slug}/${map}/${tint.join(',')}/${opts.invert ? 1 : 0}/${opts.gamma ?? 1}/${opts.lo ?? 0}/${opts.hi ?? 1}`;
  const hit = stampCache.get(key);
  if (hit) return hit;
  const img = texImage(slug, map);
  if (!img) return null;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  const lo = opts.lo ?? 0, hi = opts.hi ?? 1, gam = opts.gamma ?? 1;
  for (let i = 0; i < d.data.length; i += 4) {
    let v = d.data[i] / 255;
    if (opts.invert) v = 1 - v;
    v = Math.min(1, Math.max(0, (v - lo) / Math.max(1e-3, hi - lo)));
    v = Math.pow(v, gam);
    d.data[i] = tint[0];
    d.data[i + 1] = tint[1];
    d.data[i + 2] = tint[2];
    d.data[i + 3] = v * 255;
  }
  g.putImageData(d, 0, 0);
  stampCache.set(key, c);
  return c;
}

/** Bake one weathering layer into a painter canvas over a rectangle. */
function weather(
  ctx: CanvasRenderingContext2D,
  stamp: HTMLCanvasElement | null,
  rect: [number, number, number, number],
  tilePx: number,
  alpha: number,
  offset = 0,
  op: GlobalCompositeOperation = 'source-over',
): void {
  if (!stamp || alpha <= 0) return;
  tileImage(ctx, stamp, rect[0], rect[1], rect[2], rect[3], tilePx, { alpha, op, offsetX: offset * 0.37, offsetY: offset * 0.61 });
}

export interface PaintScheme {
  top: string;
  bottom: string;
  patch: string;
  radome: string;
  serial: string;
  code: string;
  unit: string;
  highVis: boolean;
}

export const SCHEMES: Record<string, PaintScheme> = {
  standard: { top: '#5f666d', bottom: '#8b9198', patch: '#4f555b', radome: '#6a6f73', serial: '41-0127', code: 'VA', unit: '7th TFW', highVis: false },
  aggressor: { top: '#6e6450', bottom: '#9b927c', patch: '#4a4436', radome: '#5f5a50', serial: '41-0209', code: 'VA', unit: 'AGGRESSOR', highVis: false },
  wingman: { top: '#585f66', bottom: '#848a91', patch: '#474d53', radome: '#646a6e', serial: '41-0133', code: 'VA', unit: '7th TFW', highVis: false },
};

export interface MaterialMaps {
  map: Texture;
  normalMap: Texture;
  ormMap: Texture; // R = AO, G = roughness, B = metalness
}

class Painter {
  readonly w: number;
  readonly h: number;
  readonly color: CanvasRenderingContext2D;
  readonly height: CanvasRenderingContext2D;
  readonly rough: CanvasRenderingContext2D;
  readonly ao: CanvasRenderingContext2D;
  readonly cColor: HTMLCanvasElement;
  readonly cHeight: HTMLCanvasElement;
  readonly cRough: HTMLCanvasElement;
  readonly cAo: HTMLCanvasElement;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    const mk = () => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    };
    this.cColor = mk();
    this.cHeight = mk();
    this.cRough = mk();
    this.cAo = mk();
    this.color = this.cColor.getContext('2d')!;
    this.height = this.cHeight.getContext('2d', { willReadFrequently: true })!;
    this.rough = this.cRough.getContext('2d', { willReadFrequently: true })!;
    this.ao = this.cAo.getContext('2d', { willReadFrequently: true })!;
    this.height.fillStyle = 'rgb(128,128,128)';
    this.height.fillRect(0, 0, w, h);
    this.rough.fillStyle = 'rgb(150,150,150)';
    this.rough.fillRect(0, 0, w, h);
    this.ao.fillStyle = '#fff';
    this.ao.fillRect(0, 0, w, h);
  }

  /** engraved line on height + darkened colour */
  line(x0: number, y0: number, x1: number, y1: number, width = 2, depth = 70, darken = 0.16): void {
    const h = this.height;
    h.strokeStyle = `rgb(${128 - depth},${128 - depth},${128 - depth})`;
    h.lineWidth = width;
    h.beginPath();
    h.moveTo(x0, y0);
    h.lineTo(x1, y1);
    h.stroke();
    const c = this.color;
    c.strokeStyle = `rgba(0,0,0,${darken})`;
    c.lineWidth = width * 0.9;
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.stroke();
  }

  rivetsAlong(x0: number, y0: number, x1: number, y1: number, spacing: number, offset: number, r: () => number, raised = true): void {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.floor(len / spacing);
    const nx = -(y1 - y0) / (len || 1), ny = (x1 - x0) / (len || 1);
    const h = this.height;
    const c = this.color;
    for (let i = 0; i <= n; i++) {
      const t = i / Math.max(1, n);
      const x = x0 + (x1 - x0) * t + nx * offset, y = y0 + (y1 - y0) * t + ny * offset;
      const v = raised ? 128 + 9 : 128 - 12;
      h.fillStyle = `rgb(${v},${v},${v})`;
      h.beginPath();
      h.arc(x, y, 1.6, 0, Math.PI * 2);
      h.fill();
      if (r() < 0.6) {
        c.fillStyle = `rgba(${r() < 0.5 ? '255,255,255' : '0,0,0'},${0.05 + r() * 0.06})`;
        c.beginPath();
        c.arc(x, y, 1.4, 0, Math.PI * 2);
        c.fill();
      }
    }
  }

  /** access panel: engraved outline, fasteners, slightly different tone */
  panel(x: number, y: number, w: number, h: number, r: () => number, opts: { screws?: boolean; tone?: number; label?: string; labelSize?: number } = {}): void {
    const rad = Math.min(w, h) * 0.12;
    const path = (ctx: CanvasRenderingContext2D) => {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, rad);
    };
    const tone = opts.tone ?? (r() - 0.5) * 0.08;
    const c = this.color;
    c.fillStyle = tone > 0 ? `rgba(255,255,255,${tone})` : `rgba(0,0,0,${-tone})`;
    path(c);
    c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.2)';
    c.lineWidth = 1.6;
    path(c);
    c.stroke();
    const hh = this.height;
    hh.strokeStyle = 'rgb(60,60,60)';
    hh.lineWidth = 2;
    path(hh);
    hh.stroke();
    // roughness tweak
    this.rough.fillStyle = `rgba(${r() < 0.5 ? '170,170,170' : '135,135,135'},0.5)`;
    path(this.rough);
    this.rough.fill();
    if (opts.screws !== false) {
      const sp = 9;
      const per = 2 * (w + h);
      const n = Math.max(4, Math.floor(per / (sp * 3)));
      for (let i = 0; i < n; i++) {
        const t = (i / n) * per;
        let px: number, py: number;
        if (t < w) [px, py] = [x + t, y + 4];
        else if (t < w + h) [px, py] = [x + w - 4, y + (t - w)];
        else if (t < 2 * w + h) [px, py] = [x + w - (t - w - h), y + h - 4];
        else [px, py] = [x + 4, y + h - (t - 2 * w - h)];
        hh.fillStyle = 'rgb(100,100,100)';
        hh.beginPath();
        hh.arc(px, py, 2.0, 0, Math.PI * 2);
        hh.fill();
        c.fillStyle = 'rgba(30,30,30,0.35)';
        c.beginPath();
        c.arc(px, py, 1.3, 0, Math.PI * 2);
        c.fill();
      }
    }
    if (opts.label) this.stencil(opts.label, x + w / 2, y + h / 2, opts.labelSize ?? 14, 0, 'rgba(25,25,25,0.75)');
  }

  /**
   * Door / hatch outline with sawtooth front and rear edges (x = along the
   * airflow), engraved into the height map with a faint seal line.
   */
  sawPanel(x: number, y: number, w: number, h: number, teeth: number, depth: number, opts: { tone?: number; label?: string; labelSize?: number } = {}): void {
    const path = (ctx: CanvasRenderingContext2D) => {
      const th = h / teeth;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let i = 0; i < teeth; i++) {
        ctx.lineTo(x - depth, y + i * th + th / 2);
        ctx.lineTo(x, y + (i + 1) * th);
      }
      ctx.lineTo(x + w, y + h);
      for (let i = teeth - 1; i >= 0; i--) {
        ctx.lineTo(x + w + depth, y + i * th + th / 2);
        ctx.lineTo(x + w, y + i * th);
      }
      ctx.closePath();
    };
    const c = this.color;
    if (opts.tone) {
      c.fillStyle = opts.tone > 0 ? `rgba(255,255,255,${opts.tone})` : `rgba(0,0,0,${-opts.tone})`;
      path(c);
      c.fill();
    }
    c.strokeStyle = 'rgba(0,0,0,0.22)';
    c.lineWidth = 1.8;
    path(c);
    c.stroke();
    const hh = this.height;
    hh.strokeStyle = 'rgb(55,55,55)';
    hh.lineWidth = 2.2;
    path(hh);
    hh.stroke();
    if (opts.label) this.stencil(opts.label, x + w / 2, y + h / 2, opts.labelSize ?? 14, 0, 'rgba(25,25,25,0.6)');
  }

  stencil(text: string, x: number, y: number, size: number, rot = 0, color = 'rgba(20,20,20,0.8)', scaleX = 1, scaleY = 1): void {
    const c = this.color;
    c.save();
    c.translate(x, y);
    c.rotate(rot);
    c.scale(scaleX, scaleY);
    c.fillStyle = color;
    c.font = `600 ${size}px "Arial Narrow", Arial, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, 0, 0);
    c.restore();
  }

  /** soft streak of grime following the airflow (+x on the fuselage canvas) */
  streak(x: number, y: number, len: number, wid: number, alpha: number, color = '0,0,0', vertical = false): void {
    const c = this.color;
    const ex = vertical ? x : x + len, ey = vertical ? y + len : y;
    const g = c.createLinearGradient(x, y, ex, ey);
    g.addColorStop(0, `rgba(${color},${alpha})`);
    g.addColorStop(1, `rgba(${color},0)`);
    c.fillStyle = g;
    const cx = (x + ex) / 2, cy = (y + ey) / 2;
    const rx = vertical ? wid / 2 : len / 2, ry = vertical ? len / 2 : wid / 2;
    c.beginPath();
    c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    c.fill();
    this.rough.fillStyle = `rgba(200,200,200,${alpha * 0.6})`;
    this.rough.beginPath();
    this.rough.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    this.rough.fill();
  }

  noiseOverlay(r: () => number, count: number, minR: number, maxR: number, alpha: number): void {
    const c = this.color;
    for (let i = 0; i < count; i++) {
      const x = r() * this.w, y = r() * this.h;
      const rr = minR + r() * (maxR - minR);
      const light = r() < 0.5;
      const g = c.createRadialGradient(x, y, 0, x, y, rr);
      g.addColorStop(0, light ? `rgba(255,255,255,${alpha * r()})` : `rgba(0,0,0,${alpha * r()})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(x - rr, y - rr, rr * 2, rr * 2);
    }
    // fine speckle into roughness
    const rc = this.rough;
    for (let i = 0; i < count * 4; i++) {
      const v = 120 + Math.floor(r() * 80);
      rc.fillStyle = `rgba(${v},${v},${v},0.25)`;
      const s = 2 + r() * 10;
      rc.fillRect(r() * this.w, r() * this.h, s, s);
    }
  }

  finish(normalStrength: number, metalness = 0): MaterialMaps {
    const map = new CanvasTexture(this.cColor);
    map.colorSpace = SRGBColorSpace;
    map.anisotropy = 8;
    map.minFilter = LinearMipmapLinearFilter;
    // normal map from height via Sobel
    const { w, h } = this;
    const hd = this.height.getImageData(0, 0, w, h).data;
    const nc = document.createElement('canvas');
    nc.width = w;
    nc.height = h;
    const nctx = nc.getContext('2d')!;
    const out = nctx.createImageData(w, h);
    const o = out.data;
    const H = (x: number, y: number) => hd[((((y + h) % h) * w) + ((x + w) % w)) * 4] / 255;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
        const dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1));
        let nx = -dx * normalStrength, ny = -dy * normalStrength;
        const nz = 1;
        const l = Math.hypot(nx, ny, nz);
        nx /= l;
        ny /= l;
        const i = (y * w + x) * 4;
        o[i] = (nx * 0.5 + 0.5) * 255;
        o[i + 1] = (-ny * 0.5 + 0.5) * 255;
        o[i + 2] = (nz / l * 0.5 + 0.5) * 255;
        o[i + 3] = 255;
      }
    }
    nctx.putImageData(out, 0, 0);
    const normalMap = new CanvasTexture(nc);
    normalMap.colorSpace = LinearSRGBColorSpace;
    normalMap.anisotropy = 8;
    // ORM pack
    const rd = this.rough.getImageData(0, 0, w, h).data;
    const ad = this.ao.getImageData(0, 0, w, h).data;
    const oc = document.createElement('canvas');
    oc.width = w;
    oc.height = h;
    const octx = oc.getContext('2d')!;
    const od = octx.createImageData(w, h);
    for (let i = 0; i < w * h * 4; i += 4) {
      od.data[i] = ad[i];
      od.data[i + 1] = rd[i];
      od.data[i + 2] = metalness * 255;
      od.data[i + 3] = 255;
    }
    octx.putImageData(od, 0, 0);
    const ormMap = new CanvasTexture(oc);
    ormMap.colorSpace = LinearSRGBColorSpace;
    for (const t of [map, normalMap, ormMap]) {
      t.wrapS = RepeatWrapping;
      t.wrapT = RepeatWrapping;
      t.needsUpdate = true;
    }
    return { map, normalMap, ormMap };
  }
}

/** fictional low-visibility national insignia */
function insignia(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, sx = 1): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(sx, 1);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = r * 0.09;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  // stylised corvid wing chevron
  ctx.beginPath();
  ctx.moveTo(-r * 0.7, r * 0.15);
  ctx.lineTo(0, -r * 0.55);
  ctx.lineTo(r * 0.7, r * 0.15);
  ctx.lineTo(r * 0.42, r * 0.15);
  ctx.lineTo(0, -r * 0.2);
  ctx.lineTo(-r * 0.42, r * 0.15);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, r * 0.42, r * 0.13, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Fuselage maps. Canvas x = along z (nose -> tail), canvas y = around (0 = top, 0.25 right chine, 0.5 bottom, 0.75 left). */
export function paintFuselage(scheme: PaintScheme, perimeter: (z: number) => number, W = 4096, H = 2048): MaterialMaps {
  const p = new Painter(W, H);
  const r = rng(scheme.serial.length * 977 + 13);
  const c = p.color;
  const X = (z: number) => ((z - Z_NOSE) / (Z_TAIL - Z_NOSE)) * W;
  const Yu = (u: number) => u * H;
  const pxPerM = W / (Z_TAIL - Z_NOSE);
  // around metres -> u at a given z
  const aroundScale = (z: number) => H / Math.max(0.5, perimeter(z));

  // --- base: counter-shaded two tone with soft transition at the chines
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, scheme.top);
  g.addColorStop(0.2, scheme.top);
  g.addColorStop(0.3, scheme.bottom);
  g.addColorStop(0.7, scheme.bottom);
  g.addColorStop(0.8, scheme.top);
  g.addColorStop(1, scheme.top);
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  // disruptive darker patches on the upper surfaces (wrap across the seam at u=0/1)
  c.fillStyle = scheme.patch;
  for (let i = 0; i < 9; i++) {
    const zc = -6 + r() * 12;
    const u = (r() - 0.5) * 0.32;
    const x = X(zc), y = Yu((u + 1) % 1);
    c.globalAlpha = 0.85;
    c.beginPath();
    const rw = 120 + r() * 260, rh = 80 + r() * 160;
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2;
      const rr = 1 + (r() - 0.5) * 0.5;
      const px = x + Math.cos(a) * rw * rr, py = y + Math.sin(a) * rh * rr;
      if (k === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    }
    c.closePath();
    c.fill();
    // wrapped copy
    c.save();
    c.translate(0, y < H / 2 ? H : -H);
    c.fill();
    c.restore();
  }
  c.globalAlpha = 1;
  // radome
  c.fillStyle = scheme.radome;
  c.fillRect(0, 0, X(-8.15), H);

  // --- frames (circumferential panel lines)
  const frames = [-8.15, -7.35, -6.6, -6.05, -2.85, -2.2, -1.25, -0.3, 0.75, 1.8, 2.9, 3.85, 4.9, 5.85, 6.6];
  for (const z of frames) {
    const x = X(z);
    // skip across the open cockpit top
    if (z > COCKPIT.z0 && z < COCKPIT.z1) continue;
    p.line(x, 0, x, H, 2.2, 75);
    p.rivetsAlong(x, 0, x, H, 9, 7, r);
    p.rivetsAlong(x, 0, x, H, 9, -7, r);
  }
  // longitudinal seams (stringers) at fixed around fractions
  for (const u of [0.0, 0.11, 0.2, 0.25, 0.31, 0.42, 0.5, 0.58, 0.69, 0.75, 0.8, 0.89]) {
    const y = Yu(u) + 1;
    const z0 = u === 0 || u > 0.97 ? -2.85 : -8.15;
    p.line(X(z0), y, X(6.6), y, 2, 60);
    p.rivetsAlong(X(z0), y, X(6.6), y, 10, 6, r, false);
  }
  // --- access panels (deterministic layout per bay)
  for (let bay = 0; bay < frames.length - 1; bay++) {
    const za = frames[bay], zb = frames[bay + 1];
    if (zb - za < 0.5) continue;
    for (const [u0, u1] of [[0.035, 0.105], [0.125, 0.195], [0.3, 0.36], [0.43, 0.49], [0.51, 0.57], [0.64, 0.7], [0.805, 0.875], [0.895, 0.965]]) {
      if (r() < 0.45) continue;
      // keep the cockpit area free on top
      if ((u0 < 0.15 || u0 > 0.85) && za < -2.0 && zb > -6.2) continue;
      const x0 = X(za) + 10 + r() * 30, x1 = X(zb) - 10 - r() * 30;
      const y0 = Yu(u0) + 6, y1 = Yu(u1) - 6;
      if (x1 - x0 < 40 || y1 - y0 < 24) continue;
      p.panel(x0, y0, x1 - x0, y1 - y0, r);
    }
  }
  // --- specific named panels and stencils
  const st = (text: string, z: number, u: number, sizeM: number, rotate = false) => {
    const s = sizeM * pxPerM;
    const ay = aroundScale(z) / pxPerM; // vertical squash to keep text proportion
    p.stencil(text, X(z), Yu(u), s, rotate ? Math.PI / 2 : 0, 'rgba(25,27,30,0.78)', 1, ay);
  };
  for (const side of [0.25, 0.75]) {
    const sgn = side < 0.5 ? 1 : -1;
    // intake warning
    st('DANGER', -3.25, side + sgn * 0.035, 0.07);
    st('KEEP CLEAR OF INTAKE', -3.25, side + sgn * 0.055, 0.05);
    // rescue arrow & canopy jettison
    st('RESCUE', -4.6, side - sgn * 0.09, 0.08);
    const rx = X(-4.6), ry = Yu(side - sgn * 0.075);
    c.fillStyle = 'rgba(200,120,40,0.75)';
    c.beginPath();
    c.moveTo(rx - 40, ry);
    c.lineTo(rx + 20, ry - 14);
    c.lineTo(rx + 20, ry + 14);
    c.fill();
    // ejection seat warning triangle
    c.strokeStyle = 'rgba(160,30,25,0.8)';
    c.lineWidth = 3;
    const tx = X(-5.3), ty = Yu(side - sgn * 0.1);
    c.beginPath();
    c.moveTo(tx, ty - 18);
    c.lineTo(tx + 18, ty + 14);
    c.lineTo(tx - 18, ty + 14);
    c.closePath();
    c.stroke();
    st('EJECTION SEAT', -5.3, side - sgn * 0.125, 0.045);
    // ground power / fuel / hydraulic panels on the lower sides
    p.panel(X(-0.2), Yu(side + sgn * 0.12) - 30, 110, 60, r, { label: 'GND PWR', labelSize: 11 });
    p.panel(X(1.4), Yu(side + sgn * 0.1) - 26, 90, 52, r, { label: 'FUEL', labelSize: 11 });
    p.panel(X(3.2), Yu(side + sgn * 0.12) - 26, 90, 52, r, { label: 'HYD', labelSize: 11 });
    st('NO STEP', 2.4, side - sgn * 0.06, 0.06);
    st('JACK POINT', 0.9, side + sgn * 0.2, 0.04);
    // insignia on the aft fuselage sides
    insignia(c, X(4.3), Yu(side - sgn * 0.02), 0.34 * pxPerM, 'rgba(40,44,48,0.55)', 1);
    // unit text + serial
    st(`${scheme.unit}`, 1.0, side - sgn * 0.035, 0.09);
    st(`AF ${scheme.serial}`, 5.6, side + sgn * 0.02, 0.07);
    // gun-port style vent grille (fictional cooling vent)
    for (let k = 0; k < 6; k++) p.line(X(-1.9) + k * 9, Yu(side - sgn * 0.13) - 18, X(-1.9) + k * 9, Yu(side - sgn * 0.13) + 18, 3, 80, 0.3);
  }
  // walkway on top behind the canopy (darker, rougher non-slip)
  c.fillStyle = 'rgba(30,32,35,0.35)';
  c.fillRect(X(-2.7), Yu(0.965), X(-0.6) - X(-2.7), Yu(0.07));
  p.rough.fillStyle = 'rgb(220,220,220)';
  p.rough.fillRect(X(-2.7), Yu(0.965), X(-0.6) - X(-2.7), Yu(0.07));
  c.fillRect(X(-2.7), 0, X(-0.6) - X(-2.7), Yu(0.035));
  p.rough.fillRect(X(-2.7), 0, X(-0.6) - X(-2.7), Yu(0.035));
  // --- sawtooth-edged doors (every opening on a low-observable airframe)
  {
    const teethPx = 0.09 * pxPerM;
    const across = (u0: number, u1: number) => [Yu(u0), Yu(u1) - Yu(u0)] as const;
    // internal weapons-bay doors on the underside, either side of the keel
    for (const [u0, u1] of [[0.445, 0.497], [0.503, 0.555]] as const) {
      const [y0, hh] = across(u0, u1);
      p.sawPanel(X(-3.3), y0, X(0.2) - X(-3.3), hh, 4, teethPx, { tone: -0.03 });
    }
    // flare / chaff dispenser doors aft of the bays
    for (const [u0, u1] of [[0.462, 0.49], [0.51, 0.538]] as const) {
      const [y0, hh] = across(u0, u1);
      p.sawPanel(X(2.55), y0, X(3.05) - X(2.55), hh, 2, teethPx * 0.6, { tone: -0.04 });
    }
    // dorsal air-refuelling receptacle door (spine, wraps the u = 0/1 seam)
    for (const yOff of [0, H]) {
      p.sawPanel(X(0.95), yOff - Yu(0.022), X(1.6) - X(0.95), Yu(0.044), 2, teethPx * 0.7, { tone: -0.05 });
    }
    st('AIR REFUEL', 1.75, 0.03, 0.035);
    st('AIR REFUEL', 1.75, 0.97, 0.035);
  }
  // --- weathering from real scans (grime, water spots, dirt, smudges, wear)
  {
    const full: [number, number, number, number] = [0, 0, W, H];
    const under: [number, number, number, number] = [0, Yu(0.3), W, Yu(0.4)];
    const top1: [number, number, number, number] = [0, 0, W, Yu(0.17)];
    const top2: [number, number, number, number] = [0, Yu(0.83), W, Yu(0.17)];
    const grime = maskStamp('grime', 'mask', [34, 31, 27], { invert: true, lo: 0.25, hi: 0.95, gamma: 1.3 });
    weather(c, grime, full, 1.3 * pxPerM, 0.17, 11);
    weather(c, grime, under, 0.9 * pxPerM, 0.2, 57);
    const water = maskStamp('water-stains', 'mask', [214, 216, 214], { lo: 0.15, gamma: 1.2 });
    weather(c, water, top1, 0.42 * pxPerM, 0.09, 3);
    weather(c, water, top2, 0.42 * pxPerM, 0.09, 29);
    const dirt = maskStamp('dirt-specks', 'mask', [38, 33, 26], { lo: 0.2 });
    weather(c, dirt, under, 0.35 * pxPerM, 0.3, 5);
    weather(c, dirt, [X(-1.4), 0, X(3.4) - X(-1.4), H], 0.35 * pxPerM, 0.12, 17);
    // worn paint where crews climb and kneel: canopy sill, walkway, intake lips
    const chips = maskStamp('edge-wear', 'mask', [150, 154, 156], { lo: 0.35, gamma: 1.4 });
    const scr = maskStamp('scratches', 'mask', [176, 180, 182], { lo: 0.15 });
    for (const side of [0.25, 0.75]) {
      const sg2 = side < 0.5 ? 1 : -1;
      weather(c, chips, [X(-3.25), Yu(side - 0.02), X(-2.85) - X(-3.25), Yu(0.04)], 0.5 * pxPerM, 0.55, side * 100);
      weather(c, scr, [X(-5.7), Yu(side - sg2 * 0.17) - Yu(0.04), X(-2.8) - X(-5.7), Yu(0.08)], 0.5 * pxPerM, 0.5, side * 50);
    }
    weather(c, scr, [X(-2.75), 0, X(-0.55) - X(-2.75), Yu(0.04)], 0.5 * pxPerM, 0.6, 3);
    weather(c, scr, [X(-2.75), Yu(0.96), X(-0.55) - X(-2.75), Yu(0.04)], 0.5 * pxPerM, 0.6, 7);
    weather(c, chips, [0, 0, X(-8.05), H], 0.4 * pxPerM, 0.35, 13);
    // roughness: crew hand smudges and wiped areas, duller dried water spots
    const smudgeR = maskStamp('smudge', 'mask', [235, 235, 235], { lo: 0.45, hi: 1, gamma: 1.5 });
    const smudgeS = maskStamp('smudge', 'mask', [95, 95, 95], { invert: true, lo: 0.5, gamma: 1.5 });
    weather(p.rough, smudgeR, full, 1.1 * pxPerM, 0.45, 21);
    weather(p.rough, smudgeS, full, 1.6 * pxPerM, 0.3, 41);
    const waterR = maskStamp('water-stains', 'mask', [230, 230, 230], { lo: 0.15 });
    weather(p.rough, waterR, top1, 0.42 * pxPerM, 0.3, 3);
    weather(p.rough, waterR, top2, 0.42 * pxPerM, 0.3, 29);
    const scrR = maskStamp('scratches', 'mask', [250, 250, 250], { lo: 0.15 });
    weather(p.rough, scrR, [X(-2.75), 0, X(-0.55) - X(-2.75), Yu(0.04)], 0.5 * pxPerM, 0.7, 3);
    weather(p.rough, scrR, [X(-2.75), Yu(0.96), X(-0.55) - X(-2.75), Yu(0.04)], 0.5 * pxPerM, 0.7, 7);
  }
  // exhaust soot towards the tail
  const sg = c.createLinearGradient(X(5.2), 0, X(7.25), 0);
  sg.addColorStop(0, 'rgba(20,18,16,0)');
  sg.addColorStop(1, 'rgba(20,18,16,0.55)');
  c.fillStyle = sg;
  c.fillRect(X(5.2), 0, X(7.25) - X(5.2), H);
  // grime streaks flowing aft from panel lines and vents
  for (let i = 0; i < 260; i++) {
    const z = -8 + r() * 14;
    const u = r();
    const under = u > 0.3 && u < 0.7;
    p.streak(X(z), Yu(u), 40 + r() * (under ? 420 : 220), 3 + r() * 7, (under ? 0.12 : 0.07) * r());
  }
  // fluid leaks below hydraulics bays
  for (let i = 0; i < 18; i++) p.streak(X(1 + r() * 4), Yu(0.42 + r() * 0.16), 200 + r() * 300, 4 + r() * 5, 0.18, '30,25,15');
  // scuffs near the cockpit access (left side, below the sill)
  for (let i = 0; i < 70; i++) {
    const x = X(-5.2 + r() * 1.6), y = Yu(0.78 + r() * 0.06);
    c.fillStyle = `rgba(200,200,200,${0.05 + r() * 0.1})`;
    c.fillRect(x, y, 2 + r() * 14, 1 + r() * 3);
  }
  p.noiseOverlay(r, 900, 20, 140, 0.06);
  // underside darker grime overall
  const ug = c.createLinearGradient(0, Yu(0.35), 0, Yu(0.65));
  ug.addColorStop(0, 'rgba(0,0,0,0)');
  ug.addColorStop(0.5, 'rgba(0,0,0,0.12)');
  ug.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = ug;
  c.fillRect(0, 0, W, H);
  // baked AO: wing roots, intakes, fin roots
  const ao = p.ao;
  for (const side of [0.25, 0.75]) {
    const gg = ao.createLinearGradient(0, Yu(side - 0.06), 0, Yu(side + 0.06));
    gg.addColorStop(0, 'rgba(0,0,0,0)');
    gg.addColorStop(0.5, 'rgba(0,0,0,0.45)');
    gg.addColorStop(1, 'rgba(0,0,0,0)');
    ao.fillStyle = gg;
    ao.fillRect(X(-1.5), 0, X(4.6) - X(-1.5), H);
    ao.fillStyle = 'rgba(0,0,0,0.35)';
    ao.fillRect(X(-3.1), Yu(side - 0.04), X(-0.3) - X(-3.1), Yu(0.08));
  }
  ao.fillStyle = 'rgba(0,0,0,0.3)';
  ao.fillRect(X(3.5), Yu(0.9), X(6.6) - X(3.5), Yu(0.2));
  // roughness baseline: matte paint, radome smoother
  p.rough.fillStyle = 'rgba(105,105,105,0.6)';
  p.rough.fillRect(0, 0, X(-8.15), H);
  return p.finish(2.2);
}

/** Planform atlas for a panel spec (wing / stab / fin): left half = upper surface, right half = lower. */
export function paintPanelAtlas(scheme: PaintScheme, specs: { spec: PanelSpec; kind: 'wing' | 'stab' | 'fin' }[], W = 2048, H = 2048): MaterialMaps {
  const p = new Painter(W, H);
  const r = rng(4711);
  const c = p.color;
  for (const { spec, kind } of specs) {
    const [u0, v0, u1, v1] = spec.uvRect ?? [0, 0, 1, 1];
    const zMin = Math.min(spec.rootLE[2], spec.tipLE[2]);
    const zMax = Math.max(spec.rootLE[2] + spec.rootChord, spec.tipLE[2] + spec.tipChord);
    const toCanvas = (s: number, cf: number, lower: boolean): [number, number] => {
      const z = spec.rootLE[2] + (spec.tipLE[2] - spec.rootLE[2]) * s + cf * (spec.rootChord + (spec.tipChord - spec.rootChord) * s);
      const zN = (z - zMin) / (zMax - zMin);
      const uu = u0 + (u1 - u0) * (lower ? 0.5 + s * 0.5 : s * 0.5);
      return [uu * W, (v0 + (v1 - v0) * zN) * H];
    };
    for (const lower of [false, true]) {
      // base colour
      const x0 = (u0 + (u1 - u0) * (lower ? 0.5 : 0)) * W, x1 = (u0 + (u1 - u0) * (lower ? 1 : 0.5)) * W;
      c.fillStyle = lower ? scheme.bottom : kind === 'fin' ? scheme.top : scheme.top;
      c.fillRect(x0, v0 * H, x1 - x0, (v1 - v0) * H);
      if (!lower) {
        c.fillStyle = scheme.patch;
        c.globalAlpha = 0.8;
        for (let i = 0; i < 3; i++) {
          const [px, py] = toCanvas(0.15 + r() * 0.7, 0.2 + r() * 0.6, false);
          c.beginPath();
          c.ellipse(px, py, 60 + r() * 120, 40 + r() * 80, r() * 3, 0, Math.PI * 2);
          c.fill();
        }
        c.globalAlpha = 1;
      }
      // spars (constant chord fraction) and ribs (constant span fraction)
      const spars = kind === 'wing' ? [0.13, 0.32, 0.55, 0.8] : kind === 'stab' ? [0.25, 0.6] : [0.2, 0.5, 0.72];
      for (const cf of spars) {
        const [ax, ay] = toCanvas(0, cf, lower), [bx, by] = toCanvas(1, cf, lower);
        p.line(ax, ay, bx, by, 2, 70);
        p.rivetsAlong(ax, ay, bx, by, 9, 7, r);
        p.rivetsAlong(ax, ay, bx, by, 9, -7, r);
      }
      const ribs = kind === 'wing' ? 9 : 5;
      for (let i = 1; i < ribs; i++) {
        const s = i / ribs;
        const [ax, ay] = toCanvas(s, 0.0, lower), [bx, by] = toCanvas(s, 1, lower);
        p.line(ax, ay, bx, by, 1.4, 34, 0.06);
        p.rivetsAlong(ax, ay, bx, by, 10, 6, r);
      }
      // access panels between spars
      for (let i = 0; i < (kind === 'wing' ? 10 : 4); i++) {
        const s = 0.08 + r() * 0.8, cf = 0.16 + r() * 0.55;
        const [px, py] = toCanvas(s, cf, lower);
        p.panel(px - 30, py - 22, 60 + r() * 50, 40 + r() * 40, r);
      }
      if (kind === 'wing') {
        // leading-edge erosion (lighter, rougher) and fuel panel
        for (let i = 0; i < 120; i++) {
          const [px, py] = toCanvas(r(), r() * 0.05, lower);
          c.fillStyle = `rgba(210,210,205,${0.1 + r() * 0.15})`;
          c.fillRect(px, py, 2 + r() * 6, 1 + r() * 3);
        }
        if (!lower) {
          // NO STEP outlines and walkway near the root
          const [nx, ny] = toCanvas(0.6, 0.45, false);
          p.stencil('NO STEP', nx, ny, 26, Math.PI / 2, 'rgba(25,25,25,0.7)');
          const [wx, wy] = toCanvas(0.06, 0.35, false);
          c.fillStyle = 'rgba(25,27,30,0.4)';
          c.fillRect(wx - 30, wy - 140, 70, 280);
          p.rough.fillStyle = 'rgb(225,225,225)';
          p.rough.fillRect(wx - 30, wy - 140, 70, 280);
          c.strokeStyle = 'rgba(25,25,25,0.6)';
          c.lineWidth = 3;
          c.strokeRect(wx - 30, wy - 140, 70, 280);
          const [ix, iy] = toCanvas(0.68, 0.32, false);
          insignia(c, ix, iy, 70, 'rgba(40,44,48,0.5)');
          p.stencil('FUEL', ...toCanvas(0.35, 0.25, false), 18, 0, 'rgba(25,25,25,0.75)');
        } else {
          const [ix, iy] = toCanvas(0.68, 0.32, true);
          insignia(c, ix, iy, 70, 'rgba(50,54,58,0.45)');
          p.stencil('FUEL DRAIN', ...toCanvas(0.4, 0.6, true), 14, 0, 'rgba(25,25,25,0.7)');
        }
      }
      if (kind === 'fin' && !lower) {
        // tail code + serial + unit emblem on the outboard side
        const [tx, ty] = toCanvas(0.45, 0.42, false);
        p.stencil(scheme.code, tx, ty, 120, Math.PI / 2, 'rgba(35,38,42,0.7)');
        const [sx, sy] = toCanvas(0.18, 0.5, false);
        p.stencil(scheme.serial, sx, sy, 34, Math.PI / 2, 'rgba(35,38,42,0.75)');
        // stylised raven emblem
        const [ex, ey] = toCanvas(0.75, 0.42, false);
        c.save();
        c.translate(ex, ey);
        c.fillStyle = 'rgba(35,38,42,0.6)';
        c.beginPath();
        c.moveTo(-40, 20);
        c.quadraticCurveTo(-10, -50, 40, -30);
        c.lineTo(10, -15);
        c.lineTo(45, -10);
        c.quadraticCurveTo(0, 20, -40, 20);
        c.fill();
        c.restore();
      }
      // grime + speckle
      for (let i = 0; i < 80; i++) {
        const [px, py] = toCanvas(r(), r(), lower);
        p.streak(px, py, 30 + r() * 140, 3 + r() * 5, 0.05 * r(), '0,0,0', true);
      }
      // real scanned weathering at physical scale
      {
        const spanLen = Math.hypot(spec.tipLE[0] - spec.rootLE[0], spec.tipLE[1] - spec.rootLE[1]);
        const pxm = ((W * (u1 - u0)) / 2 / spanLen + (H * (v1 - v0)) / (zMax - zMin)) / 2;
        const rect: [number, number, number, number] = [x0, v0 * H, x1 - x0, (v1 - v0) * H];
        const seed = (kind === 'wing' ? 1 : kind === 'stab' ? 2 : 3) * 31 + (lower ? 7 : 0);
        weather(c, maskStamp('grime', 'mask', [34, 31, 27], { invert: true, lo: 0.25, hi: 0.95, gamma: 1.3 }), rect, 1.2 * pxm, lower ? 0.2 : 0.13, seed);
        if (!lower) weather(c, maskStamp('water-stains', 'mask', [214, 216, 214], { lo: 0.15, gamma: 1.2 }), rect, 0.42 * pxm, 0.08, seed);
        weather(p.rough, maskStamp('smudge', 'mask', [235, 235, 235], { lo: 0.45, gamma: 1.5 }), rect, 1.1 * pxm, 0.4, seed);
        // leading-edge erosion: chipped, rougher band along the first ~6 % of chord
        const chips = maskStamp('edge-wear', 'mask', [150, 154, 156], { lo: 0.3, gamma: 1.2 });
        if (chips) {
          const steps = 24;
          for (let k = 0; k < steps; k++) {
            const sA = k / steps, sB = (k + 1) / steps;
            const [ax, ay] = toCanvas(sA, 0, lower), [bx] = toCanvas(sB, 0, lower), [, cy] = toCanvas(sA, 0.06, lower);
            weather(c, chips, [Math.min(ax, bx), ay - 2, Math.abs(bx - ax) + 1, cy - ay + 2], 0.45 * pxm, 0.4, seed + k * 3);
            weather(p.rough, maskStamp('edge-wear', 'mask', [70, 70, 70], { lo: 0.3 }), [Math.min(ax, bx), ay - 2, Math.abs(bx - ax) + 1, cy - ay + 2], 0.45 * pxm, 0.6, seed + k * 3);
          }
        }
      }
    }
  }
  p.noiseOverlay(r, 500, 15, 90, 0.04);
  return p.finish(1.6);
}

/** Nozzle petals: heat-aged steel (scanned) with a procedural heat tint along the petal. */
export function paintNozzle(W = 512, H = 256): MaterialMaps {
  const p = new Painter(W, H);
  const c = p.color;
  const steel = texImage('nozzle-steel', 'albedo');
  if (steel) {
    tileImage(c, steel, 0, 0, W, H, H);
    // straw -> bronze -> blue -> dark heat discoloration towards the exit
    const g = c.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, 'rgba(178,168,150,0.55)');
    g.addColorStop(0.3, 'rgba(176,138,92,0.5)');
    g.addColorStop(0.55, 'rgba(108,104,150,0.5)');
    g.addColorStop(0.8, 'rgba(84,84,96,0.45)');
    g.addColorStop(1, 'rgba(48,46,50,0.55)');
    c.fillStyle = g;
    c.globalCompositeOperation = 'overlay';
    c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'source-over';
    // lift the dark scan towards a heat-treated steel albedo
    c.fillStyle = 'rgba(150,145,138,0.35)';
    c.fillRect(0, 0, W, H);
  } else {
    const g = c.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, '#9a948b');
    g.addColorStop(0.3, '#a08a70');
    g.addColorStop(0.55, '#7d7a98');
    g.addColorStop(0.8, '#6a6874');
    g.addColorStop(1, '#55545a');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
  }
  const r = rng(9);
  for (let i = 0; i < 400; i++) {
    c.fillStyle = `rgba(${r() < 0.5 ? '255,220,180' : '20,15,10'},${r() * 0.08})`;
    c.fillRect(r() * W, r() * H, 2 + r() * 30, 1 + r() * 3);
  }
  for (let y = 0; y < H; y += 32) p.line(0, y, W, y, 2, 50, 0.2);
  p.rough.fillStyle = 'rgb(125,125,125)';
  p.rough.fillRect(0, 0, W, H);
  const sr = texImage('nozzle-steel', 'roughness');
  if (sr) tileImage(p.rough, sr, 0, 0, W, H, H, { alpha: 0.75 });
  return p.finish(1.5, 0.8);
}
