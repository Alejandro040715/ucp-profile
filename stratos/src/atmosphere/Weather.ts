// Dynamic weather: six presets blended over time, producing cloud layer
// parameters, haze, fog, rain, wetness, wind (direction / altitude profile /
// gusts), turbulence (incl. in-cloud and mountain rotor) and lightning.

import { Vector3, type Data3DTexture, type DataTexture } from 'three';
import { clamp, damp, DEG, lerp, rng, SmoothNoise, smoothstep } from '../core/math.ts';
import { events } from '../core/EventBus.ts';
import { sampleWeatherCPU } from '../render/NoiseTextures.ts';
import { mountainFactor } from '../world/Heightfield.ts';

export type WeatherState = 'CLEAR' | 'PARTLY CLOUDY' | 'OVERCAST' | 'RAIN' | 'STORM' | 'FOG';
export const WEATHER_STATES: WeatherState[] = ['CLEAR', 'PARTLY CLOUDY', 'OVERCAST', 'RAIN', 'STORM', 'FOG'];

export interface WeatherParams {
  coverage: number;
  density: number;
  base: number;
  top: number;
  type: number;
  mie: number;
  fog: number;
  fogHeight: number;
  rain: number;
  wind: number;
  gust: number;
  turb: number;
  lightning: number;
  overcast: number;
  humidity: number;
  temp: number;
}

const PRESETS: Record<WeatherState, WeatherParams> = {
  'CLEAR': { coverage: 0.14, density: 0.8, base: 1900, top: 3300, type: 0.45, mie: 0.75, fog: 0, fogHeight: 300, rain: 0, wind: 4, gust: 1.5, turb: 0.12, lightning: 0, overcast: 0, humidity: 0.45, temp: 4 },
  'PARTLY CLOUDY': { coverage: 0.42, density: 1.0, base: 1500, top: 3900, type: 0.6, mie: 1.0, fog: 0, fogHeight: 300, rain: 0, wind: 7, gust: 3.5, turb: 0.3, lightning: 0, overcast: 0.08, humidity: 0.62, temp: 1 },
  'OVERCAST': { coverage: 0.93, density: 0.75, base: 950, top: 3100, type: 0.12, mie: 1.7, fog: 0.00004, fogHeight: 600, rain: 0, wind: 9, gust: 4, turb: 0.3, lightning: 0, overcast: 0.82, humidity: 0.8, temp: -2 },
  'RAIN': { coverage: 0.97, density: 1.15, base: 650, top: 4300, type: 0.3, mie: 2.6, fog: 0.00016, fogHeight: 700, rain: 0.75, wind: 11, gust: 6, turb: 0.55, lightning: 0, overcast: 0.95, humidity: 0.97, temp: -5 },
  'STORM': { coverage: 0.86, density: 1.6, base: 700, top: 10500, type: 0.97, mie: 2.9, fog: 0.00012, fogHeight: 900, rain: 1.0, wind: 15, gust: 11, turb: 1.0, lightning: 1, overcast: 0.95, humidity: 1.0, temp: -6 },
  'FOG': { coverage: 0.3, density: 0.7, base: 1300, top: 2500, type: 0.2, mie: 3.2, fog: 0.0016, fogHeight: 160, rain: 0, wind: 1.5, gust: 0.5, turb: 0.05, lightning: 0, overcast: 0.4, humidity: 1.0, temp: -3 },
};

const KEYS = Object.keys(PRESETS.CLEAR) as (keyof WeatherParams)[];

export class Weather {
  state: WeatherState = 'PARTLY CLOUDY';
  readonly current: WeatherParams = { ...PRESETS['PARTLY CLOUDY'] };
  private target: WeatherParams = { ...PRESETS['PARTLY CLOUDY'] };
  transitionTime = 90; // seconds for a full change
  wetness = 0;
  /** wind direction the wind blows FROM, degrees */
  windFrom = 245;
  readonly windOffset = new Vector3(); // accumulated cloud advection
  private gustN = new SmoothNoise(11);
  private turbU = new SmoothNoise(21);
  private turbV = new SmoothNoise(31);
  private turbW = new SmoothNoise(41);
  private rotP = new SmoothNoise(51);
  private rotQ = new SmoothNoise(61);
  private rotR = new SmoothNoise(71);
  private lightningTimer = 8;
  private r = rng(99);
  readonly turbulenceVel = new Vector3();
  readonly turbulenceRot = new Vector3();
  gustValue = 0;
  flash = 0;
  readonly flashPos = new Vector3();
  weatherTex: DataTexture | null = null;
  shapeTex: Data3DTexture | null = null;
  /** current turbulence intensity felt by the aircraft (for camera shake / audio) */
  felt = 0;

  set(state: WeatherState, instant = false): void {
    this.state = state;
    this.target = { ...PRESETS[state] };
    if (instant) Object.assign(this.current, this.target);
    events.emit('weather:change', { state });
  }

  next(): WeatherState {
    const i = WEATHER_STATES.indexOf(this.state);
    const s = WEATHER_STATES[(i + 1) % WEATHER_STATES.length];
    this.set(s);
    return s;
  }

  update(dt: number, camPos: Vector3): void {
    const rate = 3 / this.transitionTime;
    for (const k of KEYS) this.current[k] = damp(this.current[k], this.target[k], rate, dt);
    const c = this.current;
    // wetness accumulates in rain and dries slowly
    if (c.rain > 0.05) this.wetness = Math.min(1, this.wetness + dt * c.rain / 100);
    else this.wetness = Math.max(0, this.wetness - dt / 900);
    // cloud advection with the wind at cloud altitude
    const w = this.windAt(c.base + 500, new Vector3());
    this.windOffset.x -= w.x * dt;
    this.windOffset.z -= w.z * dt;
    this.windOffset.y += dt * 0.6; // slow evolution of the 3D noise
    this.gustValue = this.gustN.next(dt, 0.18);
    // lightning
    this.flash = Math.max(0, this.flash - dt * 6);
    if (c.lightning > 0.3) {
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        this.lightningTimer = 4 + this.r() * 14 / c.lightning;
        const ang = this.r() * Math.PI * 2;
        const dist = 2500 + this.r() * 14000;
        this.flashPos.set(camPos.x + Math.cos(ang) * dist, lerp(c.base, c.top, 0.35), camPos.z + Math.sin(ang) * dist);
        this.flash = 1 + this.r();
        events.emit('lightning', { position: [this.flashPos.x, this.flashPos.y, this.flashPos.z], distance: this.flashPos.distanceTo(camPos) });
      }
    }
  }

  /** Mean wind (no gust/turbulence) at altitude, world frame velocity (m/s, direction it blows TO). */
  windAt(alt: number, out: Vector3): Vector3 {
    const c = this.current;
    const speed = c.wind * (0.55 + 0.45 * smoothstep(0, 600, alt)) * (1 + Math.min(alt, 11000) / 3200);
    const dir = (this.windFrom + 25 * smoothstep(0, 8000, alt)) * DEG;
    // blowing FROM dir -> velocity points opposite
    return out.set(-Math.sin(dir) * speed, 0, Math.cos(dir) * speed);
  }

  /** Full wind incl. gusts + turbulence for physics. `tas` scales turbulence frequency. */
  sampleWind(pos: Vector3, agl: number, tas: number, dt: number, inCloud: number, out: Vector3): Vector3 {
    const c = this.current;
    this.windAt(pos.y, out);
    const gustScale = 1 + (c.gust / Math.max(c.wind, 1)) * 0.5 * this.gustValue * smoothstep(0, 400, agl + 50);
    out.multiplyScalar(gustScale);
    // boundary layer: wind drops close to the ground
    out.multiplyScalar(0.35 + 0.65 * smoothstep(0, 120, agl));
    const mtn = mountainFactor(pos.x, pos.z) * smoothstep(5000, 1500, agl) * smoothstep(3, 12, c.wind);
    const sigma = c.turb * (1.6 + 4 * inCloud + 3 * mtn) * (0.4 + 0.6 * smoothstep(0, 300, agl));
    const f = clamp(tas / 140, 0.3, 4);
    this.turbulenceVel.set(this.turbU.next(dt, f) * sigma, this.turbW.next(dt, f * 1.3) * sigma * 0.8, this.turbV.next(dt, f) * sigma);
    const rs = sigma * 0.012;
    this.turbulenceRot.set(this.rotQ.next(dt, f * 1.5) * rs, this.rotR.next(dt, f * 1.2) * rs * 0.6, this.rotP.next(dt, f * 1.8) * rs * 1.6);
    this.felt = sigma;
    return out.add(this.turbulenceVel);
  }

  /** CPU approximation of cloud density at a point (for in-cloud effects / turbulence). */
  cloudDensityAt(p: Vector3): number {
    const c = this.current;
    if (p.y < c.base || p.y > c.top || !this.weatherTex) return 0;
    const hN = (p.y - c.base) / (c.top - c.base);
    const u = (p.x + this.windOffset.x) / 40000;
    const v = (p.z + this.windOffset.z) / 40000;
    const wm = sampleWeatherCPU(this.weatherTex, u, v);
    let cov = smoothstep(1 - c.coverage - 0.12, 1 - c.coverage + 0.12, wm);
    cov = Math.max(cov, smoothstep(0.85, 1, c.coverage));
    const grad = smoothstep(0, 0.12, hN) * (1 - smoothstep(c.type > 0.8 ? 0.9 : 0.55, 1, hN));
    let n = 0.6;
    if (this.shapeTex) {
      const img = this.shapeTex.image as { data: Uint8Array; width: number };
      const s = img.width;
      const sx = (((p.x + this.windOffset.x * 1.2) / 7000) % 1 + 1) % 1;
      const sy = (((p.y * 1.6 + this.windOffset.y * 1.2) / 7000) % 1 + 1) % 1;
      const sz = (((p.z + this.windOffset.z * 1.2) / 7000) % 1 + 1) % 1;
      const ix = Math.floor(sx * s), iy = Math.floor(sy * s), iz = Math.floor(sz * s);
      n = img.data[((iz * s + iy) * s + ix) * 4] / 255;
    }
    const d = clamp((n * grad - (1 - cov * 0.82)) / Math.max(cov * 0.82, 1e-3), 0, 1) * c.density;
    return clamp(d * 1.5, 0, 1);
  }

  get visibilityKm(): number {
    const ext = this.current.fog + 1e-5 * this.current.mie;
    return Math.min(99, 3 / ext / 1000);
  }
}
