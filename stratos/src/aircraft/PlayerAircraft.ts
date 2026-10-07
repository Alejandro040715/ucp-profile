// The player's aircraft as a whole: physics + visual model + cockpit +
// systems glue. Cockpit controls are the single source of truth for switch
// states; keyboard / gamepad shortcuts operate the same controls so switches
// visibly move. Also runs the caution/warning logic, the quick start-up
// sequence, the canopy actuator, external lights and the landing light.

import { Color, Object3D, Quaternion, SpotLight, Vector3, type Texture } from 'three';
import { AircraftPhysics } from './AircraftPhysics.ts';
import { FighterModel, defaultVisualState } from './visual/FighterModel.ts';
import { visualFromPhysics } from './visual/visualFromPhysics.ts';
import { Cockpit } from '../cockpit/Cockpit.ts';
import type { CockpitControl, GuardedSwitch, PushButton, RotaryKnob } from '../cockpit/CockpitControls.ts';
import type { Annunciator } from '../cockpit/Standby.ts';
import { canopyUniforms } from './visual/CanopyMaterial.ts';
import { events } from '../core/EventBus.ts';
import { approach, clamp } from '../core/math.ts';
import type { PhysicsEnvironment } from './PhysicsTypes.ts';
import type { FlapSetting } from './ControlSurfaces.ts';
import { LightPoints, type LightDef } from '../world/LightPoints.ts';
import { globals } from '../render/Globals.ts';

export interface ExternalLights {
  nav: boolean;
  strobe: boolean;
  beacon: boolean;
  landing: number; // 0 off, 1 taxi, 2 land
  formation: number; // 0..1
}

const _v = new Vector3();

export class PlayerAircraft {
  readonly physics = new AircraftPhysics();
  readonly model: FighterModel;
  readonly cockpit: Cockpit;
  readonly visual = defaultVisualState();
  readonly lights: ExternalLights = { nav: false, strobe: false, beacon: false, landing: 0, formation: 0 };
  canopy = 1; // 0 closed .. 1 open (actual position)
  canopyLocked = false;
  readonly landingLight: SpotLight;
  readonly lightSprites: LightPoints;
  private spriteDefs: LightDef[];
  /** interpolated render transform */
  readonly renderPos = new Vector3();
  readonly renderQuat = new Quaternion();
  readonly warnings: string[] = [];
  readonly annunciators = new Set<Annunciator>();
  private cautionSeen = new Set<string>();
  masterCaution = false;
  masterWarning = false;
  private startScript: { t: number; steps: [number, () => void][] } | null = null;
  private time = 0;
  hudMode = 2;

  constructor(skyLut: Texture, scheme = 'standard') {
    this.model = new FighterModel(skyLut, scheme);
    this.cockpit = new Cockpit(skyLut);
    this.model.root.add(this.cockpit.root);
    // landing / taxi light on the nose gear strut
    this.landingLight = new SpotLight(0xfff1dc, 0, 900, 0.32, 0.45, 1.6);
    this.landingLight.position.set(0, -1.15, -5.3);
    const tgt = new Object3D();
    tgt.position.set(0, -2.3, -40);
    this.model.root.add(this.landingLight, tgt);
    this.landingLight.target = tgt;
    this.landingLight.castShadow = false;
    // external light sprites (positions updated every frame)
    const a = this.model.lightAnchors;
    this.spriteDefs = [
      { pos: [0, 0, 0], color: [1, 0.08, 0.04], size: 0.35, intensity: 2.5, day: true }, // navL
      { pos: [0, 0, 0], color: [0.08, 1, 0.25], size: 0.35, intensity: 2.5, day: true }, // navR
      { pos: [0, 0, 0], color: [1, 1, 1], size: 0.3, intensity: 2.0, day: true }, // tail
      { pos: [0, 0, 0], color: [1, 1, 1], size: 0.6, intensity: 5, day: true }, // strobe L
      { pos: [0, 0, 0], color: [1, 1, 1], size: 0.6, intensity: 5, day: true }, // strobe R
      { pos: [0, 0, 0], color: [1, 0.1, 0.05], size: 0.5, intensity: 3, day: true }, // belly beacon
      { pos: [0, 0, 0], color: [0.4, 1, 0.5], size: 0.6, intensity: 1.2, day: false }, // formation L
      { pos: [0, 0, 0], color: [0.4, 1, 0.5], size: 0.6, intensity: 1.2, day: false }, // formation R
    ];
    void a;
    this.lightSprites = new LightPoints(this.spriteDefs);
    // own lights are seen up close: keep them compact hard points
    this.lightSprites.material.uniforms.uMaxPx.value = 18;
    this.bindControls();
    events.on('canopy:move', () => {});
  }

  get controls(): Map<string, CockpitControl> {
    return this.cockpit.controls;
  }

  private ctl(id: string): CockpitControl {
    const c = this.cockpit.controls.get(id);
    if (!c) throw new Error('missing control ' + id);
    return c;
  }

  /** Operate a cockpit control from a keyboard shortcut. */
  operate(id: string, value?: number): void {
    const c = this.ctl(id);
    if (c.kind === 'guard') {
      const g = c as GuardedSwitch;
      if (value !== undefined && value === g.value) return;
      g.guardOpen = true;
      g.activate();
      return;
    }
    if (value === undefined) c.activate();
    else c.set(value, true);
  }

  private bindControls(): void {
    const ph = this.physics;
    const on = (id: string, fn: (v: number) => void) => {
      const c = this.ctl(id);
      c.onChange = (v) => fn(v);
      fn(c.value);
    };
    on('battery', (v) => (ph.electrical.batterySwitch = v === 1));
    on('generator', (v) => (ph.electrical.generatorSwitch = v === 1));
    on('fuelPump', (v) => (ph.fuel.boostPump = v === 1));
    on('engMaster', (v) => {
      if (v === 0) ph.engine.requestShutdown();
    });
    this.ctl('engStart').onChange = () => {
      if (this.ctl('engMaster').value === 1) ph.engine.requestStart();
      else events.emit('message', { text: 'ENGINE MASTER is OFF', kind: 'warn', duration: 2.5 });
    };
    this.ctl('fcsReset').onChange = () => ph.fcs.reset(!ph.gear.weightOnWheels);
    on('trim', (v) => (this.trimDir = v - 1));
    on('navLights', (v) => (this.lights.nav = v === 1));
    on('strobe', (v) => (this.lights.strobe = v === 1));
    on('antiColl', (v) => (this.lights.beacon = v === 1));
    on('landingLight', (v) => (this.lights.landing = v));
    on('formation', (v) => (this.lights.formation = v / 5));
    on('instLights', (v) => (this.cockpit.instLights = v / 5));
    on('consoleLights', (v) => (this.cockpit.consoleLevel = v / 5));
    on('floodLights', (v) => (this.cockpit.floodLevel = v / 5));
    on('hudBrt', (v) => (this.cockpit.hud.brightness = v / 5));
    on('mfdBrt', (v) => {
      this.cockpit.mfdL.brightness = this.cockpit.mfdR.brightness = 0.15 + (v / 5) * 0.85;
    });
    on('hudMode', (v) => (this.hudMode = 2 - v));
    on('canopy', (v) => {
      this.canopyTarget = v === 0 ? 1 : 0;
      events.emit('canopy:move', { open: v === 0 });
    });
    on('parkBrake', (v) => (ph.gear.parkingBrake = v === 1));
    on('nws', (v) => (ph.gear.nwsEnabled = v === 1));
    on('gear', (v) => {
      const ok = ph.gear.setHandle(v === 1);
      if (!ok) setTimeout(() => this.ctl('gear').set(1), 250);
    });
    on('flaps', (v) => ph.setFlaps(v as FlapSetting));
    on('airbrake', (v) => {
      ph.surfaces.airbrakeCmd = v === 1;
      events.emit('airbrake:move', { open: v === 1 });
    });
    on('fcsMode', (v) => {
      ph.fcs.mode = v === 1 ? 'DIRECT' : 'ASSIST';
      ph.fcs.trim = 0;
    });
    on('fireExt', (v) => {
      if (v === 1) ph.damage.extinguish();
    });
    this.ctl('masterCaution').onChange = () => {
      this.masterCaution = false;
      for (const a of this.annunciators) this.cautionSeen.add(a);
    };
    this.ctl('masterWarn').onChange = () => {
      this.masterWarning = false;
      for (const w of this.warnings) this.cautionSeen.add(w);
    };
  }

  private trimDir = 0;
  private canopyTarget = 1;

  /** Cold & dark, ready on the runway, or airborne. */
  setState(kind: 'cold' | 'ready' | 'air', pos: Vector3, heading: number, speed: number, env: PhysicsEnvironment): void {
    const ph = this.physics;
    const air = kind === 'air';
    ph.reset(pos, heading, speed, !air, env);
    ph.damage.reset();
    ph.fuel.setFraction(1);
    ph.surfaces.flapSetting = 0;
    ph.surfaces.flaps = 0;
    ph.surfaces.airbrakeCmd = false;
    ph.surfaces.airbrake = 0;
    this.startScript = null;
    const set = (id: string, v: number) => {
      const c = this.ctl(id);
      if (c.kind === 'guard') (c as GuardedSwitch).guardOpen = false;
      const changed = c.value !== v;
      c.set(v);
      if (!changed && c.onChange) c.onChange(v, c);
    };
    if (kind === 'cold') {
      ph.engine.state = 'OFF';
      ph.engine.n2 = 0;
      ph.engine.egt = 18;
      for (const [id, v] of [['battery', 0], ['generator', 1], ['fuelPump', 0], ['engMaster', 0], ['navLights', 0], ['strobe', 0], ['antiColl', 0], ['landingLight', 0], ['formation', 0], ['canopy', 0], ['parkBrake', 1], ['gear', 1], ['flaps', 0], ['airbrake', 0], ['hudMode', 2], ['fcsMode', 0]] as [string, number][]) set(id, v);
      this.canopy = 1;
      this.canopyTarget = 1;
    } else {
      ph.engine.state = 'RUN';
      ph.engine.n2 = air ? 0.9 : 0.63;
      ph.engine.egt = air ? 700 : 420;
      ph.electrical.generatorOnline = true;
      for (const [id, v] of [['battery', 1], ['generator', 1], ['fuelPump', 1], ['engMaster', 1], ['navLights', 1], ['strobe', 1], ['antiColl', 1], ['landingLight', air ? 0 : 1], ['canopy', 1], ['parkBrake', air ? 0 : 1], ['gear', air ? 0 : 1], ['flaps', air ? 0 : 1], ['airbrake', 0], ['hudMode', 2], ['fcsMode', 0]] as [string, number][]) set(id, v);
      this.canopy = 0;
      this.canopyTarget = 0;
      if (air) {
        ph.gear.handleDown = false;
        for (const l of ph.gear.legs) {
          l.extension = 0;
          l.door = 0;
        }
      }
    }
    this.renderPos.copy(ph.position);
    this.renderQuat.copy(ph.quaternion);
  }

  /** Automated start-up: flips the real switches in sequence. */
  quickStart(): void {
    if (this.physics.engine.running) {
      events.emit('message', { text: 'Engine already running', kind: 'info', duration: 2 });
      return;
    }
    const steps: [number, () => void][] = [
      [0.3, () => this.operate('battery', 1)],
      [0.9, () => this.operate('fuelPump', 1)],
      [1.4, () => this.operate('generator', 1)],
      [1.9, () => this.operate('canopy', 1)],
      [2.6, () => this.operate('engMaster', 1)],
      [3.3, () => this.operate('engMaster', 1)],
      [4.0, () => this.operate('engStart')],
      [6.0, () => this.operate('navLights', 1)],
      [6.5, () => this.operate('strobe', 1)],
      [7.0, () => this.operate('antiColl', 1)],
      [7.5, () => this.operate('landingLight', 1)],
      [8.0, () => this.operate('flaps', 1)],
    ];
    this.startScript = { t: 0, steps };
    events.emit('message', { text: 'QUICK START — follow the switches', kind: 'info', duration: 4 });
  }

  /** per-frame (not per physics step) systems update */
  update(dt: number, alpha: number, cameraInCockpit: boolean, wetness: number): void {
    this.time += dt;
    const ph = this.physics;
    // start-up script
    if (this.startScript) {
      const s = this.startScript;
      s.t += dt;
      while (s.steps.length && s.steps[0][0] <= s.t) s.steps.shift()![1]();
      if (!s.steps.length) this.startScript = null;
    }
    // DIRECT mode pitch trim from the trim switch
    if (this.trimDir !== 0) ph.fcs.trim = clamp(ph.fcs.trim + this.trimDir * dt * 0.08, -0.5, 0.5);
    // canopy actuator (electric, needs essential bus, ~5 s)
    const ess = ph.electrical.essentialBus;
    const main = ph.electrical.mainBus;
    if (ess || this.canopyTarget === 1) {
      const prev = this.canopy;
      this.canopy = approach(this.canopy, this.canopyTarget, dt / 5);
      if (prev !== this.canopy && (this.canopy === 0 || this.canopy === 1)) events.emit('canopy:locked', { open: this.canopy === 1 });
    }
    this.canopyLocked = this.canopy <= 0.001;
    // canopy forced closed above taxi speed would be unrealistic; instead it is damaged / warned
    // interpolated transform
    this.renderPos.lerpVectors(ph.prevPosition, ph.position, alpha);
    this.renderQuat.slerpQuaternions(ph.prevQuaternion, ph.quaternion, alpha);
    this.model.root.position.copy(this.renderPos);
    this.model.root.quaternion.copy(this.renderQuat);
    // visuals
    const lightsPowered = main;
    visualFromPhysics(ph, this.visual, { nav: this.lights.nav && lightsPowered, strobe: this.lights.strobe && lightsPowered, formation: this.lights.formation > 0 && lightsPowered }, this.canopy);
    this.model.update(this.visual, this.time);
    // cockpit animation
    const gearLights = ph.gear.legs.map((l) => (l.broken ? 2 : l.extension >= 1 ? 1 : l.extension > 0 ? 2 : 0));
    this.cockpit.update(dt, {
      stickPitch: ph.controls.pitch, stickRoll: ph.controls.roll, pedals: ph.controls.yaw,
      throttle: ph.controls.throttle, afterburner: ph.controls.afterburner, headYaw: 0, headPitch: 0, gearLights,
    }, ess, main);
    this.cockpit.setFirstPerson(cameraInCockpit);
    // landing light
    const gearDown = ph.gear.extension > 0.95;
    const ll = lightsPowered && gearDown ? this.lights.landing : 0;
    this.landingLight.intensity = ll === 2 ? 900 : ll === 1 ? 250 : 0;
    this.landingLight.angle = ll === 2 ? 0.22 : 0.42;
    // light sprites
    this.updateSprites(lightsPowered);
    // canopy rain / frost uniforms
    canopyUniforms.uSpeed.value = ph.t.tas;
    canopyUniforms.uRain.value = wetness;
    canopyUniforms.uFrost.value = clamp((ph.position.y - 9000) / 4000, 0, 1);
    this.updateWarnings();
  }

  private updateSprites(powered: boolean): void {
    const a = this.model.lightAnchors;
    const anchors = [a.navL, a.navR, a.tail, a.strobeL, a.strobeR, a.belly, a.formationL, a.formationR];
    const pos = this.lightSprites.points.geometry.attributes.position;
    const par = this.lightSprites.points.geometry.attributes.params;
    const t = this.time;
    const strobeOn = (t % 1.2) < 0.06 || ((t + 0.12) % 1.2) < 0.06;
    const beaconOn = (t % 1.0) < 0.12;
    const on = [this.lights.nav, this.lights.nav, this.lights.nav, this.lights.strobe && strobeOn, this.lights.strobe && strobeOn, this.lights.beacon && beaconOn, this.lights.formation > 0, this.lights.formation > 0];
    // in daylight the lamps read as small hard points, at night they bloom
    const night = globals.uLightsOn.value;
    const day = 1 - 0.6 * (1 - night);
    const base = [1.4 * day, 1.4 * day, 1.0 * day, 5 * (0.45 + 0.55 * night), 5 * (0.45 + 0.55 * night), 3 * day, 1.2 * this.lights.formation, 1.2 * this.lights.formation];
    const sizeScale = 0.4 + 0.6 * night;
    anchors.forEach((anc, i) => {
      _v.copy(anc).applyQuaternion(this.renderQuat).add(this.renderPos);
      pos.setXYZ(i, _v.x, _v.y, _v.z);
      par.setX(i, this.spriteDefs[i].size * sizeScale);
      par.setY(i, powered && on[i] ? base[i] : 0);
    });
    pos.needsUpdate = true;
    par.needsUpdate = true;
  }

  private updateWarnings(): void {
    const ph = this.physics;
    const t = ph.t;
    const w = this.warnings;
    w.length = 0;
    const A = this.annunciators;
    A.clear();
    const airborne = !t.onGround && t.agl > 3;
    const descent = -t.verticalSpeed;
    if (airborne && t.agl < 700 && descent > 5 && t.agl / descent < 6) w.push('PULL UP');
    if (t.stallWarning) {
      w.push('STALL');
      A.add('STALL');
    }
    if (t.overG) A.add('OVER G');
    if (airborne && ph.gear.extension < 0.9 && t.agl < 250 && t.ias < 85 && descent > 1) {
      w.push('GEAR');
      A.add('GEAR');
    }
    if (ph.engine.onFire || ph.damage.fire > 0.2) {
      w.unshift('FIRE');
      A.add('ENG FIRE');
    }
    if (ph.engine.egt > 900) A.add('OVERHEAT');
    if (ph.surfaces.hydraulics < 0.5 && airborne) A.add('HYD');
    if (ph.engine.running && !ph.electrical.generatorOnline) A.add('GEN');
    if (ph.engine.state === 'RUN' && ph.engine.oilPressure < 0.4) A.add('OIL');
    if (ph.fuel.total < 800) {
      A.add('FUEL LOW');
      if (ph.fuel.total < 300) w.push('BINGO FUEL');
    }
    if (this.canopy > 0.01 && t.ias > 40) A.add('CANOPY');
    if (ph.fcs.mode === 'DIRECT' || ph.damage.health.tail < 0.5) A.add('FCS');
    if (ph.electrical.batterySwitch === false && ph.engine.running) A.add('BATT');
    if (ph.electrical.charge < 0.15) A.add('BATT');
    // master caution / warning latch on new items
    for (const a of A) if (!this.cautionSeen.has(a)) this.masterCaution = true;
    for (const x of w) if (!this.cautionSeen.has(x)) this.masterWarning = true;
    for (const s of [...this.cautionSeen]) if (!A.has(s as Annunciator) && !w.includes(s)) this.cautionSeen.delete(s);
    const mc = this.ctl('masterCaution') as PushButton;
    const mw = this.ctl('masterWarn') as PushButton;
    const flash = Math.floor(this.time * 3) % 2 === 0;
    const ess = ph.electrical.essentialBus;
    mc.lit = ess && this.masterCaution ? 1 : 0;
    mw.lit = ess && this.masterWarning && flash ? 1 : 0;
    this.cockpit.annun.update(ess ? A : new Set(), flash);
    // light the START button while cranking
    (this.ctl('engStart') as PushButton).lit = ess && (ph.engine.state === 'CRANK' || ph.engine.state === 'LIGHTOFF') ? 1 : 0;
    for (const id of ['mfdL_ENGINE', 'mfdR_ENGINE']) void id;
  }

  /** knob accessor helpers */
  knob(id: string): RotaryKnob {
    return this.ctl(id) as RotaryKnob;
  }
}

export const _c = Color;
