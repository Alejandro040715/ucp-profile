// Post-processing shaders: physically based bloom (13-tap downsample / tent
// upsample), depth of field, camera motion blur and the final pass (heat
// distortion, lens effects, G-force vision, tone mapping, grading, grain).

export const downsampleFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uFirst;
uniform float uThreshold;
vec3 karis(vec3 c) { return c / (1.0 + max(max(c.r, c.g), c.b) * 0.25); }
void main() {
  vec2 t = uTexel;
  vec3 a = texture2D(tSrc, vUv + t * vec2(-2, 2)).rgb;
  vec3 b = texture2D(tSrc, vUv + t * vec2(0, 2)).rgb;
  vec3 c = texture2D(tSrc, vUv + t * vec2(2, 2)).rgb;
  vec3 d = texture2D(tSrc, vUv + t * vec2(-2, 0)).rgb;
  vec3 e = texture2D(tSrc, vUv).rgb;
  vec3 f = texture2D(tSrc, vUv + t * vec2(2, 0)).rgb;
  vec3 g = texture2D(tSrc, vUv + t * vec2(-2, -2)).rgb;
  vec3 h = texture2D(tSrc, vUv + t * vec2(0, -2)).rgb;
  vec3 i = texture2D(tSrc, vUv + t * vec2(2, -2)).rgb;
  vec3 j = texture2D(tSrc, vUv + t * vec2(-1, 1)).rgb;
  vec3 k = texture2D(tSrc, vUv + t * vec2(1, 1)).rgb;
  vec3 l = texture2D(tSrc, vUv + t * vec2(-1, -1)).rgb;
  vec3 m = texture2D(tSrc, vUv + t * vec2(1, -1)).rgb;
  vec3 res;
  if (uFirst > 0.5) {
    // Karis average on the first mip to kill fireflies
    res = karis((a + b + d + e) * 0.25) * 0.125 + karis((b + c + e + f) * 0.25) * 0.125 +
          karis((d + e + g + h) * 0.25) * 0.125 + karis((e + f + h + i) * 0.25) * 0.125 +
          karis((j + k + l + m) * 0.25) * 0.5;
    res = max(res - uThreshold, vec3(0.0));
  } else {
    res = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(res, 1.0);
}
`;

export const upsampleFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;   // lower mip (being upsampled)
uniform sampler2D tBase;  // current mip
uniform vec2 uTexel;
uniform float uRadius;
void main() {
  vec2 t = uTexel * uRadius;
  vec3 s = texture2D(tSrc, vUv + vec2(-t.x, t.y)).rgb + texture2D(tSrc, vUv + vec2(0, t.y)).rgb * 2.0 + texture2D(tSrc, vUv + vec2(t.x, t.y)).rgb
         + texture2D(tSrc, vUv + vec2(-t.x, 0)).rgb * 2.0 + texture2D(tSrc, vUv).rgb * 4.0 + texture2D(tSrc, vUv + vec2(t.x, 0)).rgb * 2.0
         + texture2D(tSrc, vUv + vec2(-t.x, -t.y)).rgb + texture2D(tSrc, vUv + vec2(0, -t.y)).rgb * 2.0 + texture2D(tSrc, vUv + vec2(t.x, -t.y)).rgb;
  gl_FragColor = vec4(texture2D(tBase, vUv).rgb + s / 16.0, 1.0);
}
`;

// Depth of field (gather, CoC from physical camera model) + optional motion blur.
export const dofMotionFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform mat4 uPrevViewProj;
uniform vec3 uCamPos;
uniform float uReversed;
uniform float uFocus;      // m
uniform float uAperture;   // f-number
uniform float uFocal;      // mm
uniform float uDofOn;
uniform float uMotion;     // shutter fraction (0 = off)
uniform vec2 uTexel;
uniform float uAspect;

vec3 viewPosAt(vec2 uv) {
  float d = texture2D(tDepth, uv).r;
  vec4 vp = uInvProj * vec4(uv * 2.0 - 1.0, uReversed > 0.5 ? max(d, 1e-7) : d * 2.0 - 1.0, 1.0);
  return vp.xyz / vp.w;
}
float coc(float z) {
  // thin lens: c = A f (z - S) / (z (S - f)), sensor 36mm wide
  float f = uFocal * 0.001;
  float A = f / uAperture;
  float c = abs(A * f * (z - uFocus) / max(z * (uFocus - f), 1e-4));
  return clamp(c / 0.036 * 0.5, 0.0, 0.025); // in uv units
}
void main() {
  vec3 col = texture2D(tSrc, vUv).rgb;
  vec3 vp = viewPosAt(vUv);
  float z = length(vp);
  if (uDofOn > 0.5) {
    float c0 = coc(z);
    vec3 acc = col;
    float wsum = 1.0;
    const int TAPS = 48;
    for (int i = 0; i < TAPS; i++) {
      float fi = float(i) + 0.5;
      float r = sqrt(fi / float(TAPS));
      float th = fi * 2.39996323;
      vec2 o = vec2(cos(th), sin(th)) * r * vec2(1.0 / uAspect, 1.0) * max(c0, 0.0005);
      vec2 suv = vUv + o;
      float zs = length(viewPosAt(suv));
      float cs = coc(zs);
      // background samples only contribute if their own CoC covers us
      float w = zs < z ? smoothstep(0.0, 1.0, cs / max(length(o), 1e-5)) : 1.0;
      acc += texture2D(tSrc, suv).rgb * w;
      wsum += w;
    }
    col = acc / wsum;
  }
  if (uMotion > 0.0) {
    vec3 wp = (uCamWorld * vec4(vp, 1.0)).xyz;
    vec4 pc = uPrevViewProj * vec4(wp, 1.0);
    vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
    vec2 vel = (vUv - puv) * uMotion;
    float len = length(vel / uTexel);
    if (len > 1.0) {
      vec3 acc = col;
      for (int i = 1; i < 10; i++) {
        float t = float(i) / 9.0 - 0.5;
        acc += texture2D(tSrc, vUv + vel * t).rgb;
      }
      col = acc / 10.0;
    }
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export const finalFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform sampler2D tBloom;
uniform sampler2D tDistort;
uniform float uExposure;
uniform float uBloom;
uniform float uVignette;
uniform float uGrain;
uniform float uTime;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uTint;
uniform float uChroma;
uniform float uGPos;       // 0..1 positive-G vision loss
uniform float uGNeg;       // 0..1 negative-G redout
uniform float uGray;       // greyout desaturation
uniform vec3 uSunScreen;   // xy uv, z visibility*intensity
uniform float uAspect;
uniform float uWetLens;    // cockpit rain veil (subtle)
uniform float uFade;       // fade to black
uniform float uHeat;
uniform sampler2D tDepth;
uniform float uReversed;
float sunOcclusion(vec2 sp) {
  // fraction of samples around the sun position that see the sky
  float vis = 0.0;
  for (int i = 0; i < 9; i++) {
    vec2 o = vec2(float(i % 3) - 1.0, float(i / 3) - 1.0) * 0.006;
    float d = texture2D(tDepth, sp + o).r;
    vis += (uReversed > 0.5 ? step(d, 0.0) : step(1.0, d));
  }
  return vis / 9.0;
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

vec3 acesFitted(vec3 v) {
  const mat3 ACESIn = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 ACESOut = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  v = ACESIn * v;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  v = a / b;
  return clamp(ACESOut * v, 0.0, 1.0);
}
vec3 srgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 uv = vUv;
  // heat haze distortion
  vec2 dist = texture2D(tDistort, uv).rg;
  uv += dist * uHeat;
  vec2 cc = uv - 0.5;
  // subtle lateral chromatic aberration towards the edges
  float ca = uChroma * dot(cc, cc);
  vec3 col;
  col.r = texture2D(tSrc, uv - cc * ca).r;
  col.g = texture2D(tSrc, uv).g;
  col.b = texture2D(tSrc, uv + cc * ca).b;
  col += texture2D(tBloom, uv).rgb * uBloom;

  // sun glare: streaks + ghosts when the sun is on screen and unoccluded
  float sunVis = uSunScreen.z > 0.001 ? sunOcclusion(uSunScreen.xy) : 0.0;
  if (sunVis > 0.001) {
    vec2 sp = uSunScreen.xy;
    vec2 d = (uv - sp) * vec2(uAspect, 1.0);
    float r = length(d);
    float glare = exp(-r * 9.0) * 0.6 + exp(-r * 2.2) * 0.12;
    float streak = exp(-abs(d.y) * 220.0) * exp(-abs(d.x) * 3.0) * 0.25;
    vec3 gl = vec3(1.0, 0.9, 0.75) * (glare + streak);
    // ghosts along the axis through the centre
    vec2 axis = 0.5 - sp;
    for (int i = 1; i <= 4; i++) {
      vec2 gp = sp + axis * (float(i) * 0.55);
      float gr = length((uv - gp) * vec2(uAspect, 1.0));
      float sz = 0.02 + 0.03 * float(i);
      gl += vec3(0.25, 0.45, 0.6) * smoothstep(sz, sz * 0.6, gr) * 0.05 / float(i);
    }
    col += gl * uSunScreen.z * sunVis;
  }

  col *= uExposure;
  // grading before tone mapping
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSaturation);
  col *= uTint;
  col = acesFitted(col);
  col = pow(col, vec3(uContrast));

  // G effects: tunnel vision and greyout (positive), red tint (negative)
  float rr = length(cc * vec2(uAspect, 1.0));
  float tunnel = smoothstep(0.95 - uGPos * 0.75, 0.25 - uGPos * 0.2, rr);
  col *= mix(1.0, tunnel, uGPos);
  float gl2 = dot(col, vec3(0.3, 0.59, 0.11));
  col = mix(col, vec3(gl2), uGray);
  col = mix(col, col * vec3(1.0, 0.35, 0.3) + vec3(0.08, 0.0, 0.0), uGNeg);

  // vignette
  col *= mix(1.0, smoothstep(1.25, 0.35, rr), uVignette);
  col = srgb(col);
  // film grain (applied in display space)
  float n = hash(vUv * 1000.0 + fract(uTime * 7.13)) - 0.5;
  col += n * uGrain;
  col *= 1.0 - uFade;
  gl_FragColor = vec4(col, 1.0);
}
`;
