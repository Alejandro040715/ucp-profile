// Where the effects attach on the current airframe (body frame: x right,
// y up, z aft). The visual model fills this in when it is built, before the
// effects are created, so the same effect code serves the procedural XF-41
// (one round nozzle) and the F-22 (two flat 2D-vectoring nozzles).

import { Vector3 } from 'three';
import { NOZZLE, WING } from './FighterGeometry.ts';

export interface NozzleExit {
  /** exit centre */
  pos: Vector3;
  /** exit width and height (m); round nozzles have both equal to the diameter */
  width: number;
  height: number;
}

export interface AirframeLayout {
  nozzles: NozzleExit[];
  /** right-wing planform for the condensation sheets (left is mirrored); y = sheet height at the root */
  wing: { rootLE: [number, number, number]; tipLE: [number, number, number]; rootChord: number; tipChord: number; y: number };
  /** right wingtip vortex origin (left is mirrored) */
  wingTip: Vector3;
  /** right LERX / chine vortex: start and end (left is mirrored) */
  lerx: [Vector3, Vector3];
  /** transonic vapour cone origin and size */
  vaporCone: { pos: Vector3; scale: number };
  landingLight: Vector3;
}

export const airframe: AirframeLayout = {
  nozzles: [{ pos: new Vector3(0, 0.08, NOZZLE.z0 + NOZZLE.length), width: NOZZLE.rootR * 2, height: NOZZLE.rootR * 2 }],
  wing: { rootLE: WING.rootLE, tipLE: WING.tipLE, rootChord: WING.rootChord, tipChord: WING.tipChord, y: 0.12 },
  wingTip: new Vector3(5.35, -0.15, 3.4),
  lerx: [new Vector3(1.0, 0.32, -4.2), new Vector3(2.9, 0.62, 3.8)],
  vaporCone: { pos: new Vector3(0, 0.25, -3.2), scale: 1 },
  landingLight: new Vector3(0, -1.15, -5.3),
};

export function setAirframe(l: Partial<AirframeLayout>): void {
  Object.assign(airframe, l);
}
