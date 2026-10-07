// Real 3D cockpit: the FlightGear F-16 (Block 50) cockpit, converted from its
// AC3D + XML model tree to a single GLB by scripts/f16/convert.py.
// GPL-2.0-or-later — authors and licence in public/models/F16-COCKPIT-CREDITS.md.
//
// The GLB holds one "static" node (merged per material) and one "dyn:<key>"
// node per moving part. The scene extras carry, per moving part, the original
// FlightGear rotate / translate / textranslate animations (centre and axis
// already converted to our body frame) and an anchor table (bounding box +
// mean normal of every part we attach things to). This module plays those
// animations from the live simulation.

import {
  Color, Group, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Vector3, type Material, type Object3D, type Texture,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { worldMaterial, type ShaderHook } from '../render/Materials.ts';

export interface F16Anim {
  type: 'rotate' | 'translate' | 'textranslate';
  prop: string;
  factor: number;
  offset: number;
  min: number | null;
  max: number | null;
  interp?: [number, number][];
  axis?: [number, number, number];
  center?: [number, number, number];
  uv?: [number, number];
  step?: number | null;
  scroll?: number | null;
}

export interface F16Anchor {
  sub: string;
  name: string;
  min: [number, number, number];
  max: [number, number, number];
  n: [number, number, number];
}

interface DynPart {
  key: string;
  node: Group;
  anims: F16Anim[];
  mats: MeshStandardMaterial[];
  /** per-material base emissive (to restore after lighting a lamp) */
  baseEmissive: Color[];
  /** cloned colour maps that textranslate scrolls */
  maps: Texture[];
}

let loaded: Group | null = null;

/** panel / instrument backlighting level (0..1, set from the INST lights knob) */
export const f16PanelLight = { value: 0 };

// Edge-lit panels: the legends and gauge markings are the bright texels of
// the panel textures, so the backlight lights exactly those (NVIS white-green).
const backlightHook: ShaderHook = (shader) => {
  shader.uniforms.uPanelLight = f16PanelLight;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uPanelLight;')
    .replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      #ifdef USE_MAP
      {
        vec3 lt = texture2D( map, vMapUv ).rgb;
        float lum = dot( lt, vec3( 0.299, 0.587, 0.114 ) );
        totalEmissiveRadiance += lt * smoothstep( 0.32, 0.7, lum ) * uPanelLight * vec3( 0.85, 1.0, 0.8 );
      }
      #endif`,
    );
};
const BACKLIT = /panel|console|icp|instrument|faces|hsi|chrono|cdu|compass|altimeter|gauge|caution|misc|threat|eyebrow|fuel|engine/i;

function f16Material<T extends Material>(m: T): T {
  const lit = BACKLIT.test(m.name) && !!(m as unknown as MeshStandardMaterial).map;
  return worldMaterial(m, { key: (m.transparent ? 'f16t' : 'f16') + (lit ? 'lit' : ''), hooks: lit ? [backlightHook] : [] });
}

/** Loads the cockpit GLB (never rejects; returns false when unavailable). */
export async function preloadF16Cockpit(onProgress?: (frac: number) => void): Promise<boolean> {
  try {
    const gltf = await new GLTFLoader().loadAsync(new URL('models/f16-cockpit.glb', document.baseURI).href, (e) => {
      if (e.total) onProgress?.(e.loaded / e.total);
    });
    loaded = gltf.scene;
    return true;
  } catch (err) {
    console.warn('F-16 cockpit model not available, using the procedural cockpit', err);
    return false;
  }
}

export function hasF16Cockpit(): boolean {
  return loaded !== null;
}

const _m = new Matrix4();
const _t = new Matrix4();
const _q = new Quaternion();
const _v = new Vector3();

function interp(table: [number, number][], x: number): number {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    if (x <= x1) {
      const [x0, y0] = table[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0 || 1);
    }
  }
  return table[table.length - 1][1];
}

/** FlightGear animation value: interpolation table, or factor * prop + offset, clamped */
function animValue(a: F16Anim, p: number): number {
  let v = a.interp ? interp(a.interp, p) : p * a.factor + a.offset;
  if (a.min !== null) v = Math.max(a.min, v);
  if (a.max !== null) v = Math.min(a.max, v);
  return v;
}

export class F16Cockpit {
  readonly root: Group;
  readonly staticNode: Group;
  readonly parts = new Map<string, DynPart>();
  readonly anchors: Record<string, F16Anchor>;

  constructor() {
    if (!loaded) throw new Error('F-16 cockpit not loaded');
    this.root = loaded;
    const extras = (this.root.userData ?? {}) as { dyn?: Record<string, { anims: F16Anim[] }>; anchors?: Record<string, F16Anchor> };
    this.anchors = extras.anchors ?? {};
    this.staticNode = this.root.getObjectByName('static') as Group;
    const shared = new Map<Material, MeshStandardMaterial>();
    const prep = (m: MeshStandardMaterial): MeshStandardMaterial => {
      // AC3D materials carry no metalness; painted cockpit surfaces are
      // satin, so keep the shininess-derived roughness but never glossier
      // than 0.45 (the old specular model over-shines under PBR lighting)
      m.roughness = Math.max(m.roughness, 0.45);
      m.metalness = 0;
      if (m.map) m.map.anisotropy = 8;
      // AC3D "emis" was used for self-lit legends; baked into the textures
      // already, so it is driven by the panel lighting instead of always on
      m.userData.emissiveBase = m.emissive.clone();
      return f16Material(m);
    };
    this.root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const src = mesh.material as MeshStandardMaterial;
      let mat = shared.get(src);
      if (!mat) {
        mat = prep(src);
        shared.set(src, mat);
      }
      mesh.material = mat;
      mesh.castShadow = !mat.transparent;
      mesh.receiveShadow = true;
    });
    // moving parts: own transform, own (cloned) materials
    for (const child of [...this.root.children]) {
      if (!child.name.startsWith('dyn:')) continue;
      const key = child.name.slice(4);
      const part: DynPart = { key, node: child as Group, anims: extras.dyn?.[key]?.anims ?? [], mats: [], baseEmissive: [], maps: [] };
      const textrans = part.anims.some((a) => a.type === 'textranslate');
      child.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        const m = f16Material((mesh.material as MeshStandardMaterial).clone());
        if (textrans && m.map) {
          m.map = m.map.clone();
          m.map.needsUpdate = true;
          part.maps.push(m.map);
          if (m.emissiveMap) m.emissiveMap = m.map;
        }
        mesh.material = m;
        // small moving parts: receive only (keeps the shadow passes cheap)
        mesh.castShadow = key === 'stick' || key === 'throttle';
        mesh.userData.noShadow = !mesh.castShadow;
        part.mats.push(m);
        part.baseEmissive.push(m.emissive.clone());
      });
      child.matrixAutoUpdate = false;
      this.parts.set(key, part);
    }
  }

  anchor(name: string): F16Anchor | undefined {
    if (this.anchors[name]) return this.anchors[name];
    for (const k in this.anchors) if (k.endsWith('/' + name)) return this.anchors[k];
    return undefined;
  }

  /** world (cockpit-frame) centre of an anchor */
  static centre(a: F16Anchor, out = new Vector3()): Vector3 {
    return out.set((a.min[0] + a.max[0]) / 2, (a.min[1] + a.max[1]) / 2, (a.min[2] + a.max[2]) / 2);
  }

  /** Evaluates every moving part's FlightGear animation chain. */
  update(prop: (name: string, key: string) => number): void {
    for (const part of this.parts.values()) {
      if (!part.anims.length) continue;
      // first listed animation is the outermost transform (SimGear wraps
      // each new animation transform around the previous ones' children)
      const M = part.node.matrix.identity();
      let du = 0, dv = 0;
      for (const a of part.anims) {
        const p = prop(a.prop, part.key);
        if (a.type === 'textranslate') {
          let x = p;
          if (a.step) {
            const s = a.step;
            const q = Math.floor(x / s);
            const r = x - q * s;
            x = q * s;
            // drums roll over in the last `scroll` units of each step
            if (a.scroll && r > s - a.scroll) x += ((r - (s - a.scroll)) / a.scroll) * s;
          }
          const val = x * a.factor + a.offset;
          du += (a.uv?.[0] ?? 0) * val;
          dv += (a.uv?.[1] ?? 0) * val;
          continue;
        }
        const v = animValue(a, p);
        const ax = a.axis ?? [0, 0, 1];
        if (a.type === 'rotate') {
          const c = a.center ?? [0, 0, 0];
          _q.setFromAxisAngle(_v.set(ax[0], ax[1], ax[2]), (v * Math.PI) / 180);
          _m.makeTranslation(c[0], c[1], c[2]);
          _m.multiply(_t.makeRotationFromQuaternion(_q));
          _m.multiply(_t.makeTranslation(-c[0], -c[1], -c[2]));
        } else _m.makeTranslation(ax[0] * v, ax[1] * v, ax[2] * v);
        M.multiply(_m);
      }
      part.node.matrixWorldNeedsUpdate = true;
      // AC3D v runs up, glTF v down (the converter flipped v)
      for (const t of part.maps) t.offset.set(du, -dv);
    }
  }

  /** Lights a part (lamp lens, lit button) with an emissive colour; null restores it. */
  setLamp(key: string, color: Color | null, intensity = 1): void {
    const part = this.parts.get(key);
    if (!part) return;
    part.mats.forEach((m, i) => {
      if (color) m.emissive.copy(color).multiplyScalar(intensity);
      else m.emissive.copy(part.baseEmissive[i]);
    });
  }

  /** transform of a moving part (identity if it has none) */
  partMatrix(key: string): Matrix4 | null {
    return this.parts.get(key)?.node.matrix ?? null;
  }

  static objectsOf(node: Object3D): Mesh[] {
    const out: Mesh[] = [];
    node.traverse((o) => ((o as Mesh).isMesh ? out.push(o as Mesh) : 0));
    return out;
  }
}
