// close exterior study (terrain streamed first)
await page.waitForFunction(() => window.game.terrain.pending === 0, null, { timeout: 240000, polling: 500 });
await page.evaluate(() => { const g = window.game; g.time.setHours(15.5); });

const views = [
  ['x_front34', [9, 2.2, -11], [0, 0.3, -2]],
  ['x_side', [13, 0.8, -1], [0, 0.5, -1]],
  ['x_rear34', [-8, 3.2, 12], [0, 0.6, 2]],
  ['x_top', [5, 11, 1], [0, 0, 0]],
  ['x_nose', [2.5, 1.0, -9.5], [0, 0.6, -5]],
  ['x_gear', [4.2, -0.6, -1.2], [0, -1.2, 0.5]],
];
for (const [name, off, tgt] of views) {
  await page.evaluate(([o, t]) => {
    const g = window.game;
    const p = g.aircraft.position;
    const q = g.aircraft.quaternion;
    const V = g.camera.position.constructor;
    g.debugCam = { pos: p.clone().add(new V(...o).applyQuaternion(q)), target: p.clone().add(new V(...t).applyQuaternion(q)) };
    g.camera.fov = 50; g.camera.updateProjectionMatrix();
  }, [off, tgt]);
  await wait(4);
  await snap(name);
}
