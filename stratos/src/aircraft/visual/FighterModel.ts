// Assembles the XF-41 visual model: painted airframe, hinged control surfaces,
// animated landing gear (retraction, oleo compression, wheel spin, nose
// steering, doors), variable nozzle petals, canopy, airbrake, sensors,
// antennas and lights. `update()` applies an AircraftVisualState so the same
// model serves the player, AI traffic, parked aircraft and replays.

import {
  BoxGeometry, Color, CylinderGeometry, Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, Object3D, Quaternion, SphereGeometry, TorusGeometry, Vector3,
  type BufferGeometry, type Material, type Texture, DoubleSide, MeshBasicMaterial, AdditiveBlending, ConeGeometry, BufferAttribute, Matrix4,
} from 'three';
import {
  buildFuselage, buildIntake, buildPanel, buildCanopy, buildNozzlePetal, revolve, hingeOf, mirrorSpec, WING, STAB, FIN, NOZZLE, CANOPY_HINGE, stationAt,
  buildSerratedPlate, orientPlate, sectionLoop,
  type PanelSpec,
} from './FighterGeometry.ts';
import { paintFuselage, paintPanelAtlas, paintNozzle, SCHEMES, type MaterialMaps, type PaintScheme } from './FighterTextures.ts';
import { createCanopyMaterial } from './CanopyMaterial.ts';
import { worldMaterial } from '../../render/Materials.ts';
import { surfaceDetailHook, surfaceDetailKey, type SurfaceDetailOptions } from '../../render/SurfaceDetail.ts';
import { libTexture } from '../../assets/TextureLibrary.ts';
import { sunOcclusionHook } from '../../world/TerrainMaterial.ts';
import { AircraftConfig } from '../AircraftConfig.ts';
import { DEG } from '../../core/math.ts';
import { mergeStatic } from '../../render/mergeStatic.ts';

export interface GearVisual {
  ext: number;
  door: number;
  compression: number;
  wheelAngle: number;
  steer: number;
  broken: boolean;
}

export interface AircraftVisualState {
  stabL: number; // rad, + = nose-up command (TE up)
  stabR: number;
  flapL: number; // rad, + = trailing edge down
  flapR: number;
  rudder: number; // rad, + = TE right
  lef: number;
  airbrake: number;
  canopy: number; // 0 closed .. 1 open
  nozzle: number; // 0 closed .. 1 open
  gear: GearVisual[];
  heat: number; // 0..1 nozzle heat glow
  ab: number;
  navLights: boolean;
  strobes: boolean;
  formation: number; // 0 off .. 1 bright
  damageL: number;
  damageR: number;
  damageTail: number;
}

export function defaultVisualState(): AircraftVisualState {
  return {
    stabL: 0, stabR: 0, flapL: 0, flapR: 0, rudder: 0, lef: 0, airbrake: 0, canopy: 0, nozzle: 0.4,
    gear: [0, 1, 2].map(() => ({ ext: 1, door: 1, compression: 0.12, wheelAngle: 0, steer: 0, broken: false })),
    heat: 0, ab: 0, navLights: false, strobes: false, formation: 0, damageL: 1, damageR: 1, damageTail: 1,
  };
}

interface Hinged {
  pivot: Group;
  axis: Vector3;
}

// shared, lazily painted textures per scheme
const mapCache = new Map<string, { fus: MaterialMaps; panels: MaterialMaps; perimeter: (z: number) => number; fusGeo: BufferGeometry }>();
let nozzleMaps: MaterialMaps | null = null;

function paintMaterial(maps: MaterialMaps, key: string): MeshStandardMaterial {
  // semi-gloss polyurethane topcoat: a faint sharp reflection over the
  // rougher pigment layer catches the sky along the curvature
  const m = new MeshPhysicalMaterial({
    clearcoat: 0.22,
    clearcoatRoughness: 0.32,
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.ormMap,
    metalnessMap: maps.ormMap,
    aoMap: maps.ormMap,
    aoMapIntensity: 0.9,
    roughness: 1.0,
    metalness: 1.0,
    envMapIntensity: 1.0,
  });
  m.normalScale.set(1, 1);
  // scanned paint micro-surface (orange peel / grain) at physical scale
  const detail: SurfaceDetailOptions = {
    normal: libTexture('paint-grain', 'normal'),
    normalTile: 0.32,
    normalStrength: 0.22,
    rough: libTexture('paint-grain', 'roughness'),
    roughTile: 0.45,
    roughLo: 0.9,
    roughHi: 1.12,
  };
  return worldMaterial(m, { key: 'paint' + key + surfaceDetailKey(detail), hooks: [sunOcclusionHook, surfaceDetailHook(detail)] });
}

/** gear doors sample a small patch of the fuselage underside paint */
function doorUV(g: BufferGeometry): void {
  const pos = g.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = 0.52 + pos.getZ(i) * 0.03;
    uv[i * 2 + 1] = 0.5 + (pos.getX(i) + pos.getY(i)) * 0.03;
  }
  g.setAttribute('uv', new BufferAttribute(uv, 2));
}

/** lit standard material with optional scanned surface detail */
function litMat(params: ConstructorParameters<typeof MeshStandardMaterial>[0], key: string, detail?: SurfaceDetailOptions): MeshStandardMaterial {
  const hooks = [sunOcclusionHook];
  if (detail) hooks.push(surfaceDetailHook(detail));
  return worldMaterial(new MeshStandardMaterial(params), { hooks, key: detail ? key + surfaceDetailKey(detail) : undefined });
}

export class FighterModel {
  readonly root = new Group();
  /** non-animated parts, merged per material after construction */
  private staticGroup = new Group();
  private hinges: Record<string, Hinged> = {};
  private gearParts: { leg: Group; piston: Object3D; wheel: Object3D; steer: Object3D; doors: { obj: Object3D; axis: Vector3; angle: number }[]; mount: Vector3; strut: number; id: string }[] = [];
  private petals: Object3D[] = [];
  private nozzleGlow: MeshStandardMaterial;
  private formationMat!: MeshStandardMaterial;
  private abCore: Mesh;
  readonly canopyPivot = new Group();
  readonly lightAnchors: Record<string, Vector3> = {};
  private damageParts: Record<string, Object3D[]> = { leftWingTip: [], rightWingTip: [], tail: [] };
  readonly canopyGlass: Mesh;
  /** meshes hidden when the camera is inside the cockpit (avoid z-fighting / clutter) */
  readonly exteriorOnly: Object3D[] = [];

  constructor(skyLut: Texture, schemeName = 'standard') {
    const scheme: PaintScheme = SCHEMES[schemeName] ?? SCHEMES.standard;
    let cached = mapCache.get(schemeName);
    if (!cached) {
      const fusRes = buildFuselage(72);
      const fus = paintFuselage(scheme, fusRes.perimeter);
      const wingSpec = { ...WING, uvRect: [0, 0, 1, 0.5] as [number, number, number, number] };
      const stabSpec = { ...STAB, uvRect: [0, 0.5, 0.5, 1] as [number, number, number, number] };
      const finSpec = { ...FIN, uvRect: [0.5, 0.5, 1, 1] as [number, number, number, number] };
      const panels = paintPanelAtlas(scheme, [
        { spec: wingSpec, kind: 'wing' },
        { spec: stabSpec, kind: 'stab' },
        { spec: finSpec, kind: 'fin' },
      ]);
      cached = { fus, panels, perimeter: fusRes.perimeter, fusGeo: fusRes.geometry };
      mapCache.set(schemeName, cached);
    }
    nozzleMaps ??= paintNozzle();
    const paintFus = paintMaterial(cached.fus, schemeName + 'f');
    const paintPan = paintMaterial(cached.panels, schemeName + 'p');
    // scanned CC0 detail layers (see public/textures/CREDITS.md)
    const ram: SurfaceDetailOptions = { normal: libTexture('ram-coating', 'normal'), normalTile: 0.25, normalStrength: 0.6, rough: libTexture('ram-coating', 'roughness'), roughTile: 0.4, roughLo: 0.85, roughHi: 1.15 };
    const grainOnly: SurfaceDetailOptions = { normal: libTexture('paint-grain', 'normal'), normalTile: 0.25, normalStrength: 0.3, rough: libTexture('smudge', 'mask'), roughTile: 0.6, roughLo: 0.85, roughHi: 1.25 };
    const dark = litMat({ color: 0x1b1d20, roughness: 0.75, metalness: 0.1 }, 'ram', ram);
    const intakeInner = litMat({ color: 0x3a3c3f, roughness: 0.8, side: DoubleSide }, 'intake', grainOnly);
    const frameMat = litMat({ color: 0x2b2e32, roughness: 0.55, metalness: 0.2 }, 'frame', grainOnly);
    const gearPaint = litMat({ color: 0xc9cbc8, roughness: 0.5, metalness: 0.15 }, 'gearpaint', {
      ...grainOnly,
      albedo: libTexture('grime', 'mask'),
      albedoTile: 0.5,
      albedoAmount: 0.35,
    });
    const chrome = litMat({ color: 0xd8dde2, roughness: 0.14, metalness: 1.0 }, 'chrome', {
      rough: libTexture('chrome', 'roughness'),
      roughTile: 0.25,
      roughLo: 0.5,
      roughHi: 2.4,
      normal: libTexture('scratches', 'normal'),
      normalTile: 0.3,
      normalStrength: 0.4,
    });
    const tyre = litMat({ color: 0x161616, roughness: 0.92, metalness: 0 }, 'tyre', {
      normal: libTexture('rubber', 'normal'),
      normalTile: 0.12,
      normalStrength: 0.9,
      rough: libTexture('rubber', 'roughness'),
      roughTile: 0.2,
      roughLo: 0.85,
      roughHi: 1.08,
      albedo: libTexture('rubber', 'albedo'),
      albedoTile: 0.2,
      albedoAmount: 0.6,
    });
    const hub = litMat({ color: 0x8d9093, roughness: 0.45, metalness: 0.7 }, 'hub', {
      normal: libTexture('brushed-alu', 'normal'),
      normalTile: 0.15,
      normalStrength: 0.6,
      rough: libTexture('brushed-alu', 'roughness'),
      roughTile: 0.2,
      roughLo: 0.7,
      roughHi: 1.3,
    });
    const sensorGlass = worldMaterial(new MeshStandardMaterial({ color: 0x3a2a10, roughness: 0.05, metalness: 0.9, emissive: new Color(0.05, 0.03, 0.0) }), { hooks: [sunOcclusionHook] });
    const nozzleMat = worldMaterial(
      new MeshStandardMaterial({ map: nozzleMaps.map, normalMap: nozzleMaps.normalMap, roughnessMap: nozzleMaps.ormMap, metalnessMap: nozzleMaps.ormMap, roughness: 1, metalness: 1 }),
      {
        hooks: [sunOcclusionHook, surfaceDetailHook({ normal: libTexture('nozzle-steel', 'normal'), normalTile: 0.35, normalStrength: 0.8 })],
        key: 'nozzle' + (libTexture('nozzle-steel', 'normal') ? 'detN' : ''),
      },
    );
    this.nozzleGlow = worldMaterial(new MeshStandardMaterial({ color: 0x111111, roughness: 0.8, emissive: new Color(1.0, 0.35, 0.08), emissiveIntensity: 0, side: DoubleSide }), { key: 'glow' });

    // ---- fuselage
    const fus = new Mesh(cached.fusGeo, paintFus);
    this.add(fus);
    // ---- intakes
    for (const side of [1, -1] as const) {
      const it = buildIntake(side);
      this.add(new Mesh(it.outer, paintFus));
      this.add(new Mesh(it.inner, intakeInner));
      this.add(new Mesh(it.face, dark));
    }
    // ---- wings with control surfaces
    for (const side of [1, -1]) {
      const spec: PanelSpec = side > 0 ? { ...WING, uvRect: [0, 0, 1, 0.5] } : { ...mirrorSpec(WING), uvRect: [0, 0, 1, 0.5] };
      // main box between LE flap and TE surfaces
      this.add(new Mesh(buildPanel({ ...spec, c0: 0.13, c1: 0.8 }), paintPan));
      // fixed TE outboard of the flaperon
      this.add(new Mesh(buildPanel({ ...spec, c0: 0.8, c1: 1, s0: 0.92, s1: 1, nSpan: 2 }), paintPan));
      // wing tip rail with an ACMI-style training pod (detail)
      const tipX = side * 5.42;
      const rail = new Mesh(new BoxGeometry(0.08, 0.1, 1.6), frameMat);
      rail.position.set(tipX, -0.17, 2.7);
      this.add(rail);
      const pod = new Mesh(revolve([[0.0, -1.15], [0.07, -1.05], [0.075, 0.9], [0.05, 1.1], [0.0, 1.15]], 12), gearPaint);
      pod.position.set(tipX, -0.17, 2.75);
      this.add(pod);
      this.damageParts[side > 0 ? 'rightWingTip' : 'leftWingTip'].push(rail, pod);
      // LE flap
      const lefH = hingeOf(spec, 0.13, 0.04, 0.96);
      this.hinge(side > 0 ? 'lefR' : 'lefL', buildPanel({ ...spec, c0: 0, c1: 0.13, s0: 0.04, s1: 0.96, nSpan: 8 }), paintPan, lefH);
      // flaperon (single long surface)
      const fH = hingeOf(spec, 0.8, 0.05, 0.92);
      this.hinge(side > 0 ? 'flapR' : 'flapL', buildPanel({ ...spec, c0: 0.8, c1: 1, s0: 0.05, s1: 0.92, nSpan: 8 }), paintPan, fH);
      // anchors for wingtip vortices and nav lights
      this.lightAnchors[side > 0 ? 'navR' : 'navL'] = new Vector3(side * 5.48, -0.12, 2.2);
      this.lightAnchors[side > 0 ? 'tipR' : 'tipL'] = new Vector3(side * 5.35, -0.17, 3.55);
    }
    // ---- horizontal stabilators (all moving, pivot at 35% root chord)
    for (const side of [1, -1]) {
      const spec: PanelSpec = side > 0 ? { ...STAB, uvRect: [0, 0.5, 0.5, 1] } : { ...mirrorSpec(STAB), uvRect: [0, 0.5, 0.5, 1] };
      const h = hingeOf(spec, 0.35, 0, 1);
      // pivot axis purely spanwise
      h.axis.set(side, 0, 0);
      this.hinge(side > 0 ? 'stabR' : 'stabL', buildPanel(spec), paintPan, h);
      this.damageParts.tail.push(this.hinges[side > 0 ? 'stabR' : 'stabL'].pivot);
    }
    // ---- twin canted fins with rudders
    for (const side of [1, -1]) {
      const spec: PanelSpec = side > 0 ? { ...FIN, uvRect: [0.5, 0.5, 1, 1] } : { ...mirrorSpec(FIN), uvRect: [0.5, 0.5, 1, 1] };
      const fin = new Mesh(buildPanel({ ...spec, c0: 0, c1: 0.72 }), paintPan);
      this.add(fin);
      this.add(new Mesh(buildPanel({ ...spec, c0: 0.72, c1: 1, s0: 0, s1: 0.12, nSpan: 1 }), paintPan));
      this.add(new Mesh(buildPanel({ ...spec, c0: 0.72, c1: 1, s0: 0.88, s1: 1, nSpan: 1 }), paintPan));
      const rh = hingeOf(spec, 0.72, 0.12, 0.88);
      if (rh.axis.y < 0) rh.axis.negate();
      this.hinge(side > 0 ? 'rudR' : 'rudL', buildPanel({ ...spec, c0: 0.72, c1: 1, s0: 0.12, s1: 0.88, nSpan: 6 }), paintPan, rh);
      this.damageParts.tail.push(fin);
      // anti-collision strobe on the fin tip
      this.lightAnchors[side > 0 ? 'strobeR' : 'strobeL'] = new Vector3(...spec.tipLE).add(new Vector3(0, 0.05, 0.7));
    }
    // ---- dorsal airbrake panel (hinged at its front edge)
    {
      const g = new BoxGeometry(1.0, 0.04, 1.7);
      g.translate(0, 0, 0.85);
      const pivot = new Group();
      const st = stationAt(3.75);
      pivot.position.set(0, st.cy + st.ht + 0.005, 3.75);
      const m = new Mesh(g, paintFus);
      pivot.add(m);
      this.root.add(pivot);
      this.hinges.airbrake = { pivot, axis: new Vector3(1, 0, 0) };
      const well = new Mesh(new BoxGeometry(0.96, 0.02, 1.66), dark);
      well.position.set(0, stationAt(4.6).cy + stationAt(4.6).ht - 0.012, 4.6);
      this.add(well);
    }
    // ---- canopy (rear-hinged)
    const cg = buildCanopy();
    this.canopyPivot.position.copy(CANOPY_HINGE);
    const glass = new Mesh(cg.glass, createCanopyMaterial(skyLut));
    glass.position.copy(CANOPY_HINGE).negate();
    glass.renderOrder = 10;
    this.canopyGlass = glass;
    const frame = new Mesh(cg.frame, frameMat);
    frame.position.copy(CANOPY_HINGE).negate();
    this.canopyPivot.add(glass, frame);
    this.root.add(this.canopyPivot);
    // ---- nozzle: variable petals around a hot liner
    {
      const ng = new Group();
      ng.position.set(0, 0.08, NOZZLE.z0);
      const petalGeo = buildNozzlePetal();
      for (let i = 0; i < NOZZLE.petals; i++) {
        const holder = new Group();
        holder.rotation.z = (i / NOZZLE.petals) * Math.PI * 2;
        const petal = new Mesh(petalGeo, nozzleMat);
        petal.scale.set(NOZZLE.rootR, NOZZLE.rootR, NOZZLE.length);
        holder.add(petal);
        ng.add(holder);
        this.petals.push(petal);
      }
      // engine liner / flameholder visible inside
      const liner = new Mesh(revolve([[0.56, -0.6], [0.55, 0.2], [0.5, 0.6]], 24), this.nozzleGlow);
      ng.add(liner);
      const holderRing = new Mesh(new TorusGeometry(0.32, 0.04, 6, 24), this.nozzleGlow);
      holderRing.position.z = -0.4;
      ng.add(holderRing);
      const cone = new Mesh(new ConeGeometry(0.16, 0.5, 16), dark);
      cone.rotation.x = Math.PI / 2;
      cone.position.z = -0.35;
      ng.add(cone);
      // afterburner core glow (inside the nozzle)
      this.abCore = new Mesh(new CylinderGeometry(0.42, 0.38, 0.9, 24, 1, true), new MeshBasicMaterial({ color: new Color(1, 0.6, 0.3), transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }));
      this.abCore.rotation.x = Math.PI / 2;
      this.abCore.position.z = 0.2;
      ng.add(this.abCore);
      this.root.add(ng);
      this.lightAnchors.nozzle = new Vector3(0, 0.08, NOZZLE.z0 + NOZZLE.length);
    }
    // ---- landing gear
    this.buildGear(gearPaint, chrome, tyre, hub, paintFus, dark);
    // ---- sensors, probes, antennas
    // EOTS-style chin sensor: faceted sapphire window (7 flat facets) in a low
    // fairing, sensor ball visible behind the glass
    {
      const eots = new Group();
      const fairing = new Mesh(new CylinderGeometry(0.2, 0.26, 0.07, 7, 1), paintFus);
      fairing.position.y = 0.035;
      const win = new Mesh(new CylinderGeometry(0.07, 0.2, 0.13, 7, 1), worldMaterial(new MeshStandardMaterial({ color: 0x4a3512, roughness: 0.04, metalness: 0.85, flatShading: true, transparent: true, opacity: 0.88 }), { hooks: [sunOcclusionHook], key: 'eots' }));
      win.position.y = -0.065;
      const ball = new Mesh(new SphereGeometry(0.09, 16, 10), worldMaterial(new MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.25, metalness: 0.4 }), { hooks: [sunOcclusionHook] }));
      ball.position.y = -0.05;
      eots.add(fairing, ball, win);
      eots.rotation.x = Math.PI; // hang below the chin
      eots.scale.set(1, 1, 1.45);
      eots.position.set(0, -0.47, -6.75);
      this.add(eots);
    }
    for (const side of [1, -1]) {
      // L-shaped air-data probes (F-22 style): short stem out of the skin,
      // tube pointing into the free stream
      const stem = new Mesh(new CylinderGeometry(0.009, 0.014, 0.09, 6), chrome);
      stem.rotation.z = Math.PI / 2;
      stem.position.set(side * 0.47, -0.06, -7.45);
      this.add(stem);
      const tube = new Mesh(new CylinderGeometry(0.006, 0.01, 0.26, 8), chrome);
      tube.rotation.x = Math.PI / 2;
      tube.position.set(side * 0.515, -0.06, -7.57);
      this.add(tube);
      const vane = new Mesh(new BoxGeometry(0.01, 0.06, 0.12), frameMat);
      vane.position.set(side * 0.55, 0.12, -7.0);
      this.add(vane);
    }
    const blade = (x: number, y: number, z: number, h: number, flip = false) => {
      const b = new Mesh(new BoxGeometry(0.02, h, 0.28), frameMat);
      b.position.set(x, y + (flip ? -h / 2 : h / 2), z);
      b.rotation.x = flip ? 0.25 : -0.25;
      this.add(b);
    };
    blade(0, 0.97, 1.4, 0.22);
    blade(0, 0.92, 2.8, 0.14);
    blade(0, -0.82, -1.9, 0.18, true);
    blade(0.3, -0.84, 3.6, 0.12, true);
    // ---- electroluminescent formation-light strips ("slime lights"): pale
    // grey-green panels flush on the skin, glowing green when switched on
    this.formationMat = worldMaterial(new MeshStandardMaterial({ color: 0xa9b39c, roughness: 0.35, metalness: 0, emissive: new Color(0.35, 1.0, 0.45), emissiveIntensity: 0 }), { hooks: [sunOcclusionHook], key: 'formation' });
    const strip = (pos: Vector3, along: Vector3, normal: Vector3, len: number) => {
      const g = new BoxGeometry(0.04, len, 0.006);
      const mesh = new Mesh(g, this.formationMat);
      // local y -> along, local z -> normal
      const x = new Vector3().crossVectors(along, normal).normalize();
      mesh.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(x, along.clone().normalize(), normal.clone().normalize()));
      mesh.position.copy(pos).addScaledVector(normal, 0.004);
      mesh.userData.noMerge = true;
      this.root.add(mesh);
    };
    for (const side of [1, -1]) {
      // fuselage sides: below the cockpit and on the aft fuselage, just above the chine
      for (const [zc, len] of [[-6.15, 0.75], [4.75, 0.7]] as const) {
        const st = stationAt(zc);
        const loop = sectionLoop(st, 72);
        const n = loop.length;
        // right-side point a little above the chine (loop index 0 = top, n/4 ~ chine)
        const target = st.cy + st.chineY + 0.07;
        let best = 0, bestD = 1e9;
        for (let i = 1; i < n / 2; i++) {
          const d = Math.abs(loop[i][1] - target);
          if (d < bestD) { bestD = d; best = i; }
        }
        const a = loop[best - 1], b = loop[best + 1];
        const nrm = new Vector3(side * (b[1] - a[1]), -(b[0] - a[0]), 0).normalize();
        if (nrm.x * side < 0) nrm.negate();
        strip(new Vector3(side * loop[best][0], loop[best][1], zc), new Vector3(0, 0, 1), nrm, len);
      }
      // outer face of each canted fin, mid-chord from 15 % to 75 % span
      const spec = side > 0 ? FIN : mirrorSpec(FIN);
      const rl = new Vector3(...spec.rootLE), tl = new Vector3(...spec.tipLE);
      const span = new Vector3().subVectors(tl, rl);
      const at = (sf: number) => rl.clone().addScaledVector(span, sf).add(new Vector3(0, 0, (spec.rootChord + (spec.tipChord - spec.rootChord) * sf) * 0.42));
      const p0 = at(0.15), p1 = at(0.75);
      const nrm = new Vector3().crossVectors(span, new Vector3(0, 0, 1)).normalize();
      if (nrm.x * side < 0) nrm.negate();
      const mid = p0.clone().lerp(p1, 0.5).addScaledVector(nrm, 0.042);
      strip(mid, new Vector3().subVectors(p1, p0), nrm, p0.distanceTo(p1));
    }
    // ---- static dischargers (wicks) on wing, stabilator and fin trailing edges
    {
      const wickGeo = new CylinderGeometry(0.0035, 0.005, 0.13, 5);
      wickGeo.rotateX(Math.PI / 2);
      wickGeo.translate(0, 0, 0.065);
      const wick = (pos: Vector3, parent: Object3D = this.root, local = false) => {
        const w = new Mesh(wickGeo, frameMat);
        w.position.copy(pos);
        if (!local) w.userData.noMerge = true;
        parent.add(w);
      };
      const te = (spec: PanelSpec, sf: number) => new Vector3(...spec.rootLE).lerp(new Vector3(...spec.tipLE), sf).add(new Vector3(0, 0, spec.rootChord + (spec.tipChord - spec.rootChord) * sf));
      for (const side of [1, -1]) {
        const ws = side > 0 ? WING : mirrorSpec(WING);
        for (const sf of [0.94, 0.985]) wick(te(ws, sf));
        const fs = side > 0 ? FIN : mirrorSpec(FIN);
        wick(te(fs, 0.95));
        // all-moving stabilator: the wick rides on its pivot
        const stab = this.hinges[side > 0 ? 'stabR' : 'stabL'];
        const ss = side > 0 ? STAB : mirrorSpec(STAB);
        wick(te(ss, 0.92).sub(stab.pivot.position), stab.pivot, true);
      }
    }
    // anchors for effects / lights
    this.lightAnchors.tail = new Vector3(0, 0.55, 7.25);
    this.lightAnchors.landing = new Vector3(0, -1.2, -5.25);
    this.lightAnchors.formationL = new Vector3(-0.9, 0.0, -6.0);
    this.lightAnchors.formationR = new Vector3(0.9, 0.0, -6.0);
    this.lightAnchors.belly = new Vector3(0, -0.85, 1.5);
    // nav light lenses (emissive driven in update)
    for (const k of ['navL', 'navR', 'tail'] as const) {
      const lens = new Mesh(new SphereGeometry(0.06, 10, 6), new MeshBasicMaterial({ color: k === 'navL' ? 0xff2010 : k === 'navR' ? 0x10ff40 : 0xffffff }));
      lens.position.copy(this.lightAnchors[k]);
      lens.userData.lensOf = k;
      this.root.add(lens);
    }
    // wing-tip parts that can be shot off / broken stay separate
    for (const list of Object.values(this.damageParts)) for (const o of list) o.userData.noMerge = true;
    this.root.add(this.staticGroup);
    this.root.traverse((o) => {
      if ((o as Mesh).isMesh) {
        const m = o as Mesh;
        if (m !== this.canopyGlass && !(m.material as Material & { blending?: number }).transparent) {
          m.castShadow = true;
          m.receiveShadow = true;
        }
      }
    });
    mergeStatic(this.staticGroup, new Set());
  }

  private add(o: Object3D): void {
    this.staticGroup.add(o);
  }

  private hinge(name: string, geo: BufferGeometry, mat: Material, h: { origin: Vector3; axis: Vector3 }): void {
    const pivot = new Group();
    pivot.position.copy(h.origin);
    const m = new Mesh(geo, mat);
    m.position.copy(h.origin).negate();
    pivot.add(m);
    this.root.add(pivot);
    const axis = h.axis.clone();
    if (Math.abs(axis.x) > 0.5 && axis.x < 0) axis.negate();
    this.hinges[name] = { pivot, axis };
  }

  private buildGear(paint: Material, chrome: Material, tyre: Material, hub: Material, skin: Material, dark: Material): void {
    for (const leg of AircraftConfig.gear) {
      const mount = new Vector3(...leg.mount);
      const legGroup = new Group();
      legGroup.position.copy(mount);
      const L = leg.strutLength;
      const isNose = leg.id === 'nose';
      // upper strut (cylinder), from mount down to the oleo
      const upperLen = L * 0.62;
      const upper = new Mesh(new CylinderGeometry(isNose ? 0.07 : 0.1, isNose ? 0.08 : 0.11, upperLen, 10), paint);
      upper.position.y = -upperLen / 2;
      legGroup.add(upper);
      // drag brace
      const brace = new Mesh(new CylinderGeometry(0.03, 0.03, L * 0.55, 6), paint);
      brace.position.set(0, -L * 0.25, isNose ? 0.22 : -0.25);
      brace.rotation.x = isNose ? -0.45 : 0.45;
      legGroup.add(brace);
      // steering (nose) group holds the piston + wheel
      const steer = new Group();
      steer.position.y = -upperLen;
      legGroup.add(steer);
      const piston = new Group();
      steer.add(piston);
      const pistonLen = L - upperLen;
      const rod = new Mesh(new CylinderGeometry(isNose ? 0.05 : 0.07, isNose ? 0.05 : 0.07, pistonLen + 0.25, 10), chrome);
      rod.position.y = -pistonLen / 2 + 0.12;
      piston.add(rod);
      // torque links
      const link = new Mesh(new BoxGeometry(0.03, 0.28, 0.05), paint);
      link.position.set(0, -0.1, isNose ? -0.1 : 0.12);
      link.rotation.x = 0.5;
      piston.add(link);
      // axle + wheel(s)
      const wheel = new Group();
      wheel.position.y = -pistonLen;
      piston.add(wheel);
      const r = leg.wheelRadius;
      const widthT = isNose ? 0.18 : 0.26;
      const tyreGeo = revolve([[r * 0.62, -widthT / 2], [r * 0.93, -widthT / 2], [r, -widthT * 0.3], [r, widthT * 0.3], [r * 0.93, widthT / 2], [r * 0.62, widthT / 2]], 28);
      tyreGeo.rotateY(Math.PI / 2);
      const t = new Mesh(tyreGeo, tyre);
      wheel.add(t);
      const hubGeo = new CylinderGeometry(r * 0.62, r * 0.62, widthT * 0.95, 16);
      hubGeo.rotateZ(Math.PI / 2);
      const h = new Mesh(hubGeo, hub);
      wheel.add(h);
      // hub detail: bolts ring
      for (let k = 0; k < 8; k++) {
        const b = new Mesh(new BoxGeometry(widthT, 0.03, 0.03), dark);
        const a = (k / 8) * Math.PI * 2;
        b.position.set(0, Math.cos(a) * r * 0.35, Math.sin(a) * r * 0.35);
        wheel.add(b);
      }
      const doors: { obj: Object3D; axis: Vector3; angle: number }[] = [];
      if (isNose) {
        // landing/taxi light on the nose strut
        const lamp = new Mesh(new CylinderGeometry(0.06, 0.07, 0.08, 10), new MeshBasicMaterial({ color: 0xfff2d0 }));
        lamp.rotation.x = Math.PI / 2;
        lamp.position.set(0, -0.35, -0.12);
        legGroup.add(lamp);
        for (const s of [-1, 1]) {
          // sawtooth front/aft edges (every opening on a stealth airframe)
          const dg = orientPlate(buildSerratedPlate(0.32, 1.5, 0.02, 3, 0.07), 'y', 'z');
          dg.translate(0, -0.32, -0.15);
          doorUV(dg);
          const d = new Mesh(dg, skin);
          d.position.set(mount.x + s * 0.2, mount.y - 0.12, mount.z);
          this.root.add(d);
          doors.push({ obj: d, axis: new Vector3(0, 0, 1), angle: s * 1.3 });
        }
      } else {
        const s = Math.sign(mount.x);
        const dg = orientPlate(buildSerratedPlate(0.75, 2.0, 0.02, 4, 0.09), 'x', 'z');
        dg.translate(s > 0 ? -0.745 : -0.005, 0, -1.85);
        doorUV(dg);
        const d = new Mesh(dg, skin);
        d.position.set(mount.x + s * 0.3, mount.y - 0.42, mount.z);
        this.root.add(d);
        doors.push({ obj: d, axis: new Vector3(0, 0, 1), angle: -s * 1.45 });
      }
      this.root.add(legGroup);
      this.gearParts.push({ leg: legGroup, piston, wheel, steer, doors, mount, strut: L, id: leg.id });
    }
  }

  private _q = new Quaternion();

  update(s: AircraftVisualState, time: number): void {
    const set = (name: string, angle: number) => {
      const h = this.hinges[name];
      if (h) h.pivot.quaternion.setFromAxisAngle(h.axis, angle);
    };
    set('stabL', -s.stabL);
    set('stabR', -s.stabR);
    set('flapL', s.flapL);
    set('flapR', s.flapR);
    set('rudL', s.rudder);
    set('rudR', s.rudder);
    set('lefL', -s.lef);
    set('lefR', -s.lef);
    set('airbrake', -s.airbrake);
    this.canopyPivot.rotation.x = s.canopy * 48 * DEG;
    // nozzle petals: open = larger exit radius (petals flare outward)
    const flare = -0.08 + 0.2 * s.nozzle;
    for (const p of this.petals) p.rotation.x = flare;
    // a turbine at idle does not visibly glow; dull red appears only near MIL
    this.nozzleGlow.emissiveIntensity = Math.pow(Math.max(0, s.heat - 0.55) / 0.45, 2) * 0.8 + s.ab * 18;
    this.nozzleGlow.emissive.setRGB(1.0, 0.35 + 0.3 * s.ab, 0.08 + 0.25 * s.ab);
    const abm = this.abCore.material as MeshBasicMaterial;
    abm.opacity = s.ab * 0.9;
    abm.color.setRGB(1.0 * (4 + s.ab * 10), 0.55 * (4 + s.ab * 10), 0.35 * (4 + s.ab * 12));
    // gear
    for (let i = 0; i < this.gearParts.length; i++) {
      const gp = this.gearParts[i];
      const gv = s.gear[i];
      if (!gv) continue;
      const retract = 1 - gv.ext;
      if (gp.id === 'nose') gp.leg.rotation.set(-retract * 90 * DEG, 0, 0);
      else gp.leg.rotation.set(retract * 88 * DEG, 0, 0);
      // wheel lies flat when stowed (main gear)
      if (gp.id !== 'nose') gp.steer.rotation.y = 0;
      gp.piston.position.y = gv.compression;
      gp.steer.rotation.y = gp.id === 'nose' ? -gv.steer : 0;
      gp.wheel.rotation.x = -gv.wheelAngle;
      if (gp.id !== 'nose') gp.wheel.rotation.z = retract * Math.sign(gp.mount.x) * 1.5;
      gp.leg.visible = !gv.broken || true;
      if (gv.broken) gp.leg.rotation.z = Math.sign(gp.mount.x || 1) * 0.9;
      for (const d of gp.doors) d.obj.quaternion.setFromAxisAngle(d.axis, d.angle * gv.door);
      // hide when fully retracted and doors closed
      gp.leg.visible = gv.ext > 0.01 || gv.door > 0.01;
    }
    // formation strips follow the FORMATION knob
    this.formationMat.emissiveIntensity = s.formation * 2.2;
    // damage: missing wingtips / tail pieces
    for (const o of this.damageParts.leftWingTip) o.visible = s.damageL > 0.2;
    for (const o of this.damageParts.rightWingTip) o.visible = s.damageR > 0.2;
    // nav light lenses
    this.root.children.forEach((c) => {
      if (c.userData.lensOf) {
        const mat = (c as Mesh).material as MeshBasicMaterial;
        const on = s.navLights;
        const base = c.userData.lensOf === 'navL' ? [1, 0.12, 0.06] : c.userData.lensOf === 'navR' ? [0.08, 1, 0.25] : [1, 1, 1];
        const k = on ? 6 : 0.15;
        mat.color.setRGB(base[0] * k, base[1] * k, base[2] * k);
      }
    });
    void time;
  }

  setCockpitView(inside: boolean): void {
    for (const o of this.exteriorOnly) o.visible = !inside;
  }
}
