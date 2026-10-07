// Coefficient-based aerodynamic model (stability-derivative build-up).
// Computes lift, drag, side force and the three aerodynamic moments from the
// air-relative velocity, body rates, Mach number, dynamic pressure, surface
// deflections, configuration (flaps / gear / airbrake), ground effect and damage.
//
// Frames: three.js body frame (x right, y up, z aft). Internally the classic
// aero frame is used (X fwd, Y right, Z down) and converted back.

import { Vector3 } from 'three';
import { AircraftConfig } from './AircraftConfig.ts';
import { clamp, DEG, lerp, SmoothNoise, smoothstep, table } from '../core/math.ts';
import type { AtmosphereSample } from '../core/Atmosphere.ts';

export interface AeroInputs {
  vAirBody: Vector3; // air-relative velocity of the aircraft, body frame (m/s)
  omegaBody: Vector3; // body angular velocity (three frame)
  atm: AtmosphereSample;
  heightAGL: number;
  elevator: number; // rad, + nose up
  aileron: number; // rad, + roll right
  rudder: number; // rad, + nose right
  flaps: number; // rad
  lef: number; // rad
  airbrake: number; // rad
  gearExtension: number; // 0..1
  wingHealthL: number;
  wingHealthR: number;
  tailHealth: number;
  dt: number;
}

const _vhat = new Vector3();
const _lift = new Vector3();
const _side = new Vector3();
const _right = new Vector3(1, 0, 0);

export class FlightModel {
  readonly cfg = AircraftConfig;
  // outputs
  readonly force = new Vector3(); // body frame, N (aero only)
  readonly moment = new Vector3(); // body frame, N m about aero reference point
  readonly liftVec = new Vector3(); // body frame components for debug draw
  readonly dragVec = new Vector3();
  /** effective control derivatives (per rad) for the FCS model inversion */
  cmDe = 1;
  clDa = 0.08;
  cnDr = 0.06;
  alpha = 0;
  beta = 0;
  alphaDot = 0;
  mach = 0;
  qbar = 0;
  tas = 0;
  cl = 0;
  cd = 0;
  lift = 0;
  drag = 0;
  buffet = 0;
  stall = 0; // 0..1 how deep into stall
  private alphaPrev = 0;
  private stallNoise = new SmoothNoise(77);
  private stallNoise2 = new SmoothNoise(91);
  /** wingtip vortex / condensation drivers */
  liftCoefficientNorm = 0;

  /** Lift coefficient from AoA alone (no flaps), used by HUD stall cue too. */
  static clOfAlpha(alpha: number, mach: number, lefBonus = 0): { cl: number; stall: number } {
    const a = AircraftConfig.aero;
    const clA = table(a.clAlphaMach, a.clAlphaVal, mach);
    const sgn = alpha < 0 ? -1 : 1;
    let aa = Math.abs(alpha);
    // tail-first flight: reflect
    if (aa > Math.PI / 2) aa = Math.PI - aa;
    const negative = alpha < 0;
    const aLin = negative ? a.alphaLinear * 0.75 : a.alphaLinear;
    const aCrit = negative ? 19 * DEG : a.alphaCrit;
    const clMax = (negative ? 1.05 : a.clMax + lefBonus) * lerp(1, 0.78, smoothstep(0.7, 1.2, mach));
    let cl: number;
    let stall = 0;
    const clLinEnd = clA * aLin;
    if (aa <= aLin) cl = clA * aa;
    else if (aa <= aCrit) {
      const t = (aa - aLin) / (aCrit - aLin);
      cl = lerp(clLinEnd, Math.max(clMax, clLinEnd), Math.sin(t * Math.PI * 0.5));
    } else {
      stall = smoothstep(aCrit, aCrit + 10 * DEG, aa);
      const flat = a.clPostStall * Math.sin(2 * aa);
      cl = lerp(Math.max(clMax, clLinEnd), flat, stall);
    }
    // supersonic: lower usable lift, attached flow region shrinks
    return { cl: sgn * cl, stall };
  }

  compute(i: AeroInputs): void {
    const a = this.cfg.aero;
    const S = this.cfg.wingArea;
    const b = this.cfg.wingSpan;
    const c = this.cfg.meanChord;
    const v = i.vAirBody;
    const V = v.length();
    this.tas = V;
    this.mach = V / i.atm.speedOfSound;
    this.qbar = 0.5 * i.atm.density * V * V;
    this.force.set(0, 0, 0);
    this.moment.set(0, 0, 0);
    this.liftVec.set(0, 0, 0);
    this.dragVec.set(0, 0, 0);
    if (V < 0.5) {
      this.alpha = 0;
      this.beta = 0;
      this.lift = this.drag = 0;
      this.buffet = 0;
      return;
    }
    // aero-frame velocity components
    const u = -v.z;
    const vv = v.x;
    const w = -v.y;
    const alpha = Math.atan2(w, u);
    const beta = Math.asin(clamp(vv / V, -1, 1));
    this.alphaDot = lerp(this.alphaDot, (alpha - this.alphaPrev) / Math.max(i.dt, 1e-4), 0.2);
    this.alphaPrev = alpha;
    this.alpha = alpha;
    this.beta = beta;
    const M = this.mach;
    const qbar = this.qbar;

    // body rates in aero convention
    const p = -i.omegaBody.z;
    const q = i.omegaBody.x;
    const r = -i.omegaBody.y;
    const Vn = Math.max(V, 20);
    const pHat = (p * b) / (2 * Vn);
    const qHat = (q * c) / (2 * Vn);
    const rHat = (r * b) / (2 * Vn);
    const aDotHat = (clamp(this.alphaDot, -3, 3) * c) / (2 * Vn);

    const absA = Math.abs(alpha);
    const hL = i.wingHealthL;
    const hR = i.wingHealthR;
    const hT = i.tailHealth;
    const wingAvg = (hL + hR) * 0.5;

    // ---------------- lift ----------------
    const lefBonus = 0.12 * (i.lef / this.cfg.surfaces.lefMax);
    const base = FlightModel.clOfAlpha(alpha, M, lefBonus);
    this.stall = base.stall;
    const flapFrac = i.flaps / this.cfg.surfaces.flapLDG;
    const attached = 1 - base.stall;
    let cl = base.cl;
    cl += a.clFlapsLDG * flapFrac * attached * Math.cos(alpha);
    cl += a.clElevator * i.elevator * 0.3;
    cl *= lerp(0.35, 1, wingAvg);
    // ground effect (wing within one span of the ground)
    const hb = clamp(i.heightAGL / b, 0.05, 2);
    const geLift = 1 + 0.09 * Math.pow(Math.max(0, 1 - hb), 2);
    cl *= geLift;
    this.cl = cl;

    // ---------------- drag ----------------
    const cd0 = table(a.cd0Mach, a.cd0Val, M);
    const k = table(a.kMach, a.kVal, M);
    const geInduced = (16 * hb) * (16 * hb) / (1 + (16 * hb) * (16 * hb));
    const cdInduced = k * cl * cl * geInduced;
    const cdFlat = 1.3 * Math.sin(absA) * Math.sin(absA);
    let cd = cd0 + lerp(cdInduced, Math.max(cdInduced, cdFlat), smoothstep(a.alphaLinear, a.alphaCrit + 6 * DEG, absA));
    cd += a.cdGear * i.gearExtension;
    cd += lerp(0, a.cdFlapsTO, clamp(flapFrac / 0.57, 0, 1)) + Math.max(0, flapFrac - 0.57) / 0.43 * (a.cdFlapsLDG - a.cdFlapsTO);
    cd += a.cdAirbrake * (i.airbrake / this.cfg.surfaces.airbrakeMax);
    cd += 0.012 * Math.abs(beta) * 3 + 0.025 * (2 - hL - hR) + 0.015 * (1 - hT);
    cd += 0.02 * Math.abs(i.rudder / this.cfg.surfaces.rudderMax) * 0.4;
    this.cd = cd;

    // ---------------- side force ----------------
    const cy = a.cyBeta * beta + a.cyRudder * i.rudder * hT;

    const L = qbar * S * cl;
    const D = qbar * S * cd;
    const Y = qbar * S * cy;
    this.lift = L;
    this.drag = D;
    this.liftCoefficientNorm = cl / a.clMax;

    _vhat.copy(v).multiplyScalar(1 / V);
    _lift.crossVectors(_right, _vhat);
    if (_lift.lengthSq() < 1e-6) _lift.set(0, 1, 0);
    _lift.normalize();
    _side.crossVectors(_vhat, _lift).normalize();
    this.liftVec.copy(_lift).multiplyScalar(L);
    this.dragVec.copy(_vhat).multiplyScalar(-D);
    this.force.copy(this.liftVec).add(this.dragVec).addScaledVector(_side, Y);

    // ---------------- moments ----------------
    const superT = smoothstep(0.85, 1.2, M);
    const cmAlphaEff = a.cmAlpha * lerp(1, a.cmAlphaSuperFactor, superT) * lerp(0.35, 1, hT);
    const aEff = clamp(alpha, -30 * DEG, 30 * DEG);
    let cm = a.cm0 + cmAlphaEff * aEff;
    // strong nose-down restoring moment beyond 30 deg AoA (deep stall protection)
    cm -= 0.45 * Math.max(0, Math.sin(absA) - Math.sin(30 * DEG)) * Math.sign(alpha);
    cm += a.cmQ * qHat * lerp(0.5, 1, hT) + a.cmAlphaDot * aDotHat;
    const elevEff = lerp(1, 0.62, smoothstep(0.95, 1.4, M)) * hT * lerp(1, 0.55, smoothstep(30 * DEG, 50 * DEG, absA));
    cm += a.cmElevator * i.elevator * elevEff;
    this.cmDe = a.cmElevator * elevEff;
    cm += a.cmFlapsLDG * flapFrac + a.cmAirbrake * (i.airbrake / this.cfg.surfaces.airbrakeMax) + a.cmGear * i.gearExtension;
    // ground effect nose-down tendency
    cm -= 0.02 * Math.max(0, 1 - hb) * Math.max(0, 1 - hb);

    // lateral-directional, AoA dependent
    const clBeta = a.clBeta * (1 + 1.5 * Math.sin(clamp(alpha, 0, 0.6)));
    const clp = a.clP * (1 - 0.75 * base.stall) * lerp(0.6, 1, wingAvg);
    const ailEff = lerp(1, 0.5, smoothstep(20 * DEG, 35 * DEG, absA)) * lerp(1, 0.7, smoothstep(0.9, 1.6, M)) * lerp(0.2, 1, wingAvg);
    this.clDa = a.clAileron * ailEff;
    let cRoll = clBeta * beta + clp * pHat + a.clR * rHat + a.clAileron * i.aileron * ailEff + a.clRudder * i.rudder * hT;
    // asymmetric wing damage and random wing drop in the stall
    cRoll += 0.12 * cl * (hL - hR);
    const stallDrop = this.stallNoise.next(i.dt, 0.6) * base.stall;
    cRoll += 0.045 * stallDrop;

    const cnBetaEff = a.cnBeta * (1 - 1.6 * smoothstep(18 * DEG, 34 * DEG, absA)) * (1 - 0.35 * smoothstep(1.2, 2.0, M)) * lerp(0.15, 1, hT);
    const rudEff = (1 - 0.6 * smoothstep(25 * DEG, 40 * DEG, absA)) * hT;
    this.cnDr = a.cnRudder * rudEff;
    let cn = cnBetaEff * beta + a.cnR * rHat * lerp(0.3, 1, hT) + a.cnP * pHat + a.cnRudder * i.rudder * rudEff + a.cnAileron * i.aileron;
    cn += 0.012 * this.stallNoise2.next(i.dt, 0.5) * base.stall;
    cn += 0.01 * (hR - hL) * cd;

    const Lm = qbar * S * b * cRoll;
    const Mm = qbar * S * c * cm;
    const Nm = qbar * S * b * cn;
    // aero (L,M,N) -> three body moments
    this.moment.set(Mm, -Nm, -Lm);

    // ---------------- buffet ----------------
    const aoaBuffet = smoothstep(13 * DEG, 25 * DEG, absA) * clamp(qbar / 9000, 0, 1.4);
    const transonic = smoothstep(0.88, 0.96, M) * (1 - smoothstep(1.02, 1.12, M)) * smoothstep(4 * DEG, 10 * DEG, absA);
    this.buffet = clamp(aoaBuffet + 0.6 * transonic + 0.8 * base.stall, 0, 1.5);
  }
}
