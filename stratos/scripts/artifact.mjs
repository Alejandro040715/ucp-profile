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
writeFileSync(
  join(out, 'index.html'),
  `<title>Stratos XF-41 Corvus</title>
<meta name="description" content="Fictional modern fighter flight simulator vertical slice: 6-DOF flight model, fly-by-wire, clickable cockpit, procedural sound.">
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
