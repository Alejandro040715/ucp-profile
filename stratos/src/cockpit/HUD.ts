// Collimated head-up display. Symbology is drawn into a canvas that represents
// angular space around the aircraft boresight (focused at infinity). The
// combiner glass shader converts each fragment's view direction into body-frame
// angles and samples the canvas, so symbols stay conformal with the outside
// world regardless of head position, exactly like a real HUD.

import { AdditiveBlending, CanvasTexture, Color, DoubleSide, Group, LinearMipmapLinearFilter, Matrix3, Matrix4, Mesh, PlaneGeometry, ShaderMaterial, Vector3, type Quaternion } from 'three';
import type { AircraftPhysics } from '../aircraft/AircraftPhysics.ts';
import { clamp, DEG, RAD, wrap360 } from '../core/math.ts';
import { AircraftConfig } from '../aircraft/AircraftConfig.ts';

const FOV = 25 * DEG; // canvas angular extent (square)
const EL_CENTER = -4 * DEG; // canvas centre elevation relative to boresight
const RES = 1024;
const PX_PER_RAD = RES / FOV;

export interface HudContext {
  ac: AircraftPhysics;
  waypoint: { x: number; y: number; z: number; name: string } | null;
  warnings: string[];
  units: 'imperial' | 'metric';
  mode: number; // 0 NORM, 1 DECLUTTER, 2 OFF
  time: number;
}

export class HUD {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  readonly texture: CanvasTexture;
  readonly group = new Group();
  readonly glassMat: ShaderMaterial;
  brightness = 0.8;
  power = true;
  color = new Color(0.45, 1.0, 0.55);
  private bodyInv = new Matrix3();
  private tmpM4 = new Matrix4();
  exposure = 1;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = RES;
    this.canvas.height = RES;
    this.g = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    // the canvas is minified ~3-4x on screen: mipmaps keep thin strokes from
    // breaking up into sparkling fragments
    this.texture.minFilter = LinearMipmapLinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.anisotropy = 4;
    this.glassMat = new ShaderMaterial({
      uniforms: {
        uHud: { value: this.texture },
        uBodyInv: { value: this.bodyInv },
        uColor: { value: this.color },
        uIntensity: { value: 1 },
        uFov: { value: FOV },
        uElCenter: { value: EL_CENTER },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorldPos;
        void main() { vec4 wp = modelMatrix * vec4(position, 1.0); vWorldPos = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uHud; uniform mat3 uBodyInv; uniform vec3 uColor; uniform float uIntensity; uniform float uFov; uniform float uElCenter;
        varying vec3 vWorldPos;
        void main() {
          vec3 d = normalize(uBodyInv * normalize(vWorldPos - cameraPosition));
          // body frame: forward = -z, up = +y, right = +x
          float az = atan(d.x, -d.z);
          float el = atan(d.y, length(vec2(d.x, d.z)));
          vec2 uv = vec2(0.5 + az / uFov, 0.5 + (el - uElCenter) / uFov);
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
          float s = texture2D(uHud, uv).r;
          // faint tint of the combiner coating itself
          vec3 col = uColor * s * uIntensity + vec3(0.002, 0.004, 0.003);
          gl_FragColor = vec4(col, 1.0);
        }`,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    });
    // combiner glass plates (tilted) above the projector on the glareshield
    const eye = AircraftConfig.eyePoint;
    const plate = new Mesh(new PlaneGeometry(0.27, 0.255), this.glassMat);
    plate.position.set(eye[0], 0.905, -4.885);
    plate.rotation.x = -0.62;
    plate.renderOrder = 12;
    this.group.add(plate);
  }

  update(ctx: HudContext, bodyQuat: Quaternion, powered: boolean): void {
    // world -> body rotation for the glass shader
    this.bodyInv.setFromMatrix4(this.tmpM4.makeRotationFromQuaternion(bodyQuat)).transpose();
    const on = powered && this.power && ctx.mode !== 2;
    // bright green against a daylight sky without clipping to white
    this.glassMat.uniforms.uIntensity.value = on ? (this.brightness * 1.25) / Math.max(0.6, this.exposure) : 0;
    if (!on) return;
    this.draw(ctx);
    this.texture.needsUpdate = true;
  }

  // angular helpers: (az, el) radians relative to boresight -> canvas px
  private X(az: number): number {
    return RES / 2 + az * PX_PER_RAD;
  }
  private Y(el: number): number {
    return RES / 2 - (el - EL_CENTER) * PX_PER_RAD;
  }

  /** canvas position for an angular location (degrees) */
  private P(azDeg: number, elDeg: number): [number, number] {
    return [this.X(azDeg * DEG), this.Y(elDeg * DEG)];
  }

  private draw(ctx: HudContext): void {
    const g = this.g;
    const ac = ctx.ac;
    const t = ac.t;
    const imp = ctx.units === 'imperial';
    const declutter = ctx.mode === 1;
    g.clearRect(0, 0, RES, RES);
    g.strokeStyle = '#fff';
    g.fillStyle = '#fff';
    g.lineWidth = 3.6;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.shadowColor = 'rgba(255,255,255,0.35)';
    g.shadowBlur = 3;
    const font = (s: number) => (g.font = `600 ${s}px "JetBrains Mono", "Consolas", monospace`);
    const txt = (s: string, x: number, y: number, size = 26, align: CanvasTextAlign = 'center') => {
      font(size);
      g.textAlign = align;
      g.textBaseline = 'middle';
      g.fillText(s, x, y);
    };

    // ---- flight path marker (velocity vector in body frame)
    const vb = ac.velocity.clone().applyQuaternion(ac.quaternion.clone().invert());
    const speed = vb.length();
    let fpAz = 0, fpEl = -t.alpha;
    if (speed > 15) {
      fpAz = Math.atan2(vb.x, -vb.z);
      fpEl = Math.atan2(vb.y, Math.hypot(vb.x, vb.z));
    }
    let fx = this.X(fpAz), fy = this.Y(fpEl);
    const [lx0, ly0] = this.P(-7, 3.6), [lx1, ly1] = this.P(7, -10.5);
    const clipped = fx < lx0 || fx > lx1 || fy < ly0 || fy > ly1;
    fx = clamp(fx, lx0, lx1);
    fy = clamp(fy, ly0, ly1);

    // ---- boresight / waterline symbol
    const bx = this.X(0), by = this.Y(0);
    g.beginPath();
    g.moveTo(bx - 34, by);
    g.lineTo(bx - 16, by);
    g.lineTo(bx - 8, by + 12);
    g.lineTo(bx, by);
    g.lineTo(bx + 8, by + 12);
    g.lineTo(bx + 16, by);
    g.lineTo(bx + 34, by);
    g.stroke();

    // ---- pitch ladder (centred on the FPM, rotated by bank)
    const bank = t.bank;
    g.save();
    g.beginPath();
    g.rect(lx0 - 60, ly0 - 20, lx1 - lx0 + 120, ly1 - ly0 + 40);
    g.clip();
    g.translate(fx, fy);
    g.rotate(-bank);
    // the FPM sits at flight-path angle gamma; ladder line p is at (p - gamma)
    const gamma = t.flightPathAngle;
    for (let p = -90; p <= 90; p += 5) {
      const dy = -(p * DEG - gamma) * PX_PER_RAD;
      if (Math.abs(dy) > 420) continue;
      if (declutter && p % 10 !== 0) continue;
      if (p === 0) {
        g.beginPath();
        g.moveTo(-330, dy);
        g.lineTo(-60, dy);
        g.moveTo(60, dy);
        g.lineTo(330, dy);
        g.stroke();
        continue;
      }
      const w = 120, gap = 50;
      const tick = p > 0 ? 16 : -16;
      g.setLineDash(p < 0 ? [14, 10] : []);
      // negative lines tilt towards the horizon (half the pitch angle, like modern HUDs)
      const tilt = p < 0 ? Math.min(Math.abs(p) * DEG * 0.5, 0.6) : 0;
      for (const s of [-1, 1]) {
        g.beginPath();
        const x0 = s * gap, x1 = s * (gap + w);
        g.moveTo(x0, dy + tick);
        g.lineTo(x0, dy);
        g.lineTo(x1, dy + Math.sin(tilt) * w);
        g.stroke();
      }
      g.setLineDash([]);
      txt(`${Math.abs(p)}`, -(gap + w + 30), dy, 22);
      txt(`${Math.abs(p)}`, gap + w + 30, dy, 22);
    }
    // -3 deg glideslope reference in landing configuration
    if (ac.gear.extension > 0.5) {
      const dy = -(-3 * DEG - gamma) * PX_PER_RAD;
      g.setLineDash([20, 12]);
      g.beginPath();
      g.moveTo(-200, dy);
      g.lineTo(-70, dy);
      g.moveTo(70, dy);
      g.lineTo(200, dy);
      g.stroke();
      g.setLineDash([]);
    }
    g.restore();

    // ---- FPM symbol
    g.beginPath();
    g.arc(fx, fy, 15, 0, Math.PI * 2);
    g.moveTo(fx - 15, fy);
    g.lineTo(fx - 38, fy);
    g.moveTo(fx + 15, fy);
    g.lineTo(fx + 38, fy);
    g.moveTo(fx, fy - 15);
    g.lineTo(fx, fy - 30);
    if (clipped) {
      g.moveTo(fx - 20, fy - 20);
      g.lineTo(fx + 20, fy + 20);
    }
    g.stroke();
    // energy caret (longitudinal acceleration)
    const accel = clamp(ac.t.nx, -1, 1);
    const cy2 = fy - accel * 100;
    g.beginPath();
    g.moveTo(fx - 52, cy2 - 9);
    g.lineTo(fx - 44, cy2);
    g.lineTo(fx - 52, cy2 + 9);
    g.stroke();

    // ---- AoA bracket in landing configuration (on-speed 11-13 deg)
    if (ac.gear.extension > 0.5) {
      const aoa = t.alpha * RAD;
      const off = (aoa - 12) * 12;
      g.beginPath();
      g.moveTo(fx - 70, fy - 30 + off);
      g.lineTo(fx - 78, fy - 30 + off);
      g.lineTo(fx - 78, fy + 30 + off);
      g.lineTo(fx - 70, fy + 30 + off);
      g.moveTo(fx - 78, fy + off);
      g.lineTo(fx - 72, fy + off);
      g.stroke();
    }

    // ---- speed (left) and altitude (right) tapes
    const ias = imp ? t.ias / 0.5144 : t.ias * 3.6;
    const alt = imp ? t.altitude / 0.3048 : t.altitude;
    const [tlx, tcy] = this.P(-8.6, -3.4), [trx] = this.P(8.6, 0);
    this.tape(g, tlx, tcy, ias, imp ? 10 : 20, imp ? 50 : 100, 'left');
    this.tape(g, trx, tcy, alt, imp ? 100 : 50, imp ? 500 : 250, 'right');
    const yRow = (el: number) => this.Y(el * DEG);
    txt(t.mach.toFixed(2), tlx, yRow(-8.4), 26);
    txt(`α ${(t.alpha * RAD).toFixed(1)}`, tlx, yRow(-9.5), 24);
    txt(`G ${t.nz.toFixed(1)}`, tlx, yRow(2.4), 28);
    txt(`${t.maxG.toFixed(1)}`, tlx, yRow(1.4), 22);
    const vs = imp ? t.verticalSpeed * 196.85 : t.verticalSpeed;
    txt(`${vs >= 0 ? '+' : ''}${vs.toFixed(0)}`, trx, yRow(1.6), 22);
    if (t.agl < (imp ? 5000 * 0.3048 : 1500)) txt(`R ${(imp ? t.agl / 0.3048 : t.agl).toFixed(0).padStart(4, ' ')}`, trx, yRow(-8.4), 26);
    // ---- heading tape (top)
    this.headingTape(g, t.heading, ctx);
    // ---- bank scale (bottom)
    if (!declutter) {
      const cx = RES / 2, cy = this.Y(-2 * DEG), r = 5.2 * DEG * PX_PER_RAD;
      for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
        const ang = Math.PI / 2 + a * DEG;
        const l = a % 30 === 0 ? 20 : 11;
        g.beginPath();
        g.moveTo(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
        g.lineTo(cx + Math.cos(ang) * (r + l), cy + Math.sin(ang) * (r + l));
        g.stroke();
      }
      const ba = Math.PI / 2 - bank;
      g.beginPath();
      g.moveTo(cx + Math.cos(ba) * (r - 4), cy + Math.sin(ba) * (r - 4));
      g.lineTo(cx + Math.cos(ba - 0.05) * (r - 22), cy + Math.sin(ba - 0.05) * (r - 22));
      g.lineTo(cx + Math.cos(ba + 0.05) * (r - 22), cy + Math.sin(ba + 0.05) * (r - 22));
      g.closePath();
      g.stroke();
    }
    // ---- engine / config / fuel
    const e = ac.engine;
    const [bl, r1] = this.P(-7.4, -11.1), [br, r2] = this.P(7.4, -12.2);
    txt(e.abLit ? 'AB' : `${e.rpmPercent.toFixed(0)}%`, bl, r1, 24, 'left');
    txt(`THR ${(ac.controls.throttle * 100).toFixed(0)}`, bl, r2, 22, 'left');
    txt(`FUEL ${ac.fuel.total.toFixed(0)}`, br, r1, 22, 'right');
    if (ac.gear.extension > 0.01) txt(ac.gear.downAndLocked ? 'GEAR' : 'GEAR ▲▼', br, r2, 22, 'right');
    if (ac.surfaces.flapSetting > 0) txt(['', 'FLAP TO', 'FLAP LDG'][ac.surfaces.flapSetting], RES / 2, r2, 22);
    if (ac.surfaces.airbrake > 0.05) txt('SPD BRK', RES / 2, r1, 22);
    if (ac.fcs.mode === 'DIRECT') txt('DIRECT', bl, this.Y(3.4 * DEG), 24, 'left');
    if (ac.fcs.aoaLimiting) txt('AOA LIM', RES / 2, this.Y(-9.8 * DEG), 24);
    else if (ac.fcs.gLimiting) txt('G LIM', RES / 2, this.Y(-9.8 * DEG), 24);

    // ---- waypoint steering
    if (ctx.waypoint) {
      const to = new Vector3(ctx.waypoint.x - ac.position.x, ctx.waypoint.y - ac.position.y, ctx.waypoint.z - ac.position.z);
      const dist = to.length();
      to.normalize().applyQuaternion(ac.quaternion.clone().invert());
      if (to.z < 0) {
        const az = Math.atan2(to.x, -to.z), el = Math.atan2(to.y, Math.hypot(to.x, to.z));
        const wx = clamp(this.X(az), lx0, lx1), wy = clamp(this.Y(el), ly0, ly1);
        g.beginPath();
        g.moveTo(wx, wy - 18);
        g.lineTo(wx + 18, wy);
        g.lineTo(wx, wy + 18);
        g.lineTo(wx - 18, wy);
        g.closePath();
        g.stroke();
      }
      txt(`${ctx.waypoint.name} ${(dist / 1852).toFixed(1)}`, br, this.Y(3.4 * DEG), 22, 'right');
    }
    // ---- warnings (flashing)
    const flash = Math.floor(ctx.time * 3) % 2 === 0;
    ctx.warnings.slice(0, 2).forEach((w, i) => {
      if (w === 'PULL UP' || w === 'STALL' ? flash : true) {
        g.lineWidth = 3;
        font(44);
        const ww = g.measureText(w).width + 30;
        const wy = this.Y((-5.6 - i * 1.5) * DEG);
        g.strokeRect(RES / 2 - ww / 2, wy - 26, ww, 52);
        txt(w, RES / 2, wy, 44);
        g.lineWidth = 2.6;
      }
    });
  }

  private tape(g: CanvasRenderingContext2D, x: number, cy: number, value: number, minor: number, major: number, side: 'left' | 'right'): void {
    const h = 300, ppu = 150 / (major * 2);
    g.save();
    g.beginPath();
    g.rect(x - 90, cy - h / 2, 180, h);
    g.clip();
    const dir = side === 'left' ? 1 : -1;
    const lineX = x + dir * 42;
    for (let v = Math.floor((value - h / 2 / ppu) / minor) * minor; v <= value + h / 2 / ppu; v += minor) {
      if (v < 0) continue;
      const y = cy - (v - value) * ppu;
      const isMajor = Math.abs(v % major) < 1e-6;
      g.beginPath();
      g.moveTo(lineX, y);
      g.lineTo(lineX + dir * (isMajor ? 18 : 9), y);
      g.stroke();
      if (isMajor) {
        g.font = '600 20px "JetBrains Mono", monospace';
        g.textAlign = side === 'left' ? 'right' : 'left';
        g.textBaseline = 'middle';
        g.fillText(`${Math.round(v)}`, lineX - dir * 8, y);
      }
    }
    g.restore();
    // current value box
    g.lineWidth = 2.6;
    g.strokeRect(x - 66, cy - 22, 132, 44);
    g.font = '700 30px "JetBrains Mono", monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(`${Math.round(value)}`, x, cy);
  }

  private headingTape(g: CanvasRenderingContext2D, hdg: number, ctx: HudContext): void {
    const cx = RES / 2, y = this.Y(4.3 * DEG), ppd = 9;
    g.save();
    g.beginPath();
    g.rect(cx - 220, y - 40, 440, 80);
    g.clip();
    for (let d = Math.floor(hdg - 25); d <= hdg + 25; d++) {
      if (d % 5 !== 0) continue;
      const x = cx + (d - hdg) * ppd;
      const major = d % 10 === 0;
      g.beginPath();
      g.moveTo(x, y + 18);
      g.lineTo(x, y + (major ? 4 : 11));
      g.stroke();
      if (major) {
        const v = wrap360(d) / 10;
        g.font = '600 20px "JetBrains Mono", monospace';
        g.textAlign = 'center';
        g.fillText(`${Math.round(v).toString().padStart(2, '0')}`, x, y - 12);
      }
    }
    g.restore();
    g.beginPath();
    g.moveTo(cx, y + 22);
    g.lineTo(cx - 9, y + 36);
    g.lineTo(cx + 9, y + 36);
    g.closePath();
    g.stroke();
    void ctx;
  }
}
