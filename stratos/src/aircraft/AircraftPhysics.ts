// The aircraft as a 6-DOF rigid body. Composes FlightModel, FCS, actuators,
// engine, fuel, electrical, landing gear and damage, integrates the equations
// of motion (Newton + Euler with gyroscopic coupling) at a fixed sub-step and
// publishes a telemetry snapshot for HUD / instruments / audio / effects.

import { Quaternion, Vector3, Euler } from 'three';
import { AircraftConfig } from './AircraftConfig.ts';
import { FlightModel } from './FlightModel.ts';
import { FlightControlSystem } from './FlightControlSystem.ts';
import { ControlSurfaces, type FlapSetting } from './ControlSurfaces.ts';
import { EngineSystem } from './EngineSystem.ts';
import { FuelSystem } from './FuelSystem.ts';
import { ElectricalSystem } from './ElectricalSystem.ts';
import { LandingGear } from './LandingGear.ts';
import { DamageSystem, type DamageComponent } from './DamageSystem.ts';
import { sampleAtmosphere, trueToCalibrated, type AtmosphereSample } from '../core/Atmosphere.ts';
import { clamp, damp, G0, lerp, RAD, wrap360 } from '../core/math.ts';
import { events } from '../core/EventBus.ts';
import type { GroundSample, PhysicsEnvironment } from './PhysicsTypes.ts';

export interface PilotControls {
  pitch: number; // -1..1 (+ pull)
  roll: number; // -1..1 (+ right)
  yaw: number; // -1..1 (+ right)
  throttle: number; // 0..1 (dry)
  afterburner: boolean;
  brakeLeft: number;
  brakeRight: number;
}

export interface Telemetry {
  altitude: number; // m MSL
  agl: number; // m above ground
  tas: number;
  ias: number;
  groundSpeed: number;
  mach: number;
  alpha: number; // rad
  beta: number;
  nz: number; // g
  nx: number;
  ny: number;
  maxG: number;
  minG: number;
  verticalSpeed: number; // m/s
  heading: number; // deg 0..360
  pitch: number; // rad
  bank: number; // rad
  track: number; // deg
  flightPathAngle: number; // rad
  turnRate: number; // deg/s
  qbar: number;
  lift: number;
  drag: number;
  thrust: number;
  weight: number;
  mass: number;
  onGround: boolean;
  stallWarning: boolean;
  overG: boolean;
  buffet: number;
  airDensity: number;
  oat: number; // C
}

const _q = new Quaternion();
const _qInv = new Quaternion();
const _vAirW = new Vector3();
const _vAirB = new Vector3();
const _wind = new Vector3();
const _omegaW = new Vector3();
const _F = new Vector3();
const _Fb = new Vector3();
const _Tb = new Vector3();
const _Fw = new Vector3();
const _tmp = new Vector3();
const _tmp2 = new Vector3();
const _Iw = new Vector3();
const _dq = new Quaternion();
const _turb = new Vector3();
const _euler = new Euler(0, 0, 0, 'YXZ');
const _gs: GroundSample = { height: 0, normal: new Vector3(0, 1, 0), surface: 'grass' };
const _fwd = new Vector3();

export class AircraftPhysics {
  readonly cfg = AircraftConfig;
  // rigid body state (world frame; omega in body frame)
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  readonly quaternion = new Quaternion();
  readonly omega = new Vector3();
  readonly acceleration = new Vector3();
  readonly specificForceBody = new Vector3();
  // previous state for render interpolation
  readonly prevPosition = new Vector3();
  readonly prevQuaternion = new Quaternion();

  readonly aero = new FlightModel();
  readonly fcs = new FlightControlSystem();
  readonly surfaces = new ControlSurfaces();
  readonly engine = new EngineSystem();
  readonly fuel = new FuelSystem(1);
  readonly electrical = new ElectricalSystem();
  readonly gear = new LandingGear(true);
  readonly damage: DamageSystem;

  readonly controls: PilotControls = { pitch: 0, roll: 0, yaw: 0, throttle: 0, afterburner: false, brakeLeft: 0, brakeRight: 0 };
  readonly atm: AtmosphereSample = sampleAtmosphere(0);
  readonly cg = new Vector3();
  readonly windVelocity = new Vector3();
  mass = 14800;
  time = 0;
  readonly t: Telemetry;
  /** body-frame debug vectors (N) */
  readonly debugThrust = new Vector3();
  readonly debugGravityBody = new Vector3();
  private vsFilt = 0;
  private wasOnGround = true;
  private airborneTimer = 0;
  private supersonic = false;
  scrapeIntensity = 0;
  /** inside-cloud density at aircraft (set by env) */
  cloud = 0;
  frozen = false;
  /** on-board model terms for the FCS (computed at the end of each step) */
  private ndi = { mNoElev: 0, lNoAil: 0, nNoRud: 0, mPerElev: 1, lPerAil: 1, nPerRud: 1, Ipitch: 78000, Iroll: 15500, Iyaw: 90000 };

  constructor() {
    this.damage = new DamageSystem(this.engine, this.fuel, this.surfaces, this.gear);
    this.t = {
      altitude: 0, agl: 0, tas: 0, ias: 0, groundSpeed: 0, mach: 0, alpha: 0, beta: 0, nz: 1, nx: 0, ny: 0,
      maxG: 1, minG: 1, verticalSpeed: 0, heading: 0, pitch: 0, bank: 0, track: 0, flightPathAngle: 0, turnRate: 0,
      qbar: 0, lift: 0, drag: 0, thrust: 0, weight: 0, mass: 0, onGround: true, stallWarning: false, overG: false,
      buffet: 0, airDensity: 1.225, oat: 15,
    };
  }

  /** Place the aircraft. heading in degrees (0 = north = -Z). */
  reset(pos: Vector3, headingDeg: number, speed: number, onGround: boolean, env: PhysicsEnvironment): void {
    this.position.copy(pos);
    _euler.set(0, -headingDeg * (Math.PI / 180), 0, 'YXZ');
    this.quaternion.setFromEuler(_euler);
    _fwd.set(0, 0, -1).applyQuaternion(this.quaternion);
    this.velocity.copy(_fwd).multiplyScalar(speed);
    this.gear.weightOnWheels = onGround;
    if (!onGround && speed > 30) {
      // start trimmed: pitch the nose up to the AoA where lift balances weight
      // (velocity stays level), so the FCS does not have to recover a sink
      const atm = sampleAtmosphere(pos.y);
      const mach = speed / atm.speedOfSound;
      const clNeed = (this.mass * G0) / (0.5 * atm.density * speed * speed * this.cfg.wingArea);
      let lo = 0, hi = 14 * (Math.PI / 180);
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (FlightModel.clOfAlpha(mid, mach).cl < clNeed) lo = mid;
        else hi = mid;
      }
      _euler.set(lo, -headingDeg * (Math.PI / 180), 0, 'YXZ');
      this.quaternion.setFromEuler(_euler);
    }
    this.omega.set(0, 0, 0);
    this.prevPosition.copy(this.position);
    this.prevQuaternion.copy(this.quaternion);
    this.fcs.reset(!onGround);
    this.t.maxG = 1;
    this.t.minG = 1;
    this.wasOnGround = onGround;
    if (onGround) {
      // settle on the gear: CG height so that struts are statically compressed
      env.sampleGround(pos.x, pos.z, _gs);
      this.position.y = _gs.height + 2.38;
      this.gear.handleDown = true;
      for (const l of this.gear.legs) {
        l.extension = 1;
        l.door = 1;
      }
    }
  }

  setFlaps(s: FlapSetting): void {
    if (this.surfaces.flapSetting !== s) {
      this.surfaces.flapSetting = s;
      events.emit('flaps:move', { target: s });
    }
  }

  private updateMass(): void {
    const cfgCg = this.cfg.emptyCG;
    const fuelMass = this.fuel.momentContribution(_tmp);
    const mEmpty = this.cfg.emptyMass + this.cfg.pilotMass;
    this.mass = mEmpty + fuelMass;
    this.cg.set(
      (cfgCg[0] * mEmpty + _tmp.x) / this.mass,
      (cfgCg[1] * mEmpty + _tmp.y) / this.mass,
      (cfgCg[2] * mEmpty + _tmp.z) / this.mass,
    );
  }

  step(dt: number, env: PhysicsEnvironment): void {
    if (this.frozen) return;
    this.time += dt;
    this.updateMass();
    const m = this.mass;
    const cfg = this.cfg;
    const inertiaScale = lerp(0.85, 1, clamp((m - 10000) / (cfg.inertiaRefMass - 10000), 0, 1.2));
    // wing fuel adds roll inertia
    const wingFuel = (this.fuel.tanks[2].quantity + this.fuel.tanks[3].quantity) / 2100;
    const Ix = cfg.inertiaPitch * inertiaScale;
    const Iy = cfg.inertiaYaw * inertiaScale;
    const Iz = cfg.inertiaRoll * inertiaScale * (0.88 + 0.12 * wingFuel);

    _q.copy(this.quaternion);
    _qInv.copy(_q).invert();
    const alt = this.position.y;
    sampleAtmosphere(alt, env.tempOffset, this.atm);
    env.sampleGround(this.position.x, this.position.z, _gs);
    const agl = alt - _gs.height;

    // ---- air-relative velocity
    env.sampleWind(this.position, _wind);
    this.windVelocity.copy(_wind);
    _vAirW.copy(this.velocity).sub(_wind);
    _vAirB.copy(_vAirW).applyQuaternion(_qInv);
    // rotational turbulence adds to the rates seen by the aerodynamics
    env.turbulenceRates(_turb);
    _tmp2.copy(this.omega).sub(_turb);

    // ---- FCS + actuators (use last aero state for feedback)
    const fm = this.aero;
    _euler.setFromQuaternion(_q, 'YXZ');
    const pitchAngle = _euler.x;
    const bank = -_euler.z;
    const onGround = this.gear.weightOnWheels;
    const fcsOut = this.fcs.update({
      pitch: this.controls.pitch, roll: this.controls.roll, yaw: this.controls.yaw,
      alpha: fm.alpha, beta: fm.beta,
      p: -this.omega.z, q: this.omega.x, r: -this.omega.y,
      nz: this.t.nz, qbar: fm.qbar, tas: fm.tas, mach: fm.mach,
      bank, pitchAngle, flightPath: this.t.flightPathAngle, alphaDot: fm.alphaDot, gearDown: this.gear.extension > 0.5, onGround, dt,
      ...this.ndi,
    });
    this.surfaces.update(dt, fcsOut.elevator, fcsOut.aileron, fcsOut.rudder, fm.alpha, fm.mach, this.engine.n2, fm.tas);
    const s = this.surfaces;

    // ---- aerodynamics
    fm.compute({
      vAirBody: _vAirB, omegaBody: _tmp2, atm: this.atm, heightAGL: Math.max(0, agl - 1.2),
      elevator: s.elevator.pos, aileron: s.aileron.pos, rudder: s.rudder.pos,
      flaps: s.flaps, lef: s.lef, airbrake: s.airbrake, gearExtension: this.gear.extension,
      wingHealthL: this.damage.health.leftWing, wingHealthR: this.damage.health.rightWing,
      tailHealth: this.damage.health.tail, dt,
    });

    // ---- engine, fuel, electrical
    this.engine.update(dt, {
      throttle: this.controls.throttle, afterburner: this.controls.afterburner,
      fuelAvailable: this.fuel.available, starterPower: this.electrical.starterAvailable,
      mach: fm.mach, densityRatio: this.atm.densityRatio, altitude: alt,
      ambientTempC: this.atm.temperature - 273.15, tas: fm.tas,
    });
    this.fuel.update(dt, this.engine.fuelFlow);
    this.electrical.update(dt, this.engine.n2, this.engine.running);

    // ---- assemble forces (body frame) and moments about CG
    _Fb.copy(fm.force);
    _Tb.copy(fm.moment);
    // aero force acts at reference point (origin): r = ref - cg
    _tmp.set(-this.cg.x, -this.cg.y, -this.cg.z).cross(fm.force);
    _Tb.add(_tmp);
    // thrust along body forward at the nozzle
    const T = this.engine.thrust;
    this.debugThrust.set(0, 0, -T);
    _Fb.add(this.debugThrust);
    const nm = this.engine.cfg.nozzleMount;
    _tmp.set(nm[0] - this.cg.x, nm[1] - this.cg.y, nm[2] - this.cg.z).cross(this.debugThrust);
    _Tb.add(_tmp);
    // gyroscopic coupling of the engine rotor (spins about the longitudinal axis)
    const H = this.engine.cfg.rotorInertia * this.engine.cfg.rotorRadPerSec * this.engine.n2;
    _tmp.set(0, 0, -H);
    _tmp.crossVectors(this.omega, _tmp).multiplyScalar(-1);
    _Tb.add(_tmp);
    // aerodynamic buffet as random forcing
    if (fm.buffet > 0.02) {
      const bq = fm.buffet * fm.qbar * 0.6;
      _Tb.x += (Math.random() - 0.5) * bq * 2.0;
      _Tb.z += (Math.random() - 0.5) * bq * 1.2;
      _Fb.y += (Math.random() - 0.5) * bq * 0.8;
    }

    // on-board model for next FCS step: moments about CG minus control contributions,
    // including the gyroscopic w x Iw term (aero convention L, M, N)
    {
      const w0 = this.omega;
      const gx = (Iz - Iy) * w0.y * w0.z; // (w x Iw).x
      const gy = (Ix - Iz) * w0.z * w0.x;
      const gz = (Iy - Ix) * w0.x * w0.y;
      const S = cfg.wingArea, b = cfg.wingSpan, c = cfg.meanChord, qb = fm.qbar;
      const mPerElev = qb * S * c * fm.cmDe;
      const lPerAil = qb * S * b * fm.clDa;
      const nPerRud = qb * S * b * fm.cnDr;
      this.ndi.mPerElev = mPerElev;
      this.ndi.lPerAil = lPerAil;
      this.ndi.nPerRud = nPerRud;
      this.ndi.mNoElev = (_Tb.x - gx) - mPerElev * s.elevator.pos;
      this.ndi.lNoAil = -(_Tb.z - gz) - lPerAil * s.aileron.pos;
      this.ndi.nNoRud = -(_Tb.y - gy) - nPerRud * s.rudder.pos;
      this.ndi.Ipitch = Ix;
      this.ndi.Iroll = Iz;
      this.ndi.Iyaw = Iy;
    }

    // world-frame non-gravitational force
    _Fw.copy(_Fb).applyQuaternion(_q);
    // ---- landing gear + airframe contacts (world forces, body torques)
    _omegaW.copy(this.omega).applyQuaternion(_q);
    const gs = Math.hypot(this.velocity.x, this.velocity.z);
    this.gear.brakeLeft = this.controls.brakeLeft;
    this.gear.brakeRight = this.controls.brakeRight;
    this.gear.updateSequence(dt, s.hydraulics, this.t.ias);
    const nearGround = agl < 22;
    this.gear.computeForces(env, this.position, _q, _qInv, this.velocity, _omegaW, this.cg, this.controls.yaw, gs, dt, _Fw, _Tb, nearGround);
    if (agl < 14) this.airframeContacts(env, dt, _Fw, _Tb);
    else this.scrapeIntensity = damp(this.scrapeIntensity, 0, 10, dt);

    // specific force (what accelerometers / the pilot feel)
    this.specificForceBody.copy(_Fw).applyQuaternion(_qInv).multiplyScalar(1 / m);

    // ---- translational integration (semi-implicit Euler)
    this.acceleration.copy(_Fw).multiplyScalar(1 / m);
    this.acceleration.y -= G0;
    this.velocity.addScaledVector(this.acceleration, dt);
    this.position.addScaledVector(this.velocity, dt);

    // ---- rotational integration: I w' = M - w x (I w)
    const w = this.omega;
    _Iw.set(Ix * w.x, Iy * w.y, Iz * w.z);
    _tmp.crossVectors(w, _Iw);
    w.x += ((_Tb.x - _tmp.x) / Ix) * dt;
    w.y += ((_Tb.y - _tmp.y) / Iy) * dt;
    w.z += ((_Tb.z - _tmp.z) / Iz) * dt;
    // numerical safety
    w.clampLength(0, 12);
    _dq.set(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 0);
    _dq.multiplyQuaternions(this.quaternion, _dq);
    this.quaternion.x += _dq.x;
    this.quaternion.y += _dq.y;
    this.quaternion.z += _dq.z;
    this.quaternion.w += _dq.w;
    this.quaternion.normalize();

    // ---- damage & telemetry
    this.updateTelemetry(dt, env, agl);
    this.damage.update(dt, this.t.nz, this.t.mach, this.engine.egt, this.t.ias);
    if (this.damage.destroyed) {
      // wreck: heavy damping so it comes to rest
      this.velocity.multiplyScalar(Math.exp(-dt * 1.2));
      this.omega.multiplyScalar(Math.exp(-dt * 2));
    }
  }

  private airframeContacts(env: PhysicsEnvironment, dt: number, forceW: Vector3, torqueB: Vector3): void {
    let scrape = 0;
    for (const c of this.cfg.contacts) {
      _tmp.set(c.pos[0], c.pos[1], c.pos[2]).applyQuaternion(_q).add(this.position);
      env.sampleGround(_tmp.x, _tmp.z, _gs);
      const pen = _gs.height - _tmp.y;
      if (pen <= 0) continue;
      const n = _gs.normal;
      // contact velocity
      const r = _tmp2.set(c.pos[0] - this.cg.x, c.pos[1] - this.cg.y, c.pos[2] - this.cg.z).applyQuaternion(_q);
      const vc = new Vector3().crossVectors(_omegaW, r).add(this.velocity);
      const vn = vc.dot(n);
      const vt = vc.clone().addScaledVector(n, -vn);
      const slide = vt.length();
      const water = _gs.surface === 'water';
      const k = water ? 4e5 : 2.5e6;
      let Fn = k * pen - (vn < 0 ? vn * (water ? 2e5 : 4e5) : 0);
      Fn = Math.max(0, Fn);
      const mu = water ? 0.9 : 0.45;
      const F = n.clone().multiplyScalar(Fn);
      if (slide > 0.01) F.addScaledVector(vt, (-mu * Fn) / Math.max(slide, 1));
      forceW.add(F);
      const t = new Vector3().crossVectors(r, F).applyQuaternion(_qInv);
      torqueB.add(t);
      scrape = Math.max(scrape, clamp(slide / 40, 0, 1));
      this.damage.impact(c.id, c.component as DamageComponent, Math.max(0, -vn), slide * (water ? 2 : 1));
      if (water && (slide > 60 || -vn > 8)) this.damage.destroy('water impact');
    }
    this.scrapeIntensity = damp(this.scrapeIntensity, scrape, 10, dt);
    if (scrape > 0.05) events.emit('scrape', { intensity: scrape });
  }

  private updateTelemetry(dt: number, env: PhysicsEnvironment, agl: number): void {
    const t = this.t;
    const fm = this.aero;
    t.altitude = this.position.y;
    t.agl = agl - 2.38 + (this.gear.extension < 0.5 ? 1.2 : 0);
    t.tas = fm.tas;
    t.ias = fm.tas > 1 ? trueToCalibrated(fm.tas, this.atm) : 0;
    t.mach = fm.mach;
    t.groundSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    t.alpha = fm.alpha;
    t.beta = fm.beta;
    const sf = this.specificForceBody;
    t.nz = damp(t.nz, sf.y / G0, 30, dt);
    t.nx = damp(t.nx, -sf.z / G0, 30, dt);
    t.ny = damp(t.ny, sf.x / G0, 30, dt);
    const onGround = this.gear.weightOnWheels;
    if (!onGround) {
      t.maxG = Math.max(t.maxG, t.nz);
      t.minG = Math.min(t.minG, t.nz);
    }
    this.vsFilt = damp(this.vsFilt, this.velocity.y, 6, dt);
    t.verticalSpeed = this.vsFilt;
    _euler.setFromQuaternion(this.quaternion, 'YXZ');
    t.pitch = _euler.x;
    t.bank = -_euler.z;
    t.heading = wrap360(-_euler.y * RAD);
    const prevTrack = t.track;
    t.track = t.groundSpeed > 2 ? wrap360(Math.atan2(this.velocity.x, -this.velocity.z) * RAD) : t.heading;
    let dTrack = t.track - prevTrack;
    if (dTrack > 180) dTrack -= 360;
    if (dTrack < -180) dTrack += 360;
    t.turnRate = damp(t.turnRate, dTrack / dt, 4, dt);
    const sp = this.velocity.length();
    t.flightPathAngle = sp > 1 ? Math.asin(clamp(this.velocity.y / sp, -1, 1)) : 0;
    t.qbar = fm.qbar;
    t.lift = fm.lift;
    t.drag = fm.drag;
    t.thrust = this.engine.thrust;
    t.mass = this.mass;
    t.weight = this.mass * G0;
    t.onGround = onGround;
    t.buffet = fm.buffet;
    t.airDensity = this.atm.density;
    t.oat = this.atm.temperature - 273.15;
    t.stallWarning = !onGround && fm.tas > 15 && (fm.alpha > 22 * (Math.PI / 180) || (t.ias < 62 && this.gear.extension < 0.5) || fm.stall > 0.05);
    t.overG = t.nz > 9.3 || t.nz < -3.3;
    this.debugGravityBody.set(0, -t.weight, 0).applyQuaternion(_qInv);

    // takeoff / landing / mach events
    if (onGround) {
      this.airborneTimer = 0;
    } else {
      this.airborneTimer += dt;
    }
    if (this.wasOnGround && !onGround && this.airborneTimer > 0.5 && t.ias > 50) {
      this.wasOnGround = false;
      events.emit('takeoff', { speed: t.ias });
    }
    if (!this.wasOnGround && onGround) {
      this.wasOnGround = true;
    }
    const sup = t.mach >= this.cfg.machCritical;
    if (sup !== this.supersonic && Math.abs(t.mach - 1) > 0.004) {
      this.supersonic = sup;
      events.emit('mach', { supersonic: sup });
      if (sup) events.emit('sonicboom', { position: [this.position.x, this.position.y, this.position.z] });
    }
    // cloud density for effects/turbulence
    this.cloud = env.cloudDensityAt(this.position);
  }

  /** Forward vector (world) */
  forward(out: Vector3): Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.quaternion);
  }
}
