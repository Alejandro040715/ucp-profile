// Procedural "texture painting" for the airframe: canvas-drawn albedo, height
// (-> normal map) and ORM maps with panel lines, rivets, fasteners, access
// panels, two-tone camouflage, fictional insignia and stencils, walkways,
// exhaust soot, grime streaks, scuffs and baked ambient occlusion.

import { CanvasTexture, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace, LinearSRGBColorSpace, type Texture } from 'three';
import { rng } from '../../core/math.ts';
import { COCKPIT, Z_NOSE, Z_TAIL, type PanelSpec } from './FighterGeometry.ts';

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
      const v = raised ? 128 + 26 : 128 - 30;
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
  streak(x: number, y: number, len: number, wid: number, alpha: number, color = '0,0,0'): void {
    const c = this.color;
    const g = c.createLinearGradient(x, y, x + len, y);
    g.addColorStop(0, `rgba(${color},${alpha})`);
    g.addColorStop(1, `rgba(${color},0)`);
    c.fillStyle = g;
    c.beginPath();
    c.ellipse(x + len / 2, y, len / 2, wid / 2, 0, 0, Math.PI * 2);
    c.fill();
    this.rough.fillStyle = `rgba(200,200,200,${alpha * 0.6})`;
    this.rough.beginPath();
    this.rough.ellipse(x + len / 2, y, len / 2, wid / 2, 0, 0, Math.PI * 2);
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
  // antenna & light footprints (formation light strips: lighter rectangles)
  for (const side of [0.24, 0.76]) {
    c.fillStyle = 'rgba(190,210,170,0.5)';
    c.fillRect(X(-6.4), Yu(side) - 4, 0.6 * pxPerM, 8);
    c.fillRect(X(5.0), Yu(side) - 4, 0.6 * pxPerM, 8);
  }
  // --- weathering
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
        p.line(ax, ay, bx, by, 1.6, 50, 0.1);
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
        p.streak(px, py, 30 + r() * 140, 3 + r() * 5, 0.06 * r());
      }
    }
  }
  p.noiseOverlay(r, 500, 15, 90, 0.05);
  return p.finish(2.0);
}

/** Nozzle petals: heat-tinted titanium. */
export function paintNozzle(W = 512, H = 256): MaterialMaps {
  const p = new Painter(W, H);
  const c = p.color;
  const g = c.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, '#5b5650');
  g.addColorStop(0.35, '#6d5a49');
  g.addColorStop(0.6, '#4d4a6a');
  g.addColorStop(0.85, '#3b3a46');
  g.addColorStop(1, '#2a2a2e');
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  const r = rng(9);
  for (let i = 0; i < 400; i++) {
    c.fillStyle = `rgba(${r() < 0.5 ? '255,220,180' : '20,15,10'},${r() * 0.08})`;
    c.fillRect(r() * W, r() * H, 2 + r() * 30, 1 + r() * 3);
  }
  for (let y = 0; y < H; y += 32) p.line(0, y, W, y, 2, 50, 0.2);
  p.rough.fillStyle = 'rgb(110,110,110)';
  p.rough.fillRect(0, 0, W, H);
  return p.finish(1.5, 0.85);
}
