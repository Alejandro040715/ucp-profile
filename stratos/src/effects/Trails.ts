// Camera-facing ribbon trails (contrails, wingtip vortices, smoke trails).
// Points are pushed into a ring buffer with their birth time; width growth
// and fade happen in the shader so updates are cheap.

import { BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, Mesh, NormalBlending, ShaderMaterial, Vector3 } from 'three';
import { CURVATURE_GLSL, FX_DEPTH_GLSL, fxDepth, globals } from '../render/Globals.ts';

const vert = /* glsl */ `
attribute vec3 center;
attribute vec3 tangent;
attribute float side;
attribute float birth;
attribute float strength;
uniform float uNow;
uniform float uLife;
uniform float uWidth0;
uniform float uWidth1;
varying float vAge;
varying float vSide;
varying float vStrength;
varying float vViewZ;
varying float vU;
${CURVATURE_GLSL}
void main() {
  float age = clamp((uNow - birth) / uLife, 0.0, 1.0);
  vAge = age;
  vSide = side;
  vStrength = strength;
  vec3 wp = applyCurvature(center);
  vec3 toCam = normalize(cameraPosition - wp);
  vec3 t = normalize(tangent + 1e-5);
  vec3 n = normalize(cross(t, toCam));
  float w = mix(uWidth0, uWidth1, sqrt(age));
  wp += n * side * w;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewZ = -mv.z;
  vU = birth;
  gl_Position = projectionMatrix * mv;
}`;

const frag = /* glsl */ `
uniform sampler2D uNoiseTex;
uniform vec3 uColor;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
uniform float uOpacity;
uniform float uNow;
varying float vAge;
varying float vSide;
varying float vStrength;
varying float vViewZ;
varying float vU;
${FX_DEPTH_GLSL}
void main() {
  float sd = sceneViewDepth(gl_FragCoord.xy);
  if (vViewZ > sd) discard;
  float soft = clamp((sd - vViewZ) / 3.0, 0.0, 1.0);
  float across = 1.0 - abs(vSide);
  float n = texture2D(uNoiseTex, vec2(vU * 0.8, vSide * 0.3 + 0.5)).r;
  float a = smoothstep(0.0, 0.6, across) * (1.0 - vAge) * (1.0 - vAge) * vStrength * uOpacity;
  a *= 0.6 + 0.8 * n;
  a *= smoothstep(0.0, 0.03, vAge);
  a *= soft;
  if (a < 0.003) discard;
  vec3 lit = uColor * (uSunColor * 0.3 + uSkyAmbient * 0.9);
  gl_FragColor = vec4(lit * a, a);
}`;

export class Trail {
  readonly mesh: Mesh;
  private n: number;
  private head = 0;
  private count = 0;
  private centers: Float32Array;
  private tangents: Float32Array;
  private births: Float32Array;
  private strengths: Float32Array;
  private last = new Vector3(Infinity, 0, 0);
  readonly material: ShaderMaterial;
  minStep: number;
  private geo: BufferGeometry;

  constructor(points: number, life: number, width0: number, width1: number, color: Color, opacity: number, minStep = 6) {
    this.n = points;
    this.minStep = minStep;
    const v = points * 2;
    this.centers = new Float32Array(v * 3);
    this.tangents = new Float32Array(v * 3);
    this.births = new Float32Array(v).fill(-1e9);
    this.strengths = new Float32Array(v);
    const side = new Float32Array(v);
    for (let i = 0; i < points; i++) {
      side[i * 2] = -1;
      side[i * 2 + 1] = 1;
    }
    const g = new BufferGeometry();
    const mk = (a: Float32Array, s: number) => {
      const b = new BufferAttribute(a, s);
      b.setUsage(DynamicDrawUsage);
      return b;
    };
    g.setAttribute('center', mk(this.centers, 3));
    g.setAttribute('position', mk(this.centers, 3));
    g.setAttribute('tangent', mk(this.tangents, 3));
    g.setAttribute('birth', mk(this.births, 1));
    g.setAttribute('strength', mk(this.strengths, 1));
    g.setAttribute('side', new BufferAttribute(side, 1));
    this.geo = g;
    this.material = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uNow: { value: 0 },
        uLife: { value: life },
        uWidth0: { value: width0 },
        uWidth1: { value: width1 },
        uColor: { value: color },
        uOpacity: { value: opacity },
        uNoiseTex: globals.uNoiseTex,
        uSunColor: globals.uSunColor,
        uSkyAmbient: globals.uSkyAmbient,
        uCurvOrigin: globals.uCurvOrigin,
        ...fxDepth,
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: NormalBlending,
      premultipliedAlpha: true,
    });
    this.mesh = new Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.rebuildIndex();
  }

  private rebuildIndex(): void {
    // segments between consecutive ring entries, skipping the wrap seam
    const idx: number[] = [];
    for (let k = 0; k < this.n - 1; k++) {
      const i = (this.head + k) % this.n, j = (this.head + k + 1) % this.n;
      idx.push(i * 2, j * 2, i * 2 + 1, i * 2 + 1, j * 2, j * 2 + 1);
    }
    this.geo.setIndex(idx);
  }

  /** add a point if the source moved far enough; strength 0 breaks the visible trail */
  push(p: Vector3, now: number, strength: number): void {
    this.material.uniforms.uNow.value = now;
    if (this.last.distanceToSquared(p) < this.minStep * this.minStep && this.count > 0) {
      // keep the newest point glued to the source
      const prev = (this.head - 1 + this.n) % this.n;
      for (const s of [0, 1]) this.centers.set([p.x, p.y, p.z], (prev * 2 + s) * 3);
      (this.geo.attributes.center as BufferAttribute).needsUpdate = true;
      (this.geo.attributes.position as BufferAttribute).needsUpdate = true;
      return;
    }
    const i = this.head;
    const prevIdx = (i - 1 + this.n) % this.n;
    const tx = p.x - this.centers[prevIdx * 6], ty = p.y - this.centers[prevIdx * 6 + 1], tz = p.z - this.centers[prevIdx * 6 + 2];
    for (const s of [0, 1]) {
      const v = i * 2 + s;
      this.centers.set([p.x, p.y, p.z], v * 3);
      this.tangents.set([tx, ty, tz], v * 3);
      this.births[v] = now;
      this.strengths[v] = strength;
    }
    this.last.copy(p);
    this.head = (this.head + 1) % this.n;
    this.count++;
    for (const name of ['center', 'position', 'tangent', 'birth', 'strength']) (this.geo.attributes[name] as BufferAttribute).needsUpdate = true;
    if (this.head % 8 === 0) this.rebuildIndex();
    else this.rebuildIndex();
  }

  tick(now: number): void {
    this.material.uniforms.uNow.value = now;
  }
}
