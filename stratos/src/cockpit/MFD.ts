// Multi-function display: 5x5" colour screen rendered to a canvas texture with
// pages ENGINE, FLIGHT, MAP, SYSTEMS, DAMAGE, FUEL. Screen material simulates
// an LCD under glass (pixel grid, backlight bleed, glass reflection, dim/off
// states driven by the electrical bus and the brightness knob).

import { CanvasTexture, Color, Mesh, PlaneGeometry, ShaderMaterial, SRGBColorSpace, Texture, LinearFilter } from 'three';
import type { AircraftPhysics } from '../aircraft/AircraftPhysics.ts';
import { DAMAGE_LABELS, type DamageComponent } from '../aircraft/DamageSystem.ts';
import { clamp, RAD, wrap360, formatTime } from '../core/math.ts';
import { SKY_LUT_GLSL } from '../atmosphere/Sky.ts';
import { globals } from '../render/Globals.ts';

export type MfdPage = 'ENGINE' | 'FLIGHT' | 'MAP' | 'SYSTEMS' | 'DAMAGE' | 'FUEL';
export const MFD_PAGES: MfdPage[] = ['ENGINE', 'FLIGHT', 'MAP', 'SYSTEMS', 'DAMAGE', 'FUEL'];

export interface MfdContext {
  ac: AircraftPhysics;
  lights: { nav: boolean; strobe: boolean; landing: number; formation: number };
  canopy: number;
  hudMode: number;
  mapImage: HTMLCanvasElement | ImageBitmap | null;
  mapRect: [number, number, number]; // cx, cz, span of the map image
  waypoint: { x: number; z: number; name: string } | null;
  missionTime: number;
  units: 'imperial' | 'metric';
  caution: string[];
}

const GREEN = '#5bff8a';
const CYAN = '#5fe3ff';
const AMBER = '#ffb52e';
const RED = '#ff4135';
const WHITE = '#e8f1ea';

export class MFD {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  readonly texture: CanvasTexture;
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  page: MfdPage;
  private timer = 0;
  rate = 1 / 20;
  brightness = 1;
  power = true;
  private bootTimer = 0;
  private prevPower = false;
  readonly size: number;

  constructor(page: MfdPage, sizeM = 0.165, skyLut: Texture | null = null) {
    this.page = page;
    this.size = sizeM;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 512;
    this.canvas.height = 512;
    this.g = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.material = new ShaderMaterial({
      uniforms: {
        uScreen: { value: this.texture },
        uBright: { value: 1 },
        uPower: { value: 1 },
        uSkyLut: { value: skyLut },
        uSunDir: globals.uSunDir,
        uSunColor: globals.uSunColor,
        uTint: { value: new Color(1, 1, 1) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vWorldPos; varying vec3 vN;
        void main() { vUv = uv; vec4 wp = modelMatrix * vec4(position, 1.0); vWorldPos = wp.xyz; vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: /* glsl */ `
        #define PI 3.141592653589793
        uniform sampler2D uScreen; uniform sampler2D uSkyLut; uniform float uBright; uniform float uPower; uniform vec3 uSunDir; uniform vec3 uSunColor;
        varying vec2 vUv; varying vec3 vWorldPos; varying vec3 vN;
        ${SKY_LUT_GLSL}
        void main() {
          vec3 img = texture2D(uScreen, vUv).rgb;
          img = pow(img, vec3(2.2));
          // LCD sub-pixel grid
          vec2 pg = fract(vUv * 512.0);
          float grid = 0.82 + 0.18 * smoothstep(0.0, 0.18, pg.x) * smoothstep(0.0, 0.18, pg.y);
          vec3 lit = img * grid * uBright * 2.4 * uPower;
          // backlight bleed (black level) when powered
          lit += vec3(0.004, 0.006, 0.006) * uPower * uBright;
          // cover glass reflection (anti-reflective coated, still visible at grazing angles)
          vec3 V = normalize(cameraPosition - vWorldPos);
          vec3 N = normalize(vN);
          float F = 0.02 + 0.5 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
          vec3 R = reflect(-V, N);
          vec3 refl = texture2D(uSkyLut, skyLutUV(vec3(R.x, max(R.y, 0.0), R.z))).rgb * 0.35;
          float sunGlare = pow(max(dot(R, uSunDir), 0.0), 120.0) * 0.6;
          vec3 col = lit + (refl + uSunColor * sunGlare) * F;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.mesh = new Mesh(new PlaneGeometry(sizeM, sizeM), this.material);
  }

  setPage(p: MfdPage): void {
    this.page = p;
    this.timer = 0;
  }

  nextPage(): void {
    this.setPage(MFD_PAGES[(MFD_PAGES.indexOf(this.page) + 1) % MFD_PAGES.length]);
  }

  update(dt: number, ctx: MfdContext, powered: boolean): void {
    this.material.uniforms.uBright.value = this.brightness;
    if (powered && !this.prevPower) this.bootTimer = 2.2;
    this.prevPower = powered;
    this.material.uniforms.uPower.value = powered ? 1 : 0;
    if (!powered) return;
    if (this.bootTimer > 0) this.bootTimer -= dt;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = this.rate;
    const g = this.g;
    g.fillStyle = '#000';
    g.fillRect(0, 0, 512, 512);
    if (this.bootTimer > 0) {
      this.drawBoot(g, 1 - this.bootTimer / 2.2);
    } else {
      switch (this.page) {
        case 'ENGINE': this.drawEngine(g, ctx); break;
        case 'FLIGHT': this.drawFlight(g, ctx); break;
        case 'MAP': this.drawMap(g, ctx); break;
        case 'SYSTEMS': this.drawSystems(g, ctx); break;
        case 'DAMAGE': this.drawDamage(g, ctx); break;
        case 'FUEL': this.drawFuel(g, ctx); break;
      }
      this.drawFrame(g, ctx);
    }
    this.texture.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  private text(g: CanvasRenderingContext2D, t: string, x: number, y: number, size = 22, color = GREEN, align: CanvasTextAlign = 'left'): void {
    g.font = `600 ${size}px "JetBrains Mono", "Consolas", monospace`;
    g.fillStyle = color;
    g.textAlign = align;
    g.textBaseline = 'middle';
    g.fillText(t, x, y);
  }

  private drawBoot(g: CanvasRenderingContext2D, t: number): void {
    this.text(g, 'XF-41 AVIONICS', 256, 200, 26, GREEN, 'center');
    this.text(g, 'BIT IN PROGRESS', 256, 240, 18, GREEN, 'center');
    g.strokeStyle = GREEN;
    g.strokeRect(126, 280, 260, 18);
    g.fillStyle = GREEN;
    g.fillRect(128, 282, 256 * t, 14);
  }

  private drawFrame(g: CanvasRenderingContext2D, ctx: MfdContext): void {
    // bezel button labels (top row = pages)
    const labels = MFD_PAGES.slice(0, 5);
    labels.forEach((l, i) => {
      const x = 52 + i * 102;
      const active = l === this.page;
      if (active) {
        g.strokeStyle = WHITE;
        g.lineWidth = 2;
        g.strokeRect(x - 44, 6, 88, 28);
      }
      this.text(g, l, x, 21, 16, active ? WHITE : CYAN, 'center');
    });
    this.text(g, 'FUEL', 460, 492, 16, this.page === 'FUEL' ? WHITE : CYAN, 'center');
    this.text(g, formatTime(ctx.missionTime).slice(0, -3), 52, 492, 16, CYAN, 'center');
    if (ctx.caution.length) this.text(g, ctx.caution[0], 256, 492, 16, AMBER, 'center');
  }

  private gauge(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, v: number, max: number, label: string, valueText: string, redFrom: number, color = GREEN): void {
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    g.lineWidth = 3;
    g.strokeStyle = '#3a4a40';
    g.beginPath();
    g.arc(cx, cy, r, a0, a1);
    g.stroke();
    // red zone
    g.strokeStyle = RED;
    g.beginPath();
    g.arc(cx, cy, r, a0 + (a1 - a0) * (redFrom / max), a1);
    g.stroke();
    const t = clamp(v / max, 0, 1);
    g.strokeStyle = v >= redFrom ? RED : color;
    g.lineWidth = 6;
    g.beginPath();
    g.arc(cx, cy, r - 6, a0, a0 + (a1 - a0) * t);
    g.stroke();
    // needle
    const a = a0 + (a1 - a0) * t;
    g.strokeStyle = WHITE;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(a) * (r - 4), cy + Math.sin(a) * (r - 4));
    g.stroke();
    this.text(g, label, cx, cy + r * 0.55, 15, CYAN, 'center');
    g.strokeStyle = WHITE;
    g.lineWidth = 1.5;
    g.strokeRect(cx - 42, cy + r * 0.82 - 13, 84, 26);
    this.text(g, valueText, cx, cy + r * 0.82, 20, v >= redFrom ? RED : WHITE, 'center');
  }

  private drawEngine(g: CanvasRenderingContext2D, ctx: MfdContext): void {
    const e = ctx.ac.engine;
    this.gauge(g, 140, 150, 82, e.rpmPercent, 110, 'RPM %', e.rpmPercent.toFixed(1), 103);
    this.gauge(g, 372, 150, 82, e.egt, 1000, 'EGT °C', e.egt.toFixed(0), 900, AMBER);
    // thrust / throttle / nozzle bars
    const bar = (x: number, label: string, v: number, txt: string, color = GREEN) => {
      g.strokeStyle = '#3a4a40';
      g.lineWidth = 2;
      g.strokeRect(x - 18, 300, 36, 130);
      g.fillStyle = color;
      const h = clamp(v, 0, 1) * 126;
      g.fillRect(x - 16, 428 - h, 32, h);
      this.text(g, label, x, 290, 14, CYAN, 'center');
      this.text(g, txt, x, 448, 16, WHITE, 'center');
    };
    bar(80, 'THR', ctx.ac.controls.throttle, `${(ctx.ac.controls.throttle * 100).toFixed(0)}`);
    bar(160, 'NOZ', e.nozzle, `${(e.nozzle * 100).toFixed(0)}`);
    bar(240, 'A/B', e.abFraction, e.abLit ? 'ON' : 'OFF', AMBER);
    bar(320, 'OIL', e.oilPressure, `${(e.oilPressure * 60).toFixed(0)}`);
    const ff = e.fuelFlow * 3600;
    this.text(g, 'FF', 400, 320, 16, CYAN);
    this.text(g, `${ff.toFixed(0)}`, 440, 345, 22, WHITE, 'center');
    this.text(g, 'KG/H', 440, 368, 13, CYAN, 'center');
    this.text(g, 'THRUST', 440, 400, 14, CYAN, 'center');
    this.text(g, `${(e.thrust / 1000).toFixed(1)} kN`, 440, 424, 20, WHITE, 'center');
    const stColor = e.state === 'RUN' ? GREEN : e.state === 'FAILED' || e.state === 'FLAMEOUT' ? RED : AMBER;
    this.text(g, `ENG ${e.state}`, 256, 470, 18, stColor, 'center');
    if (e.onFire) this.text(g, 'ENGINE FIRE', 256, 260, 28, RED, 'center');
  }

  private drawFlight(g: CanvasRenderingContext2D, ctx: MfdContext): void {
    const t = ctx.ac.t;
    const imp = ctx.units === 'imperial';
    // mini attitude indicator
    const cx = 256, cy = 190, r = 120;
    g.save();
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.clip();
    g.translate(cx, cy);
    g.rotate(-t.bank);
    const pp = t.pitch * RAD * 4;
    g.fillStyle = '#0d3f73';
    g.fillRect(-300, -600 + pp, 600, 600);
    g.fillStyle = '#5a3b1c';
    g.fillRect(-300, pp, 600, 600);
    g.strokeStyle = WHITE;
    g.lineWidth = 2;
    for (let p = -60; p <= 60; p += 10) {
      if (p === 0) continue;
      const y = pp - p * 4;
      g.beginPath();
      g.moveTo(-36, y);
      g.lineTo(36, y);
      g.stroke();
      this.text(g, `${Math.abs(p)}`, 46, y, 13, WHITE);
    }
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(-300, pp);
    g.lineTo(300, pp);
    g.stroke();
    g.restore();
    // aircraft symbol
    g.strokeStyle = AMBER;
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(cx - 70, cy);
    g.lineTo(cx - 25, cy);
    g.lineTo(cx - 12, cy + 12);
    g.moveTo(cx + 70, cy);
    g.lineTo(cx + 25, cy);
    g.lineTo(cx + 12, cy + 12);
    g.stroke();
    g.strokeStyle = WHITE;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.stroke();
    // data blocks
    const row = (y: number, l: string, v: string, c = WHITE) => {
      this.text(g, l, 30, y, 16, CYAN);
      this.text(g, v, 236, y, 20, c, 'right');
    };
    const spd = imp ? `${(t.ias / 0.5144).toFixed(0)} KT` : `${(t.ias * 3.6).toFixed(0)} KM/H`;
    row(340, 'IAS', spd);
    row(368, 'MACH', t.mach.toFixed(2));
    row(396, 'AOA', `${(t.alpha * RAD).toFixed(1)}°`, t.alpha * RAD > 20 ? AMBER : WHITE);
    row(424, 'G', t.nz.toFixed(1), t.nz > 8 ? AMBER : WHITE);
    row(452, 'G MAX', t.maxG.toFixed(1));
    const alt = imp ? `${(t.altitude / 0.3048).toFixed(0)} FT` : `${t.altitude.toFixed(0)} M`;
    const vs = imp ? `${(t.verticalSpeed * 196.85).toFixed(0)} FPM` : `${t.verticalSpeed.toFixed(1)} M/S`;
    this.text(g, 'ALT', 290, 340, 16, CYAN);
    this.text(g, alt, 490, 340, 20, WHITE, 'right');
    this.text(g, 'V/S', 290, 368, 16, CYAN);
    this.text(g, vs, 490, 368, 20, WHITE, 'right');
    this.text(g, 'HDG', 290, 396, 16, CYAN);
    this.text(g, `${t.heading.toFixed(0).padStart(3, '0')}°`, 490, 396, 20, WHITE, 'right');
    this.text(g, 'RALT', 290, 424, 16, CYAN);
    this.text(g, t.agl < 1500 ? (imp ? `${(t.agl / 0.3048).toFixed(0)} FT` : `${t.agl.toFixed(0)} M`) : '---', 490, 424, 20, WHITE, 'right');
    this.text(g, 'FCS', 290, 452, 16, CYAN);
    this.text(g, ctx.ac.fcs.mode, 490, 452, 20, ctx.ac.fcs.mode === 'DIRECT' ? AMBER : GREEN, 'right');
  }

  private drawMap(g: CanvasRenderingContext2D, ctx: MfdContext): void {
    const ac = ctx.ac;
    const range = 20000; // metres from centre to edge
    const cx = 256, cy = 300;
    const scale = 220 / range;
    const hdg = ac.t.heading * (Math.PI / 180);
    g.save();
    g.beginPath();
    g.rect(0, 40, 512, 440);
    g.clip();
    g.translate(cx, cy);
    g.rotate(-hdg);
    if (ctx.mapImage) {
      const [mcx, mcz, span] = ctx.mapRect;
      const px = (mcx - span / 2 - ac.position.x) * scale;
      const pz = (mcz - span / 2 - ac.position.z) * scale;
      g.globalAlpha = 0.85;
      g.drawImage(ctx.mapImage, px, pz, span * scale, span * scale);
      g.globalAlpha = 1;
    }
    // range rings
    g.strokeStyle = 'rgba(95,227,255,0.5)';
    g.lineWidth = 1.5;
    for (const rr of [0.25, 0.5, 1]) {
      g.beginPath();
      g.arc(0, 0, 220 * rr, 0, Math.PI * 2);
      g.stroke();
    }
    // waypoint
    if (ctx.waypoint) {
      const wx = (ctx.waypoint.x - ac.position.x) * scale, wz = (ctx.waypoint.z - ac.position.z) * scale;
      g.strokeStyle = '#ff63ff';
      g.lineWidth = 2;
      g.setLineDash([8, 6]);
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(wx, wz);
      g.stroke();
      g.setLineDash([]);
      g.beginPath();
      g.arc(wx, wz, 9, 0, Math.PI * 2);
      g.stroke();
    }
    // north marker
    this.text(g, 'N', 0, -235, 18, WHITE, 'center');
    g.restore();
    // ownship
    g.strokeStyle = WHITE;
    g.fillStyle = WHITE;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx, cy - 16);
    g.lineTo(cx + 11, cy + 12);
    g.lineTo(cx, cy + 6);
    g.lineTo(cx - 11, cy + 12);
    g.closePath();
    g.stroke();
    this.text(g, `${(range / 1852).toFixed(0)} NM`, 470, 60, 16, CYAN, 'right');
    this.text(g, `HDG ${ac.t.heading.toFixed(0).padStart(3, '0')}`, 40, 60, 16, CYAN);
    if (ctx.waypoint) {
      const d = Math.hypot(ctx.waypoint.x - ac.position.x, ctx.waypoint.z - ac.position.z);
      const brg = wrap360(Math.atan2(ctx.waypoint.x - ac.position.x, -(ctx.waypoint.z - ac.position.z)) * RAD);
      this.text(g, `${ctx.waypoint.name}  ${brg.toFixed(0).padStart(3, '0')}° / ${(d / 1852).toFixed(1)} NM`, 256, 465, 16, '#ff63ff', 'center');
    }
  }

  private drawSystems(g: CanvasRenderingContext2D, ctx: MfdContext): void {
    const ac = ctx.ac;
    // gear diagram
    this.text(g, 'GEAR', 120, 70, 18, CYAN, 'center');
    const gearPos = [[120, 110], [80, 170], [160, 170]];
    ac.gear.legs.forEach((l, i) => {
      const [x, y] = gearPos[i];
      const col = l.broken ? RED : l.extension >= 1 ? GREEN : l.extension <= 0 ? '#333' : AMBER;
      g.fillStyle = col;
      g.fillRect(x - 18, y - 18, 36, 36);
      this.text(g, l.broken ? 'X' : l.extension >= 1 ? 'DN' : l.extension <= 0 ? 'UP' : 'TR', x, y, 14, '#000', 'center');
    });
    this.text(g, `NWS ${ac.gear.nwsEnabled ? 'ON' : 'OFF'}`, 120, 215, 15, WHITE, 'center');
    this.text(g, `PARK BRK ${ac.gear.parkingBrake ? 'SET' : 'OFF'}`, 120, 240, 15, ac.gear.parkingBrake ? AMBER : WHITE, 'center');
    // flaps / airbrake / LEF
    const fl = ['UP', 'TO', 'LDG'][ac.surfaces.flapSetting];
    this.text(g, 'FLAPS', 330, 70, 18, CYAN, 'center');
    this.text(g, `${fl}  ${(ac.surfaces.flaps * RAD).toFixed(0)}°`, 330, 100, 22, WHITE, 'center');
    this.text(g, 'SPD BRK', 330, 140, 18, CYAN, 'center');
    this.text(g, `${(ac.surfaces.airbrake * RAD).toFixed(0)}°`, 330, 168, 22, ac.surfaces.airbrake > 0.05 ? AMBER : WHITE, 'center');
    this.text(g, `LEF ${(ac.surfaces.lef * RAD).toFixed(0)}°   HYD ${(ac.surfaces.hydraulics * 3000).toFixed(0)} PSI`, 330, 210, 15, WHITE, 'center');
    // electrical
    const el = ac.electrical;
    this.text(g, 'ELECTRICAL', 256, 280, 18, CYAN, 'center');
    this.text(g, `BATT ${el.batterySwitch ? 'ON' : 'OFF'}  ${(el.charge * 100).toFixed(0)}%`, 40, 312, 17, el.batterySwitch ? WHITE : '#888');
    this.text(g, `GEN ${el.generatorOnline ? 'ONLINE' : 'OFF'}`, 300, 312, 17, el.generatorOnline ? GREEN : AMBER);
    this.text(g, `BUS ${el.voltage.toFixed(1)} V`, 40, 340, 17, WHITE);
    this.text(g, `MAIN ${el.mainBus ? 'PWR' : '---'}   ESS ${el.essentialBus ? 'PWR' : '---'}`, 220, 340, 17, WHITE);
    // lights
    this.text(g, 'EXT LIGHTS', 256, 385, 18, CYAN, 'center');
    const L = ctx.lights;
    this.text(g, `NAV ${L.nav ? 'ON' : 'OFF'}   STROBE ${L.strobe ? 'ON' : 'OFF'}   LDG ${['OFF', 'TAXI', 'LAND'][L.landing]}`, 256, 415, 16, WHITE, 'center');
    this.text(g, `FORM ${(L.formation * 100).toFixed(0)}%   CANOPY ${ctx.canopy > 0.99 ? 'OPEN' : ctx.canopy < 0.01 ? 'LOCKED' : 'MOVING'}`, 256, 442, 16, ctx.canopy > 0.01 ? AMBER : WHITE, 'center');
  }

  private drawDamage(g: CanvasRenderingContext2D, ctx: MfdContext): void {
    const h = ctx.ac.damage.health;
    const col = (v: number) => (v > 0.8 ? GREEN : v > 0.4 ? AMBER : RED);
    const cx = 256, cy = 230;
    // top-view silhouette with coloured sections
    const poly = (pts: [number, number][], c: string) => {
      g.fillStyle = c;
      g.globalAlpha = 0.75;
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(cx + x, cy + y) : g.moveTo(cx + x, cy + y)));
      g.closePath();
      g.fill();
      g.globalAlpha = 1;
      g.strokeStyle = WHITE;
      g.lineWidth = 1.5;
      g.stroke();
    };
    poly([[0, -170], [22, -110], [26, 60], [-26, 60], [-22, -110]], col(h.fuselage));
    poly([[24, -40], [150, 50], [150, 80], [26, 70]], col(h.rightWing));
    poly([[-24, -40], [-150, 50], [-150, 80], [-26, 70]], col(h.leftWing));
    poly([[26, 70], [26, 140], [-26, 140], [-26, 70]], col(h.engine));
    poly([[26, 110], [90, 150], [90, 165], [26, 160]], col(Math.min(h.tail, h.stabR)));
    poly([[-26, 110], [-90, 150], [-90, 165], [-26, 160]], col(Math.min(h.tail, h.stabL)));
    const list = Object.keys(h) as DamageComponent[];
    list.forEach((k, i) => {
      const x = i < 5 ? 30 : 280;
      const y = 410 + (i % 5) * 18;
      this.text(g, `${DAMAGE_LABELS[k].padEnd(11)} ${(h[k] * 100).toFixed(0).padStart(3)}%`, x, y, 14, col(h[k]));
    });
    const gl = ctx.ac.gear.legs.map((l) => `${l.cfg.id.toUpperCase()} ${(l.health * 100).toFixed(0)}%`).join('  ');
    this.text(g, `GEAR  ${gl}`, 256, 395, 14, WHITE, 'center');
    if (ctx.ac.damage.fire > 0.05) this.text(g, 'FIRE', 256, 60, 32, RED, 'center');
  }

  private drawFuel(g: CanvasRenderingContext2D, ctx: MfdContext): void {
    const f = ctx.ac.fuel;
    this.text(g, 'FUEL QUANTITY', 256, 70, 20, CYAN, 'center');
    const tanks = f.tanks;
    const pos: [number, number][] = [[256, 140], [256, 300], [120, 220], [392, 220]];
    tanks.forEach((t, i) => {
      const [x, y] = pos[i];
      const frac = t.quantity / t.capacity;
      g.strokeStyle = t.leakRate > 0 ? RED : WHITE;
      g.lineWidth = 2;
      g.strokeRect(x - 60, y - 40, 120, 80);
      g.fillStyle = frac < 0.15 ? AMBER : GREEN;
      g.globalAlpha = 0.5;
      g.fillRect(x - 58, y + 38 - 76 * frac, 116, 76 * frac);
      g.globalAlpha = 1;
      this.text(g, t.id, x, y - 22, 14, CYAN, 'center');
      this.text(g, `${t.quantity.toFixed(0)}`, x, y + 6, 20, WHITE, 'center');
    });
    const total = f.total;
    this.text(g, `TOTAL ${total.toFixed(0)} KG`, 256, 390, 24, total < 800 ? AMBER : WHITE, 'center');
    const ff = ctx.ac.engine.fuelFlow * f.burnMultiplier;
    const endurance = ff > 0.01 ? total / ff : 0;
    this.text(g, `FLOW ${(ff * 3600).toFixed(0)} KG/H   ENDUR ${endurance > 0 ? formatTime(endurance).slice(0, -3) : '--:--'}`, 256, 425, 16, WHITE, 'center');
    this.text(g, `BINGO 800   USED ${f.totalBurned.toFixed(0)}`, 256, 452, 16, CYAN, 'center');
  }
}
