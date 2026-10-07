// DOM overlay: start / pause menu, controls help, message toasts, camera
// label, external-view flight data strip and the engineering debug panel.
// Everything lives in #ui; panels opt into pointer events individually.

import './ui.css';
import { KEY_HELP } from '../input/InputSystem.ts';
import { events } from '../core/EventBus.ts';
import { QUALITY_PRESETS, saveSettings } from '../core/Settings.ts';
import type { Game, SpawnKind } from '../core/Game.ts';
import type { WeatherState } from '../atmosphere/Weather.ts';

const WEATHERS: WeatherState[] = ['CLEAR', 'PARTLY CLOUDY', 'OVERCAST', 'RAIN', 'STORM', 'FOG'];
const M_TO_FT = 3.28084;
const MS_TO_KT = 1.943844;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
}

export class UI {
  private game: Game;
  private root: HTMLElement;
  private menu: HTMLElement;
  private resumeBtn: HTMLButtonElement;
  private help: HTMLElement;
  private toasts: HTMLElement;
  private camLabel: HTMLElement;
  private camTimer = 0;
  private strip: HTMLElement;
  private stripCells: Record<string, HTMLElement> = {};
  private debug: HTMLElement;
  private debugTimer = 0;
  private photoHint: HTMLElement;
  private loading: HTMLElement;
  menuOpen = true;
  started = false;
  showDebug = false;

  constructor(game: Game) {
    this.game = game;
    this.root = game.uiRoot;

    // --- start / pause menu
    this.menu = el('div', 'ui-menu', this.root);
    const panel = el('div', 'ui-panel', this.menu);
    el('div', 'ui-kicker', panel, 'STRATOS · FLIGHT &amp; SYSTEMS DEMONSTRATOR');
    el('h1', 'ui-title', panel, 'XF-41 CORVUS');
    el('p', 'ui-sub', panel, 'Single-engine air-superiority demonstrator. 6-DOF rigid body at 240 Hz, fly-by-wire with AoA / G limiting, afterburning turbofan, working landing gear and a fully clickable cockpit.');
    this.resumeBtn = el('button', 'ui-resume', panel, 'RESUME') as HTMLButtonElement;
    this.resumeBtn.addEventListener('click', () => this.closeMenu());
    const cards = el('div', 'ui-cards', panel);
    const spawns: [SpawnKind, string, string][] = [
      ['cold', 'COLD &amp; DARK', 'On the apron, canopy open, every system off. Start it from the switches — or press O.'],
      ['ready', 'READY FOR TAKEOFF', 'Lined up on the runway, engine at idle, flaps TO, parking brake set.'],
      ['air', 'AIRBORNE', 'Clean configuration at 1,600 m and 370 kt, trimmed for level flight.'],
    ];
    for (const [kind, title, text] of spawns) {
      const b = el('button', 'ui-card', cards) as HTMLButtonElement;
      el('div', 'ui-card-title', b, title);
      el('div', 'ui-card-text', b, text);
      b.addEventListener('click', () => this.fly(kind));
    }
    const opts = el('div', 'ui-opts', panel);
    // weather
    const wSel = this.select(opts, 'WEATHER', WEATHERS.map((w) => [w, w]), 'PARTLY CLOUDY', (v) => game.setWeather(v as WeatherState, true));
    events.on('weather:change', (e) => (wSel.value = e.state));
    // time of day
    const tWrap = el('label', 'ui-opt', opts);
    el('span', '', tWrap, 'TIME');
    const tIn = el('input', '', tWrap) as HTMLInputElement;
    tIn.type = 'range';
    tIn.min = '0';
    tIn.max = '24';
    tIn.step = '0.25';
    tIn.value = String(game.time.hours);
    const tOut = el('span', 'ui-opt-val', tWrap);
    const showT = () => {
      const h = Number(tIn.value);
      tOut.textContent = `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
    };
    showT();
    tIn.addEventListener('input', () => {
      game.time.setHours(Number(tIn.value));
      showT();
    });
    this.menu.addEventListener('pointerenter', () => {
      tIn.value = String(((game.time.hours % 24) + 24) % 24);
      showT();
    });
    // first camera
    this.select(opts, 'VIEW', [['COCKPIT', 'COCKPIT'], ['CHASE', 'CHASE'], ['CINEMATIC', 'CINEMATIC']], 'COCKPIT', (v) => (this.startCamera = v as 'COCKPIT'));
    // quality (reloads, every system sizes its buffers at start-up)
    this.select(opts, 'QUALITY', Object.keys(QUALITY_PRESETS).map((q) => [q, q]), game.settings.quality, (v) => {
      game.settings.quality = v as typeof game.settings.quality;
      saveSettings(game.settings);
      const u = new URL(location.href);
      u.searchParams.delete('q');
      location.href = u.toString();
    });
    const foot = el('div', 'ui-foot', panel);
    foot.innerHTML = '<b>H</b> controls &nbsp;·&nbsp; <b>Esc</b> pause &nbsp;·&nbsp; click the view to capture the mouse, click again to press the cockpit control under the reticle';
    this.loading = el('div', 'ui-loading', panel, 'STREAMING TERRAIN…');

    // --- help
    this.help = el('div', 'ui-help', this.root);
    el('div', 'ui-help-title', this.help, 'CONTROLS');
    const grid = el('div', 'ui-help-grid', this.help);
    for (const [k, v] of KEY_HELP) {
      el('div', 'ui-key', grid, k);
      el('div', 'ui-key-desc', grid, v);
    }
    el('div', 'ui-help-foot', this.help, 'Gamepad: left stick pitch / roll · LB RB yaw · RT LT throttle · right stick look · A press control · B airbrake · X flaps · Y camera · D-pad gear / brakes / MFD pages · L3 afterburner · Start pause');

    // --- toasts and camera label
    this.toasts = el('div', 'ui-toasts', this.root);
    this.camLabel = el('div', 'ui-cam', this.root);
    events.on('message', (m) => this.toast(m.text, m.kind ?? 'info', m.duration ?? 3));
    events.on('camera:mode', (e) => {
      this.camLabel.textContent = e.mode;
      this.camLabel.classList.add('show');
      this.camTimer = 1.6;
    });

    // --- flight data strip (external views)
    this.strip = el('div', 'ui-strip', this.root);
    for (const k of ['IAS', 'MACH', 'ALT', 'VS', 'G', 'AOA', 'THR', 'FUEL', 'CFG']) {
      const c = el('div', 'ui-cell', this.strip);
      el('span', 'ui-cell-k', c, k);
      this.stripCells[k] = el('span', 'ui-cell-v', c);
    }

    // --- debug
    this.debug = el('pre', 'ui-debug', this.root);
    this.photoHint = el('div', 'ui-photo', this.root, 'PHOTO MODE — mouse look · WASD / Q E move (Shift fast) · wheel zoom · F depth of field · P exit');

    // ?fly skips the start menu (automated tests, direct links)
    if (new URLSearchParams(location.search).has('fly')) {
      this.started = true;
      this.closeMenu();
      game.cameras.setMode('COCKPIT');
    } else this.openMenu();
  }

  private startCamera: 'COCKPIT' | 'CHASE' | 'CINEMATIC' = 'COCKPIT';
  private viewKey = '';

  private select(parent: HTMLElement, label: string, options: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement {
    const wrap = el('label', 'ui-opt', parent);
    el('span', '', wrap, label);
    const s = el('select', '', wrap) as HTMLSelectElement;
    for (const [v, t] of options) {
      const o = el('option', '', s, t) as HTMLOptionElement;
      o.value = v;
    }
    s.value = value;
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }

  private fly(kind: SpawnKind): void {
    const g = this.game;
    g.audio.start();
    g.spawn(kind);
    if (!this.started) g.cameras.setMode(this.startCamera);
    this.started = true;
    this.closeMenu();
  }

  openMenu(): void {
    this.menuOpen = true;
    this.menu.classList.add('show');
    this.resumeBtn.style.display = this.started ? '' : 'none';
    this.game.paused = this.started;
    this.game.input.flightControlsEnabled = false;
    this.game.input.exitPointerLock();
    this.game.audio.setMuted(this.started);
  }

  closeMenu(): void {
    this.menuOpen = false;
    this.menu.classList.remove('show');
    this.game.paused = false;
    this.game.input.flightControlsEnabled = true;
    this.game.audio.setMuted(false);
  }

  toggleHelp(): void {
    this.help.classList.toggle('show');
  }

  toast(text: string, kind: string, duration: number): void {
    const t = el('div', `ui-toast ${kind}`, this.toasts, '');
    t.textContent = text;
    while (this.toasts.children.length > 4) this.toasts.firstElementChild?.remove();
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 400);
    }, duration * 1000);
  }

  update(dt: number): void {
    const g = this.game;
    const ph = g.aircraft;
    const t = ph.t;
    const photo = g.photoMode;
    this.root.classList.toggle('photo', photo);
    this.photoHint.classList.toggle('show', photo);
    if (this.camTimer > 0) {
      this.camTimer -= dt;
      if (this.camTimer <= 0) this.camLabel.classList.remove('show');
    }
    this.loading.style.opacity = g.terrain.pending > 0 ? '1' : '0';
    // start menu: shift the projection so the aircraft sits beside the panel
    const w = window.innerWidth, h = window.innerHeight;
    const off = this.menuOpen && !this.started && w > 720 ? Math.round(-Math.min(0.24, 330 / w) * w) : 0;
    const key = `${off}:${w}x${h}`;
    if (key !== this.viewKey) {
      this.viewKey = key;
      if (off) g.camera.setViewOffset(w, h, off, 0, w, h);
      else g.camera.clearViewOffset();
    }

    // external-view flight data
    const showStrip = this.started && !this.menuOpen && !photo && !g.cameras.inCockpit;
    this.strip.classList.toggle('show', showStrip);
    if (showStrip) {
      const imp = g.settings.units === 'imperial';
      const c = this.stripCells;
      c.IAS.textContent = imp ? `${Math.round(t.ias * MS_TO_KT)} KT` : `${Math.round(t.ias * 3.6)} KM/H`;
      c.MACH.textContent = t.mach.toFixed(2);
      c.ALT.textContent = imp ? `${Math.round(t.altitude * M_TO_FT).toLocaleString('en-US')} FT` : `${Math.round(t.altitude).toLocaleString('en-US')} M`;
      const vs = imp ? t.verticalSpeed * M_TO_FT * 60 : t.verticalSpeed;
      c.VS.textContent = `${vs >= 0 ? '+' : ''}${Math.round(imp ? vs / 10 : vs) * (imp ? 10 : 1)}${imp ? '' : ' M/S'}`;
      c.G.textContent = t.nz.toFixed(1);
      c.G.classList.toggle('warn', t.nz > 8 || t.nz < -2.5);
      c.AOA.textContent = `${(t.alpha * 57.2958).toFixed(1)}°`;
      c.AOA.classList.toggle('warn', t.stallWarning);
      const e = ph.engine;
      c.THR.textContent = e.state === 'RUN' ? `${Math.round(e.n2 * 100)}%${e.abLit ? ' AB' : ''}` : e.state;
      c.THR.classList.toggle('ab', e.abLit);
      c.FUEL.textContent = `${Math.round(ph.fuel.total).toLocaleString('en-US')} KG`;
      const gear = ph.gear.handleDown ? (ph.gear.extension > 0.99 ? 'GEAR DN' : 'GEAR ··') : ph.gear.extension > 0.01 ? 'GEAR ··' : 'GEAR UP';
      const flaps = ['', ' · FLAP TO', ' · FLAP LDG'][ph.surfaces.flapSetting] ?? '';
      const brk = ph.surfaces.airbrake > 0.05 ? ' · SPD BRK' : '';
      const pbrk = ph.gear.parkingBrake ? ' · P-BRK' : '';
      c.CFG.textContent = `${gear}${flaps}${brk}${pbrk} · ${ph.fcs.mode}`;
    }

    // debug panel at 10 Hz
    this.debug.classList.toggle('show', this.showDebug && !photo);
    if (this.showDebug && !photo) {
      this.debugTimer -= dt;
      if (this.debugTimer <= 0) {
        this.debugTimer = 0.1;
        this.debug.textContent = this.debugText();
      }
    }
  }

  private debugText(): string {
    const g = this.game;
    const ph = g.aircraft;
    const t = ph.t;
    const a = ph.aero;
    const e = ph.engine;
    const f = (v: number, d = 1, w = 8) => v.toFixed(d).padStart(w);
    const kN = (v: number) => f(v / 1000, 1, 7) + ' kN';
    const legs = ph.gear.legs.map((l) => `${l.cfg.id.padEnd(5)} ext ${f(l.extension, 2, 4)} comp ${f(l.compression, 3, 6)} F ${kN(l.force.length())}`).join('\n');
    const r = g.pipeline;
    return [
      `FPS ${f(g.fps, 0, 4)}   draw ${r.lastCalls}   tris ${(r.lastTriangles / 1e6).toFixed(2)}M   chunks ${g.terrain.pending} pending`,
      '',
      `── AERO ─────────────────────────────`,
      `alpha ${f(t.alpha * 57.2958, 2)}°  beta ${f(t.beta * 57.2958, 2)}°`,
      `mach  ${f(t.mach, 3)}   qbar ${f(t.qbar / 1000, 2)} kPa`,
      `TAS   ${f(t.tas, 1)} m/s  IAS ${f(t.ias, 1)} m/s`,
      `CL    ${f(a.cl, 3)}   L/D ${f(t.drag > 1 ? t.lift / t.drag : 0, 2)}`,
      `lift  ${kN(t.lift)}  drag ${kN(t.drag)}`,
      `thrust${kN(t.thrust)}  weight ${kN(t.weight)}`,
      `nz ${f(t.nz, 2)}  nx ${f(t.nx, 2)}  ny ${f(t.ny, 2)}  buffet ${f(t.buffet, 2)}`,
      `p ${f(ph.omega.z * -57.3, 1)}  q ${f(ph.omega.x * 57.3, 1)}  r ${f(ph.omega.y * -57.3, 1)} °/s`,
      `rho ${f(t.airDensity, 3)}  OAT ${f(t.oat, 1)} C  alt ${f(t.altitude, 0)} m  agl ${f(t.agl, 1)} m`,
      `mass ${f(t.mass, 0)} kg  CG x${f(ph.cg.x, 3, 6)} y${f(ph.cg.y, 3, 6)} z${f(ph.cg.z, 3, 6)} m`,
      '',
      `── FCS ${ph.fcs.mode.padEnd(6)} ──────────────────────`,
      `nz cmd ${f(ph.fcs.nzCommand, 2)}  ${ph.fcs.aoaLimiting ? 'AOA-LIM' : '       '} ${ph.fcs.gLimiting ? 'G-LIM' : ''}`,
      `elev ${f(ph.surfaces.elevator.pos * 57.3, 1)}°  ail ${f(ph.surfaces.aileron.pos * 57.3, 1)}°  rud ${f(ph.surfaces.rudder.pos * 57.3, 1)}°`,
      `flap ${f(ph.surfaces.flaps * 57.3, 1)}°  lef ${f(ph.surfaces.lef * 57.3, 1)}°  spdbrk ${f(ph.surfaces.airbrake * 57.3, 1)}°  hyd ${f(ph.surfaces.hydraulics, 2)}`,
      '',
      `── ENGINE ${e.state.padEnd(9)} ──────────────────`,
      `N2 ${f(e.n2 * 100, 1)}%  EGT ${f(e.egt, 0)} C  AB ${f(e.abFraction, 2)}  nozzle ${f(e.nozzle, 2)}`,
      `thrust ${kN(e.thrust)}  FF ${f(e.fuelFlow * 3600, 0)} kg/h  fuel ${f(ph.fuel.total, 0)} kg`,
      '',
      `── GEAR ${ph.gear.weightOnWheels ? 'WOW' : 'AIR'} ───────────────────────────`,
      legs,
      '',
      `F4 force vectors: lift (green) drag (red) thrust (orange) weight (blue) velocity (white) gear (yellow)`,
    ].join('\n');
  }
}
