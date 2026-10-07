// afterburner + vapour test from an external camera
await wait(6);
await page.evaluate(() => { const g = window.game; g.spawn('air'); g.weather.set('OVERCAST', true); g.weather.current.humidity = 0.95; g.cameras.setMode('CHASE'); g.input.throttle = 1; g.input.afterburner = true; });
await wait(5);
await page.evaluate(() => { const g = window.game; g.cameras.orbitYaw = 2.6; g.cameras.orbitPitch = 0.1; });
await wait(3);
await snap('fx_ab_rear');
await page.evaluate(() => { const g = window.game; g.cameras.orbitYaw = 0.6; g.cameras.orbitPitch = 0.25; });
await wait(2);
// pull hard for vapour
await page.evaluate(() => { const g = window.game; g.input.afterburner = false; g.input.throttle = 0.9; window.__pull = setInterval(() => { g.aircraft.controls.pitch = 1; g.input.axes.pitch = 1; }, 16); });
await wait(4);
await snap('fx_vapor');
await page.evaluate(() => { clearInterval(window.__pull); const g = window.game; g.cameras.setMode('COCKPIT'); });
await wait(4);
await snap('fx_cockpit_air');
