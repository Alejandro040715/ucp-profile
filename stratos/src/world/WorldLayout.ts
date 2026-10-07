// Hand-authored layout of the fictional region (the "level design").
// Pure data, shared by the main thread and terrain workers.
// World frame: X = east, Y = up, Z = south (north = -Z). Metres.

export interface RunwayDef {
  id: string;
  name: [string, string]; // designators at each end: [low-heading end, high-heading end]
  center: [number, number]; // x, z
  heading: number; // deg, direction from end A to end B
  length: number;
  width: number;
}

export interface TownDef {
  name: string;
  center: [number, number];
  radius: number;
  density: number; // 0..1 building density
  tall: number; // 0..1 proportion of tall buildings
}

export interface RiverPoint {
  x: number;
  z: number;
  bed: number; // river bed elevation
  width: number;
}

export interface LakeDef {
  center: [number, number];
  radii: [number, number];
  rotation: number; // deg
  level: number;
  depth: number;
}

export const AIRPORT_ELEVATION = 120;
export const SEA_LEVEL = 0;

export const RUNWAYS: RunwayDef[] = [
  { id: 'main', name: ['35', '17'], center: [0, 0], heading: 350, length: 3000, width: 45 },
  { id: 'cross', name: ['05', '23'], center: [1450, 650], heading: 50, length: 2000, width: 30 },
];

/** Convert main-runway-relative coordinates (along = towards heading 350, across = east) to world x,z. */
export function mainRwy(along: number, across: number): [number, number] {
  const h = (350 * Math.PI) / 180;
  const dx = Math.sin(h), dz = -Math.cos(h);
  const px = -dz, pz = dx; // perpendicular to the right (east-ish)
  return [along * dx + across * px, along * dz + across * pz];
}

export const AIRPORT = {
  name: 'VALDERA AIR BASE',
  icao: 'XVAL',
  elevation: AIRPORT_ELEVATION,
  /** flattened area as rotated rectangles: center, heading, half-length, half-width */
  pads: [
    { center: [0, 0] as [number, number], heading: 350, halfLength: 1780, halfWidth: 420 },
    { center: [1450, 650] as [number, number], heading: 50, halfLength: 1150, halfWidth: 200 },
    { center: mainRwy(-150, 560), heading: 350, halfLength: 700, halfWidth: 340 },
  ],
  /** parallel taxiway offset east of main runway centreline */
  taxiwayOffset: 190,
  /** apron in runway-relative coordinates */
  apron: { along: -150, across: 500, halfLength: 420, halfWidth: 140 },
  tower: mainRwy(-780, 570),
  /** player parking spot on the apron (nose pointing west towards the taxiway) */
  parking: { pos: mainRwy(-150, 420), heading: 260 },
  holdShort: { pos: mainRwy(-1430, 110), heading: 350 },
  runwayStart: { pos: mainRwy(-1440, 0), heading: 350 },
};

export const TOWNS: TownDef[] = [
  { name: 'VALDERA', center: [4700, 3900], radius: 1300, density: 0.9, tall: 0.25 },
  { name: 'PUERTO LUMEN', center: [9400, 25800], radius: 1500, density: 0.95, tall: 0.35 },
  { name: 'ARENZO', center: [1850, -13300], radius: 650, density: 0.7, tall: 0.05 },
  { name: 'SIEL', center: [-9300, 9800], radius: 700, density: 0.65, tall: 0.05 },
  { name: 'CORVA', center: [-6200, -5200], radius: 600, density: 0.6, tall: 0.05 },
  { name: 'MONTEALTO', center: [-15500, -1800], radius: 500, density: 0.55, tall: 0.0 },
];

export const RIVER: RiverPoint[] = [
  { x: 1500, z: -44000, bed: 1150, width: 14 },
  { x: 2600, z: -37000, bed: 940, width: 18 },
  { x: 1700, z: -30500, bed: 780, width: 22 },
  { x: 3300, z: -24500, bed: 630, width: 26 },
  { x: 2400, z: -18500, bed: 480, width: 30 },
  { x: 3000, z: -13700, bed: 330, width: 34 },
  { x: 4300, z: -8200, bed: 200, width: 38 },
  { x: 3700, z: -3600, bed: 112, width: 42 },
  { x: 3900, z: 1500, bed: 96, width: 46 },
  { x: 5800, z: 5600, bed: 76, width: 50 },
  { x: 7300, z: 11000, bed: 55, width: 56 },
  { x: 6900, z: 17000, bed: 34, width: 62 },
  { x: 8300, z: 22000, bed: 14, width: 70 },
  { x: 10100, z: 26600, bed: -2, width: 80 },
  { x: 11000, z: 30500, bed: -12, width: 90 },
];

export const LAKE: LakeDef = { center: [-13200, 6400], radii: [4300, 2100], rotation: 22, level: 68, depth: 24 };

/** Road network: polylines (x, z) between towns and the air base. */
export const ROADS: [number, number][][] = [
  // air base gate -> Valdera
  [[900, 300], [1900, 1400], [3100, 2500], [4100, 3500]],
  // Valdera -> Puerto Lumen along the river
  [[4900, 4600], [6200, 8200], [6400, 12500], [6100, 16800], [7200, 21000], [8600, 24800]],
  // Valdera -> Arenzo (north valley)
  [[4300, 3100], [3200, 0], [2700, -4200], [3300, -8400], [2600, -12600]],
  // Arenzo -> mountain pass
  [[1700, -14000], [1300, -18000], [2000, -23000], [1100, -28000]],
  // Valdera -> Siel (west, passes south of air base)
  [[3900, 4200], [1500, 3600], [-2200, 4100], [-6100, 7300], [-8800, 9400]],
  // Siel -> Montealto
  [[-9600, 9200], [-12400, 3300], [-15000, -1300]],
  // Corva -> air base / Valdera road
  [[-6000, -4800], [-3600, -2600], [-1400, 2900], [-200, 3600]],
  // coast road
  [[9000, 26200], [4000, 25400], [-2000, 24600], [-8000, 23800]],
];

/** Mission waypoints / checkpoints (x, altitude, z) */
export const CHECKPOINTS = {
  climb: [[-600, 3000, -9000]] as [number, number, number][],
  highRoute: [
    [-6000, 3000, -14000],
    [-14000, 3200, -6000],
    [-12000, 2800, 5000],
  ] as [number, number, number][],
  lowLevel: [
    [9000, 250, 22000],
    [7100, 220, 15500],
    [7000, 210, 9800],
    [5300, 200, 4500],
  ] as [number, number, number][],
  canyon: [
    [4100, 420, -8400],
    [3000, 560, -13800],
    [2500, 720, -18600],
    [3200, 880, -24200],
    [1800, 1050, -30200],
  ] as [number, number, number][],
};

export function runwayFrame(r: RunwayDef): { dirX: number; dirZ: number; perpX: number; perpZ: number } {
  const h = (r.heading * Math.PI) / 180;
  const dirX = Math.sin(h);
  const dirZ = -Math.cos(h);
  return { dirX, dirZ, perpX: -dirZ, perpZ: dirX };
}

/** Threshold position (x,z) of a runway end: end 0 = start (low end), 1 = far end */
export function runwayThreshold(r: RunwayDef, end: 0 | 1): [number, number] {
  const f = runwayFrame(r);
  const s = end === 0 ? -1 : 1;
  return [r.center[0] + f.dirX * s * r.length * 0.5, r.center[1] + f.dirZ * s * r.length * 0.5];
}
