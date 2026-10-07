// International Standard Atmosphere (troposphere + lower stratosphere) with a
// weather temperature offset. Used by the flight model, engine and HUD.

import { G0 } from './math.ts';

const R = 287.05287; // J/(kg K)
const GAMMA = 1.4;
const T0 = 288.15;
const P0 = 101325;
const L = 0.0065;
const H_TROPO = 11000;
const T_TROPO = T0 - L * H_TROPO; // 216.65
const P_TROPO = P0 * Math.pow(T_TROPO / T0, G0 / (R * L));
const H_STRAT2 = 20000;
const P_STRAT2 = P_TROPO * Math.exp((-G0 * (H_STRAT2 - H_TROPO)) / (R * T_TROPO));

export interface AtmosphereSample {
  temperature: number; // K
  pressure: number; // Pa
  density: number; // kg/m^3
  speedOfSound: number; // m/s
  densityRatio: number; // rho / rho0
}

export const RHO0 = P0 / (R * T0);

export function sampleAtmosphere(altitude: number, tempOffset = 0, out?: AtmosphereSample): AtmosphereSample {
  const h = Math.max(-500, Math.min(altitude, 32000));
  let T: number;
  let p: number;
  if (h < H_TROPO) {
    T = T0 - L * h;
    p = P0 * Math.pow(T / T0, G0 / (R * L));
  } else if (h < H_STRAT2) {
    T = T_TROPO;
    p = P_TROPO * Math.exp((-G0 * (h - H_TROPO)) / (R * T_TROPO));
  } else {
    T = T_TROPO + 0.001 * (h - H_STRAT2);
    p = P_STRAT2 * Math.pow(T / T_TROPO, -G0 / (R * 0.001));
  }
  const Tw = T + tempOffset;
  const rho = p / (R * Tw);
  const o = out ?? ({} as AtmosphereSample);
  o.temperature = Tw;
  o.pressure = p;
  o.density = rho;
  o.speedOfSound = Math.sqrt(GAMMA * R * Tw);
  o.densityRatio = rho / RHO0;
  return o;
}

/** Calibrated airspeed approximation from true airspeed (subsonic compressible). */
export function trueToCalibrated(tas: number, atm: AtmosphereSample): number {
  const a0 = 340.294;
  const qc = atm.pressure * (Math.pow(1 + 0.2 * Math.pow(tas / atm.speedOfSound, 2), 3.5) - 1);
  return a0 * Math.sqrt(5 * (Math.pow(qc / P0 + 1, 2 / 7) - 1));
}
