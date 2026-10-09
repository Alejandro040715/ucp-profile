// glTF model loading that works on restrictive hosts. Locally the models are
// plain .glb files. The published artifact page refuses fetches of data: URIs
// and serves no binary model type, so its build (scripts/artifact.mjs) ships
// each model as the GLB in base64 text (<name>.glb.txt) with the textures as
// sibling image files, which load like any other published file.

import type { Group } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export async function loadModel(name: string, onProgress?: (frac: number) => void): Promise<Group> {
  const base = new URL('models/', document.baseURI).href;
  const loader = new GLTFLoader();
  try {
    const gltf = await loader.loadAsync(base + name + '.glb', (e) => {
      if (e.total) onProgress?.(e.loaded / e.total);
    });
    return gltf.scene;
  } catch {
    // fall through to the text-packed model
  }
  const res = await fetch(base + name + '.glb.txt');
  if (!res.ok) throw new Error(`model ${name} not found (${res.status})`);
  const text = (await res.text()).trim();
  onProgress?.(0.9);
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const gltf = await loader.parseAsync(bytes.buffer, base);
  onProgress?.(1);
  return gltf.scene;
}
