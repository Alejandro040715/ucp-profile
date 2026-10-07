// afterburner plume close-up (rear quarter), then a side pass with vapour
await wait(6);
await page.evaluate(() => { const g = window.game; g.spawn('air'); g.weather.set('CLEAR', true); g.cameras.setMode('CHASE'); g.input.throttle = 1; g.input.afterburner = true; });
await page.waitForFunction(() => window.game.aircraft.engine.abFraction > 0.9, null, { timeout: 240000, polling: 300 });
await page.evaluate(() => { const g = window.game; g.cameras.orbitYaw = 0.35; g.cameras.orbitPitch = 0.12; g.cameras.chaseDistance = 14; });
await wait(3);
await snap('ab_rear');
await page.evaluate(() => { const g = window.game; g.cameras.orbitYaw = 1.45; g.cameras.orbitPitch = 0.05; });
await wait(3);
await snap('ab_side');
