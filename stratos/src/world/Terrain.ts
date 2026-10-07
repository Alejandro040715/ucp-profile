// CDLOD-style quadtree terrain streaming. Chunks are generated in workers,
// selected per frame by camera distance, geomorphed in the vertex shader and
// cached with LRU eviction. A node is only refined once all four children are
// resident, so there are never holes while streaming.

import { BufferAttribute, BufferGeometry, Mesh, Sphere, Vector3, type Camera, type Object3D, Frustum, Matrix4, Box3 } from 'three';
import { WorkerPool } from './WorkerPool.ts';
import { chunkIndices, type ChunkResult } from './TerrainGen.ts';
import { createTerrainMaterial, terrainUniforms } from './TerrainMaterial.ts';
import { EARTH_RADIUS } from '../render/Globals.ts';

const ROOT_SIZE = 524288;
const MIN_SIZE = 256;
const RES = 64;

interface Node {
  key: string;
  cx: number;
  cz: number;
  size: number;
  level: number;
  children: Node[] | null;
  mesh: Mesh | null;
  state: 'none' | 'loading' | 'ready';
  minY: number;
  maxY: number;
  lastUsed: number;
  cancel?: () => void;
  setPriority?: (p: number) => void;
}

const _tmp = new Vector3();
const _box = new Box3();
const _frustum = new Frustum();
const _pm = new Matrix4();

export class Terrain {
  readonly root: Node;
  readonly material = createTerrainMaterial();
  private pool: WorkerPool;
  private parent: Object3D;
  private index: BufferAttribute;
  private frame = 0;
  private resident = new Map<string, Node>();
  maxResident = 900;
  lodFactor = 2.5;
  visibleCount = 0;
  wireframe = false;
  private selected: Node[] = [];
  private loading = new Set<Node>();

  constructor(parent: Object3D, pool: WorkerPool) {
    this.parent = parent;
    this.pool = pool;
    this.index = new BufferAttribute(chunkIndices(RES), 1);
    this.root = this.makeNode(0, 0, ROOT_SIZE, 0);
  }

  private makeNode(cx: number, cz: number, size: number, level: number): Node {
    return { key: `${level}:${cx}:${cz}`, cx, cz, size, level, children: null, mesh: null, state: 'none', minY: -100, maxY: 3200, lastUsed: 0 };
  }

  private request(n: Node, cam: Vector3): void {
    if (n.state !== 'none') return;
    n.state = 'loading';
    const d = this.distanceTo(n, cam);
    const priority = d / n.size + n.level * 0.01;
    const { promise, cancel, setPriority } = this.pool.request<ChunkResult>({ type: 'chunk', cx: n.cx, cz: n.cz, size: n.size, res: RES }, priority);
    n.cancel = cancel;
    n.setPriority = setPriority;
    this.loading.add(n);
    promise.then((r) => {
      this.loading.delete(n);
      if (n.state === 'loading') this.build(n, r);
    });
  }

  private build(n: Node, r: ChunkResult): void {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(r.positions, 3));
    const nrm = new Float32Array((r.normals.length / 4) * 3);
    for (let i = 0, j = 0; i < r.normals.length; i += 4, j += 3) {
      nrm[j] = r.normals[i] / 127;
      nrm[j + 1] = r.normals[i + 1] / 127;
      nrm[j + 2] = r.normals[i + 2] / 127;
    }
    g.setAttribute('normal', new BufferAttribute(nrm, 3));
    g.setAttribute('cover', new BufferAttribute(r.cover, 4, true));
    const morph = new Float32Array(r.morph.length * 2);
    for (let i = 0; i < r.morph.length; i++) {
      morph[i * 2] = r.morph[i];
      morph[i * 2 + 1] = n.size;
    }
    g.setAttribute('morph', new BufferAttribute(morph, 2));
    g.setIndex(this.index);
    const midY = (r.minY + r.maxY) / 2;
    const half = n.size * 0.5;
    const radius = Math.sqrt(half * half * 2 + ((r.maxY - r.minY) / 2) ** 2) + 30;
    g.boundingSphere = new Sphere(new Vector3(0, midY, 0), radius);
    const m = new Mesh(g, this.material);
    m.position.set(n.cx, 0, n.cz);
    m.receiveShadow = true;
    m.castShadow = false;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    m.visible = false;
    // large chunks are bent by earth curvature; skip CPU culling for them
    if (n.size >= 16384) m.frustumCulled = false;
    m.userData.terrainNode = n;
    n.mesh = m;
    n.minY = r.minY;
    n.maxY = r.maxY;
    n.state = 'ready';
    this.parent.add(m);
    this.resident.set(n.key, n);
  }

  private distanceTo(n: Node, cam: Vector3): number {
    const h = n.size / 2;
    const dx = Math.max(Math.abs(cam.x - n.cx) - h, 0);
    const dz = Math.max(Math.abs(cam.z - n.cz) - h, 0);
    const dy = cam.y < n.minY ? n.minY - cam.y : cam.y > n.maxY ? cam.y - n.maxY : 0;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  private shouldSplit(n: Node, cam: Vector3): boolean {
    return n.size > MIN_SIZE && this.distanceTo(n, cam) < n.size * this.lodFactor;
  }

  private ensureChildren(n: Node): Node[] {
    if (!n.children) {
      const q = n.size / 4;
      const s = n.size / 2;
      const l = n.level + 1;
      n.children = [
        this.makeNode(n.cx - q, n.cz - q, s, l),
        this.makeNode(n.cx + q, n.cz - q, s, l),
        this.makeNode(n.cx - q, n.cz + q, s, l),
        this.makeNode(n.cx + q, n.cz + q, s, l),
      ];
    }
    return n.children;
  }

  private select(n: Node, cam: Vector3, out: Node[]): void {
    n.lastUsed = this.frame;
    if (n.state === 'none') this.request(n, cam);
    else if (n.state === 'loading') n.setPriority?.(this.distanceTo(n, cam) / n.size + n.level * 0.01);
    if (this.shouldSplit(n, cam)) {
      const ch = this.ensureChildren(n);
      let allReady = true;
      for (const c of ch) {
        c.lastUsed = this.frame;
        if (c.state === 'none') this.request(c, cam);
        else if (c.state === 'loading') c.setPriority?.(this.distanceTo(c, cam) / c.size + c.level * 0.01);
        if (c.state !== 'ready') allReady = false;
      }
      if (allReady) {
        for (const c of ch) this.select(c, cam, out);
        return;
      }
    }
    if (n.state === 'ready') out.push(n);
  }

  update(camera: Camera): void {
    this.frame++;
    terrainUniforms.uLodFactor.value = this.lodFactor;
    const cam = camera.getWorldPosition(_tmp);
    for (const n of this.selected) if (n.mesh) n.mesh.visible = false;
    this.selected.length = 0;
    this.select(this.root, cam, this.selected);
    // curvature-aware bounding spheres for mid-size chunks
    for (const n of this.selected) {
      const m = n.mesh!;
      m.visible = true;
      if (m.frustumCulled) {
        const d = Math.hypot(n.cx - cam.x, n.cz - cam.z);
        const drop = (d * d) / (2 * EARTH_RADIUS);
        const g = m.geometry;
        const sph = g.boundingSphere!;
        sph.center.y = (n.minY + n.maxY) / 2 - drop;
      }
    }
    this.visibleCount = this.selected.length;
    // cancel stale requests (camera moved away before they were generated)
    for (const n of this.loading) {
      if (n.lastUsed < this.frame - 30) {
        n.cancel?.();
        n.state = 'none';
        this.loading.delete(n);
      }
    }
    if (this.material.wireframe !== this.wireframe) this.material.wireframe = this.wireframe;
    this.evict();
  }

  private evict(): void {
    if (this.resident.size <= this.maxResident) return;
    const list = [...this.resident.values()].filter((n) => n.lastUsed < this.frame - 2 && n.level > 1);
    list.sort((a, b) => a.lastUsed - b.lastUsed);
    let toFree = this.resident.size - this.maxResident;
    for (const n of list) {
      if (toFree <= 0) break;
      this.freeNode(n);
      toFree--;
    }
  }

  private freeNode(n: Node): void {
    if (n.mesh) {
      this.parent.remove(n.mesh);
      // shared index must not be disposed
      n.mesh.geometry.setIndex(null);
      n.mesh.geometry.dispose();
      n.mesh = null;
    }
    n.state = 'none';
    this.resident.delete(n.key);
    // drop children subtree that are not resident
    if (n.children && n.children.every((c) => c.state === 'none' && !c.children)) n.children = null;
  }

  /** True once the region around a point is streamed in at a useful resolution. */
  isReadyAround(p: Vector3, minSize = 1024): boolean {
    let n: Node | null = this.root;
    while (n) {
      if (n.state !== 'ready') return false;
      if (n.size <= minSize) return true;
      if (!n.children) return false;
      const c: Node[] = n.children;
      n = c[(p.x > n.cx ? 1 : 0) + (p.z > n.cz ? 2 : 0)];
    }
    return false;
  }

  get pending(): number {
    return this.pool.pending;
  }
}
