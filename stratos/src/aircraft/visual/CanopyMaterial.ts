// Canopy glass: gold-tinted ITO coating, Fresnel sky reflections (from the
// sky LUT), sun glint on micro-scratches and dust, and procedural rain
// droplets that streak back with airspeed. Rendered double-sided, blended
// over the scene (premultiplied) so reflections never darken the interior.

import { DoubleSide, ShaderMaterial, type Texture, Vector3 } from 'three';
import { globals, CURVATURE_GLSL } from '../../render/Globals.ts';
import { SKY_LUT_GLSL } from '../../atmosphere/Sky.ts';

export const canopyUniforms = {
  uRain: { value: 0 },
  uSpeed: { value: 0 },
  uInsideCam: { value: 0 },
  uFrost: { value: 0 },
};

export function createCanopyMaterial(skyLut: Texture): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uSkyLut: { value: skyLut },
      uSunDir: globals.uSunDir,
      uSunColor: globals.uSunColor,
      uTime: globals.uTime,
      uNoiseTex: globals.uNoiseTex,
      uCurvOrigin: globals.uCurvOrigin,
      uLightsOn: globals.uLightsOn,
      ...canopyUniforms,
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying vec3 vWorldN;
      varying vec2 vUv;
      varying vec3 vLocal;
      ${CURVATURE_GLSL}
      void main() {
        vUv = uv;
        vLocal = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vWorldN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * vec4(applyCurvature(wp.xyz), 1.0);
      }`,
    fragmentShader: /* glsl */ `
      #define PI 3.141592653589793
      uniform sampler2D uSkyLut;
      uniform sampler2D uNoiseTex;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uTime;
      uniform float uRain;
      uniform float uSpeed;
      uniform float uInsideCam;
      uniform float uFrost;
      varying vec3 vWorldPos;
      varying vec3 vWorldN;
      varying vec2 vUv;
      varying vec3 vLocal;
      ${SKY_LUT_GLSL}
      float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 N = normalize(vWorldN);
        if (dot(N, V) < 0.0) N = -N;
        float NdV = clamp(dot(N, V), 0.0, 1.0);
        float F = 0.04 + 0.96 * pow(1.0 - NdV, 5.0);
        vec3 R = reflect(-V, N);
        vec3 sky = texture2D(uSkyLut, skyLutUV(vec3(R.x, max(R.y, -0.1), R.z))).rgb;
        // ITO gold tint on the reflection
        vec3 gold = vec3(1.0, 0.82, 0.5);
        vec3 refl = sky * mix(vec3(1.0), gold, 0.55) * F;
        // sun specular + glint on scratches / dust
        vec3 H = normalize(uSunDir + V);
        float spec = pow(max(dot(N, H), 0.0), 900.0) * 60.0;
        float scratch = texture2D(uNoiseTex, vUv * vec2(9.0, 4.0)).b;
        float dust = texture2D(uNoiseTex, vUv * vec2(3.0, 1.5) + 0.3).a;
        float glint = pow(max(dot(normalize(uSunDir), -V) * 0.5 + 0.5, 0.0), 24.0) * (smoothstep(0.78, 0.92, scratch) * 0.4 + dust * 0.15);
        vec3 col = refl + uSunColor * (spec * F * gold + glint * 0.35);
        float alpha = clamp(0.08 + F * 0.85 + glint * 0.2, 0.0, 1.0);
        // rain droplets: jittered cells, stretched aft with airspeed
        if (uRain > 0.01) {
          float stretch = 1.0 + clamp(uSpeed / 40.0, 0.0, 6.0);
          vec2 uv = vUv * vec2(26.0, 40.0);
          uv.x -= uTime * clamp(uSpeed / 30.0, 0.0, 3.0);
          vec2 cell = floor(uv);
          vec2 f = fract(uv) - 0.5;
          float rnd = h21(cell);
          vec2 o = vec2(h21(cell + 3.1), h21(cell + 7.7)) - 0.5;
          vec2 d = (f - o * 0.6) * vec2(stretch, 1.0);
          float drop = smoothstep(0.22, 0.12, length(d)) * step(1.0 - uRain * 0.7, rnd);
          float edge = smoothstep(0.24, 0.18, length(d)) - smoothstep(0.18, 0.1, length(d));
          col += sky * drop * 0.35 + vec3(edge) * 0.08;
          alpha = max(alpha, drop * 0.45);
        }
        // light misting / frost at very high altitude
        alpha = max(alpha, uFrost * 0.25 * dust);
        gl_FragColor = vec4(col, alpha);
      }`,
    transparent: true,
    side: DoubleSide,
    depthWrite: false,
    premultipliedAlpha: true,
  });
}

export const _v = new Vector3();
