// Towns and roads: instanced buildings on a street grid (flat-roof blocks in
// the centres, pitched-roof houses at the edges) with procedural facades and
// lit windows at night, street lights, and terrain-following road ribbons
// with markings and simple night traffic.

import {
  BufferAttribute, BufferGeometry, BoxGeometry, Color, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, Mesh,
  MeshStandardMaterial, Quaternion, Vector3, type Scene, Points, ShaderMaterial, AdditiveBlending,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TOWNS, ROADS } from './WorldLayout.ts';
import { terrainHeight, townMask, waterLevelAt, airportMask, queryRiver } from './Heightfield.ts';
import { facadeMaterial } from '../render/ProceduralMaterials.ts';
import { worldMaterial, GLSL_NOISE, type ShaderHook } from '../render/Materials.ts';
import { globals, CURVATURE_GLSL, FX_DEPTH_GLSL, fxDepth, decalOffset } from '../render/Globals.ts';
import { sunOcclusionHook } from './TerrainMaterial.ts';
import { LightPoints, type LightDef } from './LightPoints.ts';
import { rng } from '../core/math.ts';

function houseGeometry(): BufferGeometry {
  const body = new BoxGeometry(1, 1, 1);
  body.translate(0, 0.5, 0);
  // gable roof prism on top (height 0.45 of unit)
  const roof = new BufferGeometry();
  const v = [
    -0.55, 1, -0.55, 0.55, 1, -0.55, 0, 1.45, -0.55,
    -0.55, 1, 0.55, 0, 1.45, 0.55, 0.55, 1, 0.55,
    -0.55, 1, -0.55, 0, 1.45, -0.55, 0, 1.45, 0.55, -0.55, 1, -0.55, 0, 1.45, 0.55, -0.55, 1, 0.55,
    0.55, 1, -0.55, 0.55, 1, 0.55, 0, 1.45, 0.55, 0.55, 1, -0.55, 0, 1.45, 0.55, 0, 1.45, -0.55,
  ];
  roof.setAttribute('position', new BufferAttribute(new Float32Array(v), 3));
  roof.computeVertexNormals();
  const b = body.toNonIndexed();
  b.deleteAttribute('uv');
  return mergeGeometries([b, roof]);
}

const roadHook: ShaderHook = (shader) => {
  shader.uniforms.uNoiseTex = globals.uNoiseTex;
  shader.uniforms.uWetness = globals.uWetness;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 pav;\nvarying vec2 vPav;\nvarying vec3 vRW;')
    .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvPav = pav;\nvRW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\nvarying vec2 vPav;\nvarying vec3 vRW;\nuniform sampler2D uNoiseTex;\nuniform float uWetness;\n${GLSL_NOISE}\nfloat rdRough;`)
    .replace(
      '#include <map_fragment>',
      /* glsl */ `{
        float a = vPav.x, c = vPav.y;
        float n = texture2D(uNoiseTex, vRW.xz / 9.0).a;
        vec3 col = vec3(0.06, 0.06, 0.062) * (0.8 + 0.4 * n);
        float ac = abs(c);
        float paint = step(ac, 0.08) * step(fract(a / 12.0), 0.5) + step(3.6, ac) * step(ac, 3.75);
        col = mix(col, vec3(0.7), paint * (0.6 + 0.4 * n));
        // dirt shoulders
        col = mix(col, vec3(0.12, 0.1, 0.07), smoothstep(3.9, 4.4, ac));
        col *= 1.0 - 0.4 * uWetness;
        rdRough = mix(0.85, 0.2, uWetness * 0.8);
        diffuseColor.rgb = col;
      }`,
    )
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = rdRough;');
};

const trafficVert = /* glsl */ `
attribute vec3 color;
uniform float uPixelScale;
uniform float uLightsOn;
varying vec3 vColor;
varying float vViewZ;
${CURVATURE_GLSL}
void main() {
  vec3 wp = applyCurvature(position);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
  float d = length(mv.xyz);
  float px = 0.6 / max(d, 1.0) * uPixelScale * 6.0;
  gl_PointSize = clamp(px, 1.5, 40.0) * step(0.01, uLightsOn);
  vColor = color * uLightsOn * clamp(px / 1.5, 0.2, 1.0) * exp(-d / 30000.0) * 1.5;
}`;
const trafficFrag = /* glsl */ `
varying vec3 vColor;
varying float vViewZ;
${FX_DEPTH_GLSL}
void main() {
  if (vViewZ > sceneViewDepth(gl_FragCoord.xy) + 1.0) discard;
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = dot(c, c);
  if (r > 1.0) discard;
  gl_FragColor = vec4(vColor * (exp(-r * 12.0) * 5.0 + exp(-r * 3.0) * 0.5), 1.0);
}`;

interface RoadPath {
  pts: Vector3[];
  cum: number[];
  length: number;
}

export class Towns {
  readonly group = new Group();
  readonly streetLights: LightPoints;
  private roads: RoadPath[] = [];
  private cars: { road: number; s: number; speed: number; dir: number }[] = [];
  private traffic: Points;
  private trafficPos: Float32Array;
  buildingCount = 0;

  constructor(scene: Scene, fxScene: Scene) {
    const lights: LightDef[] = [];
    const facade = facadeMaterial();
    const boxGeo = new BoxGeometry(1, 1, 1);
    boxGeo.translate(0, 0.5, 0);
    const house = houseGeometry();
    const m = new Matrix4();
    const q = new Quaternion();
    const p = new Vector3();
    const s = new Vector3();
    for (const [ti, t] of TOWNS.entries()) {
      const r = rng(1000 + ti * 77);
      const blocks: { x: number; z: number; w: number; d: number; h: number; tall: boolean }[] = [];
      const cell = 38;
      const R = t.radius * 1.1;
      for (let gz = Math.floor((t.center[1] - R) / cell); gz <= Math.ceil((t.center[1] + R) / cell); gz++) {
        for (let gx = Math.floor((t.center[0] - R) / cell); gx <= Math.ceil((t.center[0] + R) / cell); gx++) {
          const cx = gx * cell + cell / 2, cz = gz * cell + cell / 2;
          const tm = townMask(cx, cz);
          if (tm < 0.35 || r() > t.density * (0.55 + 0.45 * tm)) continue;
          if (airportMask(cx, cz) > 0.05) continue;
          const rq = queryRiver(cx, cz);
          if (rq.dist < rq.width + 20) continue;
          if (waterLevelAt(cx, cz) > terrainHeight(cx, cz) - 1) continue;
          const centre = 1 - Math.min(1, Math.hypot(cx - t.center[0], cz - t.center[1]) / t.radius);
          const tall = r() < t.tall * centre * 1.6;
          if (tall) {
            const w = 16 + r() * 12, d = 14 + r() * 12;
            const h = 12 + r() * 30 * centre + r() * 10;
            blocks.push({ x: cx + (r() - 0.5) * 4, z: cz + (r() - 0.5) * 4, w, d, h, tall: true });
          } else {
            // 2-4 houses per block around the perimeter
            const nH = 2 + Math.floor(r() * 3);
            for (let k = 0; k < nH; k++) {
              const ox = (k % 2 ? 1 : -1) * (6 + r() * 4);
              const oz = (k < 2 ? -1 : 1) * (6 + r() * 4);
              const w = 8 + r() * 5, d = 8 + r() * 6;
              const h = 3.2 * (1 + Math.floor(r() * (centre > 0.4 ? 4 : 2))) + 0.6;
              blocks.push({ x: cx + ox, z: cz + oz, w, d, h, tall: false });
            }
          }
          // street lights at block corners
          if (r() < 0.6) {
            const lx = gx * cell, lz = gz * cell;
            lights.push({ pos: [lx, terrainHeight(lx, lz) + 7, lz], color: r() < 0.7 ? [1, 0.7, 0.35] : [0.85, 0.9, 1], size: 1.0, intensity: 2.2 });
          }
        }
      }
      const tallBlocks = blocks.filter((b) => b.tall);
      const houses = blocks.filter((b) => !b.tall);
      for (const [list, geo] of [[tallBlocks, boxGeo], [houses, house]] as const) {
        if (!list.length) continue;
        const im = new InstancedMesh(geo, facade, list.length);
        const params = new Float32Array(list.length * 4);
        list.forEach((b, i) => {
          const y = Math.min(terrainHeight(b.x - b.w / 2, b.z - b.d / 2), terrainHeight(b.x + b.w / 2, b.z + b.d / 2), terrainHeight(b.x, b.z)) - 0.5;
          p.set(b.x, y, b.z);
          q.identity();
          s.set(b.w, b.h + 0.5, b.d);
          m.compose(p, q, s);
          im.setMatrixAt(i, m);
          params.set([r(), r(), b.h / 40, 0.3 + r() * 0.7], i * 4);
        });
        im.geometry = im.geometry.clone();
        im.geometry.setAttribute('instParams', new InstancedBufferAttribute(params, 4));
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        im.castShadow = true;
        im.receiveShadow = true;
        this.group.add(im);
        this.buildingCount += list.length;
      }
    }
    // ---- roads
    const roadMat = worldMaterial(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, ...decalOffset(2, 6) }), {
      key: 'road',
      hooks: [roadHook, sunOcclusionHook],
    });
    const parts: BufferGeometry[] = [];
    for (const road of ROADS) {
      const pts: Vector3[] = [];
      for (let i = 0; i < road.length - 1; i++) {
        const [ax, az] = road[i], [bx, bz] = road[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        const n = Math.max(1, Math.ceil(len / 14));
        for (let k = 0; k < n; k++) {
          const tt = k / n;
          // gentle curves: offset by noise-free sine based on segment index
          const x = ax + (bx - ax) * tt, z = az + (bz - az) * tt;
          const h = Math.max(terrainHeight(x, z), waterLevelAt(x, z) + 2.5);
          pts.push(new Vector3(x, h + 0.12, z));
        }
      }
      const [lx, lz] = road[road.length - 1];
      pts.push(new Vector3(lx, Math.max(terrainHeight(lx, lz), waterLevelAt(lx, lz) + 2.5) + 0.12, lz));
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
      this.roads.push({ pts, cum, length: cum[cum.length - 1] });
      parts.push(ribbon(pts, cum, 9));
    }
    const roadMesh = new Mesh(mergeGeometries(parts), roadMat);
    roadMesh.receiveShadow = true;
    this.group.add(roadMesh);

    // ---- night traffic (headlight / tail-light pairs moving along the roads)
    const rr = rng(55);
    for (let i = 0; i < 160; i++) {
      const road = Math.floor(rr() * this.roads.length);
      this.cars.push({ road, s: rr() * this.roads[road].length, speed: 14 + rr() * 12, dir: rr() < 0.5 ? 1 : -1 });
    }
    this.trafficPos = new Float32Array(this.cars.length * 2 * 3);
    const tcol = new Float32Array(this.cars.length * 2 * 3);
    this.cars.forEach((c, i) => {
      tcol.set([1, 0.95, 0.8], i * 6);
      tcol.set([1, 0.1, 0.05], i * 6 + 3);
    });
    const tg = new BufferGeometry();
    tg.setAttribute('position', new BufferAttribute(this.trafficPos, 3));
    tg.setAttribute('color', new BufferAttribute(tcol, 3));
    this.traffic = new Points(
      tg,
      new ShaderMaterial({
        vertexShader: trafficVert,
        fragmentShader: trafficFrag,
        uniforms: { uPixelScale: { value: 1000 }, uLightsOn: globals.uLightsOn, uCurvOrigin: globals.uCurvOrigin, ...fxDepth },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    this.traffic.frustumCulled = false;
    fxScene.add(this.traffic);

    this.streetLights = new LightPoints(lights);
    fxScene.add(this.streetLights.points);
    scene.add(this.group);
  }

  update(dt: number, pixelScale: number): void {
    (this.traffic.material as ShaderMaterial).uniforms.uPixelScale.value = pixelScale;
    if (globals.uLightsOn.value < 0.01) return;
    const pos = this.trafficPos;
    const tmp = new Vector3();
    const tmp2 = new Vector3();
    this.cars.forEach((c, i) => {
      const road = this.roads[c.road];
      c.s += c.speed * c.dir * dt;
      if (c.s > road.length) c.s -= road.length;
      if (c.s < 0) c.s += road.length;
      sampleRoad(road, c.s, tmp);
      sampleRoad(road, Math.min(road.length, c.s + 1), tmp2);
      const dx = tmp2.x - tmp.x, dz = tmp2.z - tmp.z;
      const l = Math.hypot(dx, dz) || 1;
      // keep right
      const ox = (-dz / l) * 2 * c.dir, oz = (dx / l) * 2 * c.dir;
      // the visible light depends on travel direction relative to the viewer: show head + tail
      pos.set([tmp.x + ox + (dx / l) * 2 * c.dir, tmp.y + 0.8, tmp.z + oz + (dz / l) * 2 * c.dir], i * 6);
      pos.set([tmp.x + ox - (dx / l) * 2 * c.dir, tmp.y + 0.8, tmp.z + oz - (dz / l) * 2 * c.dir], i * 6 + 3);
    });
    this.traffic.geometry.attributes.position.needsUpdate = true;
  }
}

function sampleRoad(r: RoadPath, s: number, out: Vector3): Vector3 {
  let lo = 0, hi = r.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (r.cum[mid] < s) lo = mid;
    else hi = mid;
  }
  const t = (s - r.cum[lo]) / Math.max(1e-3, r.cum[hi] - r.cum[lo]);
  return out.lerpVectors(r.pts[lo], r.pts[hi], t);
}

function ribbon(pts: Vector3[], cum: number[], width: number): BufferGeometry {
  const pos = new Float32Array(pts.length * 2 * 3);
  const nrm = new Float32Array(pts.length * 2 * 3);
  const pav = new Float32Array(pts.length * 2 * 2);
  const idx: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    const px = -dz * width * 0.5, pz = dx * width * 0.5;
    const p = pts[i];
    pos.set([p.x + px, p.y, p.z + pz, p.x - px, p.y, p.z - pz], i * 6);
    nrm.set([0, 1, 0, 0, 1, 0], i * 6);
    pav.set([cum[i], width * 0.5, cum[i], -width * 0.5], i * 4);
    if (i < pts.length - 1) {
      const k = i * 2;
      idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('pav', new BufferAttribute(pav, 2));
  g.setIndex(idx);
  return g;
}

export const _c = Color;
