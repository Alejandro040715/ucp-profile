await wait(10);
await snap('ui_menu2');
await page.evaluate(() => { const g = window.game; g.ui.fly('air'); });
await wait(5);
await snap('ui_air_cockpit');
await page.evaluate(() => { const g = window.game; g.setPhotoMode(true); g.pipeline.params.dof = true; });
await wait(3);
await snap('ui_photo');
