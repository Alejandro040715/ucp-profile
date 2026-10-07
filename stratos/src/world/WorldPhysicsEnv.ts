// Adapter exposing terrain + weather to the aircraft simulation
// (implements PhysicsEnvironment). Has a fast path for the flat air base.

import { Vector3 } from 'three';
import type { GroundSample, PhysicsEnvironment } from '../aircraft/PhysicsTypes.ts';
import { airportMask, isRunway, isTaxiway, surfaceAt, terrainHeight, waterLevelAt } from './Heightfield.ts';
import { AIRPORT_ELEVATION } from './WorldLayout.ts';
import type { Weather } from '../atmosphere/Weather.ts';

const _n = { x: 0, y: 1, z: 0 };

export class WorldPhysicsEnv implements PhysicsEnvironment {
  weather: Weather;
  tempOffset = 0;
  wetness = 0;
  humidity = 0.5;
  /** per-step context set by the game loop */
  ctx = { agl: 1000, tas: 0, dt: 1 / 240, inCloud: 0 };

  constructor(weather: Weather) {
    this.weather = weather;
  }

  sampleGround(x: number, z: number, out: GroundSample): GroundSample {
    if (airportMask(x, z) >= 0.9999) {
      out.height = AIRPORT_ELEVATION;
      out.normal.set(0, 1, 0);
      out.surface = isRunway(x, z) ? 'runway' : isTaxiway(x, z) ? 'taxiway' : 'grass';
      return out;
    }
    const e = 1.5;
    const h = terrainHeight(x, z);
    const hl = terrainHeight(x - e, z), hr = terrainHeight(x + e, z);
    const hd = terrainHeight(x, z - e), hu = terrainHeight(x, z + e);
    _n.x = hl - hr;
    _n.y = 2 * e;
    _n.z = hd - hu;
    const l = Math.hypot(_n.x, _n.y, _n.z);
    out.height = h;
    out.normal.set(_n.x / l, _n.y / l, _n.z / l);
    const slope = Math.hypot(_n.x, _n.z) / (2 * e);
    out.surface = surfaceAt(x, z, h, slope);
    // water surface acts as the ground (ditching)
    const wl = waterLevelAt(x, z);
    if (wl > h) {
      out.height = wl;
      out.surface = 'water';
      out.normal.set(0, 1, 0);
    }
    return out;
  }

  /** cheap height only (camera clamps, AI) */
  height(x: number, z: number): number {
    if (airportMask(x, z) >= 0.9999) return AIRPORT_ELEVATION;
    return Math.max(terrainHeight(x, z), waterLevelAt(x, z));
  }

  sampleWind(pos: Vector3, out: Vector3): Vector3 {
    return this.weather.sampleWind(pos, this.ctx.agl, this.ctx.tas, this.ctx.dt, this.ctx.inCloud, out);
  }

  turbulenceRates(out: Vector3): Vector3 {
    return out.copy(this.weather.turbulenceRot);
  }

  cloudDensityAt(pos: Vector3): number {
    return this.weather.cloudDensityAt(pos);
  }
}
