// Top-level orchestrator: owns every system and runs the frame loop
// (input -> fixed-step physics -> aircraft systems/visuals -> camera ->
// cockpit interaction -> displays -> environment -> render -> UI).

import {
  AmbientLight, ClampToEdgeWrapping, Color, DataTexture, Euler, FloatType, HemisphereLight, LinearFilter, PCFShadowMap, PerspectiveCamera, RedFormat, Scene,
  Vector2, Vector3,
} from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { RenderPipeline } from '../render/RenderPipeline.ts';
import { globals } from '../render/Globals.ts';
import { setCSM } from '../render/Materials.ts';
import { createCloudDetailNoise, createCloudShapeNoise, createDitherTexture, createNoise2D, createWeatherNoise } from '../render/NoiseTextures.ts';
import { Sky } from '../atmosphere/Sky.ts';
import { CloudRenderer } from '../atmosphere/CloudRenderer.ts';
import { TimeOfDay } from '../atmosphere/TimeOfDay.ts';
import { Weather, type WeatherState } from '../atmosphere/Weather.ts';
import { Terrain } from '../world/Terrain.ts';
import { WorkerPool } from '../world/WorkerPool.ts';
import { WorldPhysicsEnv } from '../world/WorldPhysicsEnv.ts';
import { sunOcclusionUniforms, terrainUniforms } from '../world/TerrainMaterial.ts';
import { InputSystem, type ButtonAction } from '../input/InputSystem.ts';
import { loadSettings, QUALITY_PRESETS, saveSettings, type UserSettings } from './Settings.ts';
import { airportSpawn } from '../world/Heightfield.ts';
import type { MapResult } from '../world/TerrainGen.ts';
import { Airport } from '../world/Airport.ts';
import { Water } from '../world/Water.ts';
import { Vegetation } from '../world/Vegetation.ts';
import { Towns } from '../world/Towns.ts';
import { PlayerAircraft } from '../aircraft/PlayerAircraft.ts';
import { CameraSystem, type CameraMode, CAMERA_MODES } from '../camera/CameraSystem.ts';
import { CockpitInteraction } from '../cockpit/CockpitInteraction.ts';
import { AircraftEffects } from '../effects/AircraftEffects.ts';
import { waterLevelAt } from '../world/Heightfield.ts';
import { events } from './EventBus.ts';
import { clamp, damp } from './math.ts';
import { AIRPORT_ELEVATION } from '../world/WorldLayout.ts';
import { AudioSystem } from '../audio/AudioSystem.ts';
import { UI } from '../ui/UI.ts';
import { DebugVectors } from '../ui/DebugVectors.ts';

const PHYSICS_DT = 1 / 240;

export type SpawnKind = 'cold' | 'ready' | 'air';

export class Game {
  readonly canvas: HTMLCanvasElement;
  readonly pipeline: RenderPipeline;
  readonly scene = new Scene();
  readonly fxScene = new Scene();
  readonly distortScene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly settings: UserSettings;
  readonly input: InputSystem;
  readonly time = new TimeOfDay();
  readonly weather = new Weather();
  readonly sky: Sky;
  readonly clouds: CloudRenderer;
  csm!: CSM;
  readonly pool: WorkerPool;
  readonly terrain: Terrain;
  readonly env: WorldPhysicsEnv;
  readonly airport: Airport;
  readonly water: Water;
  readonly vegetation: Vegetation;
  readonly towns: Towns;
  readonly player: PlayerAircraft;
  readonly cameras: CameraSystem;
  readonly interaction: CockpitInteraction;
  readonly effects: AircraftEffects;
  readonly audio = new AudioSystem();
  readonly ui: UI;
  readonly vectors: DebugVectors;
  photoMode = false;
  private photoPrevMode: CameraMode = 'CHASE';
  private accumulator = 0;
  private lastTime = 0;
  frameDt = 0;
  fps = 60;
  running = false;
  paused = false;
  /** test hook: overrides the camera (position, look target) */
  debugCam: { pos: Vector3; target: Vector3 } | null = null;
  missionTime = 0;
  mapImage: HTMLCanvasElement | null = null;
  readonly mapRect: [number, number, number] = [0, -10000, 160000];
  readonly uiRoot: HTMLElement;
  /** hooks for other systems (effects, audio, UI) */
  readonly frameHooks: ((dt: number) => void)[] = [];
  private gForceVis = 0;
  private gNegVis = 0;
  private trimHeld = 0;

  get aircraft() {
    return this.player.physics;
  }

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.canvas = canvas;
    this.uiRoot = uiRoot;
    this.settings = loadSettings();
    const q = QUALITY_PRESETS[this.settings.quality];
    this.pipeline = new RenderPipeline(canvas);
    this.pipeline.renderScale = q.renderScale;
    this.pipeline.msaa = q.msaa;
    const r = this.pipeline.renderer;
    r.shadowMap.type = PCFShadowMap;

    this.camera = new PerspectiveCamera(this.settings.fov, 16 / 9, 0.03, 420000);
    if (this.pipeline.reversed) {
      (this.camera as unknown as { _reversedDepth: boolean })._reversedDepth = true;
      this.camera.updateProjectionMatrix();
    }
    this.scene.add(this.camera);
    this.input = new InputSystem(canvas);
    this.input.invertPitch = this.settings.invertPitch;

    // --- procedural textures
    globals.uNoiseTex.value = createNoise2D(256);
    const weatherTex = createWeatherNoise(512);
    const shape = createCloudShapeNoise(64);
    const detail = createCloudDetailNoise(32);
    const dither = createDitherTexture(64);
    this.weather.weatherTex = weatherTex;
    this.weather.shapeTex = shape;
    sunOcclusionUniforms.uWeatherTex.value = weatherTex;

    // --- sky & clouds
    this.sky = new Sky(r);
    this.pipeline.skyLut = this.sky.lut.texture;
    this.clouds = new CloudRenderer(shape, detail, weatherTex, dither, this.sky.lut.texture);
    this.clouds.scale = q.cloudScale;
    this.clouds.steps = q.cloudSteps;
    this.pipeline.clouds = this.clouds;

    // --- sun through cascaded shadow maps (first cascade covers the cockpit at sub-cm resolution)
    this.csm = new CSM({
      camera: this.camera,
      parent: this.scene,
      cascades: 4,
      maxFar: 3000,
      mode: 'custom',
      customSplitsCallback: (_n: number, _near: number, far: number, breaks: number[]) => {
        for (const b of [6, 40, 260, far]) breaks.push(b / far);
      },
      shadowMapSize: q.shadowMapSize,
      lightDirection: new Vector3(-0.3, -0.8, 0.2).normalize(),
      lightIntensity: 3,
      lightNear: 1,
      lightFar: 12000,
      lightMargin: 600,
    });
    if (this.pipeline.reversed) {
      const mf = (this.csm as unknown as { mainFrustum: { zNear: number; zFar: number } }).mainFrustum;
      mf.zNear = 1;
      mf.zFar = 0;
    }
    this.csm.fade = true;
    this.csm.updateFrustums();
    const nb = [0.0025, 0.015, 0.12, 0.9];
    this.csm.lights.forEach((l, i) => {
      l.shadow.normalBias = nb[i];
      l.shadow.bias = 0;
      l.shadow.radius = i === 0 ? 3 : 2;
    });
    setCSM(this.csm);
    this.scene.add(new HemisphereLight(0x8899aa, 0x443322, 0.0));
    this.scene.add(new AmbientLight(0xffffff, 0));

    // --- world (backdrop)
    this.pool = new WorkerPool(q.workers);
    this.terrain = new Terrain(this.scene, this.pool);
    this.terrain.lodFactor = q.lodFactor;
    this.env = new WorldPhysicsEnv(this.weather);
    this.pool.request<MapResult>({ type: 'map', cx: 0, cz: -10000, span: 160000, res: 512 }, -1).promise.then((m) => {
      const tex = new DataTexture(m.heights, m.res, m.res, RedFormat, FloatType);
      tex.minFilter = tex.magFilter = LinearFilter;
      tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
      tex.needsUpdate = true;
      terrainUniforms.uHeightTex.value = tex;
      terrainUniforms.uHeightTexRect.value.set(-80000, -90000, 160000, 160000);
      const c = document.createElement('canvas');
      c.width = c.height = m.res;
      const ctx = c.getContext('2d')!;
      const img = ctx.createImageData(m.res, m.res);
      img.data.set(m.rgba);
      ctx.putImageData(img, 0, 0);
      this.mapImage = c;
    });
    this.airport = new Airport(this.scene, this.fxScene);
    this.water = new Water(this.scene);
    this.vegetation = new Vegetation(this.scene, this.pool, r);
    this.vegetation.treeRadius = q.treeRadius;
    this.vegetation.farRadius = q.farTreeRadius;
    this.vegetation.density = q.treeDensity;
    this.vegetation.grassEnabled = q.grass;
    this.vegetation.terrainReady = (x, z) => this.terrain.isReadyAround(new Vector3(x, 0, z), 2048);
    this.towns = new Towns(this.scene, this.fxScene);

    // --- the aircraft
    this.player = new PlayerAircraft(this.sky.lut.texture, 'standard');
    this.scene.add(this.player.model.root);
    this.fxScene.add(this.player.lightSprites.points);
    this.cameras = new CameraSystem(this.camera);
    this.cameras.baseFov = this.settings.fov;
    this.cameras.shakeScale = this.settings.cameraShake;
    this.cameras.groundHeight = (x, z) => this.env.height(x, z);
    this.interaction = new CockpitInteraction(uiRoot);
    this.effects = new AircraftEffects(this.fxScene, this.distortScene);
    events.on('crash', () => this.effects.explode(this.player.physics.position.clone()));

    this.time.setHours(10.5);
    this.weather.set('PARTLY CLOUDY', true);
    this.spawn('ready');

    this.vectors = new DebugVectors(this.fxScene);
    // menu backdrop: slow orbit around the aircraft from the front quarter
    this.cameras.setMode('CHASE');
    this.cameras.orbitYaw = 2.5;
    this.cameras.orbitPitch = 0.05;
    this.ui = new UI(this);
    events.on('crash', (e) => events.emit('message', { text: `AIRCRAFT DESTROYED — ${e.reason}. Press BACKSPACE to respawn`, kind: 'warn', duration: 8 }));
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  spawn(kind: SpawnKind): void {
    const p = this.player;
    if (kind === 'cold') {
      const s = airportSpawn('parking');
      p.setState('cold', new Vector3(s.x, AIRPORT_ELEVATION, s.z), s.heading, 0, this.env);
      this.input.throttle = 0;
    } else if (kind === 'ready') {
      const s = airportSpawn('runway');
      p.setState('ready', new Vector3(s.x, AIRPORT_ELEVATION, s.z), s.heading, 0, this.env);
      this.input.throttle = 0;
    } else {
      const s = airportSpawn('runway');
      p.setState('air', new Vector3(s.x, 1600, s.z + 4000), 350, 190, this.env);
      this.input.throttle = 0.72;
    }
    this.input.afterburner = false;
    this.accumulator = 0;
    this.missionTime = 0;
    this.cameras.centerView();
    events.emit('respawn', {});
  }

  resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.pipeline.setSize(w, h, Math.min(window.devicePixelRatio, 2));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.csm.updateFrustums();
  }

  setQuality(q: UserSettings['quality']): void {
    this.settings.quality = q;
    saveSettings(this.settings);
  }

  setWeather(w: WeatherState, instant = false): void {
    this.weather.set(w, instant);
  }

  start(): void {
    this.running = true;
    this.lastTime = performance.now();
    const loop = (t: number) => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      const dt = Math.min(0.1, (t - this.lastTime) / 1000);
      this.lastTime = t;
      this.frame(dt);
    };
    requestAnimationFrame(loop);
  }

  private handleInput(dt: number): void {
    const inp = this.input;
    const p = this.player;
    const ph = p.physics;
    const cam = this.cameras;
    // cameras
    if (inp.pressed('cameraNext')) cam.next(1);
    const camKeys: [ButtonAction, CameraMode][] = [['cam1', 'COCKPIT'], ['cam2', 'CHASE'], ['cam3', 'CLOSE CHASE'], ['cam4', 'CINEMATIC'], ['cam5', 'WING'], ['cam6', 'TAIL']];
    for (const [k, m] of camKeys) if (inp.pressed(k)) cam.setMode(m);
    if (inp.pressed('centerView')) cam.centerView();
    const overKnob = cam.inCockpit && this.interaction.hovered?.kind === 'rotary';
    if (overKnob && (inp.pressed('zoomIn') || inp.pressed('zoomOut'))) this.interaction.hovered!.activate(inp.pressed('zoomIn') ? 1 : -1);
    else {
      if (inp.pressed('zoomIn')) cam.zoomStep(-1);
      if (inp.pressed('zoomOut')) cam.zoomStep(1);
    }
    // mouse / right stick look
    const sens = 0.0022 * this.settings.mouseSensitivity * Math.min(1, cam.zoom);
    if (inp.mouseDX || inp.mouseDY) cam.look(inp.mouseDX * sens, inp.mouseDY * sens);
    if (inp.axes.lookX || inp.axes.lookY) cam.look(inp.axes.lookX * dt * 2.4, inp.axes.lookY * dt * 2.0);
    if (inp.pressed('lookBack')) cam.look(Math.PI * 0.85, 0);
    // aircraft switches via shortcuts (they move the real cockpit controls)
    if (inp.pressed('gear')) p.operate('gear');
    if (inp.pressed('flaps')) p.operate('flaps');
    if (inp.pressed('airbrake')) p.operate('airbrake');
    if (inp.pressed('parkingBrake')) p.operate('parkBrake');
    if (inp.pressed('canopy')) p.operate('canopy');
    if (inp.pressed('landingLight')) p.operate('landingLight');
    if (inp.pressed('navLights')) {
      const on = p.controls.get('navLights')!.value === 0 ? 1 : 0;
      p.operate('navLights', on);
      p.operate('strobe', on);
      p.operate('antiColl', on);
    }
    if (inp.pressed('cockpitLights')) p.operate('floodLights', (p.controls.get('floodLights')!.value + 2) % 6);
    if (inp.pressed('fcsMode')) p.operate('fcsMode', p.controls.get('fcsMode')!.value ? 0 : 1);
    if (inp.pressed('autostart')) p.quickStart();
    if (inp.pressed('mfdLeft')) p.cockpit.mfdL.nextPage();
    if (inp.pressed('mfdRight')) p.cockpit.mfdR.nextPage();
    if (inp.pressed('map')) p.cockpit.mfdR.setPage('MAP');
    if (inp.pressed('hud')) p.operate('hudMode', (p.controls.get('hudMode')!.value + 2) % 3);
    if (inp.pressed('timeForward')) this.time.setHours(this.time.hours + 1);
    if (inp.pressed('timeBack')) this.time.setHours(this.time.hours - 1);
    if (inp.pressed('weatherNext')) {
      const s = this.weather.next();
      events.emit('message', { text: `WEATHER → ${s}`, kind: 'info', duration: 3 });
    }
    if (inp.pressed('respawn')) this.spawn(ph.gear.weightOnWheels && !ph.damage.destroyed ? 'ready' : 'air');
    // pitch trim (DIRECT mode) — animates the trim switch while held
    const trimIn = (inp.isHeld('trimUp') ? 1 : 0) - (inp.isHeld('trimDown') ? 1 : 0);
    if (trimIn !== this.trimHeld) {
      this.trimHeld = trimIn;
      p.operate('trim', trimIn + 1);
    }
    // cockpit interaction: click the control under the cursor / gaze
    if (inp.pressed('interact')) {
      const used = cam.inCockpit && this.interaction.click(inp.mouseButtons & 4 ? -1 : 1);
      if (!used && !inp.pointerLocked) inp.requestPointerLock();
    }
    // flight controls
    ph.controls.pitch = inp.axes.pitch;
    ph.controls.roll = inp.axes.roll;
    ph.controls.yaw = inp.axes.yaw;
    ph.controls.throttle = inp.throttle;
    ph.controls.afterburner = inp.afterburner;
    ph.controls.brakeLeft = ph.controls.brakeRight = inp.brake;
    ph.fuel.burnMultiplier = this.settings.fuelBurn;
  }

  /** keys that work in any state: pause, help, debug, photo mode */
  private handleMetaInput(dt: number): void {
    const inp = this.input;
    const ui = this.ui;
    if (inp.pressed('pause') && ui.started) {
      if (this.photoMode) this.setPhotoMode(false);
      else if (ui.menuOpen) ui.closeMenu();
      else ui.openMenu();
    }
    if (inp.pressed('help')) ui.toggleHelp();
    if (inp.pressed('debug')) ui.showDebug = !ui.showDebug;
    if (inp.pressed('debugVectors')) this.vectors.visible = !this.vectors.visible;
    if (inp.pressed('photo') && ui.started && !ui.menuOpen) this.setPhotoMode(!this.photoMode);
    if (this.photoMode) {
      const cam = this.cameras;
      const k = (c: string) => (inp.isKeyDown(c) ? 1 : 0);
      cam.moveFree(dt, k('KeyW') - k('KeyS'), k('KeyD') - k('KeyA'), k('KeyE') - k('KeyQ'), inp.isKeyDown('ShiftLeft') || inp.isKeyDown('ShiftRight'));
      const sens = 0.0022 * this.settings.mouseSensitivity * Math.min(1, cam.zoom);
      if (inp.mouseDX || inp.mouseDY) cam.look(inp.mouseDX * sens, inp.mouseDY * sens);
      if (inp.pressed('zoomIn')) cam.zoomStep(-1);
      if (inp.pressed('zoomOut')) cam.zoomStep(1);
      if (inp.pressed('flaps')) this.pipeline.params.dof = !this.pipeline.params.dof;
      if (inp.pressed('timeForward')) this.time.setHours(this.time.hours + 0.5);
      if (inp.pressed('timeBack')) this.time.setHours(this.time.hours - 0.5);
      if (inp.pressed('interact') && !inp.pointerLocked) inp.requestPointerLock();
      // autofocus on the aircraft
      const pp = this.pipeline.params;
      pp.focus = this.camera.position.distanceTo(this.player.renderPos);
      pp.focal = (0.5 * 24) / Math.tan((this.camera.fov * Math.PI) / 360);
      pp.aperture = 2.0;
    }
  }

  setPhotoMode(on: boolean): void {
    if (on === this.photoMode) return;
    const cam = this.cameras;
    this.photoMode = on;
    this.paused = on;
    this.input.flightControlsEnabled = !on;
    if (on) {
      this.photoPrevMode = cam.mode === 'FREE' ? 'CHASE' : cam.mode;
      cam.freePos.copy(this.camera.position);
      const e = new Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
      cam.freeYaw = e.y;
      cam.freePitch = e.x;
      cam.freeRoll = 0;
      cam.setMode('FREE');
    } else {
      cam.setMode(this.photoPrevMode);
      this.pipeline.params.dof = false;
    }
    this.audio.setMuted(on);
  }

  frame(dt: number): void {
    this.frameDt = dt;
    this.fps = this.fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;
    globals.uTime.value += dt;
    this.input.update(dt);
    const p = this.player;
    const ph = p.physics;
    this.handleMetaInput(dt);
    if (!this.ui.started && !this.debugCam) this.cameras.look(-dt * 0.05, 0);
    if (!this.paused && !this.ui.menuOpen) this.handleInput(dt);
    if (!this.paused) {
      this.missionTime += dt;
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= PHYSICS_DT && steps < 40) {
        this.env.ctx.agl = ph.t.agl;
        this.env.ctx.tas = ph.t.tas;
        this.env.ctx.dt = PHYSICS_DT;
        this.env.ctx.inCloud = ph.cloud;
        this.env.tempOffset = this.weather.current.temp;
        this.env.wetness = this.weather.wetness;
        this.env.humidity = this.weather.current.humidity;
        ph.prevPosition.copy(ph.position);
        ph.prevQuaternion.copy(ph.quaternion);
        ph.step(PHYSICS_DT, this.env);
        this.accumulator -= PHYSICS_DT;
        steps++;
      }
    }
    const alpha = this.accumulator / PHYSICS_DT;
    const inCockpit = this.cameras.inCockpit && !this.debugCam;
    p.update(dt, alpha, inCockpit, this.weather.current.rain);

    if (this.debugCam) {
      this.camera.position.copy(this.debugCam.pos);
      this.camera.lookAt(this.debugCam.target);
      this.camera.updateMatrixWorld();
    } else {
      this.cameras.update(dt, {
        position: p.renderPos,
        quaternion: p.renderQuat,
        velocity: ph.velocity,
        omega: ph.omega,
        specificForce: ph.specificForceBody,
        tas: ph.t.tas,
        mach: ph.t.mach,
        vibration: ph.engine.vibration * 0.6 + ph.t.buffet * 2.2 + this.weather.felt * 0.35 + (ph.gear.weightOnWheels ? Math.min(1.5, ph.t.groundSpeed / 40) * 0.8 : 0),
        onGround: ph.gear.weightOnWheels,
      });
    }
    p.model.setCockpitView(inCockpit);
    if (inCockpit && !this.paused) {
      const ndc = this.input.pointerLocked ? new Vector2(0, 0) : new Vector2(this.input.mouseX, this.input.mouseY);
      this.interaction.update(this.camera, p.cockpit.hitTargets(), ndc, this.input.pointerLocked);
    } else this.interaction.hide();
    this.updateDisplays(dt, inCockpit);
    this.updateEnvironment(dt);
    {
      const gx = ph.position.x, gz = ph.position.z;
      const gh = this.env.height(gx, gz);
      const water = waterLevelAt(gx, gz) >= gh - 0.5;
      const ll = p.physics.electrical.mainBus && ph.gear.extension > 0.95 ? p.lights.landing / 2 : 0;
      this.effects.update(dt, ph, p.renderPos, p.renderQuat, this.weather.current.humidity, this.weather.windAt(ph.position.y, new Vector3()), ll, clamp(this.weather.current.fog * 600 + this.weather.current.rain * 0.5, 0, 1), water, gh);
    }
    this.updatePost(dt, inCockpit);
    this.vectors.update(ph, p.renderPos, p.renderQuat, this.pipeline.params.exposure);
    this.audio.update(this.paused ? 0 : dt, ph, this.camera.position, inCockpit, {
      canopy: p.canopy,
      warnings: p.warnings,
      masterCaution: p.masterCaution,
      rain: this.weather.current.rain,
      essentialBus: ph.electrical.essentialBus,
      flash: this.weather.flash,
    });
    this.ui.update(dt);
    for (const h of this.frameHooks) h(dt);
    this.pipeline.render(this.scene, this.fxScene, this.distortScene, this.camera);
    this.input.endFrame();
  }

  private updateDisplays(dt: number, inCockpit: boolean): void {
    const p = this.player;
    const ph = p.physics;
    const ck = p.cockpit;
    const ess = ph.electrical.essentialBus;
    const main = ph.electrical.mainBus;
    const near = inCockpit || this.camera.position.distanceTo(p.renderPos) < 40;
    if (!near) return;
    const ctx = {
      ac: ph,
      lights: { nav: p.lights.nav, strobe: p.lights.strobe, landing: p.lights.landing, formation: p.lights.formation },
      canopy: p.canopy,
      hudMode: p.hudMode,
      mapImage: this.mapImage,
      mapRect: this.mapRect,
      waypoint: null,
      missionTime: this.missionTime,
      units: this.settings.units,
      caution: [...p.annunciators],
    };
    ck.mfdL.update(dt, ctx, ess);
    ck.mfdR.update(dt, ctx, main);
    ck.standby.update(dt, ph, ess);
    ck.hud.exposure = this.pipeline.params.exposure;
    ck.hud.update({ ac: ph, waypoint: null, warnings: p.warnings, units: this.settings.units, mode: p.hudMode, time: globals.uTime.value }, p.renderQuat, main && inCockpit);
  }

  private updatePost(dt: number, inCockpit: boolean): void {
    const ph = this.player.physics;
    const p = this.pipeline.params;
    // G vision effects: onset over time (pilot with anti-G suit tolerates ~7 G)
    const nz = ph.t.nz;
    const gTarget = clamp((nz - 6.5) / 3.5, 0, 1);
    this.gForceVis = damp(this.gForceVis, gTarget, gTarget > this.gForceVis ? 0.7 : 1.8, dt);
    const negTarget = clamp((-nz - 1.5) / 2, 0, 1);
    this.gNegVis = damp(this.gNegVis, negTarget, 1.2, dt);
    p.gPos = inCockpit ? this.gForceVis * 0.85 : 0;
    p.gGray = inCockpit ? this.gForceVis * 0.6 : 0;
    p.gNeg = inCockpit ? this.gNegVis * 0.35 : 0;
    p.vignette = inCockpit ? 0.32 : 0.22;
    p.motion = this.settings.motionBlur;
    // sun glare
    const sunW = new Vector3().copy(this.time.sunDir).multiplyScalar(1e6).add(this.camera.position);
    const ndc = sunW.project(this.camera);
    const visible = ndc.z < 1 && ndc.z > -1 && Math.abs(ndc.x) < 1.2 && Math.abs(ndc.y) < 1.2 && this.time.sunElevation > -0.02;
    const cov = 1 - smooth01(this.weather.current.overcast);
    p.sunScreen.set(ndc.x * 0.5 + 0.5, ndc.y * 0.5 + 0.5, visible ? 0.6 * cov * (1 - ph.cloud) : 0);
  }

  private updateEnvironment(dt: number): void {
    const camPos = this.camera.position;
    globals.uCurvOrigin.value.copy(camPos);
    this.weather.update(dt, camPos);
    const w = this.weather.current;
    const ph = this.player.physics;
    const inCloud = this.cameras.inCockpit ? ph.cloud : this.weather.cloudDensityAt(camPos);
    this.time.update(dt);
    this.time.updateLighting(dt, camPos.y, w.mie, w.overcast, inCloud);
    globals.uSunDir.value.copy(this.time.sunDir);
    globals.uMoonDir.value.copy(this.time.moonDir);
    globals.uSunColor.value.copy(this.time.sunColor);
    globals.uNight.value = this.time.night;
    globals.uLightsOn.value = this.time.lightsOn;
    globals.uWetness.value = this.weather.wetness;
    this.csm.lightDirection.copy(this.time.keyDir).multiplyScalar(-1);
    for (const l of this.csm.lights) {
      l.color.copy(this.time.keyColor);
      l.intensity = 1;
    }
    this.csm.update();
    this.sky.mieScale = w.mie;
    this.sky.overcast = w.overcast;
    this.sky.update(dt, camPos.y);
    if (this.sky.envTexture) {
      this.scene.environment = this.sky.envTexture;
      this.scene.environmentIntensity = 1 - 0.3 * this.time.night;
    }
    const cp = this.clouds.params;
    cp.coverage = w.coverage;
    cp.density = w.density;
    cp.base = w.base;
    cp.top = w.top;
    cp.type = w.type;
    this.clouds.windOffset.copy(this.weather.windOffset);
    this.clouds.flash.set(this.weather.flashPos.x, this.weather.flashPos.y, this.weather.flashPos.z, this.weather.flash);
    sunOcclusionUniforms.uCloudCoverage.value = w.coverage;
    sunOcclusionUniforms.uCloudBase.value = w.base;
    sunOcclusionUniforms.uCloudTop.value = w.top;
    sunOcclusionUniforms.uCloudOffset.value.copy(this.weather.windOffset);
    const p = this.pipeline.params;
    p.exposure = this.time.exposure;
    p.mie = w.mie;
    p.fogDensity = w.fog;
    p.fogHeight = w.fogHeight;
    p.camCloud = inCloud * 0.03 * w.density;
    p.cloudFogColor.copy(this.clouds.ambTop).lerp(new Color().copy(this.time.sunColor).multiplyScalar(0.12), 0.5).multiplyScalar(1.6);
    p.overcast = w.overcast;
    p.flash = this.weather.flash;
    const amb = new Color(0.55, 0.6, 0.68).multiplyScalar(0.5 * Math.max(0.05, this.time.sunDir.y + 0.1));
    p.fogColor.copy(amb);
    p.overcastColor.copy(amb).multiplyScalar(1.2);
    this.clouds.ambTop.setRGB(0.35, 0.45, 0.65).multiplyScalar(Math.max(0.03, this.time.sunColor.g * 0.35));
    this.clouds.ambBottom.copy(this.clouds.ambTop).multiplyScalar(0.55);
    const windTo = this.weather.windAt(10, new Vector3());
    const ws = windTo.length();
    globals.uWind.value.set(windTo.x, windTo.z);
    this.water.update(camPos.x, camPos.z, ws, new Vector2(windTo.x, windTo.z).normalize(), w.rain);
    this.airport.update(globals.uTime.value, this.weather.windFrom, ws);
    const pixelScale = this.pipeline.height / ((this.camera.fov * Math.PI) / 180);
    this.airport.lights.material.uniforms.uPixelScale.value = pixelScale;
    this.towns.streetLights.material.uniforms.uPixelScale.value = pixelScale;
    this.player.lightSprites.material.uniforms.uPixelScale.value = pixelScale;
    this.towns.update(dt, pixelScale);
    const agl = camPos.y - this.env.height(camPos.x, camPos.z);
    this.vegetation.update(camPos, agl);
    globals.uSkyAmbient.value.setRGB(0.32, 0.4, 0.55).multiplyScalar(Math.max(0.02, this.time.sunColor.g * 0.3 + 0.02));
    this.terrain.update(this.camera);
    this.pool.pump();
  }

  cameraModes(): CameraMode[] {
    return CAMERA_MODES;
  }
}

function smooth01(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}
