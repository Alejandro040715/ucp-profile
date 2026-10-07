await wait(4);
const r = await page.evaluate(async () => { const g = window.game; const m = g.player.cockpit.mfdL; const out = [];
  for (let i = 0; i < 10; i++) { await new Promise((res) => setTimeout(res, 300)); out.push(`boot=${m.bootTimer.toFixed(2)} prev=${m.prevPower} timer=${m.timer.toFixed(2)} rate=${m.rate} ess=${g.aircraft.electrical.essentialBus} main=${g.aircraft.electrical.mainBus} page=${m.page} inCk=${g.cameras.inCockpit} paused=${g.paused}`); }
  return out.join('\n'); });
console.log(r);
