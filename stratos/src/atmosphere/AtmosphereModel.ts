// Physically based single-scattering atmosphere (Rayleigh + Mie + ozone).
// The same constants drive the GPU sky LUT, aerial perspective and the CPU
// sun colour, so lighting and sky always agree.

import { Color, Vector3 } from 'three';

export const PLANET_R = 6360000;
export const ATMOS_R = 6460000;
export const RAYLEIGH = new Vector3(5.802e-6, 13.558e-6, 33.1e-6);
export const RAYLEIGH_H = 8000;
export const MIE = 3.996e-6;
export const MIE_EXT = 4.44e-6;
export const MIE_H = 1200;
export const OZONE = new Vector3(0.65e-6, 1.881e-6, 0.085e-6);
/** sun irradiance in scene units */
export const SUN_INTENSITY = 3.2;

export const ATMOSPHERE_GLSL = /* glsl */ `
const float PLANET_R = ${PLANET_R.toFixed(1)};
const float ATMOS_R = ${ATMOS_R.toFixed(1)};
const vec3 BETA_R = vec3(${RAYLEIGH.x.toExponential(4)}, ${RAYLEIGH.y.toExponential(4)}, ${RAYLEIGH.z.toExponential(4)});
const float H_R = ${RAYLEIGH_H.toFixed(1)};
const float BETA_M = ${MIE.toExponential(4)};
const float BETA_M_EXT = ${MIE_EXT.toExponential(4)};
const float H_M = ${MIE_H.toFixed(1)};
const vec3 BETA_O = vec3(${OZONE.x.toExponential(4)}, ${OZONE.y.toExponential(4)}, ${OZONE.z.toExponential(4)});
const float SUN_I = ${SUN_INTENSITY.toFixed(3)};

vec2 raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float d = b * b - c;
  if (d < 0.0) return vec2(1e9, -1e9);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}
float phaseR(float mu) { return 3.0 / (16.0 * PI) * (1.0 + mu * mu); }
float phaseM(float mu, float g) {
  float g2 = g * g;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}
float ozoneDensity(float h) { return max(0.0, 1.0 - abs(h - 25000.0) / 15000.0); }

// optical depth from point p (planet-centred) towards the sun direction
vec3 sunTransmittanceAt(vec3 p, vec3 sunDir, float mieScale) {
  vec2 hit = raySphere(p, sunDir, ATMOS_R);
  float len = hit.y;
  vec2 g = raySphere(p, sunDir, PLANET_R);
  if (g.x > 0.0) return vec3(0.0);
  float stepL = len / 6.0;
  float odR = 0.0, odM = 0.0, odO = 0.0;
  for (int i = 0; i < 6; i++) {
    vec3 s = p + sunDir * (float(i) + 0.5) * stepL;
    float h = length(s) - PLANET_R;
    odR += exp(-h / H_R) * stepL;
    odM += exp(-h / H_M) * stepL;
    odO += ozoneDensity(h) * stepL;
  }
  return exp(-(BETA_R * odR + BETA_M_EXT * mieScale * odM + BETA_O * odO));
}

// single scattering along a view ray from altitude camH (metres)
vec3 skyRadiance(float camH, vec3 rd, vec3 sunDir, float mieScale, out vec3 transmittance) {
  vec3 ro = vec3(0.0, PLANET_R + max(camH, 1.0), 0.0);
  vec2 a = raySphere(ro, rd, ATMOS_R);
  vec2 g = raySphere(ro, rd, PLANET_R);
  float tMax = a.y;
  if (g.x > 0.0) tMax = min(tMax, g.x);
  float tMin = max(a.x, 0.0);
  const int N = 24;
  float stepL = (tMax - tMin) / float(N);
  float mu = dot(rd, sunDir);
  float pr = phaseR(mu), pm = phaseM(mu, 0.76);
  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  float odR = 0.0, odM = 0.0, odO = 0.0;
  for (int i = 0; i < N; i++) {
    float t = tMin + (float(i) + 0.5) * stepL;
    vec3 p = ro + rd * t;
    float h = length(p) - PLANET_R;
    float dR = exp(-h / H_R) * stepL;
    float dM = exp(-h / H_M) * stepL;
    odR += dR; odM += dM; odO += ozoneDensity(h) * stepL;
    vec3 tView = exp(-(BETA_R * odR + BETA_M_EXT * mieScale * odM + BETA_O * odO));
    vec3 tSun = sunTransmittanceAt(p, sunDir, mieScale);
    sumR += dR * tView * tSun;
    sumM += dM * tView * tSun;
  }
  transmittance = exp(-(BETA_R * odR + BETA_M_EXT * mieScale * odM + BETA_O * odO));
  // multiple-scattering approximation: ambient lift proportional to single scattering
  vec3 single = SUN_I * (sumR * BETA_R * pr + sumM * BETA_M * mieScale * pm);
  vec3 ms = SUN_I * (sumR * BETA_R + sumM * BETA_M * mieScale) * (1.0 / (4.0 * PI)) * 0.55;
  return single + ms;
}
`;

const _p = new Vector3();

function raySphere(ro: Vector3, rd: Vector3, r: number): [number, number] {
  const b = ro.dot(rd);
  const c = ro.dot(ro) - r * r;
  const d = b * b - c;
  if (d < 0) return [1e9, -1e9];
  const s = Math.sqrt(d);
  return [-b - s, -b + s];
}

/** CPU transmittance of sunlight reaching altitude h, used for the directional light colour. */
export function sunTransmittance(h: number, sunDir: Vector3, mieScale: number, out: Color): Color {
  const ro = new Vector3(0, PLANET_R + Math.max(h, 1), 0);
  const g = raySphere(ro, sunDir, PLANET_R);
  if (g[0] > 0) {
    // below the geometric horizon: approximate a soft terminator
    const el = Math.asin(Math.max(-1, Math.min(1, sunDir.y)));
    const k = Math.max(0, 1 + el / 0.02);
    return out.setRGB(0.6 * k * k, 0.18 * k * k, 0.05 * k * k);
  }
  const len = raySphere(ro, sunDir, ATMOS_R)[1];
  const n = 24;
  const st = len / n;
  let odR = 0, odM = 0, odO = 0;
  for (let i = 0; i < n; i++) {
    _p.copy(ro).addScaledVector(sunDir, (i + 0.5) * st);
    const hh = _p.length() - PLANET_R;
    odR += Math.exp(-hh / RAYLEIGH_H) * st;
    odM += Math.exp(-hh / MIE_H) * st;
    odO += Math.max(0, 1 - Math.abs(hh - 25000) / 15000) * st;
  }
  return out.setRGB(
    Math.exp(-(RAYLEIGH.x * odR + MIE_EXT * mieScale * odM + OZONE.x * odO)),
    Math.exp(-(RAYLEIGH.y * odR + MIE_EXT * mieScale * odM + OZONE.y * odO)),
    Math.exp(-(RAYLEIGH.z * odR + MIE_EXT * mieScale * odM + OZONE.z * odO)),
  );
}
