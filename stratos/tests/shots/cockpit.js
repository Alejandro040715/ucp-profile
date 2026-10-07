await page.waitForFunction(() => window.game.terrain.pending === 0, null, { timeout: 240000, polling: 500 });
const look = (y, p, z = 1) => page.evaluate(([y, p, z]) => { const c = window.game.cameras; c.lookYawT = y; c.lookPitchT = p; c.lookYaw = y; c.lookPitch = p; c.zoom = z; }, [y, p, z]);
await page.evaluate(() => { const g = window.game; g.cameras.setMode('COCKPIT'); });
await page.waitForFunction(() => window.game.player.cockpit.mfdL.bootTimer <= 0, null, { timeout: 240000, polling: 500 });
await look(0, -0.06); await wait(3); await snap('c_front');
await look(0, -0.5); await wait(3); await snap('c_panel');
await look(0.9, -0.75); await wait(3); await snap('c_left');
await look(-0.9, -0.75); await wait(3); await snap('c_right');
await look(0, 0.05, 0.5); await wait(3); await snap('c_hud');
