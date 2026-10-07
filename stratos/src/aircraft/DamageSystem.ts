// Modular, progressive damage model. Each component keeps a health value; the
// effects (lift loss, roll asymmetry, thrust loss, jammed surfaces, fire,
// fuel leaks) are applied to the owning subsystems. Only an extreme impact
// destroys the aircraft outright.

import { events } from '../core/EventBus.ts';
import { clamp } from '../core/math.ts';
import type { EngineSystem } from './EngineSystem.ts';
import type { FuelSystem } from './FuelSystem.ts';
import type { ControlSurfaces } from './ControlSurfaces.ts';
import type { LandingGear } from './LandingGear.ts';

export type DamageComponent = 'leftWing' | 'rightWing' | 'tail' | 'engine' | 'fuselage' | 'flaperonL' | 'flaperonR' | 'stabL' | 'stabR' | 'rudder';

export const DAMAGE_LABELS: Record<DamageComponent, string> = {
  leftWing: 'L WING',
  rightWing: 'R WING',
  tail: 'TAIL',
  engine: 'ENGINE',
  fuselage: 'FUSELAGE',
  flaperonL: 'L FLAPERON',
  flaperonR: 'R FLAPERON',
  stabL: 'L STAB',
  stabR: 'R STAB',
  rudder: 'RUDDER',
};

export class DamageSystem {
  health: Record<DamageComponent, number> = {
    leftWing: 1, rightWing: 1, tail: 1, engine: 1, fuselage: 1,
    flaperonL: 1, flaperonR: 1, stabL: 1, stabR: 1, rudder: 1,
  };
  fire = 0; // 0..1 fire intensity
  smoke = 0; // 0..1 smoke intensity
  destroyed = false;
  invulnerable = false;
  private overGTimer = 0;
  private lastImpactTime = new Map<string, number>();
  time = 0;
  engine: EngineSystem;
  fuel: FuelSystem;
  surfaces: ControlSurfaces;
  gear: LandingGear;

  constructor(engine: EngineSystem, fuel: FuelSystem, surfaces: ControlSurfaces, gear: LandingGear) {
    this.engine = engine;
    this.fuel = fuel;
    this.surfaces = surfaces;
    this.gear = gear;
  }

  reset(): void {
    for (const k of Object.keys(this.health) as DamageComponent[]) this.health[k] = 1;
    this.fire = 0;
    this.smoke = 0;
    this.destroyed = false;
    this.engine.health = 1;
    this.engine.onFire = false;
    for (const t of this.fuel.tanks) t.leakRate = 0;
    this.surfaces.flaperonJamL = this.surfaces.flaperonJamR = false;
    this.surfaces.stabJamL = this.surfaces.stabJamR = false;
    this.surfaces.rudderJam = false;
    for (const l of this.gear.legs) {
      l.health = 1;
      l.broken = false;
    }
  }

  apply(c: DamageComponent, amount: number): void {
    if (this.invulnerable || this.destroyed || amount <= 0) return;
    const before = this.health[c];
    const h = clamp(before - amount, 0, 1);
    this.health[c] = h;
    if (before - h > 0.005) events.emit('damage', { component: c, amount: before - h, health: h });
    // cascading consequences
    if (c === 'leftWing' || c === 'rightWing') {
      const tank = this.fuel.tanks.find((t) => t.id === (c === 'leftWing' ? 'WING L' : 'WING R'));
      if (tank && h < 0.55) tank.leakRate = (0.55 - h) * 6;
      const fl: DamageComponent = c === 'leftWing' ? 'flaperonL' : 'flaperonR';
      if (h < 0.4) this.apply(fl, amount * 0.8);
    }
    if (c === 'tail') {
      if (h < 0.5) {
        this.apply('rudder', amount * 0.6);
        this.apply(Math.random() < 0.5 ? 'stabL' : 'stabR', amount * 0.6);
      }
    }
    if (c === 'engine') {
      this.engine.health = h;
      if (h < 0.4 && Math.random() < 0.55) this.engine.onFire = true;
      if (h <= 0.02) this.engine.kill();
    }
    if (c === 'fuselage' && h < 0.4) {
      const fwd = this.fuel.tanks.find((t) => t.id === 'FWD');
      if (fwd) fwd.leakRate = (0.4 - h) * 4;
    }
    this.surfaces.flaperonJamL = this.health.flaperonL <= 0.05;
    this.surfaces.flaperonJamR = this.health.flaperonR <= 0.05;
    this.surfaces.stabJamL = this.health.stabL <= 0.05;
    this.surfaces.stabJamR = this.health.stabR <= 0.05;
    this.surfaces.rudderJam = this.health.rudder <= 0.05;
  }

  /** impact of an airframe contact point (m/s into the surface, tangential slide speed) */
  impact(contactId: string, c: DamageComponent, normalSpeed: number, slideSpeed: number): void {
    if (this.invulnerable || this.destroyed) return;
    const key = c;
    const last = this.lastImpactTime.get(key) ?? -10;
    const severity = Math.max(0, normalSpeed - 1.5) * 0.09 + Math.max(0, slideSpeed - 5) * 0.0015;
    if (severity <= 0) return;
    // continuous scraping: rate-limited small damage
    const scale = this.time - last < 0.25 ? 0.12 : 1;
    this.lastImpactTime.set(key, this.time);
    this.apply(c, severity * scale);
    if (c === 'fuselage' && severity > 0.3) this.apply('engine', severity * 0.3);
    if (normalSpeed > 22 || (normalSpeed > 12 && slideSpeed > 90)) {
      this.destroy(`${contactId} impact at ${normalSpeed.toFixed(0)} m/s`);
    }
  }

  destroy(reason: string): void {
    if (this.destroyed || this.invulnerable) return;
    this.destroyed = true;
    this.fire = 1;
    this.smoke = 1;
    this.engine.kill();
    events.emit('crash', { speed: 0, reason });
  }

  update(dt: number, nz: number, mach: number, egt: number, ias: number): void {
    this.time += dt;
    if (this.destroyed) return;
    // structural over-G
    if (nz > 10.5 || nz < -4.2) {
      this.overGTimer += dt;
      if (this.overGTimer > 0.35) {
        const over = nz > 0 ? nz - 10.5 : -4.2 - nz;
        const d = (0.04 + over * 0.05) * dt * 4;
        this.apply('leftWing', d * (0.8 + Math.random() * 0.4));
        this.apply('rightWing', d * (0.8 + Math.random() * 0.4));
        this.apply('tail', d * 0.6);
        events.emit('stress', { g: nz });
      }
    } else this.overGTimer = Math.max(0, this.overGTimer - dt * 2);
    // overspeed flutter
    if (mach > 2.3 || ias > 420) {
      this.apply('tail', 0.05 * dt);
      this.apply(Math.random() < 0.5 ? 'flaperonL' : 'flaperonR', 0.06 * dt);
    }
    // engine over-temperature
    if (egt > this.engine.cfg.egtMax) this.apply('engine', (egt - this.engine.cfg.egtMax) * 0.0008 * dt);
    // fire progression
    if (this.engine.onFire) {
      this.fire = Math.min(1, this.fire + dt * 0.25);
      this.apply('engine', 0.025 * dt);
      if (this.health.engine < 0.15) this.apply('tail', 0.01 * dt);
    } else this.fire = Math.max(0, this.fire - dt * 0.3);
    const smokeTarget = Math.max(this.fire, (1 - this.health.engine) * 0.8, this.fuel.leaking ? 0.25 : 0);
    this.smoke += (smokeTarget - this.smoke) * Math.min(1, dt * 1.5);
  }

  /** Extinguisher (cockpit button). One shot. */
  extinguisherUsed = false;
  extinguish(): void {
    if (this.extinguisherUsed) return;
    this.extinguisherUsed = true;
    if (this.engine.onFire) {
      this.engine.onFire = false;
      this.engine.requestShutdown();
      events.emit('message', { text: 'FIRE EXTINGUISHED — ENGINE SECURED', kind: 'good', duration: 4 });
    }
  }

  get overall(): number {
    const h = this.health;
    return (h.leftWing + h.rightWing + h.tail + h.engine + h.fuselage) / 5;
  }
}
