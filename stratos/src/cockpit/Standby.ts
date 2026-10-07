// Standby instrument cluster (attitude ball, airspeed, altimeter, engine RPM,
// EGT, fuel) and the caution/warning annunciator panel. Both are canvas
// textures on emissive faces behind small cover glasses.

import { CanvasTexture, SRGBColorSpace, LinearFilter } from 'three';
import type { AircraftPhysics } from '../aircraft/AircraftPhysics.ts';
import { clamp, RAD } from '../core/math.ts';

export class StandbyCluster {
  readonly canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  readonly texture: CanvasTexture;
  private timer = 0;

  constructor() {
    this.canvas.width = 512;
    this.canvas.height = 384;
    this.g = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearFilter;
  }

  private dial(cx: number, cy: number, r: number, label: string, frac: number, ticks: number, numbers: string[], sub?: string): void {
    const g = this.g;
    const grd = g.createRadialGradient(cx, cy - r * 0.3, r * 0.1, cx, cy, r);
    grd.addColorStop(0, '#1c1d1f');
    grd.addColorStop(1, '#0a0a0b');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#555';
    g.lineWidth = 4;
    g.stroke();
    g.strokeStyle = '#ddd';
    g.fillStyle = '#ddd';
    g.lineWidth = 2;
    for (let i = 0; i < ticks; i++) {
      const a = -Math.PI / 2 + (i / ticks) * Math.PI * 2;
      const l = i % 5 === 0 ? 12 : 6;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * (r - 4), cy + Math.sin(a) * (r - 4));
      g.lineTo(cx + Math.cos(a) * (r - 4 - l), cy + Math.sin(a) * (r - 4 - l));
      g.stroke();
    }
    g.font = '600 15px "Arial Narrow", Arial';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    numbers.forEach((n, i) => {
      const a = -Math.PI / 2 + (i / numbers.length) * Math.PI * 2;
      g.fillText(n, cx + Math.cos(a) * (r - 28), cy + Math.sin(a) * (r - 28));
    });
    g.font = '600 12px "Arial Narrow", Arial';
    g.fillStyle = '#9a9';
    g.fillText(label, cx, cy + r * 0.38);
    if (sub) {
      g.fillStyle = '#ddd';
      g.font = '600 14px "JetBrains Mono", monospace';
      g.fillText(sub, cx, cy - r * 0.32);
    }
    const a = -Math.PI / 2 + frac * Math.PI * 2;
    g.strokeStyle = '#f2f2f2';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(cx - Math.cos(a) * 10, cy - Math.sin(a) * 10);
    g.lineTo(cx + Math.cos(a) * (r - 12), cy + Math.sin(a) * (r - 12));
    g.stroke();
    g.fillStyle = '#333';
    g.beginPath();
    g.arc(cx, cy, 6, 0, Math.PI * 2);
    g.fill();
  }

  update(dt: number, ac: AircraftPhysics, powered: boolean): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 1 / 15;
    const g = this.g;
    const t = ac.t;
    g.fillStyle = '#121314';
    g.fillRect(0, 0, 512, 384);
    // attitude ball (centre)
    const cx = 256, cy = 120, r = 100;
    g.save();
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.clip();
    g.translate(cx, cy);
    g.rotate(-t.bank);
    const pp = clamp(t.pitch * RAD, -60, 60) * 2.6;
    g.fillStyle = '#d8d8d8';
    g.fillRect(-200, -400 + pp, 400, 400);
    g.fillStyle = '#1b1b1b';
    g.fillRect(-200, pp, 400, 400);
    g.strokeStyle = '#000';
    g.lineWidth = 2;
    for (let p = -30; p <= 30; p += 10) {
      if (!p) continue;
      g.strokeStyle = p > 0 ? '#111' : '#ddd';
      g.beginPath();
      g.moveTo(-25, pp - p * 2.6);
      g.lineTo(25, pp - p * 2.6);
      g.stroke();
    }
    g.restore();
    g.strokeStyle = '#ffb000';
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(cx - 55, cy);
    g.lineTo(cx - 18, cy);
    g.moveTo(cx + 18, cy);
    g.lineTo(cx + 55, cy);
    g.stroke();
    g.fillStyle = '#ffb000';
    g.beginPath();
    g.arc(cx, cy, 5, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#444';
    g.lineWidth = 6;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.stroke();
    // ASI (left) and altimeter (right)
    const kt = t.ias / 0.5144;
    this.dial(80, 120, 72, 'KNOTS', clamp(kt / 800, 0, 1), 40, ['0', '100', '200', '300', '400', '500', '600', '700'], kt.toFixed(0));
    const ft = t.altitude / 0.3048;
    this.dial(432, 120, 72, 'ALT FT', ((ft % 1000) + 1000) % 1000 / 1000, 50, ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'], ft.toFixed(0));
    // bottom row: RPM, EGT, FUEL
    const e = ac.engine;
    this.dial(90, 300, 62, 'RPM %', clamp(e.rpmPercent / 110, 0, 1) * 0.83, 22, ['0', '20', '40', '60', '80', '100'], e.rpmPercent.toFixed(0));
    this.dial(256, 300, 62, 'EGT °C', clamp(e.egt / 1000, 0, 1) * 0.83, 20, ['0', '200', '400', '600', '800', '1000'], e.egt.toFixed(0));
    this.dial(422, 300, 62, 'FUEL KG', clamp(ac.fuel.total / 5000, 0, 1) * 0.83, 25, ['0', '1', '2', '3', '4', '5'], ac.fuel.total.toFixed(0));
    if (!powered) {
      g.fillStyle = 'rgba(0,0,0,0.0)';
    }
    this.texture.needsUpdate = true;
  }
}

export const ANNUNCIATORS = ['ENG FIRE', 'OVERHEAT', 'HYD', 'GEN', 'OIL', 'FUEL LOW', 'CANOPY', 'GEAR', 'STALL', 'OVER G', 'FCS', 'BATT'] as const;
export type Annunciator = (typeof ANNUNCIATORS)[number];
const RED_SET = new Set<Annunciator>(['ENG FIRE', 'STALL', 'OVER G', 'GEAR']);

export class AnnunciatorPanel {
  readonly canvas = document.createElement('canvas');
  readonly emissiveCanvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private e: CanvasRenderingContext2D;
  readonly texture: CanvasTexture;
  readonly emissiveTexture: CanvasTexture;
  private lastKey = '';
  test = false;

  constructor() {
    for (const c of [this.canvas, this.emissiveCanvas]) {
      c.width = 512;
      c.height = 128;
    }
    this.g = this.canvas.getContext('2d')!;
    this.e = this.emissiveCanvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.emissiveTexture = new CanvasTexture(this.emissiveCanvas);
    this.emissiveTexture.colorSpace = SRGBColorSpace;
  }

  update(active: Set<Annunciator>, flash: boolean): void {
    const key = [...active].sort().join('|') + (flash ? '1' : '0') + (this.test ? 'T' : '');
    if (key === this.lastKey) return;
    this.lastKey = key;
    const g = this.g, e = this.e;
    g.fillStyle = '#0c0c0d';
    g.fillRect(0, 0, 512, 128);
    e.fillStyle = '#000';
    e.fillRect(0, 0, 512, 128);
    ANNUNCIATORS.forEach((a, i) => {
      const x = (i % 6) * 85 + 4, y = Math.floor(i / 6) * 64 + 4;
      const on = this.test || (active.has(a) && (!RED_SET.has(a) || flash || a === 'GEAR'));
      const red = RED_SET.has(a);
      g.fillStyle = '#18191a';
      g.fillRect(x, y, 80, 56);
      g.fillStyle = on ? (red ? '#ff3b2b' : '#ffb21e') : '#3a3530';
      g.font = '700 15px "Arial Narrow", Arial';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(a, x + 40, y + 28);
      if (on) {
        e.fillStyle = red ? '#ff2a1a' : '#ffa010';
        e.fillRect(x + 4, y + 4, 72, 48);
        e.fillStyle = '#fff';
        e.font = '700 15px "Arial Narrow", Arial';
        e.textAlign = 'center';
        e.textBaseline = 'middle';
        e.fillText(a, x + 40, y + 28);
      }
    });
    this.texture.needsUpdate = true;
    this.emissiveTexture.needsUpdate = true;
  }
}
