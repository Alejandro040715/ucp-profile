// Interfaces the aircraft simulation needs from the outside world. The world,
// weather and test harness each implement these, keeping the flight model
// independent from rendering.

import { Vector3 } from 'three';

export type SurfaceType = 'runway' | 'taxiway' | 'grass' | 'dirt' | 'rock' | 'water' | 'snow';

export interface GroundSample {
  height: number;
  normal: Vector3;
  surface: SurfaceType;
}

export interface PhysicsEnvironment {
  /** Fills `out` with terrain height / normal / surface type at (x, z). */
  sampleGround(x: number, z: number, out: GroundSample): GroundSample;
  /** Wind velocity (m/s, world frame) at a position, including gusts + turbulence. */
  sampleWind(pos: Vector3, out: Vector3): Vector3;
  /** Rotational turbulence (rad/s, body-agnostic small rates) */
  turbulenceRates(out: Vector3): Vector3;
  /** ISA temperature deviation (K) */
  tempOffset: number;
  /** 0..1 runway wetness (affects friction) */
  wetness: number;
  /** 0..1 relative humidity (affects condensation effects only) */
  humidity: number;
  /** 0..1 how much the aircraft is inside cloud (visual + turbulence) */
  cloudDensityAt(pos: Vector3): number;
}

export const SurfaceFriction: Record<SurfaceType, { rolling: number; lateral: number; brake: number; bumpiness: number }> = {
  runway: { rolling: 1.0, lateral: 1.0, brake: 1.0, bumpiness: 0.02 },
  taxiway: { rolling: 1.05, lateral: 1.0, brake: 1.0, bumpiness: 0.04 },
  grass: { rolling: 4.5, lateral: 0.55, brake: 0.45, bumpiness: 0.6 },
  dirt: { rolling: 3.5, lateral: 0.6, brake: 0.55, bumpiness: 0.8 },
  rock: { rolling: 6.0, lateral: 0.7, brake: 0.6, bumpiness: 1.4 },
  water: { rolling: 40.0, lateral: 0.3, brake: 0.1, bumpiness: 0.3 },
  snow: { rolling: 5.0, lateral: 0.35, brake: 0.3, bumpiness: 0.3 },
};
