// Camera system: cockpit (head physics, free look, zoom, subtle dynamic FOV,
// G-loaded head motion, vibration), chase / close chase (lagged frame,
// trajectory anticipation, speed-dependent distance, free orbit), cinematic
// flyby, wing and tail cameras, plus a free camera for photo mode.

import { Euler, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { clamp, damp, DEG, lerp, SmoothNoise, Spring } from '../core/math.ts';
import { events } from '../core/EventBus.ts';
import { AircraftConfig } from '../aircraft/AircraftConfig.ts';

export type CameraMode = 'COCKPIT' | 'CHASE' | 'CLOSE CHASE' | 'CINEMATIC' | 'WING' | 'TAIL' | 'FREE';
export const CAMERA_MODES: CameraMode[] = ['COCKPIT', 'CHASE', 'CLOSE CHASE', 'CINEMATIC', 'WING', 'TAIL'];

export interface CameraTarget {
  position: Vector3; // interpolated world position
  quaternion: Quaternion; // interpolated orientation
  velocity: Vector3;
  omega: Vector3; // body rates
  specificForce: Vector3; // body frame, m/s^2 (felt acceleration)
  tas: number;
  mach: number;
  vibration: number; // 0..1+ engine / buffet / turbulence intensity
  onGround: boolean;
}

const _v = new Vector3();
const _v2 = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _e = new Euler(0, 0, 0, 'YXZ');

export class CameraSystem {
  readonly camera: PerspectiveCamera;
  mode: CameraMode = 'COCKPIT';
  baseFov = 72;
  shakeScale = 1;
  // cockpit look
  lookYaw = 0;
  lookPitch = -0.06;
  private lookYawT = 0;
  private lookPitchT = -0.06;
  zoom = 1; // 1 = normal, <1 zoomed in
  private headX = new Spring();
  private headY = new Spring();
  private headZ = new Spring();
  private shakeN = [new SmoothNoise(1), new SmoothNoise(2), new SmoothNoise(3), new SmoothNoise(4)];
  private impulse = 0;
  // chase
  orbitYaw = 0;
  orbitPitch = 0;
  private orbitIdle = 0;
  chaseDistance = 24;
  private chaseQuat = new Quaternion();
  private chasePos = new Vector3();
  private chaseInit = false;
  // cinematic
  private cinePos = new Vector3();
  private cineTimer = 0;
  // free camera
  readonly freePos = new Vector3();
  freeYaw = 0;
  freePitch = 0;
  freeRoll = 0;
  fovOverride: number | null = null;
  groundHeight: (x: number, z: number) => number = () => 0;

  constructor(camera: PerspectiveCamera) {
    this.camera = camera;
    events.on('touchdown', (e) => (this.impulse = Math.max(this.impulse, clamp(e.verticalSpeed / 4, 0.15, 1.5))));
    events.on('scrape', (e) => (this.impulse = Math.max(this.impulse, e.intensity * 0.6)));
    events.on('afterburner', (e) => {
      if (e.on) this.impulse = Math.max(this.impulse, 0.12);
    });
    events.on('sonicboom', () => (this.impulse = Math.max(this.impulse, 0.25)));
  }

  setMode(m: CameraMode): void {
    if (this.mode === m) return;
    this.mode = m;
    this.chaseInit = false;
    this.cineTimer = 0;
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    events.emit('camera:mode', { mode: m });
  }

  next(dir = 1): void {
    const i = CAMERA_MODES.indexOf(this.mode as CameraMode);
    this.setMode(CAMERA_MODES[(i + dir + CAMERA_MODES.length) % CAMERA_MODES.length]);
  }

  get inCockpit(): boolean {
    return this.mode === 'COCKPIT';
  }

  /** mouse / stick look input (radians) */
  look(dYaw: number, dPitch: number): void {
    if (this.mode === 'COCKPIT') {
      this.lookYawT = clamp(this.lookYawT - dYaw, -2.7, 2.7);
      this.lookPitchT = clamp(this.lookPitchT - dPitch, -1.0, 1.45);
    } else if (this.mode === 'FREE') {
      this.freeYaw -= dYaw;
      this.freePitch = clamp(this.freePitch - dPitch, -1.5, 1.5);
    } else {
      this.orbitYaw -= dYaw * 1.4;
      this.orbitPitch = clamp(this.orbitPitch - dPitch * 1.4, -1.3, 1.3);
      this.orbitIdle = 0;
    }
  }

  centerView(): void {
    this.lookYawT = 0;
    this.lookPitchT = -0.06;
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.zoom = 1;
  }

  zoomStep(dir: number): void {
    if (this.mode === 'COCKPIT') this.zoom = clamp(this.zoom * (dir > 0 ? 1.15 : 1 / 1.15), 0.35, 1.35);
    else if (this.mode === 'CHASE' || this.mode === 'CLOSE CHASE') this.chaseDistance = clamp(this.chaseDistance * (dir > 0 ? 1.12 : 1 / 1.12), 9, 160);
    else this.zoom = clamp(this.zoom * (dir > 0 ? 1.15 : 1 / 1.15), 0.2, 1.6);
  }

  update(dt: number, t: CameraTarget): void {
    const cam = this.camera;
    let fov = this.baseFov;
    switch (this.mode) {
      case 'COCKPIT': fov = this.cockpit(dt, t); break;
      case 'CHASE': fov = this.chase(dt, t, this.chaseDistance, 0.9); break;
      case 'CLOSE CHASE': fov = this.chase(dt, t, Math.max(9, this.chaseDistance * 0.5), 2.2); break;
      case 'CINEMATIC': fov = this.cinematic(dt, t); break;
      case 'WING': fov = this.attached(t, new Vector3(5.9, 0.6, 3.2), new Vector3(0.0, 0.4, -6)); break;
      case 'TAIL': fov = this.attached(t, new Vector3(0, 3.6, 13), new Vector3(0, 1.0, -10)); break;
      case 'FREE': fov = this.free(); break;
    }
    if (this.fovOverride !== null) fov = this.fovOverride;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    // keep external cameras above the ground
    if (this.mode !== 'COCKPIT') {
      const gh = this.groundHeight(cam.position.x, cam.position.z) + 1.2;
      if (cam.position.y < gh) cam.position.y = gh;
    }
    cam.updateMatrixWorld();
    this.impulse = Math.max(0, this.impulse - dt * 3);
  }

  private shake(dt: number, amp: number, freq: number): Vector3 {
    const n = this.shakeN;
    return _v2.set(n[0].next(dt, freq), n[1].next(dt, freq * 1.13), n[2].next(dt, freq * 0.87)).multiplyScalar(amp);
  }

  private cockpit(dt: number, t: CameraTarget): number {
    const cam = this.camera;
    const eye = AircraftConfig.eyePoint;
    // smoothed look (head turn has inertia)
    this.lookYaw = damp(this.lookYaw, this.lookYawT, 14, dt);
    this.lookPitch = damp(this.lookPitch, this.lookPitchT, 14, dt);
    // head physics: neck as a spring driven by felt acceleration (body frame)
    const sf = t.specificForce;
    const gx = sf.x / 9.81, gy = sf.y / 9.81 - 1, gz = sf.z / 9.81;
    const s = this.shakeScale;
    const hx = this.headX.update(clamp(-gx * 0.018, -0.06, 0.06) * s, 16, 0.55, dt);
    const hy = this.headY.update(clamp(-gy * 0.011, -0.07, 0.03) * s, 14, 0.6, dt);
    const hz = this.headZ.update(clamp(gz * 0.012, -0.05, 0.05) * s, 16, 0.55, dt);
    // vibration: engine + buffet + turbulence + impulses (touchdown, AB light)
    const vib = (t.vibration * 0.0016 + this.impulse * 0.01) * s;
    const sh = this.shake(dt, vib, 18 + t.vibration * 6);
    // look-over-the-shoulder: head translates sideways and forward when turning far
    const shoulder = clamp(Math.abs(this.lookYaw) - 1.0, 0, 1.6);
    const lean = Math.sign(this.lookYaw) * shoulder * 0.09;
    _v.set(eye[0] + hx + sh.x - lean, eye[1] + hy + sh.y + shoulder * 0.02, eye[2] + hz + sh.z - shoulder * 0.05);
    _v.applyQuaternion(t.quaternion).add(t.position);
    cam.position.copy(_v);
    // head turns into the roll (instinctive look into the turn)
    const rollLead = clamp(-t.omega.z * 0.06, -0.12, 0.12);
    _e.set(this.lookPitch + sh.y * 2.5, this.lookYaw + rollLead * 0.3, rollLead * 0.15 + sh.x * 2.0, 'YXZ');
    _q.setFromEuler(_e);
    cam.quaternion.copy(t.quaternion).multiply(_q);
    // dynamic FOV: very subtle widening with speed and narrowing under G
    const gLoad = sf.y / 9.81;
    const dyn = clamp(t.tas / 400, 0, 1) * 3 - clamp(gLoad - 2, 0, 7) * 0.35;
    return clamp(this.baseFov * this.zoom + dyn, 18, 110);
  }

  private chase(dt: number, t: CameraTarget, distance: number, stiffness: number): number {
    const cam = this.camera;
    // frame follows the aircraft orientation with lag (rotation spring)
    if (!this.chaseInit) {
      this.chaseQuat.copy(t.quaternion);
      this.chasePos.copy(t.position);
      this.chaseInit = true;
    }
    const rate = stiffness * (1 + clamp(t.tas / 200, 0, 1.5));
    this.chaseQuat.slerp(t.quaternion, 1 - Math.exp(-rate * dt));
    // positional lag: the camera anchor trails the aircraft slightly
    this.chasePos.lerp(t.position, 1 - Math.exp(-14 * dt));
    // free orbit drifts back to centre after a pause
    this.orbitIdle += dt;
    if (this.orbitIdle > 2.5) {
      this.orbitYaw = damp(this.orbitYaw, 0, 1.2, dt);
      this.orbitPitch = damp(this.orbitPitch, 0, 1.2, dt);
    }
    const dist = distance * (1 + clamp(t.tas / 340, 0, 2) * 0.12);
    _e.set(-0.1 + this.orbitPitch, this.orbitYaw, 0, 'YXZ');
    _q.setFromEuler(_e);
    _v.set(0, 0, dist).applyQuaternion(_q).add(new Vector3(0, dist * 0.08 + 1.2, 0));
    _v.applyQuaternion(this.chaseQuat);
    cam.position.copy(this.chasePos).add(_v);
    // look slightly ahead along the trajectory (anticipation)
    const ahead = _v2.copy(t.velocity).multiplyScalar(0.06).clampLength(0, 18);
    const target = new Vector3().copy(t.position).add(ahead).add(new Vector3(0, 1.0, 0).applyQuaternion(this.chaseQuat));
    // camera roll follows the aircraft's frame (partially)
    const up = new Vector3(0, 1, 0).applyQuaternion(this.chaseQuat).lerp(new Vector3(0, 1, 0), 0.35).normalize();
    cam.up.copy(up);
    cam.lookAt(target);
    cam.up.set(0, 1, 0);
    // external vibration (much smaller)
    const sh = this.shake(dt, (t.vibration * 0.0008 + this.impulse * 0.004) * this.shakeScale, 9);
    cam.rotateX(sh.x);
    cam.rotateY(sh.y);
    return clamp(this.baseFov * 0.85 + clamp(t.tas / 340, 0, 2) * 4, 30, 100);
  }

  private cinematic(dt: number, t: CameraTarget): number {
    const cam = this.camera;
    this.cineTimer -= dt;
    const dist = this.cinePos.distanceTo(t.position);
    const toAc = _v.subVectors(t.position, this.cinePos);
    const behind = toAc.dot(t.velocity) > 0 && dist > 220;
    if (this.cineTimer <= 0 || behind || dist > 900) {
      // place the camera ahead of the flight path, offset to the side and slightly below/above
      const speed = Math.max(t.velocity.length(), 40);
      const lead = clamp(speed * 4.5, 160, 900);
      const fwd = t.velocity.lengthSq() > 4 ? t.velocity.clone().normalize() : new Vector3(0, 0, -1).applyQuaternion(t.quaternion);
      const side = new Vector3().crossVectors(fwd, new Vector3(0, 1, 0)).normalize();
      const s = Math.random() < 0.5 ? -1 : 1;
      this.cinePos.copy(t.position).addScaledVector(fwd, lead).addScaledVector(side, s * (25 + Math.random() * 45)).add(new Vector3(0, (Math.random() - 0.35) * 25, 0));
      const gh = this.groundHeight(this.cinePos.x, this.cinePos.z) + 3;
      if (this.cinePos.y < gh) this.cinePos.y = gh;
      this.cineTimer = 12;
    }
    cam.position.copy(this.cinePos);
    cam.up.set(0, 1, 0);
    cam.lookAt(t.position);
    // zoom to keep the aircraft a consistent size (long-lens look)
    const d = cam.position.distanceTo(t.position);
    return clamp((2 * Math.atan(28 / Math.max(d, 1)) * 180) / Math.PI * this.zoom * 1.6, 3, 75);
  }

  private attached(t: CameraTarget, offset: Vector3, lookAt: Vector3): number {
    const cam = this.camera;
    cam.position.copy(offset).applyQuaternion(t.quaternion).add(t.position);
    const target = lookAt.clone().applyQuaternion(t.quaternion).add(t.position);
    cam.up.copy(new Vector3(0, 1, 0).applyQuaternion(t.quaternion));
    cam.lookAt(target);
    cam.up.set(0, 1, 0);
    _q2.setFromEuler(new Euler(this.orbitPitch * 0.5, this.orbitYaw * 0.5, 0, 'YXZ'));
    cam.quaternion.multiply(_q2);
    return clamp(this.baseFov * this.zoom, 20, 100);
  }

  private free(): number {
    const cam = this.camera;
    cam.position.copy(this.freePos);
    cam.quaternion.setFromEuler(new Euler(this.freePitch, this.freeYaw, this.freeRoll, 'YXZ'));
    return clamp(this.baseFov * this.zoom, 5, 110);
  }

  moveFree(dt: number, fwd: number, right: number, up: number, fast: boolean): void {
    const sp = (fast ? 90 : 18) * dt;
    _v.set(right * sp, up * sp, -fwd * sp).applyEuler(new Euler(this.freePitch, this.freeYaw, 0, 'YXZ'));
    this.freePos.add(_v);
    const gh = this.groundHeight(this.freePos.x, this.freePos.z) + 0.5;
    if (this.freePos.y < gh) this.freePos.y = gh;
  }
}

export const _deg = DEG;
export const _lerp = lerp;
