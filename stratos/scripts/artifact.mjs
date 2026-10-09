// Packages the Vite build as an embeddable page: inlines the stylesheet,
// strips the document skeleton (the host adds its own) and keeps the module
// bundle + terrain worker as sibling files. Usage: npm run build && node scripts/artifact.mjs [outDir]
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'dist-artifact';
const html = readFileSync('dist/index.html', 'utf8');
const assets = readdirSync('dist/assets');
const css = readFileSync(join('dist/assets', assets.find((f) => f.endsWith('.css'))), 'utf8');
const entry = assets.find((f) => /^index-.*\.js$/.test(f));
const body = html.match(/<body>([\s\S]*)<\/body>/)[1].trim();
const fonts = html.match(/<link href="https:\/\/fonts\.googleapis\.com[^>]*>/)[0];
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'assets'), { recursive: true });
for (const f of assets.filter((f) => f.endsWith('.js'))) copyFileSync(join('dist/assets', f), join(out, 'assets', f));
// real CC0 textures (public/textures -> dist/textures) ship as sibling files
if (existsSync('dist/textures')) cpSync('dist/textures', join(out, 'textures'), { recursive: true });
// F-16 cockpit model (GPL, credits alongside)
if (existsSync('dist/models')) {
  cpSync('dist/models', join(out, 'models'), { recursive: true });
  // the artifact host serves no binary model type and its page refuses
  // fetches of data: URIs. Ship each model as the GLB in base64 text
  // (<name>.glb.txt, read by src/assets/loadModel.ts) with every texture
  // moved out to a sibling image file that loads like any published file.
  for (const f of readdirSync(join(out, 'models')).filter((f) => f.endsWith('.glb'))) {
    const name = f.replace(/\.glb$/, '');
    const glb = readFileSync(join(out, 'models', f));
    const jsonLen = glb.readUInt32LE(12);
    const gltf = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
    const binStart = 20 + jsonLen;
    const bin = glb.subarray(binStart + 8, binStart + 8 + glb.readUInt32LE(binStart));
    const views = gltf.bufferViews;
    const imageViews = new Set();
    (gltf.images ?? []).forEach((img, i) => {
      if (img.bufferView === undefined) return;
      const v = views[img.bufferView];
      const ext = img.mimeType === 'image/png' ? 'png' : 'jpg';
      const file = `${name}_tex${i}.${ext}`;
      writeFileSync(join(out, 'models', file), bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength));
      imageViews.add(img.bufferView);
      img.uri = file;
      delete img.bufferView;
      delete img.mimeType;
    });
    // compact the binary chunk without the image bytes
    const remap = new Map();
    const parts = [];
    let offset = 0;
    const kept = [];
    views.forEach((v, i) => {
      if (imageViews.has(i)) return;
      const data = bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
      const pad = (4 - (data.length % 4)) % 4;
      remap.set(i, kept.length);
      kept.push({ ...v, byteOffset: offset });
      parts.push(data, Buffer.alloc(pad));
      offset += data.length + pad;
    });
    gltf.bufferViews = kept;
    for (const a of gltf.accessors ?? []) if (a.bufferView !== undefined) a.bufferView = remap.get(a.bufferView);
    gltf.buffers = [{ byteLength: offset }];
    let json = Buffer.from(JSON.stringify(gltf));
    json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
    const newBin = Buffer.concat(parts);
    const head = Buffer.alloc(12);
    head.writeUInt32LE(0x46546c67, 0);
    head.writeUInt32LE(2, 4);
    head.writeUInt32LE(12 + 8 + json.length + 8 + newBin.length, 8);
    const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
    const packed = Buffer.concat([head, ch(json.length, 0x4e4f534a), json, ch(newBin.length, 0x004e4942), newBin]);
    writeFileSync(join(out, 'models', name + '.glb.txt'), packed.toString('base64'));
    rmSync(join(out, 'models', f));
  }
}
writeFileSync(
  join(out, 'index.html'),
  `<title>Stratos F-22A Raptor</title>
<meta name="description" content="F-22A Raptor flight simulator vertical slice: 6-DOF flight model, fly-by-wire, real F-16 cockpit, procedural sound.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
${fonts}
<style>
:root{color-scheme:dark;background:#07090b}
${css}
</style>
${body}
<script type="module" src="./assets/${entry}"></script>
`,
);
console.log(`artifact page -> ${out}/index.html (+ ${assets.filter((f) => f.endsWith('.js')).length} scripts)`);
