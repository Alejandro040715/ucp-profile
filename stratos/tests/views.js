// camera tour for visual checks
const views = [
  ['apron', [600, 135, 300], [0, 120, -400]],
  ['runway_end', [380, 128, 1800], [-200, 120, -1200]],
  ['town', [3000, 400, 6500], [4700, 150, 3900]],
  ['valley', [3500, 700, -6000], [2500, 500, -16000]],
  ['high', [0, 9000, 12000], [0, 0, -30000]],
];
await wait(6);
for (const [name, pos, tgt] of views) {
  await page.evaluate(([p, t]) => { const g = window.game; g.debugCam = { pos: new g.camera.position.constructor(...p), target: new g.camera.position.constructor(...t) }; }, [pos, tgt]);
  await wait(14);
  await snap(name);
}
