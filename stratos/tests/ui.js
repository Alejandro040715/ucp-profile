await wait(8);
await snap('ui_menu');
await page.evaluate(() => { const g = window.game; g.ui.fly('air'); g.cameras.setMode('CHASE'); g.ui.showDebug = true; g.vectors.visible = true; g.input.throttle = 0.8; });
await wait(4);
await snap('ui_debug_vectors');
await page.evaluate(() => { const g = window.game; g.ui.showDebug = false; g.ui.toggleHelp(); });
await wait(2);
await snap('ui_help');
