await wait(5);
await page.evaluate(() => { const g = window.game; const V = g.camera.position.constructor; g.debugCam = { pos: new V(0, 600, 0), target: new V(0, 1800, -15000) }; });
await wait(6);
await snap('c2_temporal');
await page.evaluate(() => { window.game.clouds.temporal = false; });
await wait(4);
await snap('c2_notemporal');
const sz = await page.evaluate(() => { const c = window.game.clouds; return { w: c.rtCur.width, h: c.rtCur.height, scale: c.scale, pw: window.game.pipeline.width, ph: window.game.pipeline.height }; });
console.log(JSON.stringify(sz));
