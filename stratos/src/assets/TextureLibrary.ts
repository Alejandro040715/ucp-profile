// Library of real CC0 texture images (see public/textures/CREDITS.md).
// Files live in public/textures/<slug>/<map>.jpg and are preloaded before the
// game is constructed, so the synchronous asset builders (canvas painters,
// material factories) can use them directly. Anything that fails to load is
// simply absent and callers fall back to their procedural detail.

import { LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, SRGBColorSpace, Texture } from 'three';
import { TEXTURE_MANIFEST, type TexMap } from './textureManifest.ts';

const images = new Map<string, HTMLImageElement>();
const textures = new Map<string, Texture>();

export type { TexMap };

/** Loads every image in the manifest. Never rejects. */
export async function preloadTextures(onProgress?: (done: number, total: number) => void): Promise<number> {
  const jobs: [string, TexMap][] = [];
  for (const [slug, maps] of Object.entries(TEXTURE_MANIFEST)) for (const m of maps) jobs.push([slug, m]);
  let done = 0;
  await Promise.all(
    jobs.map(
      ([slug, map]) =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.decoding = 'async';
          const finish = () => {
            done++;
            onProgress?.(done, jobs.length);
            resolve();
          };
          img.onload = () => {
            images.set(`${slug}/${map}`, img);
            finish();
          };
          img.onerror = () => {
            console.warn(`texture not available: ${slug}/${map}`);
            finish();
          };
          img.src = new URL(`textures/${slug}/${map}.jpg`, document.baseURI).href;
        }),
    ),
  );
  return images.size;
}

export function texImage(slug: string, map: TexMap): HTMLImageElement | null {
  return images.get(`${slug}/${map}`) ?? null;
}

/**
 * Shared, repeat-wrapped three.js texture for a library image (cached per
 * slug/map/repeat). Colour maps are sRGB, data maps linear.
 */
export function libTexture(slug: string, map: TexMap, repeat: [number, number] = [1, 1]): Texture | null {
  const img = texImage(slug, map);
  if (!img) return null;
  const key = `${slug}/${map}/${repeat[0]}x${repeat[1]}`;
  let t = textures.get(key);
  if (!t) {
    t = new Texture(img);
    t.wrapS = t.wrapT = RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
    t.colorSpace = map === 'albedo' ? SRGBColorSpace : NoColorSpace;
    t.minFilter = LinearMipmapLinearFilter;
    t.anisotropy = 8;
    t.needsUpdate = true;
    textures.set(key, t);
  }
  return t;
}

/**
 * Tiles a library image over a canvas rectangle (for baking real texture
 * detail into the procedural paint canvases). `tilePx` is the on-canvas size
 * of one tile; `op` the composite operation (e.g. 'multiply', 'overlay').
 */
export function tileImage(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource & { width: number; height: number },
  x: number,
  y: number,
  w: number,
  h: number,
  tilePx: number,
  opts: { alpha?: number; op?: GlobalCompositeOperation; offsetX?: number; offsetY?: number } = {},
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.globalAlpha = opts.alpha ?? 1;
  ctx.globalCompositeOperation = opts.op ?? 'source-over';
  const th = tilePx * (img.height / img.width);
  const ox = x - (((opts.offsetX ?? 0) % tilePx) + tilePx) % tilePx;
  const oy = y - (((opts.offsetY ?? 0) % th) + th) % th;
  for (let ty = oy; ty < y + h; ty += th) for (let tx = ox; tx < x + w; tx += tilePx) ctx.drawImage(img, tx, ty, tilePx, th);
  ctx.restore();
}
