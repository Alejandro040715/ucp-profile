// Canvas painter for cockpit panels: worn dark-grey paint, engraved borders,
// Dzus fasteners, white engraved legends (with a matching emissive map for
// night backlighting), position marks for switches and knobs.

import { CanvasTexture, SRGBColorSpace, LinearMipmapLinearFilter } from 'three';
import { rng } from '../core/math.ts';

export interface PanelLabel {
  text: string;
  x: number; // metres, panel-local (origin centre, +x right)
  y: number; // metres (+y up)
  size?: number; // text height (m)
  rot?: number;
  color?: string;
  backlit?: boolean;
}

export interface PanelArt {
  map: CanvasTexture;
  emissiveMap: CanvasTexture;
}

export const PX_PER_M = 1400;

export type PanelExtra = (ctx: CanvasRenderingContext2D, emissive: CanvasRenderingContext2D, X: (x: number) => number, Y: (y: number) => number, px: number) => void;

export function paintPanel(w: number, h: number, labels: PanelLabel[], opts: { seed?: number; borders?: [number, number, number, number][]; base?: string; dark?: boolean; extra?: PanelExtra } = {}): PanelArt {
  const W = Math.max(32, Math.round(w * PX_PER_M));
  const H = Math.max(32, Math.round(h * PX_PER_M));
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    return c;
  };
  const cc = mk(), ce = mk();
  const g = cc.getContext('2d')!;
  const e = ce.getContext('2d')!;
  const r = rng(opts.seed ?? Math.round(w * 1000 + h * 7777));
  const X = (x: number) => (x / w + 0.5) * W;
  const Y = (y: number) => (0.5 - y / h) * H;
  const px = PX_PER_M;
  // base paint with subtle mottling and wear
  g.fillStyle = opts.base ?? '#2b2e31';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < (W * H) / 900; i++) {
    const a = r() * 0.06;
    g.fillStyle = r() < 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    const s = 2 + r() * 18;
    g.fillRect(r() * W, r() * H, s, s * (0.3 + r()));
  }
  // edge wear (lighter scuffs near edges)
  for (let i = 0; i < 120; i++) {
    const edge = Math.floor(r() * 4);
    const x = edge < 2 ? r() * W : edge === 2 ? r() * 10 : W - r() * 10;
    const y = edge >= 2 ? r() * H : edge === 0 ? r() * 10 : H - r() * 10;
    g.fillStyle = `rgba(160,160,155,${0.08 + r() * 0.15})`;
    g.fillRect(x, y, 2 + r() * 8, 1 + r() * 3);
  }
  e.fillStyle = '#000';
  e.fillRect(0, 0, W, H);
  // panel border bevel
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, W - 3, H - 3);
  g.strokeStyle = 'rgba(255,255,255,0.08)';
  g.lineWidth = 1;
  g.strokeRect(4, 4, W - 8, H - 8);
  // sub-panel borders (x0,y0,x1,y1 in metres) with Dzus fasteners
  const borders = opts.borders ?? [[-w / 2, -h / 2, w / 2, h / 2]];
  for (const [x0, y0, x1, y1] of borders) {
    const bx = X(x0), by = Y(y1), bw = X(x1) - X(x0), bh = Y(y0) - Y(y1);
    g.strokeStyle = 'rgba(0,0,0,0.75)';
    g.lineWidth = 2.5;
    g.strokeRect(bx + 2, by + 2, bw - 4, bh - 4);
    const dz = (cx: number, cy: number) => {
      const rr = 0.0042 * px;
      const grd = g.createRadialGradient(cx - rr * 0.3, cy - rr * 0.3, 1, cx, cy, rr);
      grd.addColorStop(0, '#77797b');
      grd.addColorStop(1, '#2a2b2c');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(cx, cy, rr, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#111';
      g.lineWidth = 1.6;
      const a = r() * Math.PI;
      g.beginPath();
      g.moveTo(cx - Math.cos(a) * rr * 0.75, cy - Math.sin(a) * rr * 0.75);
      g.lineTo(cx + Math.cos(a) * rr * 0.75, cy + Math.sin(a) * rr * 0.75);
      g.stroke();
    };
    const inset = 0.008 * px;
    dz(bx + inset, by + inset);
    dz(bx + bw - inset, by + inset);
    dz(bx + inset, by + bh - inset);
    dz(bx + bw - inset, by + bh - inset);
    if (bw > 0.2 * px) {
      dz(bx + bw / 2, by + inset);
      dz(bx + bw / 2, by + bh - inset);
    }
  }
  // labels
  for (const l of labels) {
    const size = (l.size ?? 0.0065) * px;
    const draw = (ctx: CanvasRenderingContext2D, color: string) => {
      ctx.save();
      ctx.translate(X(l.x), Y(l.y));
      if (l.rot) ctx.rotate(l.rot);
      ctx.fillStyle = color;
      ctx.font = `700 ${size}px "Arial Narrow", "Roboto Condensed", Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lines = l.text.split('\n');
      lines.forEach((t, i) => ctx.fillText(t, 0, (i - (lines.length - 1) / 2) * size * 1.1));
      ctx.restore();
    };
    draw(g, l.color ?? '#e9e9e2');
    if (l.backlit !== false) draw(e, '#ffffff');
  }
  opts.extra?.(g, e, X, Y, px);
  const map = new CanvasTexture(cc);
  map.colorSpace = SRGBColorSpace;
  map.anisotropy = 8;
  map.minFilter = LinearMipmapLinearFilter;
  const emissiveMap = new CanvasTexture(ce);
  emissiveMap.colorSpace = SRGBColorSpace;
  emissiveMap.minFilter = LinearMipmapLinearFilter;
  return { map, emissiveMap };
}

/** tick marks around a knob / switch position labels helper */
export function knobScale(g: CanvasRenderingContext2D, e: CanvasRenderingContext2D, cx: number, cy: number, r: number, n: number, sweep = 4.2): void {
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    const a = -Math.PI / 2 - sweep / 2 + t * sweep;
    for (const ctx of [g, e]) {
      ctx.strokeStyle = ctx === g ? '#e9e9e2' : '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.lineTo(cx + Math.cos(a) * r * 1.25, cy + Math.sin(a) * r * 1.25);
      ctx.stroke();
    }
  }
}
