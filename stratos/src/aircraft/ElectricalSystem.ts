// Simplified electrical system: battery bus for essentials, generator-driven
// main bus for HUD / right MFD / exterior lights. Consumers query bus state.

import { AircraftConfig } from './AircraftConfig.ts';
import { clamp } from '../core/math.ts';

export class ElectricalSystem {
  batterySwitch = false;
  generatorSwitch = true;
  charge = 0.92;
  generatorOnline = false;
  /** lightning strike / damage induced dropout timer */
  private glitch = 0;

  /** battery (essential) bus: standby instruments, warning lights, starter, left MFD, flood lights */
  get essentialBus(): boolean {
    return (this.batterySwitch && this.charge > 0.02) || this.generatorOnline;
  }

  /** main bus: HUD, right MFD, exterior lights, full avionics */
  get mainBus(): boolean {
    return this.generatorOnline && this.glitch <= 0;
  }

  get voltage(): number {
    if (this.generatorOnline) return 28.2;
    if (this.batterySwitch) return 22 + 3.6 * this.charge;
    return 0;
  }

  get starterAvailable(): boolean {
    return this.batterySwitch && this.charge > 0.08;
  }

  triggerGlitch(seconds: number): void {
    this.glitch = Math.max(this.glitch, seconds);
  }

  update(dt: number, n2: number, engineRunning: boolean): void {
    const cfg = AircraftConfig.electrical;
    this.generatorOnline = this.generatorSwitch && engineRunning && n2 >= cfg.generatorMinN2;
    if (this.generatorOnline) {
      if (this.batterySwitch) this.charge = clamp(this.charge + cfg.batteryChargePerSec * dt, 0, 1);
    } else if (this.batterySwitch) {
      this.charge = clamp(this.charge - cfg.batteryDrainPerSec * dt, 0, 1);
    }
    if (this.glitch > 0) this.glitch -= dt;
  }
}
