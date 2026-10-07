// Draw-call reduction: merges static child meshes that share a material into
// a single mesh (transforms baked). Animated objects are skipped by passing
// them in `keep` (their whole subtree is preserved).

import { Group, Matrix4, Mesh, type BufferGeometry, type Material, type Object3D } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export function mergeStatic(root: Object3D, keep: Set<Object3D>, opts: { castShadow?: boolean } = {}): number {
  root.updateMatrixWorld(true);
  const inv = new Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map<Material, { geos: BufferGeometry[]; meshes: Mesh[]; cast: boolean }>();
  const visit = (o: Object3D) => {
    if (keep.has(o)) return;
    for (const c of [...o.children]) visit(c);
    const m = o as Mesh;
    if (!m.isMesh || Array.isArray(m.material) || !m.visible || m.userData.noMerge) return;
    if ((m as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) return;
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    // keep only the attributes all merged geometries share
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    if (!g.attributes.uv) {
      const n = g.attributes.position.count;
      g.setAttribute('uv', new (g.attributes.position.constructor as never as typeof import('three').BufferAttribute)(new Float32Array(n * 2), 2));
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    const mtx = new Matrix4().multiplyMatrices(inv, m.matrixWorld);
    g.applyMatrix4(mtx);
    let b = buckets.get(m.material);
    if (!b) buckets.set(m.material, (b = { geos: [], meshes: [], cast: false }));
    b.geos.push(g);
    b.meshes.push(m);
    b.cast ||= m.castShadow;
  };
  visit(root);
  let removed = 0;
  const merged = new Group();
  merged.name = 'merged-static';
  for (const [mat, b] of buckets) {
    if (b.geos.length < 2) continue;
    const geo = mergeGeometries(b.geos, false);
    if (!geo) continue;
    for (const m of b.meshes) {
      m.parent?.remove(m);
      removed++;
    }
    const mesh = new Mesh(geo, mat);
    mesh.castShadow = opts.castShadow ?? b.cast;
    mesh.receiveShadow = true;
    merged.add(mesh);
  }
  root.add(merged);
  return removed;
}
