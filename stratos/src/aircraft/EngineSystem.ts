// Simplified but convincing afterburning turbofan: start sequence, N2 spool
// dynamics, thrust lapse with altitude/Mach, afterburner staging, fuel flow,
// EGT thermal lag, nozzle area schedule, windmilling and flameout.

import { AircraftConfig } from './AircraftConfig.ts';
import { approach, clamp, damp, lerp, saturate, smoothstep } from '../core/math.ts';
import { events } from '../core/EventBus.ts';

export type EngineState = 'OFF' | 'CRANK' | 'LIGHTOFF' | 'RUN' | 'SHUTDOWN' | 'FLAMEOUT' | 'FAILED';

export interface EngineInputs {
  throttle: number; // 0..1 dry range
  afterburner: boolean; // throttle past detent
  fuelAvailable: boolean;
  starterPower: boolean; // battery/start bus
  mach: number;
  densityRatio: number;
  altitude: number;
  ambientTempC: number;
  tas: number;
}

export class EngineSystem {
  readonly cfg = AircraftConfig.engine;
  state: EngineState = 'OFF';
  n2 = 0; // 0..~1.03 spool fraction
  egt = 15; // C
  abFraction = 0; // 0..1 afterburner stage
  abLit = false;
  private abLightTimer = 0;
  thrust = 0; // N
  fuelFlow = 0; // kg/s
  nozzle = 0.2; // 0 closed .. 1 fully open
  oilPressure = 0;
  health = 1; // set by damage system
  onFire = false;
  private startTimer = 0;
  private startRequested = false;
  throttleCmd = 0;
  /** smoothed vibration intensity for camera / audio */
  vibration = 0;
  /** 0..1 surge / compressor stall transient */
  surge = 0;

  requestStart(): void {
    if (this.state === 'OFF' || this.state === 'SHUTDOWN' || this.state === 'FLAMEOUT') {
      this.startRequested = true;
    }
  }

  requestShutdown(): void {
    if (this.state === 'RUN' || this.state === 'LIGHTOFF' || this.state === 'CRANK') {
      this.setState('SHUTDOWN');
      this.startRequested = false;
    }
  }

  get running(): boolean {
    return this.state === 'RUN';
  }

  /** N2 as displayed percentage */
  get rpmPercent(): number {
    return this.n2 * 100;
  }

  private setState(s: EngineState): void {
    if (this.state !== s) {
      this.state = s;
      events.emit('engine:state', { state: s });
    }
  }

  update(dt: number, inp: EngineInputs): void {
    const c = this.cfg;
    // windmill N2 from ram air when not driven
    const windmill = clamp(inp.tas / 520, 0, 0.32) * Math.sqrt(Math.max(0.2, inp.densityRatio));
    let n2Target = 0;
    const throttle = clamp(inp.throttle, 0, 1);
    this.throttleCmd = throttle;

    switch (this.state) {
      case 'OFF':
      case 'SHUTDOWN':
      case 'FLAMEOUT':
      case 'FAILED': {
        n2Target = this.state === 'FAILED' ? windmill * 0.4 : windmill;
        if (this.startRequested && this.state !== 'FAILED') {
          if (inp.starterPower) {
            this.setState('CRANK');
            this.startTimer = 0;
          }
          this.startRequested = false;
        }
        break;
      }
      case 'CRANK': {
        // starter motor accelerates N2 to light-off speed
        this.startTimer += dt;
        n2Target = c.n2Start + 0.04;
        if (!inp.starterPower) {
          this.setState('SHUTDOWN');
        } else if (this.n2 >= c.n2Start && inp.fuelAvailable) {
          this.setState('LIGHTOFF');
          this.startTimer = 0;
        }
        break;
      }
      case 'LIGHTOFF': {
        // combustion established, starter assists up to idle
        this.startTimer += dt;
        n2Target = c.n2Idle;
        if (!inp.fuelAvailable) this.setState('FLAMEOUT');
        if (this.n2 > c.n2Idle - 0.015) this.setState('RUN');
        break;
      }
      case 'RUN': {
        n2Target = lerp(c.n2Idle, 1.0, Math.pow(throttle, 0.85));
        if (inp.afterburner) n2Target = 1.0;
        // damaged engine cannot reach full speed
        n2Target = Math.min(n2Target, lerp(0.7, 1.0, this.health));
        if (!inp.fuelAvailable) {
          this.setState('FLAMEOUT');
          events.emit('message', { text: 'ENGINE FLAMEOUT — FUEL EXHAUSTED', kind: 'warn', duration: 5 });
        }
        if (this.health <= 0.02) {
          this.setState('FAILED');
          events.emit('message', { text: 'ENGINE FAILURE', kind: 'warn', duration: 5 });
        }
        break;
      }
    }

    // --- spool dynamics: first order lag + rate limit, slower when low
    const lowSpool = smoothstep(0.85, 0.5, this.n2);
    const tau = c.spoolTau * (1 + 1.4 * lowSpool);
    const rateUp = c.spoolUpRate * (0.55 + 0.45 * (1 - lowSpool));
    const rateDn = c.spoolDownRate;
    const desired = damp(this.n2, n2Target, 1 / tau, dt);
    const maxDelta = (desired > this.n2 ? rateUp : rateDn) * dt;
    this.n2 = approach(this.n2, desired, maxDelta);
    if (this.state === 'CRANK') this.n2 = approach(this.n2, n2Target, 0.06 * dt);

    // --- afterburner staging
    const abAllowed = this.state === 'RUN' && inp.afterburner && this.n2 > 0.95 && inp.fuelAvailable && this.health > 0.25;
    if (abAllowed) {
      if (!this.abLit) {
        this.abLightTimer += dt;
        if (this.abLightTimer > c.abLightDelay) {
          this.abLit = true;
          events.emit('afterburner', { on: true });
        }
      }
    } else {
      this.abLightTimer = 0;
      if (this.abLit) {
        this.abLit = false;
        events.emit('afterburner', { on: false });
      }
    }
    // AB intensity scales with how far the throttle is pushed into the AB range (fixed full here)
    this.abFraction = approach(this.abFraction, this.abLit ? 1 : 0, c.abStageRate * dt * (this.abLit ? 1 : 2.2));

    // --- thrust
    const combusting = this.state === 'RUN' || this.state === 'LIGHTOFF';
    const spoolFrac = saturate((this.n2 - c.n2Idle) / (1 - c.n2Idle));
    let dry = 0;
    if (combusting) {
      const idleScale = saturate((this.n2 - c.n2Start) / (c.n2Idle - c.n2Start));
      dry = lerp(c.thrustIdle * idleScale, c.thrustMil, Math.pow(spoolFrac, 1.75));
    }
    const sigma = inp.densityRatio;
    const lapse = Math.pow(sigma, 0.8);
    const M = inp.mach;
    const ramDry = 1 + 0.2 * M - 0.05 * M * M;
    const ramAB = 1 + 0.75 * M - 0.08 * M * M;
    // inlet temperature (T2) limiter in dense air at high Mach
    const t2Limit = 1 - 0.3 * smoothstep(0.85, 1.3, M) * Math.min(1, sigma * 1.4);
    const dryThrust = dry * lapse * ramDry * t2Limit;
    const abThrust = (c.thrustAB - c.thrustMil) * this.abFraction * lapse * ramAB * t2Limit;
    const healthScale = lerp(0.35, 1.0, this.health);
    // ram drag of a windmilling engine
    const windmillDrag = combusting ? 0 : -0.012 * inp.tas * inp.tas * sigma;
    this.thrust = Math.max(-4000, (dryThrust + abThrust) * healthScale + windmillDrag);
    // surge on damaged engine
    if (this.health < 0.5 && combusting && Math.random() < dt * (0.5 - this.health) * 0.8) this.surge = 1;
    this.surge = Math.max(0, this.surge - dt * 2.5);
    this.thrust *= 1 - this.surge * 0.6;

    // --- fuel flow
    if (combusting) {
      const dryFF = Math.max(c.idleFuelFlow, dryThrust * c.tsfcDry);
      const abFF = abThrust * c.tsfcAB;
      this.fuelFlow = dryFF + abFF;
    } else {
      this.fuelFlow = 0;
    }

    // --- EGT thermal model (C)
    let egtTarget = inp.ambientTempC;
    if (this.state === 'LIGHTOFF') egtTarget = c.egtStartPeak;
    else if (this.state === 'RUN') {
      egtTarget = lerp(c.egtIdle, c.egtMil, Math.pow(spoolFrac, 1.3)) + (c.egtAB - c.egtMil) * this.abFraction;
      egtTarget += (1 - this.health) * 140 + (inp.altitude / 1000) * 3;
    }
    if (this.onFire) egtTarget += 260;
    const egtRate = egtTarget > this.egt ? 0.55 : 0.18;
    this.egt = damp(this.egt, egtTarget, egtRate, dt);

    // nozzle schedule: open at idle (reduce idle thrust), close at MIL, open wide in AB
    let nozTarget = 0.55 - 0.45 * spoolFrac;
    if (!combusting) nozTarget = 0.35;
    nozTarget += 0.6 * this.abFraction;
    this.nozzle = damp(this.nozzle, clamp(nozTarget, 0, 1), 2.5, dt);

    this.oilPressure = damp(this.oilPressure, saturate(this.n2 / c.n2Idle) * (0.75 + 0.25 * spoolFrac), 3, dt);
    this.vibration = damp(this.vibration, combusting ? 0.25 + 0.5 * spoolFrac + 0.6 * this.abFraction + (1 - this.health) * 1.5 : this.n2 * 0.3, 4, dt);
  }

  /** Overtemp / fire handling is driven by DamageSystem; this lets it shut combustion. */
  kill(): void {
    this.setState('FAILED');
  }
}
