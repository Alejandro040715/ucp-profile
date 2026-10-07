// night: external lights, landing light, cockpit lighting
await page.waitForFunction(() => window.game.terrain.pending === 0, null, { timeout: 240000, polling: 500 });
await page.evaluate(() => { const g = window.game; g.time.setHours(22.5); g.player.operate('floodLights', 3); g.player.operate('instLights', 4); g.player.operate('consoleLights', 4); });
await wait(4);
const ext = (o, t) => page.evaluate(([o, t]) => { const g = window.game; const p = g.aircraft.position, q = g.aircraft.quaternion, V = g.camera.position.constructor;
  g.debugCam = { pos: p.clone().add(new V(...o).applyQuaternion(q)), target: p.clone().add(new V(...t).applyQuaternion(q)) }; g.camera.fov = 50; g.camera.updateProjectionMatrix(); }, [o, t]);
await ext([10, 2.5, -14], [0, 0.3, -6]); await wait(3); await snap('n_front34');
await page.evaluate(() => { const g = window.game; g.debugCam = null; g.cameras.setMode('COCKPIT'); g.cameras.lookPitchT = -0.35; });
await wait(4); await snap('n_cockpit');
