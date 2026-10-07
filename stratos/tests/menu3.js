const t0 = Date.now();
await page.waitForFunction(() => window.game.terrain.pending === 0 && window.game.terrain.isReadyAround(window.game.aircraft.position, 512), null, { timeout: 240000, polling: 500 });
console.log('terrain ready after', ((Date.now() - t0) / 1000).toFixed(1));
await wait(2);
await snap('ui_menu3');
