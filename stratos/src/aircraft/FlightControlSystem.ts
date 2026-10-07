// Fictional digital fly-by-wire control laws.
//  ASSIST: nonlinear dynamic inversion (NDI). The stick demands load factor /
//          pitch rate (with auto-trim and flight-path hold), AoA and G limiting,
//          roll rate, and automatic turn coordination. The FCS inverts the
//          on-board aerodynamic model to find the surface deflection that
//          produces the desired angular acceleration, which keeps handling
//          consistent from 120 kt to Mach 2.
//  DIRECT: stick = surface deflection (plus manual trim). Stalls, wing drop and
//          departures are possible.

import { AircraftConfig } from './AircraftConfig.ts';
import { clamp, damp, DEG, G0, lerp, smoothstep } from '../core/math.ts';

export type FcsMode = 'ASSIST' | 'DIRECT';

export interface FcsInputs {
  pitch: number; // pilot stick, + = pull (nose up)
  roll: number; // + = right
  yaw: number; // pedals, + = right
  alpha: number;
  beta: number;
  p: number; // roll rate (+ right wing down)
  q: number; // pitch rate (+ nose up)
  r: number; // yaw rate (+ nose right)
  nz: number; // body normal load factor (g)
  qbar: number; // dynamic pressure Pa
  tas: number;
  mach: number;
  bank: number; // rad
  pitchAngle: number; // rad
  flightPath: number; // rad
  alphaDot: number;
  gearDown: boolean;
  onGround: boolean;
  dt: number;
  /** on-board model: moments about CG excluding the control surface (N m, aero convention L/M/N) */
  mNoElev: number;
  lNoAil: number;
  nNoRud: number;
  /** control power per rad of deflection (N m / rad) */
  mPerElev: number;
  lPerAil: number;
  nPerRud: number;
  Ipitch: number;
  Iroll: number;
  Iyaw: number;
}

export interface FcsOutputs {
  elevator: number;
  aileron: number;
  rudder: number;
}

export class FlightControlSystem {
  mode: FcsMode = 'ASSIST';
  trim = 0; // DIRECT mode pitch trim (normalised)
  private pitchInt = 0;
  private rollInt = 0;
  private airborneBlend = 0;
  private qDesFilt = 0;
  private gammaRef = 0;
  private gammaHold = false;
  readonly out: FcsOutputs = { elevator: 0, aileron: 0, rudder: 0 };
  /** active limiter flags for HUD */
  aoaLimiting = false;
  gLimiting = false;
  /** commanded g for HUD/debug */
  nzCommand = 1;

  reset(airborne = false): void {
    this.pitchInt = 0;
    this.rollInt = 0;
    this.qDesFilt = 0;
    this.gammaHold = false;
    this.airborneBlend = airborne ? 1 : 0;
  }

  update(i: FcsInputs): FcsOutputs {
    const cfg = AircraftConfig.fcs;
    const sc = AircraftConfig.surfaces;
    const dt = i.dt;
    this.airborneBlend = damp(this.airborneBlend, i.onGround ? 0 : 1, i.onGround ? 2.5 : 1.2, dt);
    const ab = this.airborneBlend;
    const V = Math.max(i.tas, 25);

    if (this.mode === 'DIRECT') {
      const shaped = (x: number) => x * (0.45 + 0.55 * x * x);
      this.out.elevator = clamp(shaped(i.pitch) + this.trim, -1, 1);
      this.out.aileron = shaped(i.roll);
      this.out.rudder = clamp(i.yaw - 0.15 * i.r * ab, -1, 1);
      this.aoaLimiting = false;
      this.gLimiting = false;
      this.nzCommand = i.nz;
      this.pitchInt = 0;
      return this.out;
    }

    // ================= PITCH =================
    const gMax = i.gearDown ? cfg.gMaxGearDown : cfg.gMax;
    const aLim = i.gearDown ? cfg.alphaLimitGearDown : cfg.alphaLimit;
    const cosT = Math.cos(i.pitchAngle);
    const cosB = Math.cos(i.bank);
    // neutral stick keeps the flight path in gentle banks (auto-trim)
    const comp = smoothstep(40 * DEG, 28 * DEG, Math.abs(i.bank));
    const nzNeutral = cosT * lerp(1, 1 / Math.max(cosB, 0.5), comp);
    const s = i.pitch;
    let nzCmd = s >= 0 ? nzNeutral + s * (gMax - nzNeutral) : nzNeutral + -s * (cfg.gMin - nzNeutral);
    nzCmd = clamp(nzCmd, cfg.gMin, gMax);
    this.nzCommand = nzCmd;

    // load factor -> pitch rate demand (steady-turn kinematics) + Nz correction
    let qDes = (G0 * (nzCmd - cosT * cosB)) / V + 0.05 * (nzCmd - i.nz);
    // hands-off flight path hold (wings near level), re-captured whenever the stick moves
    const handsOff = Math.abs(s) < 0.04 && Math.abs(i.bank) < 35 * DEG && ab > 0.9;
    if (handsOff) {
      if (!this.gammaHold) {
        this.gammaHold = true;
        this.gammaRef = i.flightPath;
      }
      qDes += clamp((this.gammaRef - i.flightPath) * 0.8, -0.06, 0.06);
    } else {
      this.gammaHold = false;
    }
    const qMax = cfg.pitchRateMax * lerp(1.25, 1, smoothstep(60, 140, V));
    qDes = clamp(qDes, -qMax, qMax);
    // AoA limiter with alpha-rate anticipation
    const aPred = i.alpha + clamp(i.alphaDot, -1, 1) * 0.15;
    const qAoaCap = (aLim - aPred) * 3.0 + Math.max(0, (G0 * (cosT * cosB)) / V) * 0; // margin -> rate
    this.aoaLimiting = qDes > qAoaCap && i.alpha > aLim - 5 * DEG;
    if (qDes > qAoaCap) qDes = qAoaCap;
    const qNegCap = (-12 * DEG - aPred) * 3.0;
    if (qDes < qNegCap) qDes = qNegCap;
    // G limiter
    this.gLimiting = i.nz > gMax - 0.3 && s > 0.05;
    if (i.nz > gMax) qDes -= (i.nz - gMax) * 0.1;
    if (i.nz < cfg.gMin) qDes += (cfg.gMin - i.nz) * 0.1;
    this.qDesFilt = damp(this.qDesFilt, qDes, 12, dt);

    // NDI: desired pitch acceleration -> required elevator
    const qErr = this.qDesFilt - i.q;
    if (ab > 0.6) this.pitchInt = clamp(this.pitchInt + qErr * 2.0 * dt, -0.6, 0.6);
    else this.pitchInt = damp(this.pitchInt, 0, 4, dt);
    const qdotDes = 6.5 * qErr + this.pitchInt;
    const elevRad = (i.Ipitch * qdotDes - i.mNoElev) / Math.max(i.mPerElev, 1);
    const airElev = clamp(elevRad / sc.elevatorMax, -1, 1);
    // ground: direct stick with tail-strike protection (pitch attitude and rate)
    const tsp = clamp(1 - (i.pitchAngle - 10 * DEG) / (4 * DEG), 0, 1);
    let groundElev = s > 0 ? s * tsp - (1 - tsp) * 0.3 : s;
    groundElev -= 3.0 * Math.max(0, i.q - 6 * DEG);
    // derotation damper: after a main-gear touchdown the nose is lowered at a
    // controlled rate instead of slamming onto the nose gear (overridden by a
    // firm forward stick)
    if (s > -0.4) groundElev += 4.0 * Math.max(0, -5 * DEG - i.q);
    groundElev = clamp(groundElev, -1, 1);
    this.out.elevator = lerp(groundElev, airElev, ab);

    // ================= ROLL =================
    let pMax = (i.gearDown ? cfg.rollRateMaxGearDown : cfg.rollRateMax) * smoothstep(1500, 9000, i.qbar);
    pMax *= lerp(1, 0.35, smoothstep(14 * DEG, 26 * DEG, i.alpha));
    pMax = Math.max(pMax, 30 * DEG);
    const pDes = i.roll * pMax;
    const pErr = pDes - i.p;
    if (ab > 0.6) this.rollInt = clamp(this.rollInt + pErr * 1.5 * dt, -0.8, 0.8);
    else this.rollInt = 0;
    const pdotDes = 9 * pErr + this.rollInt;
    const ailRad = (i.Iroll * pdotDes - i.lNoAil) / Math.max(i.lPerAil, 1);
    const airAil = clamp(ailRad / sc.aileronMax, -1, 1);
    this.out.aileron = lerp(i.roll, airAil, ab);

    // ================= YAW =================
    const rCoord = (G0 * Math.sin(i.bank) * cosT) / V;
    const betaCmd = i.yaw * 8 * DEG * smoothstep(40, 120, V);
    const rDes = rCoord + 1.8 * (i.beta - betaCmd);
    const rdotDes = 4.5 * (rDes - i.r);
    const rudRad = (i.Iyaw * rdotDes - i.nNoRud) / Math.max(i.nPerRud, 1);
    const airRud = clamp(rudRad / sc.rudderMax, -1, 1);
    this.out.rudder = lerp(i.yaw, airRud, ab);
    return this.out;
  }
}
