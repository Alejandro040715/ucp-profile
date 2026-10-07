await page.waitForFunction(() => window.game.terrain.pending === 0, null, { timeout: 240000, polling: 500 });
await page.evaluate(() => { const g = window.game; g.time.setHours(15.5); });
await wait(3);
const dump = () => page.evaluate(() => { const g = window.game; const p = g.pipeline.params; return JSON.stringify({ exp: p.exposure, sunDir: g.time.sunDir, sunCol: g.time.sunColor, hours: g.time.hours, night: g.time.night }); });
console.log(await dump());
await snap('dbg_1530');
