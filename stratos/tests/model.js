// aircraft model turntable
await wait(8);
const views = [
  ['m_front34', [14, 3.5, -16]],
  ['m_side', [20, 1.5, 0]],
  ['m_rear34', [-12, 5, 16]],
  ['m_top', [3, 18, 2]],
];
for (const [name, off] of views) {
  await page.evaluate((o) => {
    const g = window.game;
    const p = g.aircraft.position;
    const q = g.aircraft.quaternion;
    const V = g.camera.position.constructor;
    const offset = new V(...o).applyQuaternion(q);
    g.debugCam = { pos: p.clone().add(offset), target: p.clone().add(new V(0, 0.3, 0)) };
  }, off);
  await wait(5);
  await snap(name);
}
