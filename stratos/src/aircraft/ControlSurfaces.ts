// Hydraulic actuator model for every moving surface. Commands come from the
// flight control system; positions are rate-limited and can jam when damaged.
// Exposes both aerodynamic deflections and per-panel visual angles.

import { AircraftConfig } from './AircraftConfig.ts';
import { approach, clamp, damp, DEG, smoothstep } from '../core/math.ts';

export type FlapSetting = 0 | 1 | 2; // UP, TO, LDG

class Actuator {
  pos = 0;
  jammed = false;
  max: number;
  rate: number;
  constructor(max: number, rate: number) {
    this.max = max;
    this.rate = rate;
  }
  update(cmd: number, dt: number, rateScale = 1): number {
    if (this.jammed) return this.pos;
    const target = clamp(cmd, -1, 1) * this.max;
    this.pos = approach(this.pos, target, this.rate * rateScale * dt);
    return this.pos;
  }
}

export class ControlSurfaces {
  readonly cfg = AircraftConfig.surfaces;
  // symmetric/aero deflections (radians)
  readonly elevator: Actuator;
  readonly aileron: Actuator;
  readonly rudder: Actuator;
  flaps = 0; // rad
  flapSetting: FlapSetting = 0;
  airbrake = 0; // rad
  airbrakeCmd = false;
  lef = 0; // leading edge flaps, rad
  /** hydraulic pressure 0..1 — drops with engine off (windmill gives some) */
  hydraulics = 0;

  // per panel jam flags for damage (L/R)
  flaperonJamL = false;
  flaperonJamR = false;
  stabJamL = false;
  stabJamR = false;
  rudderJam = false;

  constructor() {
    const c = this.cfg;
    this.elevator = new Actuator(c.elevatorMax, c.elevatorRate);
    this.aileron = new Actuator(c.aileronMax, c.aileronRate);
    this.rudder = new Actuator(c.rudderMax, c.rudderRate);
  }

  get flapTarget(): number {
    return this.flapSetting === 0 ? 0 : this.flapSetting === 1 ? this.cfg.flapTO : this.cfg.flapLDG;
  }

  /** normalised commands in [-1, 1]; positive = nose up / roll right / nose right */
  update(dt: number, elev: number, ail: number, rud: number, alpha: number, mach: number, n2: number, tas: number): void {
    // hydraulics from engine-driven pump, or windmilling, or electric backup (slow)
    const hydTarget = Math.max(smoothstep(0.15, 0.55, n2), smoothstep(40, 110, tas) * 0.55, 0.25);
    this.hydraulics = damp(this.hydraulics, hydTarget, 2, dt);
    const rs = 0.25 + 0.75 * this.hydraulics;
    this.elevator.jammed = this.stabJamL && this.stabJamR;
    this.rudder.jammed = this.rudderJam;
    this.aileron.jammed = this.flaperonJamL && this.flaperonJamR;
    this.elevator.update(elev, dt, rs);
    this.aileron.update(ail, dt, rs);
    this.rudder.update(rud, dt, rs);

    // flaps (slow), blown back at high speed
    const flapLimit = tas > 125 ? Math.max(0, 1 - (tas - 125) / 40) : 1;
    this.flaps = approach(this.flaps, this.flapTarget * flapLimit, this.cfg.flapRate * rs * dt);
    // airbrake, blows back partially at high dynamic pressure
    const abTarget = this.airbrakeCmd ? this.cfg.airbrakeMax * (tas > 260 ? 0.65 : 1) : 0;
    this.airbrake = approach(this.airbrake, abTarget, this.cfg.airbrakeRate * rs * dt);
    // automatic leading-edge flaps scheduled with AoA, retracted when supersonic
    const lefTarget = clamp((alpha - 3 * DEG) * 1.1, 0, this.cfg.lefMax) * (1 - smoothstep(0.9, 1.05, mach)) + (this.flapSetting > 0 ? 10 * DEG : 0);
    this.lef = approach(this.lef, Math.min(lefTarget, this.cfg.lefMax), 40 * DEG * dt);
  }

  // --- visual angles (radians, positive = trailing edge down for flaps/ailerons, leading edge up for stabs)
  /** left / right all-moving stabilator (elevator + 30% differential roll assist) */
  stabLeft(): number {
    return this.elevator.pos + 0.35 * this.aileron.pos;
  }
  stabRight(): number {
    return this.elevator.pos - 0.35 * this.aileron.pos;
  }
  /** flaperons: flaps down + aileron differential (right roll = left down) */
  flaperonLeft(): number {
    return this.flaps + this.aileron.pos;
  }
  flaperonRight(): number {
    return this.flaps - this.aileron.pos;
  }
  get rudderPos(): number {
    return this.rudder.pos;
  }
}
