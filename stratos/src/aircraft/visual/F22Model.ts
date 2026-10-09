// F-22A Raptor visual model, built in Blender by the user and converted by
// scripts/f22/export_glb.py: the procedural livery is baked into one albedo
// atlas, the moving parts sit under named nodes whose origin is their pivot
// (stabilators, 2D-vectoring nozzle flaps, canopy, gear legs / steering /
// oleo pistons / wheels, nose gear doors) and ANCHOR_* nodes mark the lights
// and nozzle exits. Same interface as the procedural FighterModel.

import {
  Box3, Group, Mesh, MeshStandardMaterial, Object3D, Vector3, type Material, type Texture,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createCanopyMaterial } from './CanopyMaterial.ts';
import type { AircraftVisualState } from './FighterModel.ts';
import { setAirframe } from './Airframe.ts';
import { worldMaterial } from '../../render/Materials.ts';
import { surfaceDetailHook, surfaceDetailKey, type SurfaceDetailOptions } from '../../render/SurfaceDetail.ts';
import { libTexture } from '../../assets/TextureLibrary.ts';
import { sunOcclusionHook } from '../../world/TerrainMaterial.ts';
import { DEG } from '../../core/math.ts';

/** glTF (Blender) frame -> body frame: body = (-g.z, g.y + DY, g.x + DZ) */
const DY = -2.0;
const DZ = -1.56;
/** oleo compression the model was posed with (gear at rest on the ground) */
const POSED_COMPRESSION = [0.126, 0.139, 0.139];

// axes in the glTF frame (the parent frame of every rigged node)
const RIGHT = new Vector3(0, 0, -1);
const UP = new Vector3(0, 1, 0);
const AFT = new Vector3(1, 0, 0);

let loaded: Group | null = null;

/** Loads the F-22 (never rejects; false keeps the procedural XF-41). */
export async function preloadF22(onProgress?: (frac: number) => void): Promise<boolean> {
  for (const file of ['models/f22.glb', 'models/f22.json']) {
    try {
      const gltf = await new GLTFLoader().loadAsync(new URL(file, document.baseURI).href, (e) => {
        if (e.total) onProgress?.(e.loaded / e.total);
      });
      loaded = gltf.scene;
      return true;
    } catch (err) {
      console.warn(`F-22: ${file} not available`, err);
    }
  }
  return false;
}

export function hasF22(): boolean {
  return loaded !== null;
}

interface Rig {
  node: Object3D;
  base: Vector3;
}

export class F22Model {
  readonly root = new Group();
  readonly lightAnchors: Record<string, Vector3> = {};
  /** meshes hidden when the camera is inside the cockpit */
  readonly exteriorOnly: Object3D[] = [];
  private rig = new Map<string, Rig>();
  private navMats: { mat: MeshStandardMaterial; side: 'L' | 'R' }[] = [];
  private doorSign: number[] = [];

  constructor(skyLut: Texture) {
    if (!loaded) throw new Error('F-22 model not loaded');
    const frame = new Group();
    frame.rotation.y = -Math.PI / 2;
    frame.position.set(0, DY, DZ);
    frame.add(loaded);
    this.root.add(frame);

    // scanned paint micro-surface at physical scale over the baked livery
    const detail: SurfaceDetailOptions = {
      normal: libTexture('paint-grain', 'normal'),
      normalTile: 0.32,
      normalStrength: 0.25,
      rough: libTexture('paint-grain', 'roughness'),
      roughTile: 0.45,
      roughLo: 0.9,
      roughHi: 1.12,
    };
    const shared = new Map<Material, Material>();
    loaded.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      if (mesh.name.startsWith('CANOPY_GLASS') || mesh.parent?.name === 'CANOPY_GLASS') {
        mesh.material = createCanopyMaterial(skyLut);
        mesh.renderOrder = 10;
        return;
      }
      const src = mesh.material as MeshStandardMaterial;
      let mat = shared.get(src);
      if (!mat) {
        if (/Navigation light/i.test(src.name)) {
          const m = src.clone();
          m.emissiveIntensity = 0;
          this.navMats.push({ mat: m, side: /-1/.test(src.name) ? 'L' : 'R' });
          mat = worldMaterial(m, { key: 'f22nav' });
        } else {
          if (src.map) src.map.anisotropy = 8;
          // painted classes: Blender's metallic 0.2-0.4 reads as bare metal under
          // PBR, keep a satin coating; the steel / titanium classes stay metallic
          if (src.metalness < 0.5) {
            src.metalness = Math.min(src.metalness, 0.12);
            src.roughness = Math.max(src.roughness, 0.5);
          }
          mat = worldMaterial(src, { key: 'f22paint' + surfaceDetailKey(detail), hooks: [sunOcclusionHook, surfaceDetailHook(detail)] });
        }
        shared.set(src, mat);
      }
      mesh.material = mat;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });

    for (const name of ['STAB_L', 'STAB_R', 'NOZ_L_UP', 'NOZ_L_DN', 'NOZ_R_UP', 'NOZ_R_DN', 'CANOPY', 'GEAR_N', 'STEER_N', 'PISTON_N', 'WHEEL_N',
      'GEAR_L', 'PISTON_L', 'WHEEL_L', 'GEAR_R', 'PISTON_R', 'WHEEL_R', 'DOOR_N0', 'DOOR_N1']) {
      const node = loaded.getObjectByName(name);
      if (node) this.rig.set(name, { node, base: node.position.clone() });
    }

    // anchors (body frame)
    this.root.updateMatrixWorld(true);
    const at = (name: string): Vector3 | null => {
      const n = loaded!.getObjectByName('ANCHOR_' + name);
      return n ? n.getWorldPosition(new Vector3()) : null;
    };
    for (const d of ['DOOR_N0', 'DOOR_N1']) {
      const r = this.rig.get(d);
      this.doorSign.push(r ? Math.sign(r.node.getWorldPosition(new Vector3()).x) || 1 : 1);
    }
    const navL = at('NAV_L') ?? new Vector3(-6.75, -0.2, 2.8);
    const navR = at('NAV_R') ?? new Vector3(6.75, -0.2, 2.8);
    this.lightAnchors.navL = navL;
    this.lightAnchors.navR = navR;
    this.lightAnchors.strobeL = navL.clone().add(new Vector3(0, 0, 0.25));
    this.lightAnchors.strobeR = navR.clone().add(new Vector3(0, 0, 0.25));
    this.lightAnchors.tail = at('TAIL') ?? new Vector3(0, 0.1, 7.0);
    this.lightAnchors.belly = (at('BELLY') ?? new Vector3(0, -1.1, -0.5)).add(new Vector3(0, -0.02, 0));
    this.lightAnchors.landing = (at('LANDING') ?? new Vector3(0, -1.0, -5.0));
    // formation strips on the forward fuselage sides and the fins
    this.lightAnchors.formationL = new Vector3(-0.88, 0.15, -7.3);
    this.lightAnchors.formationR = new Vector3(0.88, 0.15, -7.3);

    // effect layout: two flat 2D nozzles, long blended wing, chine vortices
    const nozzles = (['L', 'R'] as const).map((s) => {
      const b = new Box3();
      for (const f of ['UP', 'DN']) {
        const n = this.rig.get(`NOZ_${s}_${f}`)?.node;
        if (n) b.expandByObject(n);
      }
      const pos = at('NOZZLE_' + s) ?? new Vector3(s === 'L' ? -0.98 : 0.98, -0.2, 6.7);
      const size = b.isEmpty() ? new Vector3(1.4, 0.6, 0) : b.getSize(new Vector3());
      return { pos, width: size.x * 0.85, height: Math.max(0.35, size.y * 0.7) };
    });
    this.lightAnchors.nozzle = nozzles[0].pos.clone().add(nozzles[1].pos).multiplyScalar(0.5);
    setAirframe({
      nozzles,
      wing: { rootLE: [1.05, -0.03, -4.84], tipLE: [6.8, -0.23, 1.84], rootChord: 8.6, tipChord: 1.12, y: 0.1 },
      wingTip: new Vector3(6.8, -0.23, 2.96),
      lerx: [new Vector3(0.75, 0.05, -7.6), new Vector3(2.6, 0.55, 1.0)],
      vaporCone: { pos: new Vector3(0, 0.2, -3.8), scale: 1.25 },
      landingLight: this.lightAnchors.landing,
    });
  }

  private turn(name: string, axis: Vector3, angle: number): void {
    const r = this.rig.get(name);
    if (r) r.node.quaternion.setFromAxisAngle(axis, angle);
  }

  update(s: AircraftVisualState, time: number): void {
    // all-moving stabilators (+ = trailing edge up)
    this.turn('STAB_L', RIGHT, -s.stabL);
    this.turn('STAB_R', RIGHT, -s.stabR);
    // 2D thrust vectoring: flaps open with the nozzle area, both deflect for pitch
    const open = (s.nozzle - 0.4) * 0.3 + s.ab * 0.08;
    const vector = ((s.stabL + s.stabR) / 2) * 0.7;
    for (const side of ['L', 'R']) {
      this.turn(`NOZ_${side}_UP`, RIGHT, -open - vector);
      this.turn(`NOZ_${side}_DN`, RIGHT, open - vector);
    }
    // canopy hinges at its aft sill
    this.turn('CANOPY', RIGHT, s.canopy * 42 * DEG);
    // landing gear
    const legs: [string, string, string, number][] = [['GEAR_N', 'PISTON_N', 'WHEEL_N', 0], ['GEAR_L', 'PISTON_L', 'WHEEL_L', 1], ['GEAR_R', 'PISTON_R', 'WHEEL_R', 2]];
    for (const [legName, pistonName, wheelName, i] of legs) {
      const g = s.gear[i];
      const leg = this.rig.get(legName);
      if (!g || !leg) continue;
      const retract = 1 - g.ext;
      // the F-22 gear retracts forward into the fuselage
      if (g.broken) leg.node.quaternion.setFromAxisAngle(AFT, (i === 1 ? -1 : 1) * 0.9);
      else leg.node.quaternion.setFromAxisAngle(RIGHT, retract * 92 * DEG);
      leg.node.visible = g.ext > 0.01 || g.door > 0.01;
      const piston = this.rig.get(pistonName);
      if (piston) piston.node.position.copy(piston.base).addScaledVector(UP, g.compression - POSED_COMPRESSION[i]);
      this.turn(wheelName, RIGHT, -g.wheelAngle);
      if (i === 0) this.turn('STEER_N', UP, -g.steer);
    }
    // nose gear doors fold up flush with the belly as they close
    const nd = s.gear[0]?.door ?? 1;
    ['DOOR_N0', 'DOOR_N1'].forEach((d, k) => this.turn(d, AFT, -this.doorSign[k] * (1 - nd) * 88 * DEG));
    // position lights (red port, green starboard)
    for (const n of this.navMats) {
      n.mat.emissive.setRGB(n.side === 'L' ? 1 : 0.08, n.side === 'L' ? 0.1 : 1, n.side === 'L' ? 0.05 : 0.25);
      n.mat.emissiveIntensity = s.navLights ? 5 : 0;
    }
    void time;
  }

  setCockpitView(inside: boolean): void {
    for (const o of this.exteriorOnly) o.visible = !inside;
  }
}
