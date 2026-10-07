// CPU-simulated, GPU-rendered particle system (ring buffer of camera-facing
// billboards). Soft particles: each fragment fades against the scene depth.
// Supports lit smoke (sun + ambient), additive fire/sparks and drag/buoyancy.

import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry,
  Mesh, NormalBlending, ShaderMaterial, Vector3,
} from 'three';
import { CURVATURE_GLSL, FX_DEPTH_GLSL, fxDepth, globals } from '../render/Globals.ts';

export interface ParticleOptions {
  max: number;
  additive: boolean;
  /** 0 = smoke puff, 1 = soft glow, 2 = spark streak */
  shape: number;
  drag: number; // 1/s
  buoyancy: number; // m/s^2 upward
  lit: boolean;
}

const vert = /* glsl */ `
attribute vec4 iPos;     // xyz, size
attribute vec4 iColor;   // rgb, alpha
attribute vec4 iMisc;    // rotation, stretch, age01, seed
attribute vec3 iVel;
varying vec2 vUv;
varying vec4 vColor;
varying vec4 vMisc;
varying float vViewZ;
varying vec3 vWorld;
${CURVATURE_GLSL}
void main() {
  vUv = position.xy + 0.5;
  vColor = iColor;
  vMisc = iMisc;
  vec3 wp = applyCurvature(iPos.xyz);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vec2 off = position.xy * iPos.w;
  float c = cos(iMisc.x), s = sin(iMisc.x);
  off = vec2(c * off.x - s * off.y, s * off.x + c * off.y);
  // velocity-aligned stretching (sparks, streaks)
  if (iMisc.y > 0.0) {
    vec3 vv = (viewMatrix * vec4(iVel, 0.0)).xyz;
    vec2 d = normalize(vv.xy + 1e-5);
    vec2 n = vec2(-d.y, d.x);
    off = d * position.y * iPos.w * (1.0 + iMisc.y) + n * position.x * iPos.w * 0.35;
  }
  mv.xy += off;
  vViewZ = -mv.z;
  vWorld = wp;
  gl_Position = projectionMatrix * mv;
}`;

const frag = /* glsl */ `
uniform sampler2D uNoiseTex;
uniform float uShape;
uniform float uLit;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
uniform float uSoft;
varying vec2 vUv;
varying vec4 vColor;
varying vec4 vMisc;
varying float vViewZ;
varying vec3 vWorld;
${FX_DEPTH_GLSL}
void main() {
  float sd = sceneViewDepth(gl_FragCoord.xy);
  if (vViewZ > sd) discard;
  float soft = clamp((sd - vViewZ) / uSoft, 0.0, 1.0);
  vec2 c = vUv - 0.5;
  float r = length(c) * 2.0;
  float a;
  vec3 col = vColor.rgb;
  if (uShape < 0.5) {
    // billowing smoke puff: noise-eroded disc
    float n = texture2D(uNoiseTex, vUv * 0.6 + vMisc.w * 7.3).r * 0.6 + texture2D(uNoiseTex, vUv * 1.7 - vMisc.w * 3.1).g * 0.4;
    a = smoothstep(1.0, 0.25, r + (n - 0.5) * 0.7);
    if (uLit > 0.5) {
      // fake normal from the puff shape for directional lighting
      vec3 nrm = normalize(vec3(c * 1.6, sqrt(max(0.0, 0.5 - dot(c, c)))));
      float ndl = 0.45 + 0.55 * dot(nrm, normalize(vec3(uSunDir.x, uSunDir.y, 0.5)));
      col *= uSunColor * 0.28 * ndl + uSkyAmbient * 0.9;
    }
  } else if (uShape < 1.5) {
    a = exp(-r * r * 3.5);
  } else {
    a = smoothstep(1.0, 0.0, r);
  }
  a *= vColor.a * soft;
  if (a < 0.003) discard;
  gl_FragColor = uLit > 0.5 || uShape < 0.5 ? vec4(col * a, a) : vec4(col * a, a);
}`;

export class ParticleSystem {
  readonly mesh: Mesh;
  private max: number;
  private head = 0;
  private pos: Float32Array;
  private col: Float32Array;
  private misc: Float32Array;
  private vel: Float32Array;
  // simulation state
  private life: Float32Array;
  private age: Float32Array;
  private grow: Float32Array;
  private baseAlpha: Float32Array;
  private spin: Float32Array;
  readonly opts: ParticleOptions;
  alive = 0;

  constructor(opts: ParticleOptions) {
    this.opts = opts;
    this.max = opts.max;
    const quad = new BufferGeometry();
    quad.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    const g = new InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.attributes.position);
    const n = this.max;
    this.pos = new Float32Array(n * 4);
    this.col = new Float32Array(n * 4);
    this.misc = new Float32Array(n * 4);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.age = new Float32Array(n).fill(1e9);
    this.grow = new Float32Array(n);
    this.baseAlpha = new Float32Array(n);
    this.spin = new Float32Array(n);
    const mk = (a: Float32Array, size: number) => {
      const attr = new InstancedBufferAttribute(a, size);
      attr.setUsage(DynamicDrawUsage);
      return attr;
    };
    g.setAttribute('iPos', mk(this.pos, 4));
    g.setAttribute('iColor', mk(this.col, 4));
    g.setAttribute('iMisc', mk(this.misc, 4));
    g.setAttribute('iVel', mk(this.vel, 3));
    g.instanceCount = n;
    const mat = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uNoiseTex: globals.uNoiseTex,
        uShape: { value: opts.shape },
        uLit: { value: opts.lit ? 1 : 0 },
        uSunDir: globals.uSunDir,
        uSunColor: globals.uSunColor,
        uSkyAmbient: globals.uSkyAmbient,
        uSoft: { value: opts.shape === 0 ? 2.5 : 0.6 },
        uCurvOrigin: globals.uCurvOrigin,
        ...fxDepth,
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: opts.additive ? AdditiveBlending : NormalBlending,
      premultipliedAlpha: true,
    });
    this.mesh = new Mesh(g, mat);
    this.mesh.frustumCulled = false;
  }

  emit(p: Vector3, v: Vector3, size: number, grow: number, life: number, color: Color, alpha: number, stretch = 0): void {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    this.pos[i * 4] = p.x;
    this.pos[i * 4 + 1] = p.y;
    this.pos[i * 4 + 2] = p.z;
    this.pos[i * 4 + 3] = size;
    this.vel[i * 3] = v.x;
    this.vel[i * 3 + 1] = v.y;
    this.vel[i * 3 + 2] = v.z;
    this.col[i * 4] = color.r;
    this.col[i * 4 + 1] = color.g;
    this.col[i * 4 + 2] = color.b;
    this.col[i * 4 + 3] = alpha;
    this.misc[i * 4] = Math.random() * 6.28;
    this.misc[i * 4 + 1] = stretch;
    this.misc[i * 4 + 2] = 0;
    this.misc[i * 4 + 3] = Math.random();
    this.life[i] = life;
    this.age[i] = 0;
    this.grow[i] = grow;
    this.baseAlpha[i] = alpha;
    this.spin[i] = (Math.random() - 0.5) * 0.6;
  }

  update(dt: number, wind: Vector3): void {
    const drag = Math.exp(-this.opts.drag * dt);
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.age[i] >= this.life[i]) {
        this.col[i * 4 + 3] = 0;
        continue;
      }
      alive++;
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      // velocity relaxes towards the wind, buoyancy lifts hot smoke
      for (let k = 0; k < 3; k++) {
        const w = k === 0 ? wind.x : k === 1 ? wind.y : wind.z;
        this.vel[i * 3 + k] = w + (this.vel[i * 3 + k] - w) * drag;
      }
      this.vel[i * 3 + 1] += this.opts.buoyancy * dt;
      this.pos[i * 4] += this.vel[i * 3] * dt;
      this.pos[i * 4 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 4 + 2] += this.vel[i * 3 + 2] * dt;
      this.pos[i * 4 + 3] += this.grow[i] * dt;
      this.misc[i * 4] += this.spin[i] * dt;
      this.misc[i * 4 + 2] = t;
      // fade in quickly, out slowly
      this.col[i * 4 + 3] = this.baseAlpha[i] * Math.min(1, t * 8) * (1 - t) * (1 - t);
    }
    this.alive = alive;
    const g = this.mesh.geometry as InstancedBufferGeometry;
    for (const name of ['iPos', 'iColor', 'iMisc', 'iVel']) (g.attributes[name] as InstancedBufferAttribute).needsUpdate = true;
  }
}
