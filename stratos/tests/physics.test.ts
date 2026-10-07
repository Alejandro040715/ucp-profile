// Headless validation of the flight model: runs scripted scenarios in Node and
// checks the numbers against expectations for a modern fighter.
// Run: npm run test:physics

import { Vector3 } from 'three';
import { AircraftPhysics } from '../src/aircraft/AircraftPhysics.ts';
import type { GroundSample, PhysicsEnvironment } from '../src/aircraft/PhysicsTypes.ts';
import { DEG, KT, RAD } from '../src/core/math.ts';

const flatEnv: PhysicsEnvironment = {
  sampleGround(_x: number, _z: number, out: GroundSample) {
    out.height = 0;
    out.normal.set(0, 1, 0);
    out.surface = 'runway';
    return out;
  },
  sampleWind(_p: Vector3, out: Vector3) {
    return out.set(0, 0, 0);
  },
  turbulenceRates(out: Vector3) {
    return out.set(0, 0, 0);
  },
  tempOffset: 0,
  wetness: 0,
  humidity: 0.5,
  cloudDensityAt() {
    return 0;
  },
};

const DT = 1 / 240;
let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failures++;
}

function run(ac: AircraftPhysics, seconds: number, fn?: (t: number) => void | boolean) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    if (fn && fn(i * DT) === true) return i * DT;
    ac.step(DT, flatEnv);
  }
  return seconds;
}

function fresh(alt: number, speed: number, onGround = false) {
  const ac = new AircraftPhysics();
  ac.reset(new Vector3(0, alt, 0), 0, speed, onGround, flatEnv);
  ac.electrical.batterySwitch = true;
  ac.gear.parkingBrake = onGround;
  if (!onGround) {
    ac.gear.handleDown = false;
    for (const l of ac.gear.legs) { l.extension = 0; l.door = 0; }
    ac.engine.state = 'RUN';
    ac.engine.n2 = 0.9;
    ac.engine.egt = 700;
  }
  return ac;
}

// ---------- 1. ground static ----------
{
  const ac = fresh(0, 0, true);
  run(ac, 6);
  const pitch = ac.t.pitch * RAD;
  const legs = ac.gear.legs.map((l) => `${l.cfg.id}:${l.compression.toFixed(3)}`).join(' ');
  check('ground static settles', Math.abs(ac.velocity.length()) < 0.05 && Math.abs(pitch) < 2.5, `pitch=${pitch.toFixed(2)}° h=${ac.position.y.toFixed(3)} v=${ac.velocity.length().toFixed(4)} ${legs}`);
}

// ---------- 2. engine start ----------
{
  const ac = fresh(0, 0, true);
  ac.engine.requestStart();
  const t = run(ac, 60, () => ac.engine.state === 'RUN');
  check('engine start to idle', t > 6 && t < 30, `t=${t.toFixed(1)}s n2=${(ac.engine.n2 * 100).toFixed(1)}% egt=${ac.engine.egt.toFixed(0)}C gen=${ac.electrical.generatorOnline}`);
  // spool from idle to MIL
  ac.controls.throttle = 1;
  const t2 = run(ac, 20, () => ac.engine.n2 > 0.98);
  check('spool idle->MIL', t2 > 2 && t2 < 9, `t=${t2.toFixed(2)}s thrust=${(ac.engine.thrust / 1000).toFixed(1)}kN`);
}

// ---------- 3. takeoff ----------
{
  const ac = fresh(0, 0, true);
  ac.engine.state = 'RUN';
  ac.engine.n2 = 0.63;
  ac.setFlaps(1);
  run(ac, 8); // flaps travel
  ac.gear.parkingBrake = false;
  ac.controls.throttle = 1;
  ac.controls.afterburner = false;
  let rotateAt = 0;
  let liftoff = 0;
  let liftoffDist = 0;
  run(ac, 70, (t) => {
    const ias = ac.t.ias;
    if (ias > 75 && !rotateAt) rotateAt = t;
    if (rotateAt) ac.controls.pitch = 0.55;
    if (!ac.gear.weightOnWheels && ac.position.y > 3 && !liftoff) {
      liftoff = ias;
      liftoffDist = -ac.position.z;
      return true;
    }
  });
  check('takeoff MIL liftoff speed', liftoff > 70 && liftoff < 95, `liftoff IAS=${(liftoff / KT).toFixed(0)}kt dist=${liftoffDist.toFixed(0)}m pitch=${(ac.t.pitch * RAD).toFixed(1)}° aoa=${(ac.t.alpha * RAD).toFixed(1)}`);
  // no liftoff below ~120kt even with full aft stick
  const ac2 = fresh(0, 0, true);
  ac2.engine.state = 'RUN'; ac2.engine.n2 = 0.63;
  ac2.gear.parkingBrake = false; ac2.controls.throttle = 1; ac2.controls.pitch = 1;
  let early = 0;
  run(ac2, 60, () => {
    if (!ac2.gear.weightOnWheels && ac2.position.y > 3) { early = ac2.t.ias; return true; }
  });
  check('no absurdly-low-speed takeoff', early > 62, `full aft stick liftoff IAS=${(early / KT).toFixed(0)}kt`);
}

// ---------- 4. hands-off stability, level flight ----------
for (const [alt, spd] of [[1000, 150], [3000, 220], [9000, 280]] as const) {
  const ac = fresh(alt, spd);
  ac.controls.throttle = 0.75;
  run(ac, 30);
  const vs = ac.t.verticalSpeed;
  check(`hands-off ${alt}m ${spd}m/s`, Math.abs(ac.t.bank * RAD) < 3 && Math.abs(vs) < 25 && ac.omega.length() < 0.05, `vs=${vs.toFixed(1)} bank=${(ac.t.bank * RAD).toFixed(1)} pitch=${(ac.t.pitch * RAD).toFixed(1)} aoa=${(ac.t.alpha * RAD).toFixed(1)} ias=${(ac.t.ias / KT).toFixed(0)}kt nz=${ac.t.nz.toFixed(2)}`);
}

// ---------- 4b. airborne spawn starts trimmed (no initial sink) ----------
{
  const ac = fresh(1600, 190);
  ac.controls.throttle = 0.8;
  let minNz = 9, maxNz = -9;
  run(ac, 3, () => {
    minNz = Math.min(minNz, ac.t.nz);
    maxNz = Math.max(maxNz, ac.t.nz);
    return false;
  });
  check('airborne spawn trimmed', minNz > 0.8 && maxNz < 1.2 && Math.abs(ac.t.verticalSpeed) < 3, `nz ${minNz.toFixed(2)}..${maxNz.toFixed(2)} vs=${ac.t.verticalSpeed.toFixed(2)} aoa=${(ac.t.alpha * RAD).toFixed(1)}`);
}

// ---------- 5. top speeds ----------
{
  const ac = fresh(300, 250);
  ac.controls.throttle = 1;
  ac.controls.afterburner = true;
  ac.engine.n2 = 1;
  run(ac, 120, () => {
    // altitude hold-ish by stick
    ac.controls.pitch = Math.max(-0.3, Math.min(0.3, (300 - ac.position.y) * 0.004 - ac.velocity.y * 0.03));
  });
  check('sea level AB top speed ~M1.0-1.25', ac.t.mach > 0.95 && ac.t.mach < 1.3, `M=${ac.t.mach.toFixed(2)} tas=${ac.t.tas.toFixed(0)} thrust=${(ac.engine.thrust / 1000).toFixed(0)}kN drag=${(ac.t.drag / 1000).toFixed(0)}kN fuelflow=${ac.engine.fuelFlow.toFixed(2)}kg/s`);
  const ac2 = fresh(11000, 260);
  ac2.controls.throttle = 1;
  ac2.controls.afterburner = true;
  ac2.engine.n2 = 1;
  run(ac2, 240, () => {
    ac2.controls.pitch = Math.max(-0.3, Math.min(0.3, (11000 - ac2.position.y) * 0.002 - ac2.velocity.y * 0.02));
  });
  check('11km AB top speed ~M1.7-2.1', ac2.t.mach > 1.6 && ac2.t.mach < 2.2, `M=${ac2.t.mach.toFixed(2)} alt=${ac2.position.y.toFixed(0)}`);
  const ac3 = fresh(11000, 260);
  ac3.controls.throttle = 1;
  ac3.engine.n2 = 1;
  run(ac3, 200, () => {
    ac3.controls.pitch = Math.max(-0.3, Math.min(0.3, (11000 - ac3.position.y) * 0.002 - ac3.velocity.y * 0.02));
  });
  check('11km MIL speed subsonic/transonic', ac3.t.mach > 0.85 && ac3.t.mach < 1.2, `M=${ac3.t.mach.toFixed(2)}`);
}

// ---------- 6. max G pull / G limiter ----------
{
  const ac = fresh(3000, 260);
  ac.controls.throttle = 1;
  ac.controls.afterburner = true;
  let maxG = 0;
  run(ac, 2);
  run(ac, 6, () => {
    ac.controls.pitch = 1;
    maxG = Math.max(maxG, ac.t.nz);
  });
  check('full pull reaches ~9G, limited', maxG > 8.2 && maxG < 9.8, `maxG=${maxG.toFixed(2)} aoa=${(ac.t.alpha * RAD).toFixed(1)}`);
  const ac2 = fresh(3000, 110);
  ac2.controls.throttle = 1;
  let maxA = 0;
  run(ac2, 6, () => {
    ac2.controls.pitch = 1;
    maxA = Math.max(maxA, ac2.t.alpha * RAD);
  });
  check('AoA limiter at low speed', maxA > 20 && maxA < 28, `maxAoA=${maxA.toFixed(1)} nz=${ac2.t.nz.toFixed(2)}`);
}

// ---------- 7. roll rate ----------
{
  const ac = fresh(3000, 220);
  ac.controls.throttle = 0.8;
  run(ac, 1);
  let maxP = 0;
  run(ac, 3, () => {
    ac.controls.roll = 1;
    maxP = Math.max(maxP, -ac.omega.z * RAD);
  });
  check('max roll rate 180-280 deg/s', maxP > 170 && maxP < 290, `p=${maxP.toFixed(0)}°/s`);
  ac.controls.roll = 0;
  run(ac, 3);
  check('roll stops when released', Math.abs(ac.omega.z * RAD) < 5, `p=${(-ac.omega.z * RAD).toFixed(1)}°/s bank=${(ac.t.bank * RAD).toFixed(0)}`);
}

// ---------- 8. DIRECT mode stall ----------
{
  const ac = fresh(4000, 100);
  ac.fcs.mode = 'DIRECT';
  ac.controls.throttle = 0.2;
  let stalled = false;
  let maxA = 0;
  run(ac, 12, () => {
    ac.controls.pitch = 1;
    maxA = Math.max(maxA, ac.t.alpha * RAD);
    if (ac.aero.stall > 0.2) stalled = true;
  });
  check('DIRECT stall possible', stalled, `maxAoA=${maxA.toFixed(1)} stall=${ac.aero.stall.toFixed(2)} ias=${(ac.t.ias / KT).toFixed(0)}kt`);
  // recovery: release, push, power
  ac.controls.pitch = -0.3;
  ac.controls.throttle = 1;
  run(ac, 8);
  ac.controls.pitch = 0;
  run(ac, 4);
  check('stall recovery', ac.t.alpha * RAD < 15 && ac.aero.stall < 0.05, `aoa=${(ac.t.alpha * RAD).toFixed(1)} ias=${(ac.t.ias / KT).toFixed(0)}kt alt=${ac.position.y.toFixed(0)}`);
}

// ---------- 9. approach & landing ----------
{
  const ac = fresh(120, 78);
  ac.gear.handleDown = true;
  for (const l of ac.gear.legs) { l.extension = 1; l.door = 1; }
  ac.setFlaps(2);
  ac.surfaces.flaps = ac.surfaces.flapTarget;
  ac.controls.throttle = 0.55;
  let td = 0;
  let maxComp = 0;
  run(ac, 90, () => {
    // fly a 3 deg glideslope with a simple autopilot, flare at 8 m
    const h = ac.position.y - 2.4;
    const targetVs = h > 9 ? -4.0 : -0.9 - h * 0.08;
    ac.controls.pitch = Math.max(-0.6, Math.min(0.6, (targetVs - ac.velocity.y) * 0.08));
    ac.controls.throttle = Math.max(0.2, Math.min(0.9, 0.55 + (72 - ac.t.ias) * 0.05));
    if (h < 6) ac.controls.throttle = 0;
    for (const l of ac.gear.legs) maxComp = Math.max(maxComp, l.compression);
    if (ac.gear.weightOnWheels && !td) td = ac.velocity.y;
    if (td && ac.gear.legs[0].contact) {
      ac.controls.brakeLeft = ac.controls.brakeRight = 1;
      ac.surfaces.airbrakeCmd = true;
    }
    if (td && ac.t.groundSpeed < 1) return true;
  });
  const anyBroken = ac.gear.legs.some((l) => l.broken);
  check('landing & stop', td !== 0 && !anyBroken && ac.t.groundSpeed < 2, `touchdown vs=${td.toFixed(2)}m/s maxComp=${maxComp.toFixed(2)} gs=${ac.t.groundSpeed.toFixed(1)} rollout=${(-ac.position.z).toFixed(0)}m`);
}

// ---------- 10. hard landing damages gear ----------
{
  // landing configuration, no flare (DIRECT law, stick neutral), ~1500 ft/min
  // sink into the runway: gear is designed for ~600 ft/min
  const ac = fresh(4.5, 78);
  ac.gear.handleDown = true;
  for (const l of ac.gear.legs) { l.extension = 1; l.door = 1; }
  ac.setFlaps(2);
  ac.surfaces.flaps = ac.surfaces.flapTarget;
  ac.fcs.mode = 'DIRECT';
  ac.velocity.y = -7.5;
  run(ac, 3);
  const h = ac.gear.legs.map((l) => l.health.toFixed(2)).join('/');
  check('hard landing damages gear, not destroyed', ac.gear.legs.some((l) => l.health < 0.9) && !ac.damage.destroyed, `health=${h} destroyed=${ac.damage.destroyed} overall=${ac.damage.overall.toFixed(2)}`);
}

// ---------- 11. fuel exhaustion -> glide ----------
{
  const ac = fresh(5000, 200);
  ac.fuel.setFraction(0.002);
  ac.controls.throttle = 1;
  run(ac, 30);
  check('fuel exhaustion flames out', ac.engine.state === 'FLAMEOUT' && ac.engine.thrust < 2000, `state=${ac.engine.state} n2=${(ac.engine.n2 * 100).toFixed(0)}% thrust=${ac.engine.thrust.toFixed(0)}`);
  run(ac, 30);
  check('glides after flameout', ac.position.y > 2500 && ac.t.ias > 60, `alt=${ac.position.y.toFixed(0)} ias=${(ac.t.ias / KT).toFixed(0)}kt vs=${ac.t.verticalSpeed.toFixed(1)}`);
}

console.log(failures === 0 ? '\nALL PHYSICS CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
