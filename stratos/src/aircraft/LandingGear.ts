// Tricycle landing gear: per-leg ray/plane contact, progressive oleo-pneumatic
// spring-damper, tyre friction with slip-angle cornering, anti-skid brakes,
// nose-wheel steering, wheel spin-up (tyre smoke), retraction sequencing and
// structural damage on hard landings.

import { Quaternion, Vector3 } from 'three';
import { AircraftConfig, type GearLegConfig } from './AircraftConfig.ts';
import { approach, clamp, damp, DEG, lerp, smoothstep } from '../core/math.ts';
import { events } from '../core/EventBus.ts';
import { SurfaceFriction, type GroundSample, type PhysicsEnvironment, type SurfaceType } from './PhysicsTypes.ts';

export interface GearLeg {
  cfg: GearLegConfig;
  extension: number; // 0 up .. 1 down & locked
  door: number; // 0 closed .. 1 open
  compression: number;
  compressionVel: number;
  contact: boolean;
  normalForce: number;
  wheelAngle: number; // visual spin angle
  wheelSpeed: number; // rad/s
  steerAngle: number;
  skid: number; // 0..1 tyre slip intensity (smoke / chirp)
  health: number;
  broken: boolean;
  airTime: number;
  surface: SurfaceType;
  contactPoint: Vector3;
  /** for debug draw */
  force: Vector3;
}

const _mountW = new Vector3();
const _strutW = new Vector3();
const _axle = new Vector3();
const _fw = new Vector3();
const _lw = new Vector3();
const _vc = new Vector3();
const _r = new Vector3();
const _tmp = new Vector3();
const _F = new Vector3();
const _gs: GroundSample = { height: 0, normal: new Vector3(0, 1, 0), surface: 'grass' };
const _steerQ = new Quaternion();
const _up = new Vector3(0, 1, 0);

export class LandingGear {
  legs: GearLeg[];
  handleDown = true;
  brakeLeft = 0;
  brakeRight = 0;
  parkingBrake = true;
  nwsEnabled = true;
  steerInput = 0;
  /** set when the aircraft is supported by wheels */
  weightOnWheels = false;
  private wasAirborneTime = 0;
  /** accumulated scrape intensity this frame */
  overspeedTimer = 0;

  constructor(down = true) {
    this.legs = AircraftConfig.gear.map((cfg) => ({
      cfg,
      extension: down ? 1 : 0,
      door: down ? 1 : 0,
      compression: 0,
      compressionVel: 0,
      contact: false,
      normalForce: 0,
      wheelAngle: 0,
      wheelSpeed: 0,
      steerAngle: 0,
      skid: 0,
      health: 1,
      broken: false,
      airTime: 10,
      surface: 'runway' as SurfaceType,
      contactPoint: new Vector3(),
      force: new Vector3(),
    }));
    this.handleDown = down;
  }

  get extension(): number {
    let s = 0;
    for (const l of this.legs) s += l.extension;
    return s / this.legs.length;
  }

  get downAndLocked(): boolean {
    return this.legs.every((l) => l.extension >= 1 && !l.broken);
  }

  get inTransit(): boolean {
    return this.legs.some((l) => l.extension > 0 && l.extension < 1);
  }

  setHandle(down: boolean): boolean {
    if (!down && this.weightOnWheels) {
      events.emit('message', { text: 'GEAR HANDLE LOCKED — WEIGHT ON WHEELS', kind: 'warn', duration: 2.5 });
      return false;
    }
    if (this.handleDown !== down) {
      this.handleDown = down;
      events.emit('gear:transit', { down });
    }
    return true;
  }

  /** Animate retraction/extension. Hydraulics scale speed. */
  updateSequence(dt: number, hydraulics: number, ias: number): void {
    const T = AircraftConfig.gearTransitTime / Math.max(0.25, hydraulics);
    let allDone = true;
    for (let i = 0; i < this.legs.length; i++) {
      const l = this.legs[i];
      const stagger = i === 0 ? 0 : 0.06 * i;
      if (this.handleDown) {
        l.door = approach(l.door, 1, (dt / T) * 4);
        if (l.door > 0.6 + stagger) l.extension = approach(l.extension, 1, dt / (T * 0.75));
        if (l.extension < 1) allDone = false;
      } else {
        l.extension = approach(l.extension, 0, dt / (T * 0.75));
        if (l.extension < 0.05) l.door = approach(l.door, 0, (dt / T) * 4);
        if (l.door > 0) allDone = false;
      }
    }
    if (allDone && this.inTransitFlag) {
      this.inTransitFlag = false;
      events.emit('gear:locked', { down: this.handleDown });
    } else if (!allDone) this.inTransitFlag = true;
    // gear overspeed damage
    if (this.extension > 0.05 && ias > AircraftConfig.gearMaxSpeed) {
      this.overspeedTimer += dt * (ias - AircraftConfig.gearMaxSpeed) / 20;
      if (this.overspeedTimer > 2) {
        for (const l of this.legs) {
          l.health = Math.max(0, l.health - dt * 0.15);
          if (l.health <= 0 && !l.broken) this.breakLeg(l, 'overspeed');
        }
      }
    } else this.overspeedTimer = Math.max(0, this.overspeedTimer - dt);
  }
  private inTransitFlag = false;

  breakLeg(l: GearLeg, reason: string): void {
    if (l.broken) return;
    l.broken = true;
    l.health = 0;
    events.emit('damage', { component: `gear_${l.cfg.id}`, amount: 1, health: 0 });
    events.emit('message', { text: `${l.cfg.id.toUpperCase()} GEAR COLLAPSED (${reason})`, kind: 'warn', duration: 4 });
  }

  /**
   * Compute gear forces for one physics step. Forces/torques are accumulated in
   * world frame into `forceW` and body-frame torque into `torqueB` (about cg).
   */
  computeForces(
    env: PhysicsEnvironment,
    pos: Vector3,
    quat: Quaternion,
    qInv: Quaternion,
    vel: Vector3,
    omegaW: Vector3,
    cgBody: Vector3,
    rudderPedal: number,
    groundSpeed: number,
    dt: number,
    forceW: Vector3,
    torqueB: Vector3,
    nearGround = true,
  ): void {
    let anyMain = false;
    for (const l of this.legs) {
      l.force.set(0, 0, 0);
      l.skid = damp(l.skid, 0, 6, dt);
      const usable = l.extension >= 0.999 && !l.broken;
      const c = l.cfg;
      // steering
      if (c.steerable) {
        const maxA = AircraftConfig.nwsMaxAngle * lerp(1, 0.12, smoothstep(6, 40, groundSpeed));
        const target = this.nwsEnabled ? clamp(rudderPedal, -1, 1) * maxA : 0;
        l.steerAngle = approach(l.steerAngle, target, 60 * DEG * dt);
      }
      if (!usable || !nearGround) {
        l.contact = false;
        l.compression = damp(l.compression, 0, 8, dt);
        l.normalForce = 0;
        l.wheelSpeed = damp(l.wheelSpeed, 0, 0.6, dt);
        l.wheelAngle += l.wheelSpeed * dt;
        l.airTime += dt;
        continue;
      }
      _mountW.set(c.mount[0], c.mount[1], c.mount[2]).applyQuaternion(quat).add(pos);
      _strutW.set(0, -1, 0).applyQuaternion(quat);
      env.sampleGround(_mountW.x, _mountW.z, _gs);
      const n = _gs.normal;
      const surf = SurfaceFriction[_gs.surface];
      l.surface = _gs.surface;
      // micro bumps on rough surfaces
      const bump = surf.bumpiness * 0.035 * (Math.sin(_mountW.x * 1.7 + _mountW.z * 0.9) * Math.sin(_mountW.z * 2.3 - _mountW.x * 0.4));
      const groundH = _gs.height + bump;
      _axle.copy(_mountW).addScaledVector(_strutW, c.strutLength);
      // signed distance from free axle to ground plane
      const distAxle = n.x * (_axle.x - _mountW.x) + n.y * (_axle.y - groundH) + n.z * (_axle.z - _mountW.z);
      const penetration = c.wheelRadius - distAxle;
      const cosStrut = Math.max(0.35, -n.dot(_strutW));
      let comp = penetration / cosStrut;
      if (comp <= 0) {
        l.contact = false;
        l.compression = damp(l.compression, 0, 10, dt);
        l.normalForce = 0;
        l.airTime += dt;
        l.wheelSpeed = damp(l.wheelSpeed, 0, 0.25, dt);
        l.wheelAngle += l.wheelSpeed * dt;
        continue;
      }
      // contact point and its velocity
      l.contactPoint.copy(_axle).addScaledVector(_strutW, -comp).addScaledVector(n, -c.wheelRadius);
      _r.copy(l.contactPoint).sub(pos);
      _tmp.set(cgBody.x, cgBody.y, cgBody.z).applyQuaternion(quat);
      _r.sub(_tmp);
      _vc.crossVectors(omegaW, _r).add(vel);
      const vn = _vc.dot(n);
      const compVel = -vn / cosStrut;

      // touchdown event
      if (!l.contact && l.airTime > 0.6) {
        events.emit('touchdown', { wheel: c.id, verticalSpeed: -vn, groundSpeed });
        // tyre spin-up skid at touchdown
        const slip = Math.abs(groundSpeed - l.wheelSpeed * c.wheelRadius);
        l.skid = clamp(slip / 30, 0, 1);
      }
      l.contact = true;
      l.airTime = 0;

      // oleo: progressive spring + asymmetric damping, bottoming
      let bottom = 0;
      if (comp > c.travel) {
        bottom = comp - c.travel;
        comp = c.travel;
        if (compVel > 3.4) {
          const dmg = (compVel - 3.4) * 0.16;
          l.health -= dmg;
          events.emit('damage', { component: `gear_${c.id}`, amount: dmg, health: Math.max(0, l.health) });
          if (l.health <= 0) this.breakLeg(l, 'hard landing');
        }
      }
      const x = comp / c.travel;
      const spring = c.stiffness * comp * (1 + 1.8 * x * x * x);
      // metering pin: little damping over the first centimetres of stroke
      // (tyre compliance + oleo preload), full orifice damping deeper in
      const onset = 0.2 + 0.8 * smoothstep(0, 0.08, comp);
      const damper = compVel > 0 ? c.damping * compVel * onset : c.reboundDamping * compVel;
      let Fn = spring + damper + bottom * c.stiffness * 25 + Math.max(0, compVel) * bottom * 2e5;
      Fn = Math.max(0, Fn);
      // structural overload: damage grows with the load excess and its duration
      if (Fn > c.limitLoad) {
        const dmg = (Fn / c.limitLoad - 1) * 12 * dt;
        l.health -= dmg;
        events.emit('damage', { component: `gear_${c.id}`, amount: dmg, health: Math.max(0, l.health) });
        if (l.health <= 0) this.breakLeg(l, 'hard landing');
      }
      l.compression = comp;
      l.compressionVel = compVel;
      l.normalForce = Fn;
      if (c.id !== 'nose' && comp > 0.01) anyMain = true;

      // wheel axes on the ground plane
      _fw.set(0, 0, -1);
      if (c.steerable) {
        _steerQ.setFromAxisAngle(_up, -l.steerAngle);
        _fw.applyQuaternion(_steerQ);
      }
      _fw.applyQuaternion(quat);
      _fw.addScaledVector(n, -_fw.dot(n)).normalize();
      _lw.crossVectors(_fw, n).normalize();
      const vLong = _vc.dot(_fw);
      const vLat = _vc.dot(_lw);

      const wet = 1 - 0.38 * env.wetness;
      const brakeIn = c.brake ? clamp((c.id === 'left' ? this.brakeLeft : this.brakeRight) + (this.parkingBrake ? 1 : 0), 0, 1) : 0;
      const muRoll = AircraftConfig.rollingMu * surf.rolling;
      const muBrake = AircraftConfig.brakeMu * surf.brake * wet * brakeIn;
      const muLong = muRoll + muBrake;
      // smooth Coulomb friction (tanh) plus a static hold when parked
      let Flong = -Fn * muLong * Math.tanh(vLong / 0.25);
      if (brakeIn > 0.9 && Math.abs(vLong) < 0.3) Flong -= vLong * Fn * 1.5;
      const slipAngle = Math.atan2(vLat, Math.max(Math.abs(vLong), 2.5));
      const muLat = AircraftConfig.lateralMu * surf.lateral * wet;
      let Flat = -Fn * muLat * Math.tanh(slipAngle / 0.09);
      if (Math.abs(vLong) < 1.5) Flat -= vLat * Fn * 0.8; // low-speed lateral hold
      // friction circle
      const muMax = Math.max(muLat, muBrake + muRoll) * 1.05;
      const ft = Math.hypot(Flong, Flat);
      if (ft > muMax * Fn && ft > 0) {
        const s = (muMax * Fn) / ft;
        Flong *= s;
        Flat *= s;
        l.skid = Math.max(l.skid, clamp((ft / (muMax * Fn) - 1) * 2, 0, 1));
      }
      // skid when braking hard at speed (anti-skid cycling) or sideways sliding
      if (muBrake > 0.3 && Math.abs(vLong) > 15) l.skid = Math.max(l.skid, 0.25 * brakeIn);
      if (Math.abs(slipAngle) > 0.18 && Math.abs(vLong) > 8) l.skid = Math.max(l.skid, clamp(Math.abs(slipAngle), 0, 1));

      _F.copy(n).multiplyScalar(Fn).addScaledVector(_fw, Flong).addScaledVector(_lw, Flat);
      l.force.copy(_F);
      forceW.add(_F);
      // torque about cg in body frame
      _tmp.crossVectors(_r, _F).applyQuaternion(qInv);
      torqueB.add(_tmp);

      // wheel spin (rolling, spin-up with finite rate)
      const targetSpin = vLong / c.wheelRadius;
      const spinRate = brakeIn > 0.5 && Math.abs(vLong) > 3 ? 8 : 40;
      l.wheelSpeed = damp(l.wheelSpeed, targetSpin, spinRate, dt);
      l.wheelAngle += l.wheelSpeed * dt;
    }
    const wow = anyMain;
    if (!wow) this.wasAirborneTime += dt;
    else this.wasAirborneTime = 0;
    this.weightOnWheels = wow;
  }
}
