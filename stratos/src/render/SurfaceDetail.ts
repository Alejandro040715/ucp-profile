// Triplanar surface detail for lit materials: layers real tileable texture
// detail (normal, roughness, albedo grime) over a material in OBJECT space,
// so every mesh gets the same physical texel density regardless of its UV
// layout (fuselage loft, airfoil atlas, cockpit boxes alike). The detail
// normal is folded in with a whiteout blend and added on top of whatever the
// material's own normal map produced.

import type { Texture } from 'three';
import type { ShaderHook } from './Materials.ts';

export interface SurfaceDetailOptions {
  /** tileable tangent-space normal map (OpenGL convention) */
  normal?: Texture | null;
  /** metres covered by one tile of the normal map */
  normalTile?: number;
  normalStrength?: number;
  /** tileable grayscale map (R) modulating roughness: rough *= mix(1, lerp(lo, hi, value), amount) */
  rough?: Texture | null;
  roughTile?: number;
  roughLo?: number;
  roughHi?: number;
  roughAmount?: number;
  /** tileable colour/grime map multiplied into the albedo */
  albedo?: Texture | null;
  albedoTile?: number;
  albedoAmount?: number;
}

export function surfaceDetailHook(o: SurfaceDetailOptions): ShaderHook {
  const useN = !!o.normal, useR = !!o.rough, useA = !!o.albedo;
  return (shader) => {
    const u = shader.uniforms;
    if (useN) {
      u.uDetN = { value: o.normal };
      u.uDetNScale = { value: 1 / (o.normalTile ?? 0.5) };
      u.uDetNStrength = { value: o.normalStrength ?? 0.5 };
    }
    if (useR) {
      u.uDetR = { value: o.rough };
      u.uDetRScale = { value: 1 / (o.roughTile ?? 1) };
      u.uDetRRange = { value: [o.roughLo ?? 0.8, o.roughHi ?? 1.25] };
      u.uDetRAmount = { value: o.roughAmount ?? 1 };
    }
    if (useA) {
      u.uDetA = { value: o.albedo };
      u.uDetAScale = { value: 1 / (o.albedoTile ?? 1) };
      u.uDetAAmount = { value: o.albedoAmount ?? 0.5 };
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vDetPos;\nvarying vec3 vDetN;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvDetPos = position;\nvDetN = normal;`);
    const decl = `
varying vec3 vDetPos;
varying vec3 vDetN;
${useN ? 'uniform sampler2D uDetN; uniform float uDetNScale; uniform float uDetNStrength;' : ''}
${useR ? 'uniform sampler2D uDetR; uniform float uDetRScale; uniform vec2 uDetRRange; uniform float uDetRAmount;' : ''}
${useA ? 'uniform sampler2D uDetA; uniform float uDetAScale; uniform float uDetAAmount;' : ''}
vec3 detBlendW(vec3 n) {
  vec3 b = pow(abs(n), vec3(4.0));
  return b / max(b.x + b.y + b.z, 1e-5);
}
vec4 detTri(sampler2D t, vec3 p, vec3 w) {
  return texture2D(t, p.zy) * w.x + texture2D(t, p.xz) * w.y + texture2D(t, p.xy) * w.z;
}
`;
    let fs = shader.fragmentShader.replace('#include <common>', `#include <common>\n${decl}`);
    if (useA) {
      fs = fs.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec3 dw = detBlendW(normalize(vDetN));
          vec3 g = detTri(uDetA, vDetPos * uDetAScale, dw).rgb;
          diffuseColor.rgb *= mix(vec3(1.0), g, uDetAAmount);
        }`,
      );
    }
    if (useR) {
      fs = fs.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        {
          vec3 rw = detBlendW(normalize(vDetN));
          float rv = detTri(uDetR, vDetPos * uDetRScale, rw).r;
          roughnessFactor = clamp(roughnessFactor * mix(1.0, mix(uDetRRange.x, uDetRRange.y, rv), uDetRAmount), 0.04, 1.0);
        }`,
      );
    }
    if (useN) {
      fs = fs.replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          // whiteout-blended triplanar detail in object space, applied as a delta
          vec3 nO = normalize(vDetN);
          vec3 w = detBlendW(nO);
          vec3 p = vDetPos * uDetNScale;
          vec3 tx = texture2D(uDetN, p.zy).xyz * 2.0 - 1.0;
          vec3 ty = texture2D(uDetN, p.xz).xyz * 2.0 - 1.0;
          vec3 tz = texture2D(uDetN, p.xy).xyz * 2.0 - 1.0;
          tx.xy *= uDetNStrength; ty.xy *= uDetNStrength; tz.xy *= uDetNStrength;
          tx = vec3(tx.xy + nO.zy, abs(tx.z) * nO.x);
          ty = vec3(ty.xy + nO.xz, abs(ty.z) * nO.y);
          tz = vec3(tz.xy + nO.xy, abs(tz.z) * nO.z);
          vec3 nD = normalize(tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z);
          vec3 dV = normalMatrix * (nD - nO);
          #ifdef DOUBLE_SIDED
            dV *= faceDirection;
          #endif
          normal = normalize(normal + dV);
        }`,
      );
    }
    shader.fragmentShader = fs;
  };
}

/** cache-key fragment so materials with/without detail compile separately */
export function surfaceDetailKey(o: SurfaceDetailOptions): string {
  return `det${o.normal ? 'N' : ''}${o.rough ? 'R' : ''}${o.albedo ? 'A' : ''}`;
}
