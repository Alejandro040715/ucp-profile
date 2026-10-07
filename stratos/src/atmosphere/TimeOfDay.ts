// Sun / moon ephemeris (simplified astronomy at a fixed latitude) and the
// resulting key-light colour, night factor and auto-exposure target.

import { Color, Vector3 } from 'three';
import { clamp, DEG, smoothstep, damp } from '../core/math.ts';
import { sunTransmittance, SUN_INTENSITY } from './AtmosphereModel.ts';

const LAT = 41.5 * DEG;

export class TimeOfDay {
  /** hours 0..24 */
  hours = 10.5;
  dayOfYear = 172; // early summer
  /** time scale: 1 = real time; free flight lets the player speed it up */
  scale = 1;
  paused = false;
  readonly sunDir = new Vector3();
  readonly moonDir = new Vector3();
  /** direction of the active key light (sun by day, moon by night) pointing TO the light */
  readonly keyDir = new Vector3();
  readonly keyColor = new Color();
  readonly sunColor = new Color();
  sunElevation = 0; // rad
  night = 0;
  lightsOn = 0;
  exposure = 1.6;
  moonPhase = 0.75;
  private tmpC = new Color();

  update(dt: number): void {
    if (!this.paused) this.hours = (this.hours + (dt * this.scale) / 3600 + 24) % 24;
    this.computeDirections();
  }

  computeDirections(): void {
    const decl = 23.44 * DEG * Math.sin(((2 * Math.PI) / 365) * (this.dayOfYear - 81));
    const H = (this.hours - 12) * 15 * DEG;
    const sinEl = Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(H);
    const el = Math.asin(clamp(sinEl, -1, 1));
    const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(LAT) - Math.tan(decl) * Math.cos(LAT)) + Math.PI;
    this.sunElevation = el;
    this.sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    // moon: roughly opposite the sun, tilted
    const mH = H + Math.PI * 0.92;
    const mDecl = -decl * 0.6 + 5 * DEG;
    const mSin = Math.sin(LAT) * Math.sin(mDecl) + Math.cos(LAT) * Math.cos(mDecl) * Math.cos(mH);
    const mEl = Math.asin(clamp(mSin, -1, 1));
    const mAz = Math.atan2(Math.sin(mH), Math.cos(mH) * Math.sin(LAT) - Math.tan(mDecl) * Math.cos(LAT)) + Math.PI;
    this.moonDir.set(Math.sin(mAz) * Math.cos(mEl), Math.sin(mEl), -Math.cos(mAz) * Math.cos(mEl)).normalize();
  }

  /** Update key light given observer altitude and haze (Mie scale) and overcast. */
  updateLighting(dt: number, altitude: number, mie: number, overcast: number, inCloud: number): void {
    sunTransmittance(altitude, this.sunDir, mie, this.tmpC);
    this.sunColor.copy(this.tmpC).multiplyScalar(SUN_INTENSITY);
    const elDeg = this.sunElevation / DEG;
    this.night = smoothstep(2, -10, elDeg);
    this.lightsOn = Math.max(smoothstep(5, -3, elDeg), smoothstep(0.7, 1.0, overcast) * smoothstep(25, 5, elDeg));
    const sunUp = smoothstep(-3.5, 0.5, elDeg);
    const moonCol = new Color(0.34, 0.4, 0.55).multiplyScalar(0.075 * this.moonPhase * smoothstep(-0.05, 0.1, this.moonDir.y));
    if (sunUp > 0.001) {
      this.keyDir.copy(this.sunDir);
      this.keyColor.copy(this.sunColor).multiplyScalar(sunUp);
      if (this.sunDir.y < 0.02) this.keyDir.y = Math.max(this.keyDir.y, 0.02);
    } else {
      this.keyDir.copy(this.moonDir);
      if (this.keyDir.y < 0.05) this.keyDir.y = 0.05;
      this.keyColor.copy(moonCol);
    }
    // overcast & in-cloud dim the direct light
    this.keyColor.multiplyScalar(1 - 0.75 * smoothstep(0.6, 1.0, overcast));
    this.keyColor.multiplyScalar(1 - 0.85 * inCloud);
    // exposure (eye adaptation) as a function of sun elevation, overcast and cloud immersion
    const exposureCurve = [[-18, 9.0], [-8, 7.0], [-3, 4.6], [0, 3.4], [5, 2.4], [12, 1.75], [25, 1.45], [90, 1.3]];
    let target = 1.3;
    for (let i = 1; i < exposureCurve.length; i++) {
      const [e0, v0] = exposureCurve[i - 1], [e1, v1] = exposureCurve[i];
      if (elDeg <= e1) {
        const t = Math.max(0, Math.min(1, (elDeg - e0) / (e1 - e0)));
        target = v0 + (v1 - v0) * t;
        break;
      }
    }
    target *= 1 + 0.7 * smoothstep(0.5, 1.0, overcast) + 0.5 * inCloud;
    this.exposure = damp(this.exposure, target, 0.6, dt);
  }

  setHours(h: number): void {
    this.hours = ((h % 24) + 24) % 24;
    this.computeDirections();
  }

  label(): string {
    const h = Math.floor(this.hours);
    const m = Math.floor((this.hours - h) * 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  }

  phaseName(): string {
    const el = this.sunElevation / DEG;
    if (el < -8) return 'NIGHT';
    if (el < 6) return this.hours < 12 ? 'DAWN' : 'SUNSET';
    return 'DAY';
  }
}
