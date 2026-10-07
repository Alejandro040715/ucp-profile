// Procedural PBR materials for structures (no texture assets): weathered
// concrete, corrugated metal siding, building facades with lit windows,
// tinted glass. All are MeshStandardMaterial "instances" with shader hooks.

import { Color, MeshStandardMaterial, type MeshStandardMaterialParameters } from 'three';
import { globals } from './Globals.ts';
import { GLSL_NOISE, worldMaterial, type ShaderHook } from './Materials.ts';
import { sunOcclusionHook } from '../world/TerrainMaterial.ts';

const detailVarying: ShaderHook = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vObjN;\nvarying vec3 vWPos;\nvarying vec4 vInst;\n#ifdef USE_INSTANCING\nattribute vec4 instParams;\n#endif')
    .replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
       vObjPos = transformed; vObjN = objectNormal;
       #ifdef USE_INSTANCING
         vWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
         vInst = instParams;
         vObjPos = (instanceMatrix * vec4(transformed, 1.0)).xyz - instanceMatrix[3].xyz;
         vObjN = mat3(instanceMatrix) * objectNormal;
       #else
         vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
         vInst = vec4(0.5);
       #endif`,
    );
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <common>',
    `#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vObjN;\nvarying vec3 vWPos;\nvarying vec4 vInst;\nuniform sampler2D uNoiseTex;\nuniform float uWetness;\nuniform float uLightsOn;\nuniform float uTime;\n${GLSL_NOISE}\nfloat pRough; float pBump; vec3 pEmit;`,
  );
  shader.uniforms.uNoiseTex = globals.uNoiseTex;
  shader.uniforms.uWetness = globals.uWetness;
  shader.uniforms.uLightsOn = globals.uLightsOn;
  shader.uniforms.uTime = globals.uTime;
  shader.fragmentShader = shader.fragmentShader.replace('void main() {', 'void main() {\n pRough = roughness; pBump = 0.0; pEmit = vec3(0.0);');
};

const bumpApply = /* glsl */ `
{
  vec2 dHdxy = vec2(dFdx(pBump), dFdy(pBump));
  vec3 vSigmaX = dFdx(-vViewPosition);
  vec3 vSigmaY = dFdy(-vViewPosition);
  vec3 R1 = cross(vSigmaY, normal);
  vec3 R2 = cross(normal, vSigmaX);
  float fDet = dot(vSigmaX, R1);
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  if (abs(fDet) > 1e-9) normal = normalize(abs(fDet) * normal - vGrad);
}
`;

function surfaceHook(albedoCode: string): ShaderHook {
  return (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>', `#include <map_fragment>\n{\n${albedoCode}\n}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = pRough;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${bumpApply}`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += pEmit;');
  };
}

/** Weathered concrete (shelters, tower, blast walls). */
export function concreteMaterial(color = new Color(0.42, 0.41, 0.38), params: MeshStandardMaterialParameters = {}): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color, roughness: 0.92, metalness: 0, ...params });
  return worldMaterial(m, {
    key: 'concrete',
    hooks: [
      detailVarying,
      surfaceHook(/* glsl */ `
        vec3 p = vWPos;
        float n1 = texture2D(uNoiseTex, p.xz / 23.0 + p.y / 31.0).r;
        float n2 = texture2D(uNoiseTex, (p.xy + p.zy) / 4.0).a;
        // vertical rain streaks
        float streak = texture2D(uNoiseTex, vec2(p.x * 0.35 + p.z * 0.35, p.y * 0.02)).g;
        float grime = smoothstep(0.45, 0.85, streak) * 0.35;
        // formwork panel joints
        vec2 fw = abs(fract(vec2(p.x + p.z, p.y) / vec2(2.4, 1.2)) - 0.5);
        float joint = smoothstep(0.485, 0.498, max(fw.x, fw.y));
        diffuseColor.rgb *= (0.78 + 0.35 * n1) * (1.0 - grime) * (0.92 + 0.12 * n2);
        diffuseColor.rgb *= 1.0 - 0.25 * uWetness;
        pRough = mix(0.95, 0.4, uWetness * 0.7);
        pBump = n2 * 0.004 - joint * 0.004;
        diffuseColor.rgb *= 1.0 - joint * 0.25;
      `),
      sunOcclusionHook,
    ],
  });
}

/** Corrugated steel cladding with rust streaks (hangars, sheds). */
export function corrugatedMaterial(color = new Color(0.32, 0.34, 0.33), params: MeshStandardMaterialParameters = {}): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.55, ...params });
  return worldMaterial(m, {
    key: 'corrugated',
    hooks: [
      detailVarying,
      surfaceHook(/* glsl */ `
        vec3 p = vWPos;
        vec3 an = abs(normalize(vObjN));
        // ribs run vertically on walls, along slope on roofs
        float coord = an.y > 0.6 ? (p.x + p.z) : (an.x > an.z ? p.z : p.x);
        float rib = sin(coord * 2.0 * 3.14159 / 0.2);
        float streak = texture2D(uNoiseTex, vec2(coord * 0.08, p.y * 0.015)).g;
        float rust = smoothstep(0.55, 0.9, streak) * smoothstep(0.3, 0.8, texture2D(uNoiseTex, p.xz / 40.0 + p.y / 50.0).r);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.22, 0.1, 0.05), rust * 0.6);
        diffuseColor.rgb *= 0.85 + 0.25 * texture2D(uNoiseTex, (p.xz + p.y) / 9.0).a;
        // panel seams every 8 m
        float seam = 1.0 - smoothstep(0.0, 0.03, abs(fract(coord / 8.0) - 0.5) - 0.46);
        pBump = rib * 0.006 + seam * 0.004;
        pRough = mix(0.55, 0.85, rust) * (1.0 - 0.4 * uWetness);
      `),
      sunOcclusionHook,
    ],
  });
}

/** Building facade for instanced town buildings: windows, floors, lit windows at night. */
export function facadeMaterial(): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.0 });
  return worldMaterial(m, {
    key: 'facade',
    hooks: [
      detailVarying,
      surfaceHook(/* glsl */ `
        vec3 p = vObjPos;
        vec3 n = normalize(vObjN);
        vec3 an = abs(n);
        // per-building parameters: x = hue/seed, y = window style, z = height scale, w = night activity
        float seed = vInst.x;
        vec3 base = mix(vec3(0.34, 0.31, 0.27), vec3(0.5, 0.46, 0.4), fract(seed * 7.3));
        base = mix(base, vec3(0.42, 0.3, 0.22), step(0.65, fract(seed * 3.1)));
        base = mix(base, vec3(0.45, 0.45, 0.46), step(0.85, fract(seed * 5.7)));
        base = mix(base, vec3(0.5, 0.42, 0.28), step(0.92, fract(seed * 2.3)));
        vec3 col = base;
        float roof = step(0.7, an.y);
        if (roof > 0.5) {
          col = mix(vec3(0.26, 0.1, 0.06), vec3(0.14, 0.14, 0.15), step(0.62, fract(seed * 11.0)));
          col = mix(col, vec3(0.3, 0.16, 0.1), step(0.85, fract(seed * 17.0)));
          col *= 0.8 + 0.3 * texture2D(uNoiseTex, vWPos.xz / 6.0).a;
          pRough = 0.8;
        } else {
          float u = an.x > an.z ? p.z : p.x;
          float floorH = 3.1;
          float winW = mix(2.2, 3.4, fract(seed * 13.0));
          vec2 g = vec2(u / winW, p.y / floorH);
          vec2 cell = floor(g);
          vec2 f = fract(g);
          float win = step(0.22, f.x) * step(f.x, 0.78) * step(0.28, f.y) * step(f.y, 0.82) * step(1.0, cell.y + 0.01);
          float groundFloor = 1.0 - step(1.0, cell.y);
          vec3 glass = vec3(0.06, 0.08, 0.1);
          col = mix(col, glass, win);
          col *= 0.85 + 0.2 * texture2D(uNoiseTex, vWPos.xy / 7.0 + vWPos.zy / 7.0).a;
          col *= 1.0 - 0.25 * groundFloor;
          pRough = mix(0.88, 0.12, win);
          // lit windows at night: random per window, warm/cool variety
          float h = hash12(cell + vec2(seed * 97.0, an.x > an.z ? 13.0 : 7.0));
          float lit = step(1.0 - (0.35 + 0.35 * vInst.w), h) * win;
          vec3 lc = mix(vec3(1.0, 0.72, 0.42), vec3(0.75, 0.85, 1.0), step(0.8, hash12(cell * 1.7 + seed)));
          pEmit = lc * lit * uLightsOn * 1.6 * (0.6 + 0.8 * hash12(cell + 3.0));
          pBump = win * 0.01;
        }
        col *= 1.0 - 0.3 * uWetness;
        pRough *= 1.0 - 0.4 * uWetness;
        diffuseColor.rgb = col;
      `),
      sunOcclusionHook,
    ],
  });
}

/** Painted steel (towers, masts, vehicles). */
export function paintedMetalMaterial(color: Color | number, roughness = 0.5): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color, roughness, metalness: 0.3 });
  return worldMaterial(m, {
    key: 'paint',
    hooks: [
      detailVarying,
      surfaceHook(/* glsl */ `
        float n = texture2D(uNoiseTex, (vWPos.xz + vWPos.y) / 5.0).a;
        diffuseColor.rgb *= 0.88 + 0.2 * n;
        pRough = roughness * (0.85 + 0.3 * n) * (1.0 - 0.4 * uWetness);
      `),
      sunOcclusionHook,
    ],
  });
}

/** Reflective glazing; emits interior light at night. */
export function glazingMaterial(nightColor = new Color(1.0, 0.85, 0.6), nightIntensity = 1.2): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color: 0x0a0e12, roughness: 0.06, metalness: 0.9 });
  return worldMaterial(m, {
    key: 'glazing' + nightColor.getHexString(),
    hooks: [
      detailVarying,
      surfaceHook(/* glsl */ `
        pRough = 0.06;
        pEmit = vec3(${nightColor.r.toFixed(3)}, ${nightColor.g.toFixed(3)}, ${nightColor.b.toFixed(3)}) * uLightsOn * ${nightIntensity.toFixed(2)};
      `),
      sunOcclusionHook,
    ],
  });
}

export { detailVarying, surfaceHook };
