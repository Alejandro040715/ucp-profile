// Dev harness: launches Vite, opens the game in headless Chromium (SwiftShader),
// captures console output and screenshots. Usage: node tests/shot.mjs [seconds] [script.js]
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';

const seconds = Number(process.argv[2] ?? 20);
const scriptFile = process.argv[3];
const width = Number(process.env.W ?? 960), height = Number(process.env.H ?? 540);
const OUT = process.env.OUT ?? 'tests/output';
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.PORT ?? 5199);
const server = await createServer({ server: { port: PORT, host: '127.0.0.1', strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width, height } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
const url = `http://127.0.0.1:${PORT}/${process.env.QS ?? '?q=LOW&fly'}`;
await page.goto(url, { waitUntil: 'commit', timeout: 120000 });
const tLoad = Date.now();
await page.waitForFunction(() => window.game && window.game.running, null, { timeout: 240000, polling: 500 });
console.log('game ready after', ((Date.now() - tLoad) / 1000).toFixed(1) + 's');
const t0 = Date.now();
let shot = 0;
const script = scriptFile && existsSync(scriptFile) ? readFileSync(scriptFile, 'utf8') : null;
if (script) {
  // the script can call: await snap(name), await wait(sec), and use `page`
  const fn = new Function('page', 'snap', 'wait', `return (async () => { ${script} })();`);
  await fn(page, async (name) => { await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 180000 }); console.log('snap', name, ((Date.now() - t0) / 1000).toFixed(1) + 's'); }, (s) => new Promise((r) => setTimeout(r, s * 1000)));
} else {
  while ((Date.now() - t0) / 1000 < seconds) {
    await new Promise((r) => setTimeout(r, Math.max(1000, seconds * 1000 / 3)));
    await page.screenshot({ path: `${OUT}/shot${shot++}.png` });
  }
}
const stats = await page.evaluate(() => { const g = window.game; if (!g) return 'no game'; return { fps: g.fps?.toFixed(1), calls: g.pipeline?.lastCalls, tris: g.pipeline?.lastTriangles, terrain: g.terrain?.visibleCount, pending: g.pool?.pending }; }).catch((e) => String(e));
console.log('stats', JSON.stringify(stats));
const uniq = [...new Set(logs)];
console.log(uniq.slice(0, 60).join('\n'));
await browser.close();
await server.close();
