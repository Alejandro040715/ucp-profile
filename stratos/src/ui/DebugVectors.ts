// F4 overlay: aerodynamic and gear force vectors drawn from the CG in world
// space (forward FX scene, no depth test so they read through the airframe).

import { ArrowHelper, Color, Group, MeshBasicMaterial, LineBasicMaterial, Quaternion, Vector3, type Scene } from 'three';
import type { AircraftPhysics } from '../aircraft/AircraftPhysics.ts';

const N_TO_M = 1 / 14000; // 14 kN per metre
const _o = new Vector3();
const _d = new Vector3();

interface Arrow {
  a: ArrowHelper;
  base: Color;
}

export class DebugVectors {
  readonly group = new Group();
  private arrows: Record<string, Arrow> = {};
  private gear: Arrow[] = [];
  visible = false;

  constructor(scene: Scene) {
    const mk = (hex: number): Arrow => {
      const a = new ArrowHelper(new Vector3(0, 1, 0), new Vector3(), 1, hex, 0.6, 0.3);
      for (const m of [a.line.material as LineBasicMaterial, a.cone.material as MeshBasicMaterial]) {
        m.depthTest = false;
        m.depthWrite = false;
        m.transparent = true;
        m.toneMapped = false;
      }
      a.renderOrder = 1000;
      a.frustumCulled = false;
      this.group.add(a);
      return { a, base: new Color(hex) };
    };
    this.arrows.lift = mk(0x4dff7a);
    this.arrows.drag = mk(0xff4a3d);
    this.arrows.thrust = mk(0xffa23a);
    this.arrows.weight = mk(0x4aa8ff);
    this.arrows.vel = mk(0xffffff);
    for (let i = 0; i < 3; i++) this.gear.push(mk(0xffe14a));
    this.group.visible = false;
    scene.add(this.group);
  }

  update(ac: AircraftPhysics, pos: Vector3, quat: Quaternion, exposure: number): void {
    this.group.visible = this.visible;
    if (!this.visible) return;
    const boost = 1.4 / Math.max(exposure, 0.05);
    _o.copy(ac.cg).applyQuaternion(quat).add(pos);
    const set = (arr: Arrow, origin: Vector3, dir: Vector3, len: number) => {
      const a = arr.a;
      a.visible = len > 0.05;
      if (!a.visible) return;
      a.position.copy(origin);
      a.setDirection(_d.copy(dir).normalize());
      a.setLength(len, Math.min(1.2, 0.25 + len * 0.12), Math.min(0.5, 0.12 + len * 0.05));
      (a.line.material as LineBasicMaterial).color.copy(arr.base).multiplyScalar(boost);
      (a.cone.material as MeshBasicMaterial).color.copy(arr.base).multiplyScalar(boost);
    };
    const body = (v: Vector3) => _d.copy(v).applyQuaternion(quat);
    set(this.arrows.lift, _o, body(ac.aero.liftVec).clone(), ac.aero.liftVec.length() * N_TO_M);
    set(this.arrows.drag, _o, body(ac.aero.dragVec).clone(), ac.aero.dragVec.length() * N_TO_M);
    set(this.arrows.thrust, _o, body(ac.debugThrust).clone(), ac.debugThrust.length() * N_TO_M);
    set(this.arrows.weight, _o, new Vector3(0, -1, 0), ac.t.weight * N_TO_M);
    const v = ac.velocity.length();
    set(this.arrows.vel, _o, ac.velocity.clone(), Math.min(40, v * 0.06));
    ac.gear.legs.forEach((l, i) => {
      const g = this.gear[i];
      if (!g) return;
      set(g, l.contactPoint, l.force.clone(), l.contact ? l.force.length() * N_TO_M : 0);
    });
  }
}
