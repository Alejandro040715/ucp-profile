// Maps the simulation state to the visual model state.

import type { AircraftPhysics } from '../AircraftPhysics.ts';
import type { AircraftVisualState } from './FighterModel.ts';
import { clamp } from '../../core/math.ts';

export function visualFromPhysics(ac: AircraftPhysics, out: AircraftVisualState, lights: { nav: boolean; strobe: boolean; formation: boolean }, canopyOpen: number): AircraftVisualState {
  const s = ac.surfaces;
  out.stabL = s.stabLeft();
  out.stabR = s.stabRight();
  out.flapL = s.flaperonLeft();
  out.flapR = s.flaperonRight();
  out.rudder = s.rudderPos;
  out.lef = s.lef;
  out.airbrake = s.airbrake;
  out.canopy = canopyOpen;
  out.nozzle = ac.engine.nozzle;
  out.heat = clamp((ac.engine.egt - 250) / 650, 0, 1);
  out.ab = ac.engine.abFraction;
  ac.gear.legs.forEach((l, i) => {
    const g = out.gear[i];
    g.ext = l.extension;
    g.door = l.door;
    g.compression = l.compression;
    g.wheelAngle = l.wheelAngle;
    g.steer = l.steerAngle;
    g.broken = l.broken;
  });
  out.navLights = lights.nav;
  out.strobes = lights.strobe;
  out.formation = lights.formation;
  out.damageL = ac.damage.health.leftWing;
  out.damageR = ac.damage.health.rightWing;
  out.damageTail = ac.damage.health.tail;
  return out;
}
