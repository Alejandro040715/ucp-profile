// Internal fuel tanks with feed priority. Burns fuel from the engine fuel flow,
// shifts the centre of gravity as tanks empty, supports leaks from damage.

import { Vector3 } from 'three';
import { AircraftConfig, type FuelTankConfig } from './AircraftConfig.ts';

export interface FuelTank extends FuelTankConfig {
  quantity: number;
  leakRate: number; // kg/s
}

export class FuelSystem {
  tanks: FuelTank[];
  /** gameplay multiplier for fuel burn (1 = realistic) */
  burnMultiplier = 1;
  boostPump = true;
  totalBurned = 0;

  constructor(fraction = 1) {
    this.tanks = AircraftConfig.fuelTanks.map((t) => ({ ...t, quantity: t.capacity * fraction, leakRate: 0 }));
  }

  get total(): number {
    let s = 0;
    for (const t of this.tanks) s += t.quantity;
    return s;
  }

  get capacity(): number {
    let s = 0;
    for (const t of this.tanks) s += t.capacity;
    return s;
  }

  get fraction(): number {
    return this.total / this.capacity;
  }

  get available(): boolean {
    return this.total > 0.5;
  }

  setFraction(f: number): void {
    for (const t of this.tanks) t.quantity = t.capacity * f;
  }

  update(dt: number, fuelFlow: number): void {
    let demand = fuelFlow * dt * this.burnMultiplier;
    this.totalBurned += demand;
    // drain in priority order; tanks with equal priority are drawn evenly
    const priorities = [...new Set(this.tanks.map((t) => t.feedPriority))].sort((a, b) => a - b);
    for (const p of priorities) {
      if (demand <= 0) break;
      const group = this.tanks.filter((t) => t.feedPriority === p && t.quantity > 0);
      while (demand > 1e-9 && group.length) {
        const share = demand / group.length;
        for (let i = group.length - 1; i >= 0; i--) {
          const t = group[i];
          const take = Math.min(share, t.quantity);
          t.quantity -= take;
          demand -= take;
          if (t.quantity <= 1e-6) group.splice(i, 1);
        }
      }
    }
    for (const t of this.tanks) {
      if (t.leakRate > 0) t.quantity = Math.max(0, t.quantity - t.leakRate * dt);
    }
  }

  /** Mass-weighted CG contribution: returns sum(m*pos) and total mass. */
  momentContribution(out: Vector3): number {
    out.set(0, 0, 0);
    let m = 0;
    for (const t of this.tanks) {
      out.x += t.pos[0] * t.quantity;
      out.y += t.pos[1] * t.quantity;
      out.z += t.pos[2] * t.quantity;
      m += t.quantity;
    }
    return m;
  }

  get leaking(): boolean {
    return this.tanks.some((t) => t.leakRate > 0 && t.quantity > 0);
  }
}
