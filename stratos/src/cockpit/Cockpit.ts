// Cockpit assembly: tub, consoles, instrument panel, glareshield, HUD,
// MFDs with bezel buttons, standby instruments, annunciators, ejection seat,
// side-stick, throttle, rudder pedals, pilot, interior lighting (backlit
// panels + flood light) and ~40 interactive controls laid out as data.

import {
  BoxGeometry, Color, CylinderGeometry, Group, Mesh, MeshStandardMaterial, Object3D, PlaneGeometry, PointLight, SphereGeometry,
  TorusGeometry, Vector3, type Texture, CapsuleGeometry, MeshBasicMaterial,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { worldMaterial } from '../render/Materials.ts';
import { paintPanel, knobScale, type PanelLabel, type PanelExtra } from './PanelPainter.ts';
import { CockpitControl, GearLever, GuardedSwitch, PushButton, RotaryKnob, ToggleSwitch, ck } from './CockpitControls.ts';
import { MFD, MFD_PAGES } from './MFD.ts';
import { HUD } from './HUD.ts';
import { AnnunciatorPanel, StandbyCluster } from './Standby.ts';
import { Pilot } from './Pilot.ts';
import { clamp, damp } from '../core/math.ts';
import { mergeStatic } from '../render/mergeStatic.ts';

const PAINT = 0x2b2e32;

function m(color: number, roughness: number, metalness = 0, extra: Partial<MeshStandardMaterial> = {}): MeshStandardMaterial {
  const mm = new MeshStandardMaterial({ color, roughness, metalness });
  Object.assign(mm, extra);
  return ck(mm, 'cpt');
}

interface PanelSpec {
  id: string;
  pos: [number, number, number];
  rot: [number, number, number];
  size: [number, number];
  labels: PanelLabel[];
  borders?: [number, number, number, number][];
  extra?: PanelExtra;
}

export interface CockpitAnimState {
  stickPitch: number;
  stickRoll: number;
  pedals: number;
  throttle: number;
  afterburner: boolean;
  headYaw: number;
  headPitch: number;
  gearLights: number[]; // per leg: 0 off, 1 green, 2 red (transit)
}

export class Cockpit {
  readonly root = new Group();
  private staticRoot = new Group();
  readonly controls = new Map<string, CockpitControl>();
  readonly mfdL: MFD;
  readonly mfdR: MFD;
  readonly hud = new HUD();
  readonly standby = new StandbyCluster();
  readonly annun = new AnnunciatorPanel();
  readonly pilot = new Pilot();
  private backlitMats: MeshStandardMaterial[] = [];
  private stickPivot = new Group();
  private throttleLever = new Group();
  private pedalL = new Group();
  private pedalR = new Group();
  private gearLightMats: MeshStandardMaterial[] = [];
  readonly flood: PointLight;
  readonly consoleFlood: PointLight;
  private standbyMat: MeshStandardMaterial;
  private annunMat: MeshStandardMaterial;
  private stickGripWorld = new Vector3();
  private throttleGripWorld = new Vector3();
  private time = 0;
  /** 0..1 levels set from rotary knobs */
  instLights = 0.5;
  floodLevel = 0;
  consoleLevel = 0.4;

  constructor(skyLut: Texture) {
    this.mfdL = new MFD('ENGINE', 0.165, skyLut);
    this.mfdR = new MFD('FLIGHT', 0.165, skyLut);
    this.buildStructure();
    this.buildPanels();
    this.buildSeat();
    this.buildStickThrottlePedals();
    this.root.add(this.pilot.root);
    this.root.add(this.hud.group);
    // interior lights
    this.flood = new PointLight(0xffc890, 0, 1.6, 2);
    this.flood.position.set(0, 0.95, -3.75);
    this.root.add(this.flood);
    this.consoleFlood = new PointLight(0xb8e0ff, 0, 1.2, 2);
    this.consoleFlood.position.set(0, 0.62, -4.25);
    this.root.add(this.consoleFlood);
    this.standbyMat = m(0xffffff, 0.3, 0, { map: this.standby.texture, emissiveMap: this.standby.texture, emissive: new Color(0.25, 0.25, 0.25) });
    this.annunMat = m(0xffffff, 0.3, 0, { map: this.annun.texture, emissiveMap: this.annun.emissiveTexture, emissive: new Color(1, 1, 1) });
    this.placeInstruments();
    this.root.add(this.staticRoot);
    this.root.traverse((o) => {
      if ((o as Mesh).isMesh && !(o.userData.noShadow)) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    // small interactive parts receive but do not cast (keeps shadow passes cheap)
    for (const c of this.controls.values()) c.root.traverse((o) => ((o as Mesh).isMesh ? ((o as Mesh).castShadow = false) : 0));
    mergeStatic(this.staticRoot, new Set());
  }

  // -------------------------------------------------------------------------
  private buildStructure(): void {
    const paint = worldMaterial(new MeshStandardMaterial({ color: PAINT, roughness: 0.66, metalness: 0.15 }), { key: 'cptpaint' });
    const black = m(0x141516, 0.93);
    const floorMat = m(0x1f2124, 0.85, 0.2);
    const add = (geo: BoxGeometry | RoundedBoxGeometry, mat: MeshStandardMaterial, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
      const mesh = new Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.rotation.set(rx, ry, rz);
      this.staticRoot.add(mesh);
      return mesh;
    };
    // tub floor and side walls
    add(new BoxGeometry(0.92, 0.03, 2.75), floorMat, 0, -0.22, -4.22);
    for (const s of [-1, 1]) {
      add(new BoxGeometry(0.03, 0.86, 2.7), paint, s * 0.475, 0.2, -4.22);
      // structural ribs on the walls
      for (let k = 0; k < 7; k++) add(new BoxGeometry(0.02, 0.75, 0.025), paint, s * 0.458, 0.2, -5.3 + k * 0.38);
      // canopy rail lining with a light strip
      add(new RoundedBoxGeometry(0.06, 0.05, 2.65, 2, 0.01), paint, s * 0.45, 0.6, -4.22);
      // consoles (boxes under the panels)
      add(new RoundedBoxGeometry(0.25, 0.6, 1.08, 2, 0.015), paint, s * 0.35, 0.08, -4.0);
      // cable looms along the lower wall
      const loom = new Mesh(new CylinderGeometry(0.012, 0.012, 2.4, 8), m(0x141516, 0.6));
      loom.rotation.x = Math.PI / 2;
      loom.position.set(s * 0.45, -0.12, -4.2);
      this.staticRoot.add(loom);
    }
    // rear bulkhead behind the seat
    add(new BoxGeometry(0.92, 0.95, 0.04), paint, 0, 0.28, -2.92);
    // front: under-panel well (knee well) and pedal floor
    add(new BoxGeometry(0.92, 0.5, 0.04), paint, 0, 0.12, -5.38);
    // main panel housing (behind the panel face)
    add(new RoundedBoxGeometry(0.9, 0.42, 0.22, 3, 0.02), paint, 0, 0.58, -4.95, -0.32);
    // glareshield (anti-glare black) with a soft front lip
    add(new RoundedBoxGeometry(0.9, 0.05, 0.42, 3, 0.02), black, 0, 0.775, -5.02);
    const lip = new Mesh(new CylinderGeometry(0.03, 0.03, 0.9, 12, 1, false, 0, Math.PI), black);
    lip.rotation.z = Math.PI / 2;
    lip.position.set(0, 0.79, -4.82);
    this.staticRoot.add(lip);
    // HUD projector body on the glareshield
    add(new RoundedBoxGeometry(0.26, 0.07, 0.22, 2, 0.015), m(0x161719, 0.55, 0.3), 0, 0.825, -4.97);
    add(new BoxGeometry(0.28, 0.012, 0.014), m(0x111213, 0.4, 0.5), 0, 1.0, -4.95, -0.62);
    for (const s of [-1, 1]) add(new BoxGeometry(0.012, 0.24, 0.014), m(0x111213, 0.4, 0.5), s * 0.136, 0.905, -4.885, -0.62);
    // standby compass on the right of the glareshield
    const comp = new Mesh(new CylinderGeometry(0.03, 0.03, 0.04, 16), m(0x18191b, 0.4));
    comp.rotation.x = Math.PI / 2;
    comp.position.set(0.33, 0.86, -4.95);
    this.staticRoot.add(comp);
    const compFace = new Mesh(new PlaneGeometry(0.045, 0.03), m(0xd8d0b0, 0.3, 0, { emissive: new Color(0.03, 0.03, 0.02) }));
    compFace.position.set(0.33, 0.86, -4.928);
    this.staticRoot.add(compFace);
    // canopy handle / grab handles on the arch
    for (const s of [-1, 1]) {
      const h = new Mesh(new TorusGeometry(0.035, 0.008, 6, 12, Math.PI), m(0xb5b8ba, 0.35, 0.8));
      h.position.set(s * 0.38, 0.73, -3.15);
      h.rotation.y = Math.PI / 2;
      this.staticRoot.add(h);
    }
  }

  private makePanel(spec: PanelSpec): Group {
    const g = new Group();
    g.position.set(...spec.pos);
    g.rotation.set(spec.rot[0], spec.rot[1], spec.rot[2], 'YXZ');
    const art = paintPanel(spec.size[0], spec.size[1], spec.labels, { borders: spec.borders, extra: spec.extra });
    const mat = ck(new MeshStandardMaterial({ map: art.map, emissiveMap: art.emissiveMap, emissive: new Color(0.55, 0.8, 0.6), emissiveIntensity: 0, roughness: 0.62, metalness: 0.1 }), 'panel');
    this.backlitMats.push(mat);
    const face = new Mesh(new BoxGeometry(spec.size[0], spec.size[1], 0.008), [m(PAINT, 0.7), m(PAINT, 0.7), m(PAINT, 0.7), m(PAINT, 0.7), mat, m(PAINT, 0.7)]);
    face.position.z = -0.004;
    g.add(face);
    this.root.add(g);
    return g;
  }

  private addControl(panel: Group, c: CockpitControl, x: number, y: number): CockpitControl {
    c.root.position.set(x, y, 0);
    panel.add(c.root);
    this.controls.set(c.id, c);
    return c;
  }

  // -------------------------------------------------------------------------
  private buildPanels(): void {
    // ===== main instrument panel =====
    const main = this.makePanel({
      id: 'main',
      pos: [0, 0.605, -4.8],
      rot: [-0.32, 0, 0],
      size: [0.86, 0.36],
      labels: [
        { text: 'LDG GEAR', x: -0.395, y: 0.105, size: 0.0085 },
        { text: 'UP', x: -0.355, y: 0.055, size: 0.006 },
        { text: 'DN', x: -0.355, y: -0.02, size: 0.006 },
        { text: 'FLAPS', x: -0.395, y: -0.085, size: 0.0075 },
        { text: 'LDG\nTO\nUP', x: -0.36, y: -0.13, size: 0.005 },
        { text: 'FIRE EXT', x: 0.395, y: 0.135, size: 0.0075, color: '#ff8070' },
        { text: 'SPD BRK', x: 0.395, y: 0.0, size: 0.0075 },
        { text: 'OUT\nIN', x: 0.36, y: -0.035, size: 0.005 },
        { text: 'FCS MODE', x: 0.395, y: -0.095, size: 0.0072 },
        { text: 'DIRECT\nASSIST', x: 0.357, y: -0.135, size: 0.0048 },
        { text: 'GEAR', x: 0, y: -0.115, size: 0.007 },
        { text: 'N    L    R', x: 0, y: -0.165, size: 0.0055 },
        { text: 'XF-41  AVIONICS SUITE  P/N 41-7730', x: 0, y: -0.172, size: 0.004, backlit: false, color: '#8a8c88' },
      ],
      borders: [[-0.43, -0.18, -0.325, 0.18], [0.325, -0.18, 0.43, 0.18], [-0.11, -0.18, 0.11, 0.18]],
    });
    const gear = this.addControl(main, new GearLever('gear', 'LANDING GEAR', 1), -0.395, 0.015) as GearLever;
    void gear;
    this.addControl(main, new ToggleSwitch('flaps', 'FLAPS', 3, 0, ['UP', 'TO', 'LDG']), -0.395, -0.13);
    this.addControl(main, new GuardedSwitch('fireExt', 'FIRE EXTINGUISHER', 0, ['SAFE', 'DISCHARGE']), 0.395, 0.09);
    this.addControl(main, new ToggleSwitch('airbrake', 'SPEED BRAKE', 2, 0, ['IN', 'OUT']), 0.395, -0.035);
    this.addControl(main, new GuardedSwitch('fcsMode', 'FCS MODE', 0, ['ASSIST', 'DIRECT']), 0.395, -0.135);
    this.addControl(main, new PushButton('masterCaution', 'MASTER CAUTION (reset)', 'MASTER\nCAUTION', [0.034, 0.022], false, '#ffb020'), -0.06, 0.163);
    this.addControl(main, new PushButton('masterWarn', 'MASTER WARNING (reset)', 'WARN', [0.034, 0.022], false, '#ff3020'), 0.06, 0.163);
    // gear position lights (N, L, R)
    for (let i = 0; i < 3; i++) {
      const lm = m(0x101010, 0.3, 0, { emissive: new Color(0, 0, 0) });
      this.gearLightMats.push(lm);
      const l = new Mesh(new CylinderGeometry(0.007, 0.007, 0.006, 12), lm);
      l.rotation.x = Math.PI / 2;
      l.position.set(-0.025 + i * 0.025, -0.145, 0.003);
      main.add(l);
    }
    // MFD bezels + screens + bezel buttons
    for (const [side, mfd] of [[-1, this.mfdL], [1, this.mfdR]] as const) {
      const cx = side * 0.215, cy = -0.005;
      const bezel = new Mesh(new RoundedBoxGeometry(0.215, 0.215, 0.018, 2, 0.008), m(0x151618, 0.55, 0.2));
      bezel.position.set(cx, cy, 0.006);
      main.add(bezel);
      mfd.mesh.position.set(cx, cy, 0.0156);
      main.add(mfd.mesh);
      // top row buttons select pages, bottom-right = FUEL
      for (let i = 0; i < 5; i++) {
        const page = MFD_PAGES[i];
        const b = new PushButton(`mfd${side < 0 ? 'L' : 'R'}_${page}`, `${side < 0 ? 'LEFT' : 'RIGHT'} MFD — ${page}`, '', [0.022, 0.012], false, '#a0ffb0');
        b.onChange = () => mfd.setPage(page);
        this.addControl(main, b, cx - 0.072 + i * 0.036, cy + 0.096);
        b.root.position.z = 0.012;
      }
      const fb = new PushButton(`mfd${side < 0 ? 'L' : 'R'}_FUEL`, `${side < 0 ? 'LEFT' : 'RIGHT'} MFD — FUEL`, '', [0.022, 0.012], false, '#a0ffb0');
      fb.onChange = () => mfd.setPage('FUEL');
      this.addControl(main, fb, cx + 0.072, cy - 0.096);
      fb.root.position.z = 0.012;
      const pb = new PushButton(`mfd${side < 0 ? 'L' : 'R'}_NEXT`, `${side < 0 ? 'LEFT' : 'RIGHT'} MFD — NEXT PAGE`, '', [0.022, 0.012], false, '#a0ffb0');
      pb.onChange = () => mfd.nextPage();
      this.addControl(main, pb, cx - 0.072, cy - 0.096);
      pb.root.position.z = 0.012;
      // side rocker buttons (decorative, still pressable)
      for (let k = 0; k < 4; k++) {
        for (const s2 of [-1, 1]) {
          const rb = new PushButton(`mfd${side < 0 ? 'L' : 'R'}_os${k}${s2}`, 'OSB', '', [0.012, 0.02], false, '#a0ffb0');
          this.addControl(main, rb, cx + s2 * 0.098, cy - 0.054 + k * 0.036);
          rb.root.position.z = 0.012;
        }
      }
    }

    // ===== left console =====
    const lc = this.makePanel({
      id: 'left',
      pos: [-0.35, 0.384, -4.0],
      rot: [-Math.PI / 2 + 0.05, 0, -0.06],
      size: [0.24, 1.0],
      borders: [[-0.12, 0.17, 0.12, 0.5], [-0.12, -0.2, 0.12, 0.17], [-0.12, -0.5, 0.12, -0.2]],
      labels: [
        { text: 'THROTTLE', x: -0.085, y: 0.45, size: 0.007, rot: -Math.PI / 2 },
        { text: 'AB', x: 0.07, y: 0.47, size: 0.007, color: '#ffb070' },
        { text: 'MIL', x: 0.07, y: 0.42, size: 0.006 },
        { text: 'IDLE', x: 0.07, y: 0.21, size: 0.006 },
        { text: 'OFF', x: 0.07, y: 0.185, size: 0.005 },
        { text: 'ELECTRICAL / ENGINE', x: 0, y: 0.15, size: 0.0065 },
        { text: 'BATT', x: -0.07, y: 0.115, size: 0.006 },
        { text: 'GEN', x: 0.0, y: 0.115, size: 0.006 },
        { text: 'FUEL PUMP', x: 0.07, y: 0.115, size: 0.0055 },
        { text: 'ON\n\nOFF', x: -0.045, y: 0.07, size: 0.0045 },
        { text: 'ENG MASTER', x: -0.06, y: -0.015, size: 0.0058 },
        { text: 'START', x: 0.045, y: -0.015, size: 0.0058 },
        { text: 'FCS RESET', x: 0.045, y: -0.13, size: 0.0055 },
        { text: 'PITCH TRIM', x: -0.06, y: -0.13, size: 0.0055 },
        { text: 'EXT LIGHTS', x: 0, y: -0.22, size: 0.0065 },
        { text: 'NAV', x: -0.07, y: -0.255, size: 0.0058 },
        { text: 'STROBE', x: 0.0, y: -0.255, size: 0.0058 },
        { text: 'LDG/TAXI', x: 0.07, y: -0.255, size: 0.0055 },
        { text: 'LAND\nTAXI\nOFF', x: 0.098, y: -0.3, size: 0.0042 },
        { text: 'FORMATION', x: -0.04, y: -0.38, size: 0.0055 },
        { text: 'ANTI-COLL', x: 0.06, y: -0.38, size: 0.0055 },
        { text: 'OFF    BRT', x: -0.04, y: -0.455, size: 0.0045 },
      ],
      extra: (g, e, X, Y, px) => {
        // throttle slot
        g.fillStyle = '#060606';
        g.fillRect(X(0.025) - 0.006 * px, Y(0.47), 0.012 * px, Y(0.2) - Y(0.47));
        // detent marks
        for (const yy of [0.2, 0.42, 0.45]) {
          g.fillStyle = '#d0d0c8';
          g.fillRect(X(0.04), Y(yy) - 1.5, 0.018 * px, 3);
          e.fillStyle = '#fff';
          e.fillRect(X(0.04), Y(yy) - 1.5, 0.018 * px, 3);
        }
        knobScale(g, e, X(-0.04), Y(-0.42), 0.016 * px, 6);
      },
    });
    this.addControl(lc, new ToggleSwitch('battery', 'BATTERY', 2, 0, ['OFF', 'ON']), -0.07, 0.075);
    this.addControl(lc, new ToggleSwitch('generator', 'GENERATOR', 2, 1, ['OFF', 'ON']), 0.0, 0.075);
    this.addControl(lc, new ToggleSwitch('fuelPump', 'FUEL BOOST PUMP', 2, 1, ['OFF', 'ON']), 0.07, 0.075);
    this.addControl(lc, new GuardedSwitch('engMaster', 'ENGINE MASTER', 0, ['OFF', 'ON']), -0.06, -0.055);
    this.addControl(lc, new PushButton('engStart', 'ENGINE START', 'START', [0.03, 0.022], false, '#80ff90'), 0.045, -0.055);
    this.addControl(lc, new PushButton('fcsReset', 'FCS RESET', 'RESET', [0.026, 0.018], false, '#ffb020'), 0.045, -0.16);
    this.addControl(lc, new ToggleSwitch('trim', 'PITCH TRIM (DIRECT mode)', 3, 1, ['NOSE DN', 'HOLD', 'NOSE UP']), -0.06, -0.165);
    this.addControl(lc, new ToggleSwitch('navLights', 'NAV LIGHTS', 2, 0, ['OFF', 'ON']), -0.07, -0.295);
    this.addControl(lc, new ToggleSwitch('strobe', 'ANTI-COLLISION STROBE', 2, 0, ['OFF', 'ON']), 0.0, -0.295);
    this.addControl(lc, new ToggleSwitch('landingLight', 'LANDING / TAXI LIGHT', 3, 0, ['OFF', 'TAXI', 'LAND']), 0.07, -0.295);
    this.addControl(lc, new RotaryKnob('formation', 'FORMATION LIGHTS', 6, 0, ['OFF', '20%', '40%', '60%', '80%', 'BRT']), -0.04, -0.42);
    this.addControl(lc, new ToggleSwitch('antiColl', 'TAIL BEACON', 2, 0, ['OFF', 'ON']), 0.06, -0.42);

    // ===== right console =====
    const rc = this.makePanel({
      id: 'right',
      pos: [0.35, 0.384, -4.0],
      rot: [-Math.PI / 2 + 0.05, 0, 0.06],
      size: [0.24, 1.0],
      borders: [[-0.12, 0.17, 0.12, 0.5], [-0.12, -0.2, 0.12, 0.17], [-0.12, -0.5, 0.12, -0.2]],
      labels: [
        { text: 'INTERIOR LIGHTS', x: 0, y: 0.15, size: 0.0062 },
        { text: 'INST', x: -0.07, y: 0.125, size: 0.0055 },
        { text: 'CONSOLE', x: 0.0, y: 0.125, size: 0.0055 },
        { text: 'FLOOD', x: 0.07, y: 0.125, size: 0.0055 },
        { text: 'DISPLAYS', x: 0, y: -0.04, size: 0.0062 },
        { text: 'HUD BRT', x: -0.07, y: -0.065, size: 0.0055 },
        { text: 'MFD BRT', x: 0.0, y: -0.065, size: 0.0055 },
        { text: 'HUD', x: 0.07, y: -0.065, size: 0.0055 },
        { text: 'OFF\nDCLT\nNORM', x: 0.098, y: -0.12, size: 0.0042 },
        { text: 'CANOPY / BRAKES / O2', x: 0, y: -0.22, size: 0.0062 },
        { text: 'CANOPY', x: -0.07, y: -0.255, size: 0.0055, color: '#ffd080' },
        { text: 'PARK BRK', x: 0.0, y: -0.255, size: 0.0055 },
        { text: 'NWS', x: 0.07, y: -0.255, size: 0.0055 },
        { text: 'OXYGEN', x: -0.04, y: -0.38, size: 0.0055 },
        { text: 'CLOSE\n\nOPEN', x: -0.045, y: -0.3, size: 0.0042 },
        { text: 'XF-41 — DO NOT EXCEED 9.0 G', x: 0.0, y: -0.47, size: 0.0045, backlit: false, color: '#ffd0a0' },
      ],
      extra: (g, e, X, Y, px) => {
        knobScale(g, e, X(-0.07), Y(0.075), 0.016 * px, 6);
        knobScale(g, e, X(0.0), Y(0.075), 0.016 * px, 6);
        knobScale(g, e, X(0.07), Y(0.075), 0.016 * px, 6);
        knobScale(g, e, X(-0.07), Y(-0.12), 0.016 * px, 6);
        knobScale(g, e, X(0.0), Y(-0.12), 0.016 * px, 6);
        knobScale(g, e, X(-0.04), Y(-0.42), 0.016 * px, 4);
      },
    });
    this.addControl(rc, new RotaryKnob('instLights', 'INSTRUMENT BACKLIGHT', 6, 3, ['OFF', '20%', '40%', '60%', '80%', 'BRT']), -0.07, 0.075);
    this.addControl(rc, new RotaryKnob('consoleLights', 'CONSOLE FLOOD', 6, 2, ['OFF', '20%', '40%', '60%', '80%', 'BRT']), 0.0, 0.075);
    this.addControl(rc, new RotaryKnob('floodLights', 'COCKPIT FLOOD', 6, 0, ['OFF', '20%', '40%', '60%', '80%', 'BRT']), 0.07, 0.075);
    this.addControl(rc, new RotaryKnob('hudBrt', 'HUD BRIGHTNESS', 6, 4, ['OFF', '20%', '40%', '60%', '80%', 'BRT']), -0.07, -0.12);
    this.addControl(rc, new RotaryKnob('mfdBrt', 'MFD BRIGHTNESS', 6, 4, ['OFF', '20%', '40%', '60%', '80%', 'BRT']), 0.0, -0.12);
    this.addControl(rc, new ToggleSwitch('hudMode', 'HUD MODE', 3, 2, ['OFF', 'DECLUTTER', 'NORM']), 0.07, -0.12);
    this.addControl(rc, new ToggleSwitch('canopy', 'CANOPY', 2, 1, ['OPEN', 'CLOSE']), -0.07, -0.3);
    this.addControl(rc, new ToggleSwitch('parkBrake', 'PARKING BRAKE', 2, 1, ['OFF', 'SET']), 0.0, -0.3);
    this.addControl(rc, new ToggleSwitch('nws', 'NOSE WHEEL STEERING', 2, 1, ['OFF', 'ON']), 0.07, -0.3);
    this.addControl(rc, new RotaryKnob('oxygen', 'OXYGEN REGULATOR', 4, 1, ['OFF', 'NORM', '100%', 'EMER']), -0.04, -0.42);
  }

  private placeInstruments(): void {
    // standby cluster in the centre column and annunciators above it, mounted on the main panel group
    const main = this.root.children.find((c) => c instanceof Group && Math.abs(c.position.z + 4.8) < 0.01) as Group;
    const sb = new Mesh(new PlaneGeometry(0.15, 0.1125), this.standbyMat);
    sb.position.set(0, 0.03, 0.002);
    main.add(sb);
    const glass = new Mesh(new PlaneGeometry(0.152, 0.115), ck(new MeshStandardMaterial({ color: 0x000000, roughness: 0.05, metalness: 0.0, transparent: true, opacity: 0.18 }), 'glass'));
    glass.position.set(0, 0.03, 0.004);
    glass.userData.noShadow = true;
    main.add(glass);
    const an = new Mesh(new PlaneGeometry(0.2, 0.05), this.annunMat);
    an.position.set(0, 0.118, 0.002);
    main.add(an);
  }

  private buildSeat(): void {
    const cushion = m(0x3a3d33, 0.95);
    const frame = m(0x26292c, 0.55, 0.5);
    const seat = new Group();
    const pan = new Mesh(new RoundedBoxGeometry(0.42, 0.09, 0.46, 3, 0.03), cushion);
    pan.position.set(0, 0.17, -4.1);
    seat.add(pan);
    const back = new Mesh(new RoundedBoxGeometry(0.44, 0.78, 0.1, 3, 0.03), cushion);
    back.position.set(0, 0.6, -3.82);
    back.rotation.x = 0.17;
    seat.add(back);
    const headbox = new Mesh(new RoundedBoxGeometry(0.34, 0.26, 0.26, 3, 0.04), frame);
    headbox.position.set(0, 1.08, -3.73);
    headbox.rotation.x = 0.17;
    seat.add(headbox);
    const headpad = new Mesh(new RoundedBoxGeometry(0.2, 0.14, 0.05, 2, 0.02), cushion);
    headpad.position.set(0, 1.03, -3.87);
    headpad.rotation.x = 0.17;
    seat.add(headpad);
    for (const s of [-1, 1]) {
      const rail = new Mesh(new BoxGeometry(0.035, 1.15, 0.07), frame);
      rail.position.set(s * 0.235, 0.62, -3.72);
      rail.rotation.x = 0.17;
      seat.add(rail);
      const side = new Mesh(new RoundedBoxGeometry(0.035, 0.22, 0.48, 2, 0.01), frame);
      side.position.set(s * 0.225, 0.2, -4.08);
      seat.add(side);
    }
    // ejection handle (yellow/black striped loop between the knees)
    const loop = new Group();
    for (let i = 0; i < 10; i++) {
      const seg = new Mesh(new TorusGeometry(0.06, 0.011, 6, 4, Math.PI / 10), m(i % 2 ? 0x101010 : 0xe0b020, 0.5));
      seg.rotation.z = (i * Math.PI) / 10;
      loop.add(seg);
    }
    loop.position.set(0, 0.24, -4.36);
    loop.rotation.x = -1.2;
    seat.add(loop);
    // warning triangle placard on the headbox
    const tri = new Mesh(new CylinderGeometry(0.035, 0.035, 0.002, 3), new MeshBasicMaterial({ color: 0xc02818 }));
    tri.rotation.x = Math.PI / 2 + 0.17;
    tri.position.set(0, 1.12, -3.86);
    seat.add(tri);
    this.staticRoot.add(seat);
  }

  private buildStickThrottlePedals(): void {
    const grip = m(0x161718, 0.55);
    const boot = m(0x0e0e0f, 0.85);
    const metalM = m(0x9da2a6, 0.35, 0.8);
    // side-stick on the right console
    const base = new Mesh(new CylinderGeometry(0.035, 0.045, 0.03, 16), boot);
    base.position.set(0.34, 0.4, -4.3);
    this.staticRoot.add(base);
    this.stickPivot.position.set(0.34, 0.41, -4.3);
    const shaft = new Mesh(new CylinderGeometry(0.011, 0.013, 0.06, 10), metalM);
    shaft.position.y = 0.03;
    const handle = new Mesh(new CapsuleGeometry(0.022, 0.085, 6, 12), grip);
    handle.position.set(0, 0.1, -0.008);
    handle.rotation.x = -0.18;
    const hat = new Mesh(new CylinderGeometry(0.006, 0.006, 0.008, 8), metalM);
    hat.position.set(0, 0.165, -0.004);
    const trigger = new Mesh(new BoxGeometry(0.01, 0.025, 0.012), metalM);
    trigger.position.set(0, 0.095, -0.03);
    const btn = new Mesh(new CylinderGeometry(0.006, 0.006, 0.01, 8), m(0xb01810, 0.5));
    btn.position.set(-0.016, 0.15, 0.0);
    btn.rotation.z = Math.PI / 2;
    this.stickPivot.add(shaft, handle, hat, trigger, btn);
    this.root.add(this.stickPivot);
    // throttle on the left console: lever on a carriage that slides along the slot
    const carriage = new Mesh(new BoxGeometry(0.03, 0.03, 0.05), m(0x2a2d31, 0.6, 0.3));
    const lever = new Mesh(new BoxGeometry(0.022, 0.08, 0.03), m(0x2a2d31, 0.6, 0.3));
    lever.position.set(0, 0.05, 0);
    const tgrip = new Mesh(new RoundedBoxGeometry(0.06, 0.06, 0.09, 3, 0.02), grip);
    tgrip.position.set(-0.012, 0.1, 0);
    const tbtn = new Mesh(new CylinderGeometry(0.006, 0.006, 0.01, 8), metalM);
    tbtn.position.set(0.02, 0.13, -0.02);
    this.throttleLever.add(carriage, lever, tgrip, tbtn);
    this.root.add(this.throttleLever);
    // rudder pedals
    for (const [s, p] of [[-1, this.pedalL], [1, this.pedalR]] as const) {
      const plate = new Mesh(new RoundedBoxGeometry(0.09, 0.16, 0.025, 2, 0.008), m(0x2c2f33, 0.6, 0.4));
      plate.rotation.x = -0.5;
      const arm = new Mesh(new BoxGeometry(0.02, 0.2, 0.02), metalM);
      arm.position.set(0, 0.1, 0.02);
      p.add(plate, arm);
      p.position.set(s * 0.13, 0.08, -5.05);
      this.root.add(p);
    }
  }

  // -------------------------------------------------------------------------
  update(dt: number, s: CockpitAnimState, essential: boolean, mainBus: boolean): void {
    this.time += dt;
    for (const c of this.controls.values()) c.update(dt, this.time);
    // stick / throttle / pedal animation (smoothed like real linkages)
    this.stickPivot.rotation.x = damp(this.stickPivot.rotation.x, -s.stickPitch * 0.24, 25, dt);
    this.stickPivot.rotation.z = damp(this.stickPivot.rotation.z, -s.stickRoll * 0.22, 25, dt);
    const tPos = s.afterburner ? 0.47 : 0.2 + clamp(s.throttle, 0, 1) * 0.22;
    // carriage along the left console local +y (world -z), console rotated slightly
    const tz = -4.0 - tPos;
    this.throttleLever.position.set(-0.325, 0.4 + tPos * 0.05 * 0.0, tz);
    const pz = s.pedals * 0.05;
    this.pedalL.position.z = -5.05 + pz;
    this.pedalR.position.z = -5.05 - pz;
    // hands on grips
    this.stickGripWorld.set(0.34, 0.41, -4.3).add(new Vector3(0, 0.1, -0.01).applyEuler(this.stickPivot.rotation));
    this.throttleGripWorld.copy(this.throttleLever.position).add(new Vector3(-0.012, 0.11, 0));
    const handR = this.stickGripWorld.clone().add(new Vector3(-0.005, 0.0, 0.015));
    const handL = this.throttleGripWorld.clone().add(new Vector3(0.0, 0.015, 0.01));
    this.pilot.pose(handL, handR, new Vector3(-0.13, 0.16, -5.0 + pz), new Vector3(0.13, 0.16, -5.0 - pz), s.headYaw, s.headPitch);
    // lighting levels
    const back = essential ? this.instLights : 0;
    for (const mm of this.backlitMats) mm.emissiveIntensity = back * 0.35;
    this.flood.intensity = essential ? this.floodLevel * 0.9 : 0;
    this.consoleFlood.intensity = essential ? this.consoleLevel * 0.35 : 0;
    this.standbyMat.emissive.setScalar(essential ? 0.08 + 0.25 * this.instLights : 0);
    this.annunMat.emissive.setScalar(essential ? 1.2 : 0);
    s.gearLights.forEach((v, i) => {
      const lm = this.gearLightMats[i];
      if (!essential || v === 0) lm.emissive.setRGB(0, 0, 0);
      else if (v === 1) lm.emissive.setRGB(0.1, 1.8, 0.25);
      else lm.emissive.setRGB(1.8, 0.1, 0.05);
    });
    void mainBus;
  }

  setFirstPerson(fp: boolean): void {
    this.pilot.setFirstPerson(fp);
  }

  /** all interactive hit volumes for raycasting */
  hitTargets(): Object3D[] {
    return [...this.controls.values()].map((c) => c.hit);
  }
}

export const _unused = [SphereGeometry];
