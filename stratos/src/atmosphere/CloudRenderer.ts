// Volumetric cloud ray-marcher (reduced resolution + temporal reprojection).
// Clouds live in a spherical shell, shaped by a scrolling weather map,
// Perlin-Worley base noise and Worley erosion. Lit by the sun (Beer-Powder,
// dual-lobe Henyey-Greenstein) and sky ambient. The camera can fly inside.
// Lightning flashes illuminate the cloud interior.

import {
  HalfFloatType, LinearFilter, Matrix4, NearestFilter, RGBAFormat, Vector2, Vector3, WebGLRenderTarget,
  type Data3DTexture, type DataTexture, type Texture, type WebGLRenderer, Vector4, Color,
} from 'three';
import { FullscreenPass } from '../render/FullscreenPass.ts';
import { globals } from '../render/Globals.ts';
import { SKY_LUT_GLSL } from './Sky.ts';
import { PLANET_R } from './AtmosphereModel.ts';

export const CLOUD_COMMON_GLSL = /* glsl */ `
uniform sampler2D uWeather;
uniform highp sampler3D uShape;
uniform highp sampler3D uDetail;
uniform float uCoverage;
uniform float uDensity;
uniform float uBase;
uniform float uTop;
uniform float uCloudType;      // 0 stratus .. 0.5 cumulus .. 1 cumulonimbus
uniform vec3 uWindOffset;
uniform float uWeatherScale;
uniform float uShapeScale;
uniform float uDetailScale;

float remap(float v, float a0, float a1, float b0, float b1) {
  return b0 + (v - a0) * (b1 - b0) / max(a1 - a0, 1e-5);
}
float heightGradient(float h, float type) {
  // stratus: thin & low, cumulus: rounded, cumulonimbus: full column with anvil
  float st = smoothstep(0.0, 0.08, h) * (1.0 - smoothstep(0.15, 0.32, h));
  float cu = smoothstep(0.0, 0.12, h) * (1.0 - smoothstep(0.45, 0.85, h));
  float cb = smoothstep(0.0, 0.08, h) * (1.0 - smoothstep(0.85, 1.0, h));
  return type < 0.5 ? mix(st, cu, type * 2.0) : mix(cu, cb, type * 2.0 - 2.0 * 0.5);
}
// local coverage from the (equalised) weather map: 1 inside cloud cells
float localCoverage(vec2 xz) {
  vec2 wm = texture2D(uWeather, (xz + uWindOffset.xz) * uWeatherScale).rg;
  float c = smoothstep(1.0 - uCoverage - 0.12, 1.0 - uCoverage + 0.12, wm.r);
  return max(c, smoothstep(0.85, 1.0, uCoverage));
}
// p = (x, altitude, z) in metres
float cloudDensity(vec3 p, bool cheap) {
  float hN = (p.y - uBase) / (uTop - uBase);
  if (hN < 0.0 || hN > 1.0) return 0.0;
  vec2 wuv = (p.xz + uWindOffset.xz) * uWeatherScale;
  vec2 wm = texture2D(uWeather, wuv).rg;
  float cov = smoothstep(1.0 - uCoverage - 0.12, 1.0 - uCoverage + 0.12, wm.r);
  cov = max(cov, smoothstep(0.85, 1.0, uCoverage));
  if (cov <= 0.001) return 0.0;
  float type = clamp(uCloudType + (wm.g - 0.5) * 0.35, 0.0, 1.0);
  float anvil = type > 0.75 ? smoothstep(0.65, 0.95, hN) * (type - 0.75) * 4.0 : 0.0;
  vec3 sp = (p + uWindOffset * 1.2) * uShapeScale;
  sp.y *= 1.6;
  vec4 n = texture(uShape, sp);
  float wfbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  float shape = remap(n.r, wfbm - 1.0, 1.0, 0.0, 1.0);
  shape *= heightGradient(hN, type) * (1.0 + anvil);
  float d = clamp(remap(shape, 1.0 - cov * 0.82, 1.0, 0.0, 1.0), 0.0, 1.0);
  if (!cheap && d > 0.0) {
    float dn = texture(uDetail, (p + uWindOffset * 1.6) * uDetailScale).r;
    float ero = mix(dn, 1.0 - dn, clamp(hN * 4.0, 0.0, 1.0));
    d = clamp(remap(d, ero * 0.22, 1.0, 0.0, 1.0), 0.0, 1.0);
  }
  return d * uDensity;
}
`;

const cloudFrag = /* glsl */ `
precision highp float;
precision highp sampler3D;
#define PI 3.141592653589793
varying vec2 vUv;
uniform sampler2D tDepth;
uniform sampler2D uSkyLut;
uniform sampler2D uDither;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbTop;
uniform vec3 uAmbBottom;
uniform float uReversed;
uniform float uFrame;
uniform int uSteps;
uniform float uMaxDist;
uniform vec4 uFlash; // xyz pos, w intensity
uniform vec2 uRes;
uniform float uNightFactor;
const float PLANET_R = ${PLANET_R.toFixed(1)};
${SKY_LUT_GLSL}
${CLOUD_COMMON_GLSL}

vec2 raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float d = b * b - c;
  if (d < 0.0) return vec2(1e9, -1e9);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}
float hg(float mu, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}

float sceneDistance(vec2 uv, vec3 rd) {
  float d = texture2D(tDepth, uv).r;
  bool sky = uReversed > 0.5 ? d <= 0.0 : d >= 1.0;
  if (sky) return 1e9;
  float z = uReversed > 0.5 ? d : d * 2.0 - 1.0;
  vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, z, 1.0);
  v /= v.w;
  return length(v.xyz);
}

float lightMarch(vec3 p, float hN) {
  float od = 0.0;
  float stepL = (uTop - uBase) * 0.09;
  for (int i = 0; i < 6; i++) {
    float s = stepL * (float(i) + 0.5) * (1.0 + float(i) * 0.6);
    od += cloudDensity(p + uSunDir * s, i > 1) * stepL * (1.0 + float(i) * 0.6);
  }
  return od;
}

layout(location = 1) out highp vec4 gDepthOut;

void main() {
  vec2 uv = vUv;
  vec4 vp = uInvProj * vec4(uv * 2.0 - 1.0, 0.5, 1.0);
  vec3 rd = normalize((uCamWorld * vec4(normalize(vp.xyz / vp.w), 0.0)).xyz);
  float sceneD = sceneDistance(uv, rd);

  // spherical shell intersection in planet-centred coordinates
  vec3 ro = vec3(0.0, PLANET_R + uCamPos.y, 0.0);
  float rB = PLANET_R + uBase, rT = PLANET_R + uTop;
  vec2 iB = raySphere(ro, rd, rB);
  vec2 iT = raySphere(ro, rd, rT);
  vec2 iG = raySphere(ro, rd, PLANET_R);
  float camR = length(ro);
  float t0, t1;
  if (camR < rB) {
    if (iG.x > 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); gDepthOut = vec4(1e5); return; }
    t0 = iB.y; t1 = iT.y;
  } else if (camR < rT) {
    t0 = 0.0;
    t1 = iB.x > 0.0 ? iB.x : iT.y;
  } else {
    if (iT.x < 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); gDepthOut = vec4(1e5); return; }
    t0 = iT.x;
    t1 = iB.x > 0.0 ? iB.x : iT.y;
  }
  t1 = min(t1, min(sceneD, uMaxDist));
  if (t1 <= t0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); gDepthOut = vec4(1e5); return; }

  float jitter = texture2D(uDither, gl_FragCoord.xy / 64.0).r;
  jitter = fract(jitter + uFrame * 0.61803398875);
  int N = uSteps;
  float len = t1 - t0;
  bool inside = camR >= rB && camR < rT;
  float mu = dot(rd, uSunDir);
  float phase = mix(hg(mu, 0.78), hg(mu, -0.25), 0.3) * 0.9 + hg(mu, 0.2) * 0.1;
  vec3 sunL = uSunColor;
  float T = 1.0;
  vec3 L = vec3(0.0);
  float depthAcc = 0.0, depthW = 0.0;
  float tPrev = t0;
  for (int i = 0; i < 160; i++) {
    if (i >= N) break;
    float f = (float(i) + jitter) / float(N);
    // concentrate samples near the camera when inside / near the layer
    float tt = inside ? t0 + len * f * f : t0 + len * f;
    float stepL = max(tt - tPrev, 1.0);
    if (!inside) stepL = len / float(N);
    tPrev = tt;
    vec3 pw = uCamPos + rd * tt;
    // altitude on the curved shell
    vec3 pp = ro + rd * tt;
    float alt = length(pp) - PLANET_R;
    vec3 p = vec3(pw.x, alt, pw.z);
    float dens = cloudDensity(p, tt > 18000.0);
    if (dens > 0.003) {
      float hN = (alt - uBase) / (uTop - uBase);
      float sigma = dens * 0.045;
      float odL = lightMarch(p, hN) * 0.045;
      float beer = exp(-odL) * 0.7 + exp(-odL * 0.25) * 0.3;
      float powder = 1.0 - exp(-sigma * 120.0);
      vec3 amb = mix(uAmbBottom, uAmbTop, clamp(hN, 0.0, 1.0)) * (0.6 + 0.4 * hN);
      vec3 S = sigma * (sunL * beer * phase * mix(1.0, powder * 2.0, 0.5) * 4.0 + amb);
      // lightning: internal glow around the strike
      if (uFlash.w > 0.0) {
        float dl = length(pw - uFlash.xyz);
        S += sigma * vec3(0.75, 0.8, 1.0) * uFlash.w * 900.0 / (1.0 + dl * dl * 2e-6) * exp(-odL * 0.3);
      }
      float Tstep = exp(-sigma * stepL);
      L += T * (S - S * Tstep) / max(sigma, 1e-6);
      depthAcc += tt * T;
      depthW += T;
      T *= Tstep;
      if (T < 0.01) break;
    }
  }
  // fade distant clouds into the horizon haze (aerial perspective)
  float dAvg = depthW > 0.0 ? depthAcc / depthW : 1e5;
  vec3 hz = texture2D(uSkyLut, skyLutUV(vec3(rd.x, max(rd.y, 0.015), rd.z))).rgb;
  float haze = 1.0 - exp(-dAvg / 70000.0);
  L = mix(L, hz * (1.0 - T), haze);
  gl_FragColor = vec4(L, T);
  gDepthOut = vec4(dAvg, 0.0, 0.0, 1.0);
}
`;

// Temporal resolve: reproject history with the cloud depth, neighbourhood clamp.
const resolveFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tCurrent;
uniform sampler2D tCurDepth;
uniform sampler2D tHistory;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform mat4 uPrevViewProj;
uniform vec3 uCamPos;
uniform vec2 uTexel;
uniform float uBlend;
void main() {
  vec4 cur = texture2D(tCurrent, vUv);
  vec4 mn = cur, mx = cur;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec4 s = texture2D(tCurrent, vUv + vec2(x, y) * uTexel);
    mn = min(mn, s); mx = max(mx, s);
  }
  float d = texture2D(tCurDepth, vUv).r;
  vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, 0.5, 1.0);
  vec3 rd = normalize((uCamWorld * vec4(normalize(vp.xyz / vp.w), 0.0)).xyz);
  vec3 wp = uCamPos + rd * min(d, 90000.0);
  vec4 pc = uPrevViewProj * vec4(wp, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  vec4 hist = texture2D(tHistory, puv);
  bool valid = pc.w > 0.0 && all(greaterThan(puv, vec2(0.0))) && all(lessThan(puv, vec2(1.0)));
  hist = clamp(hist, mn - 0.02, mx + 0.02);
  gl_FragColor = valid ? mix(cur, hist, uBlend) : cur;
}
`;

export interface CloudParams {
  coverage: number;
  density: number;
  base: number;
  top: number;
  type: number;
}

export class CloudRenderer {
  private pass: FullscreenPass;
  private resolve: FullscreenPass;
  rtCur: WebGLRenderTarget;
  private hist: [WebGLRenderTarget, WebGLRenderTarget];
  private histIndex = 0;
  readonly windOffset = new Vector3();
  readonly params: CloudParams = { coverage: 0.35, density: 1, base: 1600, top: 3600, type: 0.5 };
  private frame = 0;
  scale = 0.5;
  steps = 72;
  enabled = true;
  private prevViewProj = new Matrix4();
  private width = 1;
  private height = 1;
  readonly flash = new Vector4(0, 0, 0, 0);
  readonly ambTop = new Color(0.5, 0.6, 0.8);
  readonly ambBottom = new Color(0.3, 0.32, 0.36);
  temporal = true;

  constructor(
    shape: Data3DTexture,
    detail: Data3DTexture,
    weather: DataTexture,
    dither: Texture,
    skyLut: Texture,
  ) {
    const uniforms = {
      tDepth: { value: null as Texture | null },
      uSkyLut: { value: skyLut },
      uDither: { value: dither },
      uWeather: { value: weather },
      uShape: { value: shape },
      uDetail: { value: detail },
      uInvProj: { value: new Matrix4() },
      uCamWorld: { value: new Matrix4() },
      uCamPos: { value: new Vector3() },
      uSunDir: globals.uSunDir,
      uSunColor: globals.uSunColor,
      uAmbTop: { value: this.ambTop },
      uAmbBottom: { value: this.ambBottom },
      uReversed: { value: 1 },
      uFrame: { value: 0 },
      uSteps: { value: 72 },
      uMaxDist: { value: 90000 },
      uFlash: { value: this.flash },
      uRes: { value: new Vector2(1, 1) },
      uNightFactor: globals.uNight,
      uCoverage: { value: 0.35 },
      uDensity: { value: 1 },
      uBase: { value: 1600 },
      uTop: { value: 3600 },
      uCloudType: { value: 0.5 },
      uWindOffset: { value: this.windOffset },
      uWeatherScale: { value: 1 / 40000 },
      uShapeScale: { value: 1 / 7000 },
      uDetailScale: { value: 1 / 900 },
    };
    this.pass = new FullscreenPass(cloudFrag, uniforms);
    this.pass.material.glslVersion = null;
    this.resolve = new FullscreenPass(resolveFrag, {
      tCurrent: { value: null },
      tCurDepth: { value: null },
      tHistory: { value: null },
      uInvProj: uniforms.uInvProj,
      uCamWorld: uniforms.uCamWorld,
      uPrevViewProj: { value: this.prevViewProj },
      uCamPos: uniforms.uCamPos,
      uTexel: { value: new Vector2() },
      uBlend: { value: 0.88 },
    });
    this.rtCur = this.makeRT(1, 1, 2);
    this.hist = [this.makeRT(1, 1, 1), this.makeRT(1, 1, 1)];
  }

  private makeRT(w: number, h: number, count: number): WebGLRenderTarget {
    const rt = new WebGLRenderTarget(w, h, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false, count });
    for (const t of rt.textures) {
      t.minFilter = LinearFilter;
      t.magFilter = LinearFilter;
      t.generateMipmaps = false;
    }
    if (count > 1) rt.textures[1].minFilter = rt.textures[1].magFilter = NearestFilter;
    return rt;
  }

  setSize(w: number, h: number): void {
    const cw = Math.max(1, Math.floor(w * this.scale));
    const ch = Math.max(1, Math.floor(h * this.scale));
    if (cw === this.width && ch === this.height) return;
    this.width = cw;
    this.height = ch;
    this.rtCur.setSize(cw, ch);
    this.hist[0].setSize(cw, ch);
    this.hist[1].setSize(cw, ch);
    this.pass.uniforms.uRes.value.set(cw, ch);
    this.resolve.uniforms.uTexel.value.set(1 / cw, 1 / ch);
  }

  get depthOutput(): Texture {
    return this.rtCur.textures[1];
  }

  get output(): Texture {
    return this.temporal ? this.hist[this.histIndex].texture : this.rtCur.textures[0];
  }

  render(renderer: WebGLRenderer, depth: Texture, camera: { projectionMatrixInverse: Matrix4; matrixWorld: Matrix4; projectionMatrix: Matrix4; matrixWorldInverse: Matrix4 }, camPos: Vector3, reversed: boolean): void {
    const u = this.pass.uniforms;
    const p = this.params;
    u.tDepth.value = depth;
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(camera.matrixWorld);
    u.uCamPos.value.copy(camPos);
    u.uReversed.value = reversed ? 1 : 0;
    u.uFrame.value = this.frame++ % 64;
    u.uSteps.value = this.steps;
    u.uCoverage.value = p.coverage;
    u.uDensity.value = p.density;
    u.uBase.value = p.base;
    u.uTop.value = p.top;
    u.uCloudType.value = p.type;
    this.pass.render(renderer, this.rtCur);
    if (this.temporal) {
      const prev = this.hist[this.histIndex];
      this.histIndex = 1 - this.histIndex;
      const r = this.resolve.uniforms;
      r.tCurrent.value = this.rtCur.textures[0];
      r.tCurDepth.value = this.rtCur.textures[1];
      r.tHistory.value = prev.texture;
      this.resolve.render(renderer, this.hist[this.histIndex]);
    }
    this.prevViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  }
}
