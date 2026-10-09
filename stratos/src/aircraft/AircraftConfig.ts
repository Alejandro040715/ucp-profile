// Data definition of the player aircraft: an F-22A Raptor (approximate public
// figures; the flight model is generic, not Lockheed Martin data).
// Everything tunable lives here so Blueprint-style tweaking is possible without
// touching system code. Units: SI (m, kg, s, N, rad unless noted).

import { DEG } from '../core/math.ts';

export interface GearLegConfig {
  id: 'nose' | 'left' | 'right';
  /** attachment point in body frame (x right, y up, z aft) */
  mount: [number, number, number];
  strutLength: number; // fully extended length from mount to axle
  travel: number; // max compression
  wheelRadius: number;
  stiffness: number; // N/m
  damping: number; // N/(m/s) compression
  reboundDamping: number;
  steerable: boolean;
  brake: boolean;
  /** structural limit load (N): sustained loads above it bend the leg */
  limitLoad: number;
}

export interface ContactPointConfig {
  id: string;
  pos: [number, number, number];
  component: string; // damage component affected on impact
}

export interface FuelTankConfig {
  id: string;
  capacity: number; // kg
  pos: [number, number, number]; // body-frame CG of tank contents
  feedPriority: number; // lower drains first
}

export const AircraftConfig = {
  name: 'F-22A Raptor',

  // --- mass & inertia ---
  emptyMass: 19700,
  pilotMass: 110,
  /** principal inertia at reference mass, about body axes (pitch, yaw, roll) */
  inertiaPitch: 200000,
  inertiaYaw: 245000,
  inertiaRoll: 48000,
  inertiaRefMass: 29000,
  /** empty-aircraft CG in body frame (z aft). Aero reference point is the origin. */
  emptyCG: [0, 0, 0.12] as [number, number, number],

  // --- geometry ---
  wingArea: 78.0,
  wingSpan: 13.56,
  meanChord: 5.75,

  // --- aerodynamics (per radian unless noted) ---
  aero: {
    // lift curve slope vs Mach
    clAlphaMach: [0, 0.6, 0.85, 0.95, 1.05, 1.2, 1.6, 2.2],
    clAlphaVal: [3.55, 3.75, 4.25, 4.6, 4.1, 3.6, 2.85, 2.2],
    alphaLinear: 17 * DEG, // end of linear lift range
    alphaCrit: 29 * DEG, // CLmax angle
    clMax: 1.58,
    clPostStall: 1.05, // flat-plate-like regime coefficient
    clFlapsTO: 0.22,
    clFlapsLDG: 0.42,
    clElevator: 0.55,
    // drag
    cd0Mach: [0, 0.8, 0.92, 1.0, 1.08, 1.25, 1.6, 2.2],
    cd0Val: [0.0205, 0.0215, 0.026, 0.040, 0.046, 0.042, 0.036, 0.031],
    kMach: [0, 0.8, 1.0, 1.3, 1.6, 2.2],
    kVal: [0.125, 0.13, 0.155, 0.19, 0.23, 0.29],
    cdGear: 0.028,
    cdFlapsTO: 0.012,
    cdFlapsLDG: 0.045,
    cdAirbrake: 0.065,
    // side force
    cyBeta: -0.95,
    cyRudder: 0.16,
    // pitching moment
    cm0: 0.004,
    cmAlpha: -0.32,
    cmAlphaSuperFactor: 2.6, // multiplier on cmAlpha when supersonic (AC shift aft)
    cmQ: -5.2,
    cmAlphaDot: -1.6,
    cmElevator: 1.05, // positive command = nose up
    cmFlapsLDG: -0.035,
    cmAirbrake: 0.012,
    cmGear: -0.006,
    // rolling moment (b-normalised)
    clBeta: -0.075,
    clP: -0.36,
    clR: 0.09,
    clAileron: 0.085, // positive command = right roll
    clRudder: 0.012,
    // yawing moment
    cnBeta: 0.13,
    cnR: -0.26,
    cnP: -0.025,
    cnRudder: 0.062, // positive command = nose right
    cnAileron: -0.006,
  },

  // --- control surfaces ---
  surfaces: {
    elevatorMax: 25 * DEG,
    elevatorRate: 60 * DEG,
    aileronMax: 22 * DEG,
    aileronRate: 80 * DEG,
    rudderMax: 30 * DEG,
    rudderRate: 60 * DEG,
    flapTO: 20 * DEG,
    flapLDG: 35 * DEG,
    flapRate: 5 * DEG, // slow hydraulic flaps
    airbrakeMax: 55 * DEG,
    airbrakeRate: 30 * DEG,
    lefMax: 25 * DEG, // automatic leading edge flaps
  },

  // --- flight control system limits (fictional FBW) ---
  fcs: {
    gMax: 9.0,
    gMin: -3.0,
    gMaxGearDown: 4.0,
    alphaLimit: 25 * DEG,
    alphaLimitGearDown: 15 * DEG,
    rollRateMax: 260 * DEG,
    rollRateMaxGearDown: 90 * DEG,
    pitchRateMax: 28 * DEG,
  },

  // --- engine ---
  engine: {
    // two F119-class engines, modelled as one thrust line
    thrustIdle: 7600,
    thrustMil: 232000,
    thrustAB: 312000,
    n2Idle: 0.63,
    n2Start: 0.22, // light-off
    spoolUpRate: 0.30, // fraction / s (max)
    spoolDownRate: 0.38,
    spoolTau: 1.05, // s, first-order lag near command
    abLightDelay: 0.35,
    abStageRate: 1.2, // fraction / s
    tsfcDry: 2.15e-5, // kg / (N s)
    tsfcAB: 5.1e-5,
    idleFuelFlow: 0.22, // kg/s
    egtIdle: 410, // C
    egtMil: 790,
    egtAB: 860,
    egtStartPeak: 640,
    egtMax: 940,
    rotorInertia: 110, // kg m^2 (gyroscopic coupling)
    rotorRadPerSec: 1150, // at 100% N2
    // thrust line through the CG height (the F119s sit on the aircraft's waterline)
    nozzleMount: [0, -0.05, 6.7] as [number, number, number],
  },

  // --- fuel ---
  fuelTanks: [
    { id: 'FWD', capacity: 2000, pos: [0, 0.1, -2.4], feedPriority: 2 },
    { id: 'AFT', capacity: 2200, pos: [0, 0.1, 2.0], feedPriority: 2 },
    { id: 'WING L', capacity: 2000, pos: [-3.0, -0.1, 0.6], feedPriority: 1 },
    { id: 'WING R', capacity: 2000, pos: [3.0, -0.1, 0.6], feedPriority: 1 },
  ] as FuelTankConfig[],

  // --- electrical ---
  electrical: {
    batteryCapacity: 1.0, // normalised charge
    batteryDrainPerSec: 1 / 1500, // ~25 min on battery only
    batteryChargePerSec: 1 / 300,
    generatorMinN2: 0.55,
  },

  // --- landing gear ---
  gear: [
    // axle positions match the F-22 model resting on its tyres
    { id: 'nose', mount: [0, -0.6, -5.18], strutLength: 1.226, travel: 0.3, wheelRadius: 0.3, stiffness: 300000, damping: 27000, reboundDamping: 13000, steerable: true, brake: false, limitLoad: 230000 },
    { id: 'left', mount: [-2.1, -0.55, 0.97], strutLength: 1.204, travel: 0.36, wheelRadius: 0.385, stiffness: 850000, damping: 70000, reboundDamping: 35000, steerable: false, brake: true, limitLoad: 420000 },
    { id: 'right', mount: [2.1, -0.55, 0.97], strutLength: 1.204, travel: 0.36, wheelRadius: 0.385, stiffness: 850000, damping: 70000, reboundDamping: 35000, steerable: false, brake: true, limitLoad: 420000 },
  ] as GearLegConfig[],
  gearTransitTime: 6.5,
  gearMaxSpeed: 150, // m/s IAS before damage risk
  nwsMaxAngle: 50 * DEG,
  brakeMu: 0.62,
  rollingMu: 0.018,
  lateralMu: 0.85,

  // --- airframe contact points used for scraping / crash detection ---
  contacts: [
    { id: 'nose', pos: [0, -0.25, -11.0], component: 'fuselage' },
    { id: 'belly_fwd', pos: [0, -1.09, -3.56], component: 'fuselage' },
    { id: 'belly_mid', pos: [0, -1.12, -0.56], component: 'fuselage' },
    { id: 'belly_aft', pos: [0, -0.95, 3.44], component: 'engine' },
    { id: 'nozzle', pos: [0, -0.63, 6.64], component: 'engine' },
    { id: 'wingtip_l', pos: [-6.8, -0.23, 2.96], component: 'leftWing' },
    { id: 'wingtip_r', pos: [6.8, -0.23, 2.96], component: 'rightWing' },
    { id: 'stab_l', pos: [-4.52, 0.0, 6.6], component: 'tail' },
    { id: 'stab_r', pos: [4.52, 0.0, 6.6], component: 'tail' },
    { id: 'fin_l', pos: [-3.6, 3.1, 6.9], component: 'tail' },
    { id: 'fin_r', pos: [3.6, 3.1, 6.9], component: 'tail' },
    { id: 'canopy', pos: [0, 1.42, -6.2], component: 'fuselage' },
  ] as ContactPointConfig[],

  // --- cockpit ---
  eyePoint: [0, 0.98, -6.2] as [number, number, number],
  machCritical: 1.0,
  vneMach: 2.25,
};

export type AircraftConfigT = typeof AircraftConfig;
