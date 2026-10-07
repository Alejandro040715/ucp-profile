// Material factory. Every lit world material goes through here so it gets:
//  - cascaded shadow map support (CSM),
//  - earth curvature in the vertex stage,
//  - optional custom shader hooks (chained onBeforeCompile).
// This is the equivalent of a master material with instances.

import type { Material, WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three';
import type { CSM } from 'three/examples/jsm/csm/CSM.js';
import { CURVATURE_GLSL, globals } from './Globals.ts';

export type ShaderHook = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => void;

let csmInstance: CSM | null = null;
const pending: Material[] = [];

export function setCSM(csm: CSM | null): void {
  csmInstance = csm;
  if (csm) {
    for (const m of pending) {
      const hooks = (m.userData.hooks as ShaderHook[]) ?? [];
      installHooks(m, hooks, (m.userData.hookKey as string) ?? '', true);
    }
    pending.length = 0;
  }
}

export const curvatureHook: ShaderHook = (shader) => {
  shader.uniforms.uCurvOrigin = globals.uCurvOrigin;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${CURVATURE_GLSL}`)
    .replace(
      '#include <project_vertex>',
      /* glsl */ `
      vec4 mvPosition = vec4( transformed, 1.0 );
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
      #endif
      vec4 curvWorld = modelMatrix * mvPosition;
      curvWorld.xyz = applyCurvature( curvWorld.xyz );
      mvPosition = viewMatrix * curvWorld;
      gl_Position = projectionMatrix * mvPosition;
      `,
    );
};

type CompileFn = (shader: WebGLProgramParametersWithUniforms, r: WebGLRenderer) => void;

function installHooks(mat: Material, hooks: ShaderHook[], key: string, useCsm: boolean): void {
  let csmHook: CompileFn | null = null;
  if (useCsm && csmInstance) {
    csmInstance.setupMaterial(mat);
    csmHook = mat.onBeforeCompile as unknown as CompileFn;
  }
  mat.onBeforeCompile = (shader, renderer) => {
    if (csmHook) csmHook.call(mat, shader, renderer);
    for (const h of hooks) h(shader, renderer);
  };
  mat.customProgramCacheKey = () => key;
  mat.needsUpdate = true;
}

export interface WorldMaterialOptions {
  curvature?: boolean;
  shadows?: boolean;
  hooks?: ShaderHook[];
  key?: string;
}

/** Prepare a lit material for the world. Returns the same material. */
export function worldMaterial<T extends Material>(mat: T, opts: WorldMaterialOptions = {}): T {
  const hooks: ShaderHook[] = [];
  if (opts.curvature !== false) hooks.push(curvatureHook);
  if (opts.hooks) hooks.push(...opts.hooks);
  const key = `w${opts.curvature !== false ? 'c' : ''}${opts.shadows !== false ? 's' : ''}_${opts.key ?? ''}`;
  mat.userData.hooks = hooks;
  mat.userData.hookKey = key;
  const useCsm = opts.shadows !== false;
  if (useCsm && !csmInstance) pending.push(mat);
  installHooks(mat, hooks, key, useCsm);
  return mat;
}

/** Shared GLSL helpers */
export const GLSL_NOISE = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
`;
