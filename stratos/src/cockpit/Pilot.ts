// Pilot figure: flight suit, harness, life vest, helmet with gold visor and
// oxygen mask, gloves and boots. Arms and legs use analytic two-bone IK so the
// hands stay on the side-stick / throttle grips and the feet on the pedals.

import {
  CapsuleGeometry, Color, Group, Mesh, MeshStandardMaterial, Object3D, SphereGeometry, Vector3, BoxGeometry, CylinderGeometry, type Material,
  CanvasTexture, RepeatWrapping, SRGBColorSpace, Vector2, Quaternion, Matrix4,
} from 'three';
import { worldMaterial } from '../render/Materials.ts';
import { surfaceDetailHook, surfaceDetailKey, type SurfaceDetailOptions } from '../render/SurfaceDetail.ts';
import { libTexture } from '../assets/TextureLibrary.ts';

const UP = new Vector3(0, 1, 0);
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _m = new Matrix4();

function mat(color: number, rough: number, metal = 0): MeshStandardMaterial {
  return worldMaterial(new MeshStandardMaterial({ color, roughness: rough, metalness: metal }), { key: 'pilot' });
}

/** pilot gear material with a scanned CC0 fabric/leather/rubber surface */
function gear(color: number, rough: number, name: string, d: SurfaceDetailOptions, metal = 0): MeshStandardMaterial {
  return worldMaterial(new MeshStandardMaterial({ color, roughness: rough, metalness: metal }), { key: `pilot-${name}-` + surfaceDetailKey(d), hooks: [surfaceDetailHook(d)] });
}
const fabric = (slug: string, tile: number, albedoAmount = 0.4): SurfaceDetailOptions => ({
  normal: libTexture(slug, 'normal'),
  normalTile: tile,
  normalStrength: 0.9,
  rough: libTexture(slug, 'roughness'),
  roughTile: tile,
  roughLo: 0.92,
  roughHi: 1.06,
  albedo: libTexture(slug, 'albedo'),
  albedoTile: tile,
  albedoAmount,
});

/** Nomex twill: diagonal weave normal map + faint colour mottling (tiling). */
function twill(): { normal: CanvasTexture; color: CanvasTexture } {
  const N = 128;
  const h = new Float32Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const d = ((x + y) % 8) / 8; // 45 degree ribs every 8 px
      const weft = Math.sin(((x - y) / N) * Math.PI * 32) * 0.15;
      h[y * N + x] = Math.sin(d * Math.PI) + weft;
    }
  const mk = (fill: (img: ImageData) => void) => {
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d')!;
    const img = g.createImageData(N, N);
    fill(img);
    g.putImageData(img, 0, 0);
    const t = new CanvasTexture(c);
    t.wrapS = t.wrapT = RepeatWrapping;
    t.repeat.set(10, 6);
    return t;
  };
  const normal = mk((img) => {
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const dx = (h[y * N + ((x + 1) % N)] - h[y * N + ((x + N - 1) % N)]) * 0.6;
        const dy = (h[((y + 1) % N) * N + x] - h[((y + N - 1) % N) * N + x]) * 0.6;
        const l = Math.hypot(dx, dy, 1);
        const i = (y * N + x) * 4;
        img.data[i] = (-dx / l * 0.5 + 0.5) * 255;
        img.data[i + 1] = (dy / l * 0.5 + 0.5) * 255;
        img.data[i + 2] = (1 / l * 0.5 + 0.5) * 255;
        img.data[i + 3] = 255;
      }
  });
  let seed = 3;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const color = mk((img) => {
    for (let i = 0; i < N * N; i++) {
      const v = 235 + Math.floor(r() * 20);
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
  });
  color.colorSpace = SRGBColorSpace;
  return { normal, color };
}

/** checklist card for the kneeboard */
function kneeboardTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 384;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e9e4d6';
  g.fillRect(0, 0, 256, 384);
  g.fillStyle = '#1d1f22';
  g.font = '700 20px "Arial Narrow", Arial, sans-serif';
  g.fillText('XF-41  BEFORE TAKEOFF', 14, 32);
  g.fillRect(14, 40, 228, 2);
  g.font = '500 15px "Arial Narrow", Arial, sans-serif';
  const items = ['CANOPY .......... CLOSED/LOCKED', 'FLAPS ............ TO', 'TRIM ............. SET', 'FCS .............. ASSIST', 'FUEL ............. CHECK', 'WARNINGS ......... CLEAR', 'LIGHTS ........... AS REQ', 'PARK BRAKE ....... OFF'];
  items.forEach((t, i) => g.fillText(t, 14, 72 + i * 24));
  g.font = '700 18px "Arial Narrow", Arial, sans-serif';
  g.fillText('V-SPEEDS', 14, 290);
  g.font = '500 15px "Arial Narrow", Arial, sans-serif';
  g.fillText('ROTATE 150 KT   APPROACH 155 KT', 14, 314);
  g.fillText('TD AOA 11-13 DEG   MAX G 9.0', 14, 338);
  g.strokeStyle = 'rgba(30,60,140,0.6)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(150, 120);
  g.lineTo(236, 112);
  g.stroke();
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
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

/** hip point of the modelled posture (between the hip joints) */
const HIP0 = new Vector3(0, 0.28, -4.12);

export class Pilot {
  readonly root = new Group();
  readonly head = new Group();
  // sage-green Nomex coverall, khaki anti-G suit, olive webbing harness
  private realFabric = !!libTexture('twill', 'normal');
  private suit = this.realFabric ? gear(0x6a7056, 0.92, 'twill', fabric('twill', 0.05, 0.35)) : mat(0x5a5f4a, 0.92);
  private gsuit = libTexture('canvas', 'normal') ? gear(0x707052, 0.95, 'canvas', fabric('canvas', 0.06, 0.4)) : mat(0x66664a, 0.95);
  private harness = libTexture('webbing', 'normal') ? gear(0x34362c, 0.85, 'webbing', fabric('webbing', 0.04, 0.45)) : mat(0x23262a, 0.7);
  private glove = libTexture('leather', 'normal')
    ? gear(0x3f3a2e, 0.75, 'glove', { normal: libTexture('leather', 'normal'), normalTile: 0.06, normalStrength: 0.7, rough: libTexture('leather', 'roughness'), roughTile: 0.06, roughLo: 0.85, roughHi: 1.1 })
    : mat(0x55553f, 0.8);
  private kneeboard: Group;
  private boot = libTexture('leather', 'normal')
    ? gear(0x141414, 0.5, 'boot', { normal: libTexture('leather', 'normal'), normalTile: 0.1, normalStrength: 0.8, rough: libTexture('leather', 'roughness'), roughTile: 0.1, roughLo: 0.8, roughHi: 1.2 })
    : mat(0x141414, 0.55);
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
  /** upper body (torso, harness, head) pivots about the hip point to sit in different seats */
  private body = new Group();
  private inner = new Group();
  private bodyM = new Matrix4();

  constructor() {
    if (!this.realFabric) {
      // procedural fallback when the scanned fabric is unavailable
      const weave = twill();
      for (const m of [this.suit, this.glove]) {
        m.normalMap = weave.normal;
        m.normalScale = new Vector2(0.45, 0.45);
        m.map = weave.color;
      }
    }
    // kneeboard strapped to the right thigh
    this.kneeboard = new Group();
    const board = new Mesh(new BoxGeometry(0.135, 0.006, 0.2), [mat(0x1b1c1e, 0.6), mat(0x1b1c1e, 0.6), worldMaterial(new MeshStandardMaterial({ map: kneeboardTexture(), roughness: 0.85 }), { key: 'pilot' }), mat(0x1b1c1e, 0.6), mat(0x1b1c1e, 0.6), mat(0x1b1c1e, 0.6)]);
    this.kneeboard.add(board);
    for (const z of [-0.06, 0.07]) {
      const strap = new Mesh(new BoxGeometry(0.16, 0.012, 0.022), mat(0x2b2d2a, 0.8));
      strap.position.set(0, -0.004, z);
      this.kneeboard.add(strap);
    }
    this.root.add(this.kneeboard);
    // torso + vest + harness
    this.torso = new Mesh(new CapsuleGeometry(0.17, 0.32, 6, 14), this.suit);
    this.torso.position.set(0, 0.47, -4.0);
    this.torso.rotation.x = -0.12;
    this.torso.scale.set(1.08, 1, 0.72);
    this.inner.add(this.torso);
    this.vest = new Mesh(new CapsuleGeometry(0.16, 0.2, 6, 12), libTexture('canvas', 'normal') ? gear(0x5f5c40, 0.9, 'vest', fabric('canvas', 0.07, 0.45)) : mat(0x5d5a3c, 0.85));
    this.vest.position.set(0, 0.55, -4.06);
    this.vest.scale.set(1.12, 1, 0.55);
    this.inner.add(this.vest);
    for (const s of [-1, 1]) {
      const strap = new Mesh(new BoxGeometry(0.045, 0.5, 0.02), this.harness);
      strap.position.set(s * 0.08, 0.5, -4.13);
      strap.rotation.z = s * 0.12;
      strap.rotation.x = -0.12;
      this.inner.add(strap);
      const buckle = new Mesh(new BoxGeometry(0.05, 0.04, 0.015), mat(0x9aa0a6, 0.3, 0.9));
      buckle.position.set(s * 0.07, 0.38, -4.15);
      this.inner.add(buckle);
    }
    const lap = new Mesh(new BoxGeometry(0.34, 0.05, 0.02), this.harness);
    lap.position.set(0, 0.3, -4.16);
    this.inner.add(lap);
    // pelvis / seat contact
    const pelvis = new Mesh(new CapsuleGeometry(0.14, 0.12, 4, 10), this.suit);
    pelvis.rotation.z = Math.PI / 2;
    pelvis.position.set(0, 0.27, -4.06);
    this.inner.add(pelvis);
    // helmet head (hidden in first person)
    this.head.position.set(0, 0.92, -4.07);
    const helmet = new Mesh(new SphereGeometry(0.135, 24, 18), mat(0x6e7378, 0.38, 0.1));
    helmet.scale.set(0.95, 1.05, 1.12);
    this.head.add(helmet);
    const visor = new Mesh(new SphereGeometry(0.139, 24, 12, Math.PI * 0.18, Math.PI * 0.64, Math.PI * 0.3, Math.PI * 0.3), worldMaterial(new MeshStandardMaterial({ color: new Color(1.0, 0.72, 0.28), roughness: 0.06, metalness: 1.0 }), { key: 'visor' }));
    visor.rotation.y = Math.PI;
    visor.scale.set(0.97, 1.05, 1.14);
    this.head.add(visor);
    const rubberMask = libTexture('rubber', 'normal')
      ? gear(0x161718, 0.6, 'mask', { normal: libTexture('rubber', 'normal'), normalTile: 0.05, normalStrength: 0.8, rough: libTexture('rubber', 'roughness'), roughTile: 0.06, roughLo: 0.85, roughHi: 1.1 })
      : mat(0x161718, 0.5);
    const mask = new Mesh(new CapsuleGeometry(0.045, 0.05, 4, 10), rubberMask);
    mask.rotation.x = Math.PI / 2;
    mask.position.set(0, -0.07, -0.12);
    this.head.add(mask);
    const hose = new Mesh(new CylinderGeometry(0.017, 0.017, 0.38, 8), mat(0x2a2c2e, 0.6));
    hose.position.set(0.05, -0.25, -0.1);
    hose.rotation.z = 0.5;
    hose.rotation.x = 0.4;
    this.head.add(hose);
    this.inner.add(this.head);
    this.body.add(this.inner);
    this.root.add(this.body);
    this.seat(HIP0, 0);
    // limbs
    this.upperArmL = new Bone(0.05, 0.28, this.suit, this.root);
    this.lowerArmL = new Bone(0.043, 0.27, this.suit, this.root);
    this.upperArmR = new Bone(0.05, 0.28, this.suit, this.root);
    this.lowerArmR = new Bone(0.043, 0.27, this.suit, this.root);
    // legs wear the anti-G suit chaps (thigh + calf bladders)
    this.thighL = new Bone(0.075, 0.42, this.gsuit, this.root);
    this.shinL = new Bone(0.058, 0.42, this.gsuit, this.root);
    this.thighR = new Bone(0.075, 0.42, this.gsuit, this.root);
    this.shinR = new Bone(0.058, 0.42, this.gsuit, this.root);
    // G-suit details riding on the thigh bones (bone local +y = along the femur):
    // cargo pocket on the outer thigh, lacing zipper, waist bladder hose
    for (const [bone, side] of [[this.thighL, -1], [this.thighR, 1]] as const) {
      const pocket = new Mesh(new BoxGeometry(0.02, 0.15, 0.11), this.gsuit);
      pocket.position.set(side * 0.072, 0.02, 0);
      bone.mesh.add(pocket);
      const flap = new Mesh(new BoxGeometry(0.022, 0.03, 0.115), this.harness);
      flap.position.set(side * 0.073, 0.09, 0);
      bone.mesh.add(flap);
      // lacing zipper on the inner leg (bone local x = body x for these poses)
      const zip = new Mesh(new BoxGeometry(0.008, 0.36, 0.006), mat(0x2c2d27, 0.5, 0.4));
      zip.position.set(-side * 0.074, 0, 0);
      bone.mesh.add(zip);
    }
    for (const [bone, side] of [[this.shinL, -1], [this.shinR, 1]] as const) {
      const zip = new Mesh(new BoxGeometry(0.008, 0.34, 0.006), mat(0x2c2d27, 0.5, 0.4));
      zip.position.set(-side * 0.057, 0, 0);
      bone.mesh.add(zip);
    }
    // anti-G hose from the waist bladder to the seat connector
    const gHose = new Mesh(new CylinderGeometry(0.012, 0.012, 0.22, 8), mat(0x22231f, 0.75));
    gHose.position.set(-0.17, 0.27, -4.05);
    gHose.rotation.set(0.3, 0, 1.2);
    this.inner.add(gHose);
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
  private sL = new Vector3();
  private sR = new Vector3();
  private hL = new Vector3();
  private hR = new Vector3();

  /**
   * Seats the pilot: the hip point moves to `hip` and the upper body reclines
   * by `recline` radians (positive leans the back aft) about it.
   */
  seat(hip: Vector3, recline: number): void {
    this.body.position.copy(hip);
    this.body.rotation.set(recline, 0, 0);
    this.inner.position.copy(HIP0).negate();
    this.body.updateMatrix();
    this.inner.updateMatrix();
    this.bodyM.multiplyMatrices(this.body.matrix, this.inner.matrix);
  }

  /** Pose the limbs. Targets are body-frame positions. */
  pose(handL: Vector3, handR: Vector3, footL: Vector3, footR: Vector3, headYaw: number, headPitch: number): void {
    const e = this.tmpE;
    const sL = this.sL.copy(this.shoulderL).applyMatrix4(this.bodyM);
    const sR = this.sR.copy(this.shoulderR).applyMatrix4(this.bodyM);
    const hipL = this.hL.copy(this.hipL).applyMatrix4(this.bodyM);
    const hipR = this.hR.copy(this.hipR).applyMatrix4(this.bodyM);
    solveTwoBone(sL, handL, 0.3, 0.29, new Vector3(-0.6, 0.1, -3.8), e);
    this.upperArmL.set(sL, e, 0.05);
    this.lowerArmL.set(e, handL, 0.043);
    solveTwoBone(sR, handR, 0.3, 0.29, new Vector3(0.6, 0.1, -3.8), e);
    this.upperArmR.set(sR, e, 0.05);
    this.lowerArmR.set(e, handR, 0.043);
    this.handL.position.copy(handL);
    this.handR.position.copy(handR);
    solveTwoBone(hipL, footL, 0.46, 0.45, new Vector3(-0.45, 1.2, -4.8), e);
    this.thighL.set(hipL, e, 0.075);
    this.shinL.set(e, footL, 0.058);
    solveTwoBone(hipR, footR, 0.46, 0.45, new Vector3(0.45, 1.2, -4.8), e);
    this.thighR.set(hipR, e, 0.075);
    this.shinR.set(e, footR, 0.058);
    // kneeboard rides on top of the right thigh, long side along the femur
    {
      const along = _a.subVectors(e, hipR).normalize();
      const side = _b.crossVectors(along, UP).normalize();
      const top = _c.crossVectors(side, along).normalize();
      this.kneeboard.position.copy(hipR).lerp(e, 0.62).addScaledVector(top, 0.078);
      _m.makeBasis(side, top, _d.copy(along).negate());
      this.kneeboard.quaternion.setFromRotationMatrix(_m);
    }
    this.footL.position.copy(footL).add(new Vector3(0, -0.02, -0.08));
    this.footR.position.copy(footR).add(new Vector3(0, -0.02, -0.08));
    this.footL.rotation.x = this.footR.rotation.x = -0.35;
    this.head.rotation.set(headPitch * 0.8, headYaw * 0.9, 0, 'YXZ');
  }

  setFirstPerson(fp: boolean): void {
    this.head.visible = !fp;
  }
}
