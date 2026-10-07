await wait(6);
const info = await page.evaluate(() => {
  const g = window.game;
  const rw = g.airport.group.children.filter((c) => c.isMesh).slice(0, 4).map((m) => ({ pos: m.position.toArray().map((v) => +v.toFixed(1)), rotY: +m.rotation.y.toFixed(3), visible: m.visible, kind: m.material.userData?.hookKey, geoCount: m.geometry.attributes.position.count, bs: m.geometry.boundingSphere ? m.geometry.boundingSphere.radius : null }));
  const progs = g.pipeline.renderer.info.programs.length;
  return { rw, progs, ac: g.aircraft.position.toArray().map((v) => +v.toFixed(1)) };
});
console.log(JSON.stringify(info));
await page.evaluate(() => { const g = window.game; const V = g.camera.position.constructor; g.debugCam = { pos: new V(250, 700, 1600), target: new V(0, 120, 0) }; });
await wait(6);
await snap('rwy_above');
