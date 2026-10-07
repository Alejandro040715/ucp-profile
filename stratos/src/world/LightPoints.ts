// Point light sprites for runway / taxiway / city / obstruction lights.
// Rendered in the forward FX pass with a manual depth test, distance-correct
// size, atmospheric dimming, optional directionality (e.g. PAPI colour
// depends on the viewing angle) and blinking / sequenced flashing.

import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial, Vector3 } from 'three';
import { CURVATURE_GLSL, globals, FX_DEPTH_GLSL, fxDepth } from '../render/Globals.ts';

export interface LightDef {
  pos: [number, number, number];
  color: [number, number, number];
  size: number; // physical glow size (m)
  intensity: number;
  /** 0 = omni; otherwise light faces this horizontal direction (degrees heading), with a forward lobe */
  dir?: number;
  /** blink: period (s), phase (0..1), duty; strobe if duty small */
  blink?: [number, number, number];
  /** PAPI box: glide slope angle (deg) — colour switches red/white across it */
  papi?: number;
  /** emit even in daylight (obstruction strobes, approach flashers) */
  day?: boolean;
}

const vert = /* glsl */ `
attribute vec3 color;
attribute vec4 params;   // size, intensity, dirHeading(rad or -10 = omni), papiAngle (rad or 0)
attribute vec4 blink;    // period, phase, duty, day
uniform float uTime;
uniform float uLightsOn;
uniform float uPixelScale;
uniform float uMaxPx;
uniform vec3 uCamPos;
varying vec3 vColor;
varying float vAlpha;
varying float vViewZ;
${CURVATURE_GLSL}
void main() {
  vec3 wp = applyCurvature((modelMatrix * vec4(position, 1.0)).xyz);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = length(mv.xyz);
  vViewZ = -mv.z;
  vec3 toCam = normalize(uCamPos - wp);
  float on = mix(uLightsOn, 1.0, blink.w);
  float inten = params.y * on;
  // directional lobe
  if (params.z > -5.0) {
    vec2 fdir = vec2(sin(params.z), -cos(params.z));
    float c = dot(normalize(toCam.xz), fdir);
    inten *= smoothstep(-0.2, 0.6, c) * smoothstep(-0.05, 0.03, toCam.y);
  }
  vec3 col = color;
  // PAPI: white when above the glide slope, red below
  if (params.w > 0.0) {
    float el = asin(clamp(toCam.y, -1.0, 1.0));
    col = mix(vec3(1.0, 0.05, 0.02), vec3(1.0, 0.95, 0.85), smoothstep(params.w - 0.002, params.w + 0.002, el));
  }
  // blinking / strobes
  if (blink.x > 0.0) {
    float ph = fract(uTime / blink.x + blink.y);
    inten *= step(ph, blink.z);
  }
  // atmospheric extinction by distance (coarse)
  inten *= exp(-dist / 45000.0);
  vColor = col * inten;
  vAlpha = inten;
  // physical size projected, clamped to a minimum so lights stay visible far away
  float px = params.x / max(dist, 1.0) * uPixelScale;
  gl_PointSize = clamp(px * 3.0, 2.0, uMaxPx) * step(0.001, inten);
  // brightness compensation when the sprite is clamped to the minimum size
  vColor *= clamp(px * 3.0 / 2.0, 0.15, 1.0) * 1.6;
}
`;

const frag = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vViewZ;
${FX_DEPTH_GLSL}
void main() {
  float sd = sceneViewDepth(gl_FragCoord.xy);
  if (vViewZ > sd + 0.5) discard;
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = dot(c, c);
  if (r > 1.0) discard;
  float core = exp(-r * 18.0) * 6.0;
  float halo = exp(-r * 4.0) * 0.8;
  gl_FragColor = vec4(vColor * (core + halo), 1.0);
}
`;

export class LightPoints {
  readonly points: Points;
  readonly material: ShaderMaterial;

  constructor(lights: LightDef[]) {
    const n = lights.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const par = new Float32Array(n * 4);
    const bl = new Float32Array(n * 4);
    lights.forEach((l, i) => {
      pos.set(l.pos, i * 3);
      col.set(l.color, i * 3);
      par[i * 4] = l.size;
      par[i * 4 + 1] = l.intensity;
      par[i * 4 + 2] = l.dir !== undefined ? (l.dir * Math.PI) / 180 : -10;
      par[i * 4 + 3] = l.papi ? (l.papi * Math.PI) / 180 : 0;
      if (l.blink) {
        bl[i * 4] = l.blink[0];
        bl[i * 4 + 1] = l.blink[1];
        bl[i * 4 + 2] = l.blink[2];
      }
      bl[i * 4 + 3] = l.day ? 1 : 0;
    });
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('color', new BufferAttribute(col, 3));
    g.setAttribute('params', new BufferAttribute(par, 4));
    g.setAttribute('blink', new BufferAttribute(bl, 4));
    g.computeBoundingSphere();
    this.material = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uTime: globals.uTime,
        uLightsOn: globals.uLightsOn,
        uPixelScale: { value: 1000 },
        uMaxPx: { value: 28 },
        uCamPos: globals.uCurvOrigin,
        uCurvOrigin: globals.uCurvOrigin,
        ...fxDepth,
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.points = new Points(g, this.material);
    this.points.frustumCulled = false;
  }

  /** pixels per radian at the current resolution/FOV */
  setPixelScale(heightPx: number, fovDeg: number): void {
    this.material.uniforms.uPixelScale.value = heightPx / ((fovDeg * Math.PI) / 180);
  }
}

export const _unused = new Vector3();
