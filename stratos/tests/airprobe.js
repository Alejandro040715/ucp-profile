await wait(5);
const r = await page.evaluate(async () => {
  const g = window.game; g.ui.fly('air'); g.cameras.setMode('CHASE'); g.input.throttle = 0.8;
  const out = [];
  for (let i = 0; i < 12; i++) {
    await new Promise((res) => setTimeout(res, 500));
    const ph = g.aircraft, t = ph.t;
    out.push(`${(i*0.5+0.5).toFixed(1)}s nz=${t.nz.toFixed(2)} a=${(t.alpha*57.3).toFixed(1)} pitch=${(t.pitch*57.3).toFixed(1)} vs=${t.verticalSpeed.toFixed(1)} tas=${t.tas.toFixed(0)} hd=${ph.gear.handleDown} ext=${ph.gear.extension.toFixed(3)} fcs=${ph.fcs.nzCommand.toFixed(2)} elev=${(ph.surfaces.elevator.pos*57.3).toFixed(1)} mt=${g.missionTime.toFixed(1)} paused=${g.paused} pitchIn=${ph.controls.pitch.toFixed(2)}`);
  }
  return out.join('\n');
});
console.log(r);
