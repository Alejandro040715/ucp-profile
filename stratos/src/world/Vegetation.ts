// Vegetation streaming: instanced 3D trees near the camera (two species with
// lumpy procedural crowns, wind sway, dithered LOD fade, shadows), impostor
// billboards rendered at startup from the same meshes for the mid/far ring,
// grass clumps near the ground and rocks on mountain slopes. Placement comes
// from the terrain workers so the main thread only builds instance buffers.

import {
  BufferAttribute, BufferGeometry, CanvasTexture, Color, ConeGeometry, CylinderGeometry, DoubleSide, Group, IcosahedronGeometry,
  InstancedBufferAttribute, InstancedBufferGeometry, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, NearestFilter, OrthographicCamera, PlaneGeometry,
  Quaternion, RGBAFormat, Scene, ShaderMaterial, UnsignedByteType, Vector3, WebGLRenderTarget, type WebGLRenderer, LinearMipmapLinearFilter,
  LinearFilter, AmbientLight, DirectionalLight, SRGBColorSpace,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { WorkerPool } from './WorkerPool.ts';
import type { VegKind, VegResult } from './TerrainGen.ts';
import { worldMaterial, type ShaderHook } from '../render/Materials.ts';
import { globals, CURVATURE_GLSL } from '../render/Globals.ts';
import { sunOcclusionHook } from './TerrainMaterial.ts';
import { SimplexNoise } from '../core/Noise.ts';
import { rng } from '../core/math.ts';

const noise = new SimplexNoise(4242);

function colorize(g: BufferGeometry, fn: (x: number, y: number, z: number) => [number, number, number]): BufferGeometry {
  const p = g.attributes.position;
  const c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) c.set(fn(p.getX(i), p.getY(i), p.getZ(i)), i * 3);
  g.setAttribute('color', new BufferAttribute(c, 3));
  return g;
}

function lumpy(g: BufferGeometry, amp: number, freq: number, seed: number): BufferGeometry {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = noise.noise3(x * freq + seed, y * freq, z * freq - seed);
    const l = Math.hypot(x, z) || 1;
    p.setXYZ(i, x + (x / l) * n * amp, y + n * amp * 0.4, z + (z / l) * n * amp);
  }
  g.computeVertexNormals();
  return g;
}

/** Broadleaf tree ~14 m: trunk + 5 noisy blobs. Normals pushed outward for soft crown lighting. */
function broadleafGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const trunk = new CylinderGeometry(0.22, 0.38, 6, 6, 1);
  trunk.translate(0, 3, 0);
  parts.push(colorize(trunk, () => [0.11, 0.08, 0.055]));
  const r = rng(5);
  const blobs: [number, number, number, number][] = [[0, 8.5, 0, 3.6], [1.8, 7.2, 0.6, 2.6], [-1.6, 7.4, -0.8, 2.7], [0.5, 10.4, -0.7, 2.6], [-0.4, 7.0, 1.9, 2.4]];
  for (const [x, y, z, s] of blobs) {
    const b = lumpy(new IcosahedronGeometry(s, 2), s * 0.28, 0.6, r() * 10);
    b.translate(x, y, z);
    parts.push(colorize(b, (_x, yy) => {
      const t = Math.min(1, Math.max(0, (yy - 5) / 7));
      return [0.05 + 0.03 * t, 0.085 + 0.06 * t, 0.025 + 0.015 * t];
    }));
  }
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()));
  // spherical crown normals: blend face normals with direction from crown centre
  const p = g.attributes.position, n = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y < 4.5) continue;
    const dx = p.getX(i), dy = y - 8.3, dz = p.getZ(i);
    const l = Math.hypot(dx, dy, dz) || 1;
    const nx = n.getX(i) * 0.4 + (dx / l) * 0.6, ny = n.getY(i) * 0.4 + (dy / l) * 0.6, nz = n.getZ(i) * 0.4 + (dz / l) * 0.6;
    const nl = Math.hypot(nx, ny, nz);
    n.setXYZ(i, nx / nl, ny / nl, nz / nl);
  }
  return g;
}

/** Conifer ~18 m: trunk + 4 stacked drooping cones. */
function coniferGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const trunk = new CylinderGeometry(0.15, 0.32, 5, 6, 1);
  trunk.translate(0, 2.5, 0);
  parts.push(colorize(trunk, () => [0.1, 0.07, 0.05]));
  const tiers: [number, number, number][] = [[3.4, 6.0, 4.0], [2.8, 5.2, 7.6], [2.1, 4.6, 10.8], [1.3, 4.2, 13.8]];
  tiers.forEach(([rad, h, y], i) => {
    const c = lumpy(new ConeGeometry(rad, h, 9, 3, false), 0.35, 0.9, i * 3.1);
    c.translate(0, y, 0);
    parts.push(colorize(c, (_x, yy) => {
      const t = Math.min(1, Math.max(0, (yy - 2) / 15));
      return [0.025 + 0.02 * t, 0.05 + 0.035 * t, 0.03 + 0.012 * t];
    }));
  });
  return mergeGeometries(parts.map((p) => p.toNonIndexed()));
}

function rockGeometry(): BufferGeometry {
  const g = lumpy(new IcosahedronGeometry(1, 1), 0.35, 1.3, 7);
  g.scale(1.3, 0.75, 1.0);
  return colorize(g, (_x, y) => [0.2 + y * 0.03, 0.19 + y * 0.03, 0.18 + y * 0.025]);
}

function grassGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const q = new PlaneGeometry(1.1, 0.55, 1, 1);
    q.translate(0, 0.27, 0);
    q.rotateY((i / 3) * Math.PI);
    parts.push(q);
  }
  return mergeGeometries(parts);
}

function grassTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  const r = rng(3);
  for (let i = 0; i < 70; i++) {
    const x = 10 + r() * 236;
    const h = 50 + r() * 76;
    const lean = (r() - 0.5) * 30;
    const shade = 90 + r() * 80;
    g.strokeStyle = `rgb(${shade * 0.55},${shade},${shade * 0.32})`;
    g.lineWidth = 2 + r() * 2.5;
    g.beginPath();
    g.moveTo(x, 128);
    g.quadraticCurveTo(x + lean * 0.3, 128 - h * 0.6, x + lean, 128 - h);
    g.stroke();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.minFilter = LinearMipmapLinearFilter;
  return t;
}

// wind sway + dithered LOD fade for instanced vegetation
function vegHook(fadeNear: { value: number }, fadeFar: { value: number }, swayAmp: number): ShaderHook {
  return (shader) => {
    shader.uniforms.uTime = globals.uTime;
    shader.uniforms.uWindV = globals.uWind;
    shader.uniforms.uFadeNear = fadeNear;
    shader.uniforms.uFadeFar = fadeFar;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec2 uWindV;\nvarying float vVegDist;\nvarying float vVegSeed;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec3 ip = instanceMatrix[3].xyz;
          float seed = fract(sin(dot(ip.xz, vec2(12.9898, 78.233))) * 43758.5453);
          vVegSeed = seed;
          float h = max(0.0, transformed.y);
          float w = length(uWindV) * 0.08 + 0.15;
          float sway = sin(uTime * (1.3 + seed) + ip.x * 0.05 + ip.z * 0.04) * w * ${swayAmp.toFixed(3)} * h * h;
          transformed.x += sway * 0.8;
          transformed.z += sway * 0.5;
        }`,
      )
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvVegDist = length((modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz - cameraPosition);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vVegDist;\nvarying float vVegSeed;\nuniform float uFadeNear;\nuniform float uFadeFar;')
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        {
          float fade = smoothstep(uFadeFar, uFadeFar * 0.86, vVegDist) * smoothstep(uFadeNear * 0.9, uFadeNear, vVegDist + (uFadeNear < 1.0 ? 1.0 : 0.0));
          float dith = fract(dot(gl_FragCoord.xy, vec2(0.7548776662, 0.56984029)) + vVegSeed);
          if (fade < 1.0 && dith > fade) discard;
        }`,
      );
  };
}

// ----- impostor billboards -----
const impostorVert = /* glsl */ `
attribute vec4 inst;    // x, y, z, scale
attribute vec2 inst2;   // variant, color jitter
uniform float uNear;
uniform float uFar;
varying vec2 vUv;
varying float vFade;
varying float vJit;
varying vec3 vWorldPos;
varying float vVariant;
${CURVATURE_GLSL}
void main() {
  vec3 base = inst.xyz;
  vec3 toCam = cameraPosition - base;
  float dist = length(toCam);
  vec2 dir = normalize(toCam.xz + 1e-4);
  vec3 right = vec3(dir.y, 0.0, -dir.x);
  float s = inst.w;
  float w = 11.0 * s, h = 17.0 * s;
  vec3 wp = base + right * (position.x * w) + vec3(0.0, (position.y + 0.5) * h, 0.0);
  wp = applyCurvature(wp);
  vWorldPos = wp;
  vUv = vec2(position.x + 0.5, position.y + 0.5);
  vVariant = inst2.x;
  vJit = inst2.y;
  vFade = smoothstep(uNear * 0.82, uNear * 0.97, dist) * smoothstep(uFar, uFar * 0.82, dist);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const impostorFrag = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
varying vec2 vUv;
varying float vFade;
varying float vJit;
varying vec3 vWorldPos;
varying float vVariant;
void main() {
  vec2 uv = vec2((vVariant + vUv.x) / 4.0, vUv.y);
  vec4 t = texture2D(uAtlas, uv);
  float dith = fract(dot(gl_FragCoord.xy, vec2(0.7548776662, 0.56984029)) + vJit);
  if (t.a < 0.5 || dith > vFade) discard;
  // approximate spherical normal for the crown
  vec3 n = normalize(vec3((vUv.x - 0.5) * 1.6, 0.6, 0.4));
  float ndl = max(dot(n, normalize(uSunDir)), 0.0) * 0.8 + 0.2;
  vec3 albedo = t.rgb * (0.85 + 0.3 * vJit);
  vec3 col = albedo * (uSunColor * ndl * 0.32 + uSkyAmbient * 0.9);
  gl_FragColor = vec4(col, 1.0);
}`;

interface Tile {
  key: string;
  kind: VegKind;
  x0: number;
  z0: number;
  objects: Object3D[];
  cancel?: () => void;
  state: 'loading' | 'ready';
}

type Object3D = Mesh | InstancedMesh;

const _m = new Matrix4();
const _q = new Quaternion();
const _s = new Vector3();
const _p = new Vector3();
const _up = new Vector3(0, 1, 0);

export class Vegetation {
  readonly group = new Group();
  private pool: WorkerPool;
  private tiles = new Map<string, Tile>();
  private broadleafGeo = broadleafGeometry();
  private coniferGeo = coniferGeometry();
  private rockGeo = rockGeometry();
  private grassGeo = grassGeometry();
  private treeMat: MeshStandardMaterial;
  private rockMat: MeshStandardMaterial;
  private grassMat: MeshStandardMaterial;
  private impostorMat: ShaderMaterial;
  private impostorGeo: BufferGeometry;
  readonly treeFadeNear = { value: 0 };
  readonly treeFadeFar = { value: 1300 };
  readonly grassFadeFar = { value: 150 };
  readonly zero = { value: 0 };
  treeRadius = 1300;
  farRadius = 7000;
  grassRadius = 150;
  density = 1;
  grassEnabled = true;
  instanceCount = 0;

  constructor(scene: Scene, pool: WorkerPool, renderer: WebGLRenderer) {
    this.pool = pool;
    scene.add(this.group);
    const treeMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
    this.treeMat = worldMaterial(treeMat, { key: 'tree', hooks: [vegHook(this.zero, this.treeFadeFar, 0.0012), sunOcclusionHook] });
    this.rockMat = worldMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }), { key: 'rock', hooks: [sunOcclusionHook] });
    const gt = grassTexture();
    this.grassMat = worldMaterial(
      new MeshStandardMaterial({ map: gt, alphaTest: 0.45, alphaToCoverage: true, side: DoubleSide, roughness: 0.95, color: new Color(0.55, 0.62, 0.42) }),
      { key: 'grass', hooks: [vegHook(this.zero, this.grassFadeFar, 0.35), sunOcclusionHook] },
    );
    this.impostorGeo = new PlaneGeometry(1, 1);
    this.impostorMat = new ShaderMaterial({
      vertexShader: impostorVert,
      fragmentShader: impostorFrag,
      uniforms: {
        uAtlas: { value: this.renderAtlas(renderer) },
        uNear: this.treeFadeFar,
        uFar: { value: this.farRadius },
        uSunDir: globals.uSunDir,
        uSunColor: globals.uSunColor,
        uSkyAmbient: globals.uSkyAmbient,
        uCurvOrigin: globals.uCurvOrigin,
      },
    });
  }

  /** Render the two species (two variants each) into a 4-cell impostor atlas. */
  private renderAtlas(renderer: WebGLRenderer): WebGLRenderTarget['texture'] {
    const rt = new WebGLRenderTarget(1024, 256, { format: RGBAFormat, type: UnsignedByteType, depthBuffer: true });
    rt.texture.minFilter = LinearMipmapLinearFilter;
    rt.texture.magFilter = LinearFilter;
    rt.texture.generateMipmaps = true;
    const sc = new Scene();
    sc.add(new AmbientLight(0xffffff, 2.2));
    const dl = new DirectionalLight(0xffffff, 1.5);
    dl.position.set(0.4, 1, 0.8);
    sc.add(dl);
    const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 1 });
    const cam = new OrthographicCamera(-5.5, 5.5, 17, 0, -50, 50);
    const prevRT = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.autoClear = false;
    const geos = [this.broadleafGeo, this.broadleafGeo, this.coniferGeo, this.coniferGeo];
    for (let i = 0; i < 4; i++) {
      const m = new Mesh(geos[i], mat);
      m.rotation.y = i % 2 ? 1.3 : 0;
      m.scale.setScalar(i < 2 ? 1.05 : 0.9);
      sc.add(m);
      renderer.setViewport(i * 256, 0, 256, 256);
      renderer.setScissor(i * 256, 0, 256, 256);
      renderer.setScissorTest(true);
      renderer.render(sc, cam);
      sc.remove(m);
    }
    renderer.setScissorTest(false);
    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAuto;
    renderer.setClearColor(0x000000, 1);
    return rt.texture;
  }

  /** returns true when terrain is streamed in around a point (avoids floating trees) */
  terrainReady: (x: number, z: number) => boolean = () => true;

  update(camPos: Vector3, agl: number): void {
    this.treeFadeFar.value = this.treeRadius;
    this.impostorMat.uniforms.uFar.value = this.farRadius;
    this.grassFadeFar.value = this.grassRadius;
    const want = new Set<string>();
    const consider = (kind: VegKind, size: number, radius: number) => {
      const cx = Math.floor(camPos.x / size), cz = Math.floor(camPos.z / size);
      const rt = Math.ceil(radius / size);
      for (let j = -rt; j <= rt; j++)
        for (let i = -rt; i <= rt; i++) {
          const x0 = (cx + i) * size, z0 = (cz + j) * size;
          const dx = Math.max(0, Math.abs(camPos.x - (x0 + size / 2)) - size / 2);
          const dz = Math.max(0, Math.abs(camPos.z - (z0 + size / 2)) - size / 2);
          const d = Math.hypot(dx, dz, Math.max(0, camPos.y - 2500) * 0.5);
          if (d > radius) continue;
          const key = `${kind}:${x0}:${z0}`;
          if (!this.tiles.has(key) && !this.terrainReady(x0 + size / 2, z0 + size / 2)) continue;
          want.add(key);
          if (!this.tiles.has(key)) this.requestTile(kind, key, x0, z0, size, d);
        }
    };
    // vegetation only matters below a few km of altitude
    if (camPos.y < 9000) {
      consider('trees', 512, this.treeRadius);
      consider('far', 1024, this.farRadius);
      consider('rocks', 512, Math.min(this.treeRadius, 900));
    }
    if (this.grassEnabled && agl < 80) consider('grass', 64, this.grassRadius);
    for (const [key, t] of this.tiles) {
      if (!want.has(key)) {
        t.cancel?.();
        for (const o of t.objects) {
          this.group.remove(o);
          (o as InstancedMesh).dispose?.();
        }
        this.tiles.delete(key);
      }
    }
  }

  private requestTile(kind: VegKind, key: string, x0: number, z0: number, size: number, dist: number): void {
    const tile: Tile = { key, kind, x0, z0, objects: [], state: 'loading' };
    this.tiles.set(key, tile);
    const pr = (kind === 'grass' ? 2 : kind === 'trees' ? 3 : 5) + dist / 1500;
    const { promise, cancel } = this.pool.request<VegResult>({ type: 'veg', kind, x0, z0, size, density: this.density }, pr);
    tile.cancel = cancel;
    promise.then((r) => {
      if (this.tiles.get(key) !== tile) return;
      tile.state = 'ready';
      this.buildTile(tile, r);
    });
  }

  private buildTile(tile: Tile, r: VegResult): void {
    const d = r.data;
    const n = r.count;
    if (n === 0) return;
    if (tile.kind === 'far') {
      const inst = new Float32Array(n * 4);
      const inst2 = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const o = i * 8;
        inst.set([d[o], d[o + 1], d[o + 2], d[o + 3]], i * 4);
        const shape = d[o + 7];
        inst2[i * 2] = shape > 0.5 ? 2 + (d[o + 5] % 2) : d[o + 5] % 2;
        inst2[i * 2 + 1] = d[o + 6];
      }
      const ig = new InstancedBufferGeometry();
      ig.setAttribute('position', this.impostorGeo.attributes.position);
      ig.setIndex(this.impostorGeo.index);
      ig.setAttribute('inst', new InstancedBufferAttribute(inst, 4));
      ig.setAttribute('inst2', new InstancedBufferAttribute(inst2, 2));
      ig.instanceCount = n;
      const mesh = new Mesh(ig, this.impostorMat);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      tile.objects.push(mesh);
      this.instanceCount += n;
      return;
    }
    const buildInstanced = (geo: BufferGeometry, mat: MeshStandardMaterial, filter: (o: number) => boolean, castShadow: boolean, scaleY = 1) => {
      let count = 0;
      for (let i = 0; i < n; i++) if (filter(i * 8)) count++;
      if (!count) return;
      const im = new InstancedMesh(geo, mat, count);
      let k = 0;
      const col = new Color();
      for (let i = 0; i < n; i++) {
        const o = i * 8;
        if (!filter(o)) continue;
        _p.set(d[o], d[o + 1], d[o + 2]);
        _q.setFromAxisAngle(_up, d[o + 4]);
        const sc = d[o + 3];
        _s.set(sc, sc * scaleY * (0.9 + d[o + 6] * 0.25), sc);
        _m.compose(_p, _q, _s);
        im.setMatrixAt(k, _m);
        const j = d[o + 6];
        col.setRGB(0.85 + j * 0.3, 0.85 + j * 0.25, 0.8 + j * 0.2);
        im.setColorAt(k, col);
        k++;
      }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = castShadow;
      im.receiveShadow = true;
      this.group.add(im);
      tile.objects.push(im);
      this.instanceCount += count;
    };
    if (tile.kind === 'trees') {
      buildInstanced(this.broadleafGeo, this.treeMat, (o) => d[o + 7] < 0.5, true);
      buildInstanced(this.coniferGeo, this.treeMat, (o) => d[o + 7] >= 0.5, true);
    } else if (tile.kind === 'rocks') {
      buildInstanced(this.rockGeo, this.rockMat, () => true, true, 1);
    } else if (tile.kind === 'grass') {
      buildInstanced(this.grassGeo, this.grassMat, () => true, false, 1);
    }
  }
}

export const _unused = [NearestFilter, CanvasTexture];
