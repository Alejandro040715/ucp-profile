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
  // the artifact host does not serve .glb: ship each model as glTF JSON with
  // the binary chunk embedded as a data URI (the loaders fall back to it)
  for (const f of readdirSync(join(out, 'models')).filter((f) => f.endsWith('.glb'))) {
    const glb = readFileSync(join(out, 'models', f));
    const jsonLen = glb.readUInt32LE(12);
    const gltf = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
    const binStart = 20 + jsonLen;
    const bin = glb.subarray(binStart + 8, binStart + 8 + glb.readUInt32LE(binStart));
    gltf.buffers = [{ byteLength: bin.length, uri: 'data:application/octet-stream;base64,' + bin.toString('base64') }];
    writeFileSync(join(out, 'models', f.replace(/\.glb$/, '.json')), JSON.stringify(gltf));
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
