// Terrain master material: PBR (MeshStandardMaterial) with procedural layers
// driven by land cover, slope, altitude and noise: grass variations, patchwork
// farmland, forest canopy, rock strata, snow, beaches, urban grain, wetness.
// Includes CDLOD geomorphing, earth curvature, detail bump and sun occlusion
// (cloud shadows + large-scale terrain shadows).

import { MeshStandardMaterial, Vector2, Vector3, type Texture, Vector4 } from 'three';
import { AIRPORT, AIRPORT_ELEVATION } from './WorldLayout.ts';
import { globals } from '../render/Globals.ts';
import { worldMaterial, type ShaderHook } from '../render/Materials.ts';

export const terrainUniforms = {
  uLodFactor: { value: 2.5 },
  uHeightTex: { value: null as Texture | null },
  /** xy = origin (world x,z of texel 0), zw = span */
  uHeightTexRect: { value: new Vector4(-80000, -90000, 160000, 160000) },
  uTerrainShadows: { value: 1 },
  /** air base pads (x, z, dirX, dirZ) + half sizes: coarse LODs never rise above the field */
  uPads: { value: AIRPORT.pads.map((p) => new Vector4(p.center[0], p.center[1], Math.sin((p.heading * Math.PI) / 180), -Math.cos((p.heading * Math.PI) / 180))) },
  uPadSize: { value: AIRPORT.pads.map((p) => new Vector2(p.halfLength, p.halfWidth)) },
  uFieldElev: { value: AIRPORT_ELEVATION },
};

/** Shared sun-occlusion GLSL: cloud shadows from the weather map + heightmap shadows. */
export const sunOcclusionUniforms = {
  uWeatherTex: { value: null as Texture | null },
  uCloudCoverage: { value: 0.3 },
  uCloudBase: { value: 1500 },
  uCloudTop: { value: 3500 },
  uCloudOffset: { value: new Vector3() },
  uCloudScale: { value: 1 / 40000 },
  uCloudShadowStrength: { value: 0.6 },
};

export const SUN_OCCLUSION_GLSL = /* glsl */ `
uniform sampler2D uWeatherTex;
uniform float uCloudCoverage;
uniform float uCloudBase;
uniform float uCloudTop;
uniform vec3 uCloudOffset;
uniform float uCloudScale;
uniform float uCloudShadowStrength;
uniform vec3 uSunDir;
float cloudShadowAt(vec3 wp) {
  if (uSunDir.y <= 0.02) return 1.0;
  float hMid = mix(uCloudBase, uCloudTop, 0.35);
  float t = max(0.0, (hMid - wp.y) / uSunDir.y);
  vec2 p = wp.xz + uSunDir.xz * t + uCloudOffset.xz;
  vec2 wm = texture2D(uWeatherTex, p * uCloudScale).rg;
  float cov = smoothstep(1.0 - uCloudCoverage + 0.04, 1.0 - uCloudCoverage + 0.24, wm.r) * 0.85;
  float shadow = 1.0 - uCloudShadowStrength * cov * smoothstep(0.02, 0.15, uSunDir.y);
  // overcast skies dim direct light everywhere
  shadow *= mix(1.0, 0.25, smoothstep(0.65, 0.95, uCloudCoverage));
  return shadow;
}
`;

export const sunOcclusionHook: ShaderHook = (shader) => {
  Object.assign(shader.uniforms, sunOcclusionUniforms);
  shader.uniforms.uSunDir = globals.uSunDir;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vSunOccWorld;')
    .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n#ifdef USE_INSTANCING\n vSunOccWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;\n#else\n vSunOccWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#endif');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\nvarying vec3 vSunOccWorld;\n${SUN_OCCLUSION_GLSL}`)
    .replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
       { float so = cloudShadowAt(vSunOccWorld); reflectedLight.directDiffuse *= so; reflectedLight.directSpecular *= so; }`,
    );
};

const terrainHook: ShaderHook = (shader) => {
  Object.assign(shader.uniforms, terrainUniforms);
  shader.uniforms.uNoiseTex = globals.uNoiseTex;
  shader.uniforms.uWetness = globals.uWetness;
  shader.uniforms.uSnow = globals.uSnow;
  shader.uniforms.uTime = globals.uTime;
  shader.uniforms.uNight = globals.uNight;
  shader.uniforms.uLightsOn = globals.uLightsOn;
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      /* glsl */ `#include <common>
      attribute vec4 cover;
      attribute vec2 morph;
      uniform float uLodFactor;
      uniform vec4 uPads[${AIRPORT.pads.length}];
      uniform vec2 uPadSize[${AIRPORT.pads.length}];
      uniform float uFieldElev;
      varying vec4 vCover;
      varying vec3 vWorldPosT;
      varying vec3 vWorldNormalT;
      varying float vViewDist;`,
    )
    .replace(
      '#include <begin_vertex>',
      /* glsl */ `#include <begin_vertex>
      {
        vec3 wpm = (modelMatrix * vec4(position, 1.0)).xyz;
        float d = distance(wpm, uCurvOrigin);
        float s = morph.y;
        float k = smoothstep(1.35 * s * uLodFactor, 1.9 * s * uLodFactor, d);
        transformed.y = mix(position.y, morph.x, k);
        // while coarse chunks are on screen, keep them under the air base so
        // interpolated hills never swallow the runway (margin ~ 1.5 cells)
        float margin = s / 64.0 * 1.5;
        float dPad = 1e9;
        for (int i = 0; i < ${AIRPORT.pads.length}; i++) {
          vec2 r = wpm.xz - uPads[i].xy;
          vec2 q = abs(vec2(dot(r, uPads[i].zw), dot(r, vec2(-uPads[i].w, uPads[i].z)))) - uPadSize[i];
          dPad = min(dPad, length(max(q, 0.0)) + min(max(q.x, q.y), 0.0));
        }
        if (dPad < margin) transformed.y = min(transformed.y, uFieldElev - 0.05);
      }`,
    )
    .replace(
      '#include <worldpos_vertex>',
      /* glsl */ `#include <worldpos_vertex>
      vCover = cover;
      vWorldPosT = (modelMatrix * vec4(transformed, 1.0)).xyz;
      vWorldNormalT = normalize(mat3(modelMatrix) * objectNormal);
      vViewDist = distance(vWorldPosT, uCurvOrigin);`,
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      /* glsl */ `#include <common>
      uniform sampler2D uNoiseTex;
      uniform sampler2D uHeightTex;
      uniform vec4 uHeightTexRect;
      uniform float uTerrainShadows;
      uniform float uWetness;
      uniform float uSnow;
      uniform float uTime;
      uniform float uNight;
      uniform float uLightsOn;
      varying vec4 vCover;
      varying vec3 vWorldPosT;
      varying vec3 vWorldNormalT;
      varying float vViewDist;
      float tRough;
      float tBump;
      float tWet;
      vec3 tEmissive;

      vec4 nz(vec2 p) { return texture2D(uNoiseTex, p); }
      float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

      // patchwork farmland: returns crop colour, writes furrow bump
      vec3 fieldColor(vec2 p, float lod, out float furrow, out float hedge) {
        // field orientation is constant over large parcels (straight hedgerows, no swirls)
        vec2 region = floor(p / 2600.0 + vec2(nz(p / 21000.0).g, nz(p / 21000.0 + 0.5).r) * 0.8);
        float ang = (h12(region * 1.31) - 0.5) * 3.0;
        mat2 R = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
        vec2 q = R * p;
        vec2 fsize = vec2(260.0, 170.0) * (0.7 + nz(p / 5000.0).g * 0.8);
        vec2 warp = (vec2(nz(p / 1300.0).g, nz(p / 1300.0 + 0.37).r) - 0.5) * 14.0;
        vec2 g = (q + warp) / fsize;
        vec2 cell = floor(g);
        vec2 f = fract(g);
        float id = h12(cell);
        float id2 = h12(cell + 17.3);
        vec3 c;
        if (id < 0.16) c = vec3(0.21, 0.18, 0.085);       // ripe wheat
        else if (id < 0.40) c = vec3(0.075, 0.11, 0.04);   // green crop
        else if (id < 0.50) c = vec3(0.11, 0.085, 0.055);  // ploughed soil
        else if (id < 0.60) c = vec3(0.16, 0.145, 0.075);  // stubble
        else if (id < 0.82) c = vec3(0.09, 0.115, 0.05);   // pasture
        else if (id < 0.90) c = vec3(0.17, 0.155, 0.10);   // dry fallow
        else c = vec3(0.06, 0.085, 0.04);                  // orchard / dark crop
        c *= 0.9 + 0.2 * id2;
        // furrows along the field orientation
        float dir = id2 > 0.5 ? q.x : q.y;
        furrow = (sin(dir * 2.1) * 0.5 + 0.5) * (1.0 - lod) * step(0.42, id) * step(id, 0.68);
        c *= 1.0 - 0.18 * furrow;
        // hedgerows / field borders
        vec2 e = min(f, 1.0 - f) * fsize;
        float border = min(e.x, e.y);
        hedge = 1.0 - smoothstep(1.5, 5.0 + lod * 20.0, border);
        return c;
      }

      float terrainSunShadow(vec3 wp, vec3 sun) {
        if (uTerrainShadows < 0.5 || sun.y > 0.9 || sun.y < -0.05) return 1.0;
        vec2 dir = normalize(sun.xz + 1e-5);
        float tanEl = sun.y / max(length(sun.xz), 1e-4);
        float shadow = 1.0;
        float dist = 60.0;
        for (int i = 0; i < 14; i++) {
          vec2 p = wp.xz + dir * dist;
          vec2 uv = (p - uHeightTexRect.xy) / uHeightTexRect.zw;
          float th = texture2D(uHeightTex, uv).r;
          float rayH = wp.y + dist * tanEl;
          shadow = min(shadow, clamp((rayH - th) / (dist * 0.035) + 0.5, 0.0, 1.0));
          dist *= 1.55;
        }
        return shadow;
      }`,
    )
    .replace(
      '#include <map_fragment>',
      /* glsl */ `
      vec3 wp = vWorldPosT;
      vec3 wn = normalize(vWorldNormalT);
      float slope = 1.0 - wn.y;
      float h = wp.y;
      float lod = smoothstep(800.0, 9000.0, vViewDist);
      vec4 nA = nz(wp.xz / 2600.0);
      vec4 nB = nz(wp.xz / 410.0);
      vec4 nC = nz(wp.xz / 53.0);
      vec4 nD = nz(wp.xz / 7.0);
      float forest = vCover.r;
      float farm = vCover.g;
      float urban = vCover.b;
      float rockC = vCover.a;

      // --- grass base with macro/meso variation (green <-> dry)
      float dry = clamp(nA.r * 0.9 + nB.g * 0.5 - 0.35 + smoothstep(300.0, 900.0, h) * 0.2, 0.0, 1.0);
      vec3 col = mix(vec3(0.055, 0.085, 0.025), vec3(0.15, 0.135, 0.06), dry);
      col *= 0.8 + 0.4 * nC.a;
      col = mix(col, col * vec3(1.1, 0.95, 0.8), nD.b * (1.0 - lod) * 0.4);
      tRough = 0.92;
      tBump = nD.a * 0.6 + nC.b * 0.3;

      // --- farmland patchwork
      float furrow = 0.0, hedge = 0.0;
      if (farm > 0.02) {
        vec3 fc = fieldColor(wp.xz, lod, furrow, hedge);
        float fm = smoothstep(0.15, 0.6, farm + (nB.r - 0.5) * 0.3) * mix(0.85, 0.6, lod);
        col = mix(col, fc, fm);
        col = mix(col, vec3(0.03, 0.05, 0.02), hedge * fm * 0.85);
        tBump += furrow * 0.6 * fm;
      }

      // --- forest floor / canopy seen from afar
      float fo = smoothstep(0.08, 0.5, forest + (nC.r - 0.5) * 0.25);
      vec3 canopy = mix(vec3(0.035, 0.06, 0.022), vec3(0.06, 0.08, 0.03), nB.b);
      canopy = mix(canopy, vec3(0.035, 0.05, 0.025), smoothstep(400.0, 1200.0, h)); // darker conifers
      canopy *= 0.8 + 0.4 * nC.b * nD.r;
      // near the camera trees are real meshes; ground under them is litter/moss
      vec3 floorCol = vec3(0.045, 0.04, 0.022) * (0.8 + 0.4 * nD.g);
      col = mix(col, mix(floorCol, canopy, lod), fo);
      tBump += fo * nC.b * 1.5 * lod;

      // --- urban grain
      if (urban > 0.05) {
        vec2 bp = wp.xz / 38.0;
        vec2 bc = floor(bp);
        float blk = h12(bc);
        vec2 bf = fract(bp);
        float street = 1.0 - step(0.1, min(min(bf.x, 1.0 - bf.x), min(bf.y, 1.0 - bf.y)));
        vec3 uc = mix(vec3(0.16, 0.15, 0.14), vec3(0.24, 0.21, 0.19), blk);
        uc = mix(uc, vec3(0.05, 0.05, 0.055), street);
        uc = mix(uc, vec3(0.06, 0.08, 0.035), step(0.82, blk) * (1.0 - street)); // parks
        col = mix(col, uc, smoothstep(0.2, 0.7, urban) * 0.9);
        tRough = mix(tRough, 0.75, urban);
        // night: street grid glow seen from far
        tEmissive = vec3(1.0, 0.62, 0.3) * street * smoothstep(0.35, 0.8, urban) * uLightsOn * 0.6 * (0.5 + h12(bc + 3.1));
      }

      // --- rock and cliffs
      float strata = sin(h * 0.09 + nB.r * 6.0) * 0.5 + 0.5;
      vec3 rockCol = mix(vec3(0.11, 0.10, 0.09), vec3(0.22, 0.20, 0.18), strata * 0.6 + nC.g * 0.4);
      rockCol *= 0.75 + 0.5 * nD.r;
      float rockM = clamp(smoothstep(0.28, 0.48, slope + (nC.r - 0.5) * 0.12) + rockC * 0.35 + smoothstep(1900.0, 2600.0, h) * 0.5, 0.0, 1.0);
      col = mix(col, rockCol, rockM);
      tRough = mix(tRough, 0.82, rockM);
      tBump += rockM * (nC.g * 2.0 + nD.b);

      // --- beaches and shores
      float sand = (1.0 - smoothstep(1.2, 5.0, h)) * (1.0 - rockM);
      col = mix(col, vec3(0.38, 0.33, 0.24) * (0.85 + 0.3 * nD.a), sand);
      // underwater sea floor gets darker / greener
      col = mix(col, vec3(0.05, 0.07, 0.06), smoothstep(-1.0, -12.0, h));

      // --- snow on flatter high ground (+ global snow from weather)
      float snowLine = 2250.0 - uSnow * 1800.0 + (nB.r - 0.5) * 400.0;
      float snow = smoothstep(snowLine, snowLine + 250.0, h) * (1.0 - smoothstep(0.35, 0.6, slope));
      col = mix(col, vec3(0.75, 0.77, 0.8) * (0.9 + 0.1 * nD.a), snow);
      tRough = mix(tRough, 0.55, snow);


      // --- wetness: darker albedo, glossier; puddles in low spots
      float puddle = smoothstep(0.62, 0.8, nC.r * 0.7 + nD.g * 0.3) * (1.0 - slope * 3.0);
      tWet = uWetness * (0.6 + 0.4 * puddle) * (1.0 - snow);
      col *= mix(1.0, 0.55, tWet);
      tRough = mix(tRough, 0.25, tWet * (0.5 + 0.5 * puddle));

      diffuseColor.rgb = col;
      `,
    )
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRough;')
    .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
    .replace(
      '#include <normal_fragment_maps>',
      /* glsl */ `
      {
        float fade = 1.0 - smoothstep(150.0, 2500.0, vViewDist);
        float bh = tBump * fade * 0.08 * (1.0 - tWet * 0.6);
        vec2 dHdxy = vec2(dFdx(bh), dFdy(bh));
        vec3 vSigmaX = dFdx(-vViewPosition);
        vec3 vSigmaY = dFdy(-vViewPosition);
        vec3 R1 = cross(vSigmaY, normal);
        vec3 R2 = cross(normal, vSigmaX);
        float fDet = dot(vSigmaX, R1);
        vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
        if (abs(fDet) > 1e-9) normal = normalize(abs(fDet) * normal - vGrad);
      }
      `,
    )
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += tEmissive;')
    .replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
       { float ts = terrainSunShadow(vWorldPosT, uSunDir); reflectedLight.directDiffuse *= ts; reflectedLight.directSpecular *= ts; }`,
    );
  shader.fragmentShader = shader.fragmentShader.replace('void main() {', 'void main() {\n tEmissive = vec3(0.0);');
};

export function createTerrainMaterial(): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  return worldMaterial(mat, { hooks: [terrainHook, sunOcclusionHook], key: 'terrain' });
}
