// Pilot figure: flight suit, harness, life vest, helmet with gold visor and
// oxygen mask, gloves and boots. Arms and legs use analytic two-bone IK so the
// hands stay on the side-stick / throttle grips and the feet on the pedals.

import { CapsuleGeometry, Color, Group, Mesh, MeshStandardMaterial, Object3D, SphereGeometry, Vector3, BoxGeometry, CylinderGeometry, type Material } from 'three';
import { worldMaterial } from '../render/Materials.ts';

const UP = new Vector3(0, 1, 0);

function mat(color: number, rough: number, metal = 0): MeshStandardMaterial {
  return worldMaterial(new MeshStandardMaterial({ color, roughness: rough, metalness: metal }), { key: 'pilot' });
}

class Bone {
  readonly mesh: Mesh;
  constructor(radius: number, length: number, mat: Material, parent: Object3D) {
    // capsule body spans the bone; rounded caps overlap the neighbouring joints
    this.mesh = new Mesh(new CapsuleGeometry(radius, length, 4, 12), mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    parent.add(this.mesh);
  }
  set(a: Vector3, b: Vector3, _radius: number): void {
    const d = new Vector3().subVectors(b, a);
    this.mesh.position.copy(a).addScaledVector(d, 0.5);
    this.mesh.quaternion.setFromUnitVectors(UP, d.normalize());
  }
}

/** Two-bone IK: returns the elbow/knee position. */
export function solveTwoBone(root: Vector3, target: Vector3, l1: number, l2: number, pole: Vector3, out: Vector3): Vector3 {
  const d = new Vector3().subVectors(target, root);
  let dist = d.length();
  dist = Math.min(dist, l1 + l2 - 1e-4);
  dist = Math.max(dist, Math.abs(l1 - l2) + 1e-4);
  const dir = d.normalize();
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  // bend direction = pole projected perpendicular to dir
  const bend = pole.clone().sub(root);
  bend.addScaledVector(dir, -bend.dot(dir)).normalize();
  return out.copy(root).addScaledVector(dir, a).addScaledVector(bend, h);
}

export class Pilot {
  readonly root = new Group();
  readonly head = new Group();
  private suit = mat(0x4d5240, 0.88);
  private harness = mat(0x23262a, 0.7);
  private glove = mat(0x2e241d, 0.62);
  private boot = mat(0x141414, 0.55);
  private upperArmL: Bone;
  private lowerArmL: Bone;
  private upperArmR: Bone;
  private lowerArmR: Bone;
  private thighL: Bone;
  private shinL: Bone;
  private thighR: Bone;
  private shinR: Bone;
  private handL: Mesh;
  private handR: Mesh;
  private footL: Mesh;
  private footR: Mesh;
  readonly shoulderL = new Vector3(-0.19, 0.67, -3.99);
  readonly shoulderR = new Vector3(0.19, 0.67, -3.99);
  readonly hipL = new Vector3(-0.1, 0.28, -4.12);
  readonly hipR = new Vector3(0.1, 0.28, -4.12);
  private torso: Mesh;
  private vest: Mesh;

  constructor() {
    // torso + vest + harness
    this.torso = new Mesh(new CapsuleGeometry(0.17, 0.32, 6, 14), this.suit);
    this.torso.position.set(0, 0.47, -4.0);
    this.torso.rotation.x = -0.12;
    this.torso.scale.set(1.08, 1, 0.72);
    this.root.add(this.torso);
    this.vest = new Mesh(new CapsuleGeometry(0.16, 0.2, 6, 12), mat(0x5d5a3c, 0.85));
    this.vest.position.set(0, 0.55, -4.06);
    this.vest.scale.set(1.12, 1, 0.55);
    this.root.add(this.vest);
    for (const s of [-1, 1]) {
      const strap = new Mesh(new BoxGeometry(0.045, 0.5, 0.02), this.harness);
      strap.position.set(s * 0.08, 0.5, -4.13);
      strap.rotation.z = s * 0.12;
      strap.rotation.x = -0.12;
      this.root.add(strap);
      const buckle = new Mesh(new BoxGeometry(0.05, 0.04, 0.015), mat(0x9aa0a6, 0.3, 0.9));
      buckle.position.set(s * 0.07, 0.38, -4.15);
      this.root.add(buckle);
    }
    const lap = new Mesh(new BoxGeometry(0.34, 0.05, 0.02), this.harness);
    lap.position.set(0, 0.3, -4.16);
    this.root.add(lap);
    // pelvis / seat contact
    const pelvis = new Mesh(new CapsuleGeometry(0.14, 0.12, 4, 10), this.suit);
    pelvis.rotation.z = Math.PI / 2;
    pelvis.position.set(0, 0.27, -4.06);
    this.root.add(pelvis);
    // helmet head (hidden in first person)
    this.head.position.set(0, 0.92, -4.07);
    const helmet = new Mesh(new SphereGeometry(0.135, 24, 18), mat(0x6e7378, 0.38, 0.1));
    helmet.scale.set(0.95, 1.05, 1.12);
    this.head.add(helmet);
    const visor = new Mesh(new SphereGeometry(0.139, 24, 12, Math.PI * 0.18, Math.PI * 0.64, Math.PI * 0.3, Math.PI * 0.3), worldMaterial(new MeshStandardMaterial({ color: new Color(1.0, 0.72, 0.28), roughness: 0.06, metalness: 1.0 }), { key: 'visor' }));
    visor.rotation.y = Math.PI;
    visor.scale.set(0.97, 1.05, 1.14);
    this.head.add(visor);
    const mask = new Mesh(new CapsuleGeometry(0.045, 0.05, 4, 10), mat(0x161718, 0.5));
    mask.rotation.x = Math.PI / 2;
    mask.position.set(0, -0.07, -0.12);
    this.head.add(mask);
    const hose = new Mesh(new CylinderGeometry(0.017, 0.017, 0.38, 8), mat(0x2a2c2e, 0.6));
    hose.position.set(0.05, -0.25, -0.1);
    hose.rotation.z = 0.5;
    hose.rotation.x = 0.4;
    this.head.add(hose);
    this.root.add(this.head);
    // limbs
    this.upperArmL = new Bone(0.05, 0.28, this.suit, this.root);
    this.lowerArmL = new Bone(0.043, 0.27, this.suit, this.root);
    this.upperArmR = new Bone(0.05, 0.28, this.suit, this.root);
    this.lowerArmR = new Bone(0.043, 0.27, this.suit, this.root);
    this.thighL = new Bone(0.075, 0.42, this.suit, this.root);
    this.shinL = new Bone(0.058, 0.42, this.suit, this.root);
    this.thighR = new Bone(0.075, 0.42, this.suit, this.root);
    this.shinR = new Bone(0.058, 0.42, this.suit, this.root);
    const handGeo = new SphereGeometry(0.045, 12, 8);
    this.handL = new Mesh(handGeo, this.glove);
    this.handL.scale.set(0.85, 1.2, 1.05);
    this.handR = new Mesh(handGeo, this.glove);
    this.handR.scale.set(0.85, 1.2, 1.05);
    this.root.add(this.handL, this.handR);
    const footGeo = new BoxGeometry(0.1, 0.09, 0.27);
    this.footL = new Mesh(footGeo, this.boot);
    this.footR = new Mesh(footGeo, this.boot);
    this.root.add(this.footL, this.footR);
    this.root.traverse((o) => {
      if ((o as Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }

  private tmpE = new Vector3();

  /** Pose the limbs. Targets are body-frame positions. */
  pose(handL: Vector3, handR: Vector3, footL: Vector3, footR: Vector3, headYaw: number, headPitch: number): void {
    const e = this.tmpE;
    solveTwoBone(this.shoulderL, handL, 0.3, 0.29, new Vector3(-0.6, 0.1, -3.8), e);
    this.upperArmL.set(this.shoulderL, e, 0.05);
    this.lowerArmL.set(e, handL, 0.043);
    solveTwoBone(this.shoulderR, handR, 0.3, 0.29, new Vector3(0.6, 0.1, -3.8), e);
    this.upperArmR.set(this.shoulderR, e, 0.05);
    this.lowerArmR.set(e, handR, 0.043);
    this.handL.position.copy(handL);
    this.handR.position.copy(handR);
    solveTwoBone(this.hipL, footL, 0.46, 0.45, new Vector3(-0.2, 1.2, -4.8), e);
    this.thighL.set(this.hipL, e, 0.075);
    this.shinL.set(e, footL, 0.058);
    solveTwoBone(this.hipR, footR, 0.46, 0.45, new Vector3(0.2, 1.2, -4.8), e);
    this.thighR.set(this.hipR, e, 0.075);
    this.shinR.set(e, footR, 0.058);
    this.footL.position.copy(footL).add(new Vector3(0, -0.02, -0.08));
    this.footR.position.copy(footR).add(new Vector3(0, -0.02, -0.08));
    this.footL.rotation.x = this.footR.rotation.x = -0.35;
    this.head.rotation.set(headPitch * 0.8, headYaw * 0.9, 0, 'YXZ');
  }

  setFirstPerson(fp: boolean): void {
    this.head.visible = !fp;
  }
}
