await page.waitForFunction(() => window.game.terrain.pending === 0, null, { timeout: 240000, polling: 500 });
const info = await page.evaluate(() => { const g = window.game; const p = g.pipeline.params; return JSON.stringify({ exp: p.exposure, fog: p.fogDensity, camCloud: p.camCloud, pos: g.aircraft.position, cam: g.camera.position, hours: g.time.hours, w: g.weather.current.coverage, destroyed: g.aircraft.damage.destroyed, ao: p.ao }); });
console.log(info);
await snap('dbg_a');
await page.evaluate(() => { window.game.pipeline.params.ao = 0; });
await wait(2);
await snap('dbg_noao');
