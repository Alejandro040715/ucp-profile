await wait(5);
const views = [
  ['c_below', [0, 600, 0], [0, 1800, -15000]],
  ['c_level', [0, 2600, 0], [0, 2600, -20000]],
  ['c_above', [0, 5200, 0], [0, 1500, -18000]],
];
for (const [name, pos, tgt] of views) {
  await page.evaluate(([p, t]) => { const g = window.game; const V = g.camera.position.constructor; g.debugCam = { pos: new V(...p), target: new V(...t) }; }, [pos, tgt]);
  await wait(8);
  await snap(name);
}
const w = await page.evaluate(() => JSON.stringify(window.game.weather.current));
console.log(w);
