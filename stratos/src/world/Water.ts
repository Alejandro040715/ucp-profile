// Water bodies: camera-following sea (radial grid out to the horizon, curved
// with the earth), the mountain-fed river ribbon and the lake. Shared PBR
// water shading: multi-octave scrolling normals scaled by wind, depth-based
// absorption colour, shoreline foam, whitecaps, rain ripples, sky reflection
// through the environment map and sun glints via the CSM key light.

import { BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh, MeshStandardMaterial, type Scene, Vector2 } from 'three';
import { globals } from '../render/Globals.ts';
import { worldMaterial, type ShaderHook } from '../render/Materials.ts';
import { sunOcclusionHook, terrainUniforms } from './TerrainMaterial.ts';
import { LAKE, RIVER } from './WorldLayout.ts';
import { SimplexNoise } from '../core/Noise.ts';

export const waterUniforms = {
  uWaterWind: { value: 5 },
  uRain: { value: 0 },
  uWaveDir: { value: new Vector2(0.7, 0.7) },
};

function waterHook(level: number, kind: number): ShaderHook {
  return (shader) => {
    Object.assign(shader.uniforms, waterUniforms);
    shader.uniforms.uNoiseTex = globals.uNoiseTex;
    shader.uniforms.uTime = globals.uTime;
    shader.uniforms.uHeightTex = terrainUniforms.uHeightTex;
    shader.uniforms.uHeightTexRect = terrainUniforms.uHeightTexRect;
    shader.uniforms.uSunDir = globals.uSunDir;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWW;\nattribute float flow;\nvarying float vFlow;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvFlow = flow;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vWW;
        varying float vFlow;
        uniform sampler2D uNoiseTex;
        uniform sampler2D uHeightTex;
        uniform vec4 uHeightTexRect;
        uniform float uTime;
        uniform float uWaterWind;
        uniform float uRain;
        uniform vec2 uWaveDir;
        float wRough; vec3 wN; float wFoam;
        vec2 wGrad(vec2 p, float scale, vec2 vel, float amp) {
          vec2 uv = p / scale + vel * uTime / scale;
          float e = 1.0 / 256.0;
          float h0 = texture2D(uNoiseTex, uv).g;
          float hx = texture2D(uNoiseTex, uv + vec2(e, 0.0)).g;
          float hz = texture2D(uNoiseTex, uv + vec2(0.0, e)).g;
          return vec2(hx - h0, hz - h0) * amp / (e * scale);
        }
        float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        `,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        {
          vec2 p = vWW.xz;
          float dist = length(vWW - cameraPosition);
          float wind = clamp(uWaterWind, 0.5, 25.0);
          vec2 dir = normalize(uWaveDir);
          vec2 perp = vec2(-dir.y, dir.x);
          float k = ${kind.toFixed(1)}; // 0 sea, 1 lake, 2 river
          float ampScale = k < 0.5 ? 1.0 : k < 1.5 ? 0.45 : 0.3;
          vec2 g = vec2(0.0);
          g += wGrad(p, 180.0, dir * wind * 0.9, 0.9 * wind / 10.0 * ampScale);
          g += wGrad(p * mat2(0.8, 0.6, -0.6, 0.8), 47.0, (dir + perp * 0.4) * wind * 0.5, 0.5 * ampScale);
          g += wGrad(p * mat2(0.6, -0.8, 0.8, 0.6), 11.0, (dir - perp * 0.5) * 1.6, 0.25);
          g += wGrad(p, 2.9, dir * 0.8, 0.12 * (1.0 + uRain));
          // river: flow-aligned ripples
          if (k > 1.5) g += wGrad(p, 6.0, vec2(0.0, 2.0), 0.3);
          float fade = 1.0 - smoothstep(800.0, 20000.0, dist);
          g *= mix(0.25, 1.0, fade);
          // rain ripples: expanding rings in a jittered grid
          if (uRain > 0.01 && dist < 120.0) {
            vec2 cell = floor(p / 1.2);
            vec2 f = fract(p / 1.2) - 0.5;
            for (int i = 0; i < 2; i++) {
              vec2 c = cell + float(i) * 0.37;
              float t = fract(uTime * 0.9 + hash21(c));
              vec2 o = vec2(hash21(c + 1.3), hash21(c + 7.1)) - 0.5;
              float r = length(f - o * 0.6);
              float ring = sin((r - t * 0.5) * 60.0) * exp(-r * 6.0) * (1.0 - t);
              g += (f - o) / max(r, 1e-3) * ring * 0.15 * uRain;
            }
          }
          wN = normalize(vec3(-g.x, 1.0, -g.y));
          // water depth from the terrain heightmap (coarse) -> absorption colour + foam
          vec2 huv = (p - uHeightTexRect.xy) / uHeightTexRect.zw;
          float ground = texture2D(uHeightTex, huv).r;
          float depth = max(0.0, ${level.toFixed(2)} - ground);
          if (k > 0.5) depth = k > 1.5 ? 2.5 : 18.0;
          vec3 deep = k < 0.5 ? vec3(0.004, 0.018, 0.03) : vec3(0.006, 0.02, 0.018);
          vec3 shallow = k < 0.5 ? vec3(0.02, 0.09, 0.085) : vec3(0.03, 0.06, 0.04);
          vec3 col = mix(shallow, deep, smoothstep(0.0, 25.0, depth));
          if (k > 1.5) col = vec3(0.025, 0.045, 0.035) + vec3(0.03, 0.025, 0.015) * (0.5 + 0.5 * sin(p.x * 0.01));
          // whitecaps in strong wind
          float cap = smoothstep(0.62, 0.8, texture2D(uNoiseTex, p / 37.0 + dir * uTime * 0.03).b) * smoothstep(9.0, 18.0, wind) * ampScale;
          // shore foam (sea only, coarse depth)
          float shore = k < 0.5 ? (1.0 - smoothstep(0.0, 3.0, depth)) * (0.5 + 0.5 * sin(uTime * 1.3 - depth * 2.0 + texture2D(uNoiseTex, p / 20.0).r * 6.0)) : 0.0;
          wFoam = clamp(cap + shore * 0.6, 0.0, 1.0) * fade;
          col = mix(col, vec3(0.75, 0.78, 0.8), wFoam);
          wRough = mix(0.035 + wind * 0.004, 0.6, wFoam) + uRain * 0.05;
          diffuseColor.rgb = col;
        }`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = wRough;')
      .replace(
        '#include <normal_fragment_maps>',
        `normal = normalize((viewMatrix * vec4(wN, 0.0)).xyz);`,
      );
  };
}

function waterMaterial(level: number, kind: number): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color: 0x0a1a24, roughness: 0.05, metalness: 0.0, side: DoubleSide });
  m.envMapIntensity = 1.0;
  return worldMaterial(m, { key: `water${kind}`, hooks: [waterHook(level, kind), sunOcclusionHook] });
}

/** Radial grid: dense near the centre, out to `radius`. */
function radialGrid(radius: number, rings: number, segs: number): BufferGeometry {
  const pos: number[] = [0, 0, 0];
  const idx: number[] = [];
  for (let r = 1; r <= rings; r++) {
    const rad = radius * Math.pow(r / rings, 2.6);
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      pos.push(Math.cos(a) * rad, 0, Math.sin(a) * rad);
    }
  }
  for (let s = 0; s < segs; s++) idx.push(0, 1 + ((s + 1) % segs), 1 + s);
  for (let r = 1; r < rings; r++) {
    const a0 = 1 + (r - 1) * segs, a1 = 1 + r * segs;
    for (let s = 0; s < segs; s++) {
      const s1 = (s + 1) % segs;
      idx.push(a0 + s, a0 + s1, a1 + s, a0 + s1, a1 + s1, a1 + s);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  const n = new Float32Array(pos.length);
  for (let i = 1; i < n.length; i += 3) n[i] = 1;
  g.setAttribute('normal', new BufferAttribute(n, 3));
  g.setAttribute('flow', new BufferAttribute(new Float32Array(pos.length / 3), 1));
  g.setIndex(idx);
  return g;
}

export class Water {
  readonly sea: Mesh;
  readonly lake: Mesh;
  readonly river: Mesh;

  constructor(scene: Scene) {
    this.sea = new Mesh(radialGrid(320000, 90, 128), waterMaterial(0, 0));
    this.sea.frustumCulled = false;
    this.sea.receiveShadow = true;
    scene.add(this.sea);

    // lake: ellipse disc slightly larger than the shoreline
    const lg = radialGrid(1, 24, 96);
    const lp = lg.attributes.position;
    const rot = (LAKE.rotation * Math.PI) / 180;
    for (let i = 0; i < lp.count; i++) {
      const x = lp.getX(i) * LAKE.radii[0] * 1.35, z = lp.getZ(i) * LAKE.radii[1] * 1.35;
      lp.setXYZ(i, LAKE.center[0] + x * Math.cos(rot) - z * Math.sin(rot), LAKE.level, LAKE.center[1] + x * Math.sin(rot) + z * Math.cos(rot));
    }
    lg.computeBoundingSphere();
    this.lake = new Mesh(lg, waterMaterial(LAKE.level, 1));
    this.lake.receiveShadow = true;
    scene.add(this.lake);

    this.river = new Mesh(buildRiverGeometry(), waterMaterial(0, 2));
    this.river.receiveShadow = true;
    scene.add(this.river);
  }

  update(camX: number, camZ: number, windSpeed: number, windDirTo: Vector2, rain: number): void {
    // snap the sea grid to avoid vertex swimming
    const snap = 200;
    this.sea.position.set(Math.round(camX / snap) * snap, 0, Math.round(camZ / snap) * snap);
    waterUniforms.uWaterWind.value = windSpeed;
    waterUniforms.uWaveDir.value.copy(windDirTo);
    waterUniforms.uRain.value = rain;
  }
}

function buildRiverGeometry(): BufferGeometry {
  const noise = new SimplexNoise(20251007);
  // replicate the meander displacement used by the height function
  const meander = (z: number) => 220 * noise.noise2(z / 2600, 7.1) + 60 * noise.noise2(z / 700, 3.3);
  const pts: { x: number; z: number; y: number; w: number }[] = [];
  for (let i = 0; i < RIVER.length - 1; i++) {
    const a = RIVER[i], b = RIVER[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.ceil(len / 20);
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const z = a.z + (b.z - a.z) * t;
      const x = a.x + (b.x - a.x) * t - meander(z);
      pts.push({ x, z, y: a.bed + (b.bed - a.bed) * t + 0.6, w: (a.width + (b.width - a.width) * t) * 0.66 });
    }
  }
  const pos = new Float32Array(pts.length * 2 * 3);
  const nrm = new Float32Array(pts.length * 2 * 3);
  const flow = new Float32Array(pts.length * 2);
  const idx: number[] = [];
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[Math.min(pts.length - 1, i + 1)];
    const o = pts[Math.max(0, i - 1)];
    let dx = q.x - o.x, dz = q.z - o.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    const px = -dz, pz = dx;
    pos.set([p.x + px * p.w, p.y, p.z + pz * p.w, p.x - px * p.w, p.y, p.z - pz * p.w], i * 6);
    nrm.set([0, 1, 0, 0, 1, 0], i * 6);
    if (i > 0) acc += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
    flow[i * 2] = flow[i * 2 + 1] = acc;
    if (i < pts.length - 1) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('flow', new BufferAttribute(flow, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export const _c = new Color();
