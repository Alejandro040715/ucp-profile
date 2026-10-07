// Composite pass: sky (LUT + sun + moon + stars), aerial perspective / height
// fog on opaque geometry, weather fog and clouds. Output is linear HDR.

import { SKY_LUT_GLSL } from '../../atmosphere/Sky.ts';

export const compositeFrag = /* glsl */ `
precision highp float;
#define PI 3.141592653589793
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D tClouds;
uniform sampler2D tCloudDepth;
uniform float uCamCloud;      // cloud extinction at the camera (1/m) for full-res near fog
uniform vec3 uCloudFogColor;
uniform sampler2D uSkyLut;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform float uReversed;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform float uMoonPhase;
uniform float uTime;
uniform float uNight;
uniform float uMie;           // haze multiplier
uniform float uFogDensity;    // weather fog extinction at fog base (1/m)
uniform float uFogBase;
uniform float uFogHeight;     // fog scale height (m)
uniform vec3 uFogColor;
uniform float uCloudsOn;
uniform float uOvercast;
uniform vec3 uOvercastColor;
uniform float uFlash;
uniform float uSunVisible;
${SKY_LUT_GLSL}

const vec3 BETA_R = vec3(5.802e-6, 13.558e-6, 33.1e-6);
const float BETA_M = 4.44e-6;

float hash13(vec3 p3) {
  p3 = fract(p3 * .1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

// optical depth of an exponential layer along a straight ray
float odExp(float y0, float dy, float dist, float H) {
  float a = exp(-max(y0, -500.0) / H);
  if (abs(dy) < 1e-4) return dist * a;
  float y1 = y0 + dy * dist;
  return H / dy * (a - exp(-max(y1, -500.0) / H));
}

vec3 stars(vec3 d) {
  vec3 p = d * 220.0;
  vec3 c = floor(p);
  float h = hash13(c);
  float s = 0.0;
  if (h > 0.9965) {
    vec3 f = fract(p) - 0.5;
    float r = length(f);
    float tw = 0.7 + 0.3 * sin(uTime * (2.0 + h * 9.0) + h * 40.0);
    s = smoothstep(0.12, 0.0, r) * (h - 0.9965) * 300.0 * tw;
  }
  // faint milky band
  float band = exp(-pow(dot(d, normalize(vec3(0.3, 0.5, 0.8))) * 3.0, 2.0)) * 0.012;
  vec3 col = mix(vec3(0.8, 0.85, 1.0), vec3(1.0, 0.85, 0.7), fract(h * 91.7));
  return col * s + vec3(0.6, 0.65, 0.8) * band;
}

vec3 skyColor(vec3 rd) {
  vec3 c = texture2D(uSkyLut, skyLutUV(rd)).rgb;
  // sun disk with limb darkening
  float mu = dot(rd, uSunDir);
  float sunR = 0.99996;
  if (mu > sunR - 0.00003) {
    float x = clamp((mu - sunR) / (1.0 - sunR), 0.0, 1.0);
    float limb = 0.55 + 0.45 * sqrt(x);
    c += uSunColor * 2600.0 * smoothstep(sunR - 0.00003, sunR, mu) * limb * uSunVisible;
  }
  // moon
  float mm = dot(rd, uMoonDir);
  if (mm > 0.99985) {
    vec3 mc = vec3(0.9, 0.92, 1.0) * 0.6 * uMoonPhase;
    c += mc * smoothstep(0.99985, 0.9999, mm);
  }
  c += vec3(0.7, 0.75, 0.9) * pow(max(mm, 0.0), 2000.0) * 0.05 * uNight;
  // stars fade in at night
  float starVis = uNight * (1.0 - uOvercast) * smoothstep(-0.05, 0.15, rd.y);
  c += stars(rd) * starVis;
  // overcast dome
  c = mix(c, uOvercastColor * (0.75 + 0.25 * max(rd.y, 0.0)), uOvercast * smoothstep(-0.1, 0.05, rd.y));
  return c;
}

void main() {
  vec3 col = texture2D(tScene, vUv).rgb;
  float d = texture2D(tDepth, vUv).r;
  bool isSky = uReversed > 0.5 ? d <= 0.0 : d >= 1.0;
  vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, uReversed > 0.5 ? max(d, 1e-7) : d * 2.0 - 1.0, 1.0);
  vec3 viewPos = vp.xyz / vp.w;
  vec3 rd = normalize((uCamWorld * vec4(viewPos, 0.0)).xyz);
  if (isSky) {
    col = skyColor(rd);
    // heavy fog still veils the sky
    float fogOD = uFogDensity * odExp(uCamPos.y - uFogBase, rd.y, 80000.0, uFogHeight);
    col = mix(uFogColor, col, exp(-fogOD));
  } else {
    float dist = length(viewPos);
    // aerial perspective: transmittance along the ray (exponential atmosphere)
    float y0 = uCamPos.y;
    float odR = odExp(y0, rd.y, dist, 8000.0);
    float odM = odExp(y0, rd.y, dist, 1200.0) * uMie;
    vec3 T = exp(-(BETA_R * odR + BETA_M * odM));
    // inscatter scaled from the LUT radiance along the same direction
    vec3 lutDir = vec3(rd.x, max(rd.y, -0.25), rd.z);
    vec3 skyL = texture2D(uSkyLut, skyLutUV(lutDir)).rgb;
    float fullOdR = odExp(y0, rd.y, 300000.0, 8000.0);
    float fullOdM = odExp(y0, rd.y, 300000.0, 1200.0) * uMie;
    vec3 Tfull = exp(-(BETA_R * fullOdR + BETA_M * fullOdM));
    vec3 inscatter = skyL * (1.0 - T) / max(1.0 - Tfull, vec3(1e-3));
    inscatter = mix(inscatter, uOvercastColor * (1.0 - T) * 0.9, uOvercast * 0.8);
    col = col * T + inscatter;
    // weather fog / mist layer
    float fogOD = uFogDensity * odExp(y0 - uFogBase, rd.y, dist, uFogHeight);
    float fT = exp(-fogOD);
    col = mix(uFogColor, col, fT);
  }
  // clouds (premultiplied: rgb = inscattered light, a = transmittance).
  // Low-res cloud texels are only applied where the cloud lies beyond the
  // surface; nearby geometry gets an analytic full-resolution in-cloud fog.
  float sceneDist = isSky ? 1e9 : length(viewPos);
  if (uCloudsOn > 0.5) {
    vec4 cl = texture2D(tClouds, vUv);
    float cd = texture2D(tCloudDepth, vUv).r;
    float apply = isSky ? 1.0 : smoothstep(0.6, 1.0, sceneDist / max(cd, 1.0));
    if (sceneDist < 250.0) apply *= smoothstep(120.0, 250.0, sceneDist);
    col = mix(col, col * cl.a + cl.rgb, apply);
  }
  if (uCamCloud > 0.0) {
    float d = min(sceneDist, 250.0);
    float T = exp(-uCamCloud * d);
    col = mix(uCloudFogColor, col, T);
  }
  col += uFlash * vec3(0.6, 0.65, 0.8) * 0.15;
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;
