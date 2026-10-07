// close-ups of the airframe details (nozzle, chin sensor, probes, fins, doors)
await page.waitForFunction(() => window.game.terrain.pending === 0, null, { timeout: 240000, polling: 500 });
await page.evaluate(() => { const g = window.game; g.time.setHours(15.5); });
const cam = (o, t, fov = 45) => page.evaluate(([o, t, fov]) => { const g = window.game; const p = g.aircraft.position, q = g.aircraft.quaternion, V = g.camera.position.constructor;
  g.debugCam = { pos: p.clone().add(new V(...o).applyQuaternion(q)), target: p.clone().add(new V(...t).applyQuaternion(q)) }; g.camera.fov = fov; g.camera.updateProjectionMatrix(); }, [o, t, fov]);
await cam([-2.2, 1.0, 13.5], [0, 0.1, 7.5], 35); await wait(4); await snap('d_nozzle');
await cam([2.4, -1.1, -9.2], [0, -0.4, -6.8], 40); await wait(4); await snap('d_chin');
await cam([-6.5, 2.6, 9.5], [0, 1.4, 4.8], 40); await wait(4); await snap('d_tail');
await cam([3.5, -1.6, 2.0], [0, -0.9, -0.5], 55); await wait(4); await snap('d_under');
await page.evaluate(() => { const g = window.game; g.time.setHours(19.4); g.player.operate('formation', 5); g.player.operate('navLights', 1); });
await cam([-9, 2.5, -6], [0, 0.6, 0], 50); await wait(5); await snap('d_dusk');
