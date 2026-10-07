// Web Worker entry: terrain chunk / vegetation / map generation off the main thread.

import { generateChunk, generateMap, generateVegetation, type ChunkRequest, type MapRequest, type VegRequest } from './TerrainGen.ts';

type Req = ChunkRequest | VegRequest | MapRequest;

self.onmessage = (e: MessageEvent<Req>) => {
  const req = e.data;
  if (req.type === 'chunk') {
    const r = generateChunk(req);
    (self as unknown as Worker).postMessage(r, [r.positions.buffer, r.normals.buffer, r.cover.buffer, r.morph.buffer]);
  } else if (req.type === 'veg') {
    const r = generateVegetation(req);
    (self as unknown as Worker).postMessage(r, [r.data.buffer]);
  } else if (req.type === 'map') {
    const r = generateMap(req);
    (self as unknown as Worker).postMessage(r, [r.rgba.buffer, r.heights.buffer]);
  }
};
