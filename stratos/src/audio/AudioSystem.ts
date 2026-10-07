// Procedural, layered aircraft audio (WebAudio, no samples).
//   engine: turbine whine (blade-pass tones), combustion roar, low rumble,
//           afterburner rumble + crackle + light-off thump
//   airflow: wind / canopy hiss vs dynamic pressure, buffet, airbrake rumble
//   cockpit: ECS hiss, avionics hum, breathing (strained under G), switch
//            clicks per control type, warning tones + optional voice callouts
//   mechanical: gear / flaps / airbrake hydraulics, gear lock clunks, canopy
//            motor + seal, touchdown thumps, tyre screech, runway rumble,
//            structural creaks under load, sonic boom, explosion, thunder.
// Interior vs exterior mixes: muffled engine in the cockpit, directional and
// Doppler-shifted engine outside.

import { Vector3 } from 'three';
import { events } from '../core/EventBus.ts';
import { clamp, smoothstep } from '../core/math.ts';
import type { AircraftPhysics } from '../aircraft/AircraftPhysics.ts';

function noiseBuffer(ctx: AudioContext, kind: 'white' | 'pink' | 'brown', seconds = 3): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'white') d[i] = w * 0.5;
    else if (kind === 'pink') {
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    } else {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  return buf;
}

interface Loop {
  src: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  gain: GainNode;
}

export class AudioSystem {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private interior!: GainNode; // cockpit-only sounds
  private exterior!: GainNode; // engine & airflow (filtered when inside)
  private extFilter!: BiquadFilterNode;
  private noise: Record<string, AudioBuffer> = {};
  private whine: OscillatorNode[] = [];
  private whineGain!: GainNode;
  private whineFilter!: BiquadFilterNode;
  private roar!: Loop;
  private rumble!: Loop;
  private ab!: Loop;
  private abMod!: GainNode;
  private wind!: Loop;
  private hiss!: Loop;
  private ecs!: Loop;
  private rolling!: Loop;
  private buffet!: Loop;
  private rain!: Loop;
  private hydraulic!: OscillatorNode;
  private hydGain!: GainNode;
  private hum!: OscillatorNode;
  private humGain!: GainNode;
  private warnOsc!: OscillatorNode;
  private warnGain!: GainNode;
  volume = 0.8;
  inCockpit = true;
  voice = true;
  private hydTimer = 0;
  private breathTimer = 0;
  private creakTimer = 0;
  private abCrackle = 0;
  private lastWarn = '';
  private voiceTimer = 0;
  private cameraPos = new Vector3();
  private acPos = new Vector3();

  get started(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** fade everything out (pause menu) or back in */
  setMuted(muted: boolean): void {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(muted ? 0 : this.volume, this.ctx.currentTime, 0.08);
  }

  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.noise.white = noiseBuffer(ctx, 'white');
    this.noise.pink = noiseBuffer(ctx, 'pink');
    this.noise.brown = noiseBuffer(ctx, 'brown');
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(comp).connect(ctx.destination);
    this.extFilter = ctx.createBiquadFilter();
    this.extFilter.type = 'lowpass';
    this.extFilter.frequency.value = 18000;
    this.exterior = ctx.createGain();
    this.exterior.connect(this.extFilter).connect(this.master);
    this.interior = ctx.createGain();
    this.interior.connect(this.master);

    // ---- engine turbine whine: blade-passing tones + harmonics
    this.whineFilter = ctx.createBiquadFilter();
    this.whineFilter.type = 'bandpass';
    this.whineFilter.Q.value = 0.9;
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whineFilter.connect(this.whineGain).connect(this.exterior);
    for (const [type, mult, g] of [['sawtooth', 1, 0.18], ['triangle', 2.01, 0.14], ['sine', 0.5, 0.2], ['sawtooth', 3.02, 0.05]] as [OscillatorType, number, number][]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 400 * mult;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(this.whineFilter);
      o.start();
      (o as unknown as { mult: number }).mult = mult;
      this.whine.push(o);
    }
    this.roar = this.loop('pink', 'bandpass', 600, 0.7, this.exterior);
    this.rumble = this.loop('brown', 'lowpass', 160, 0.8, this.exterior);
    this.ab = this.loop('brown', 'lowpass', 420, 0.5, this.exterior);
    this.abMod = ctx.createGain();
    this.abMod.gain.value = 1;
    this.ab.gain.disconnect();
    this.ab.gain.connect(this.abMod).connect(this.exterior);
    this.wind = this.loop('pink', 'bandpass', 500, 0.5, this.exterior);
    this.hiss = this.loop('white', 'highpass', 3500, 0.4, this.interior);
    this.ecs = this.loop('pink', 'bandpass', 2200, 0.6, this.interior);
    this.rolling = this.loop('brown', 'lowpass', 220, 0.9, this.exterior);
    this.buffet = this.loop('brown', 'lowpass', 60, 1.2, this.exterior);
    this.rain = this.loop('white', 'bandpass', 4000, 0.5, this.interior);
    // hydraulic pump whine
    this.hydraulic = ctx.createOscillator();
    this.hydraulic.type = 'sawtooth';
    this.hydraulic.frequency.value = 380;
    const hf = ctx.createBiquadFilter();
    hf.type = 'bandpass';
    hf.frequency.value = 900;
    hf.Q.value = 3;
    this.hydGain = ctx.createGain();
    this.hydGain.gain.value = 0;
    this.hydraulic.connect(hf).connect(this.hydGain).connect(this.interior);
    this.hydraulic.start();
    // avionics hum (400 Hz aircraft power)
    this.hum = ctx.createOscillator();
    this.hum.type = 'sine';
    this.hum.frequency.value = 400;
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0;
    this.hum.connect(this.humGain).connect(this.interior);
    this.hum.start();
    // warning tone generator
    this.warnOsc = ctx.createOscillator();
    this.warnOsc.type = 'square';
    this.warnOsc.frequency.value = 900;
    const wf = ctx.createBiquadFilter();
    wf.type = 'lowpass';
    wf.frequency.value = 2400;
    this.warnGain = ctx.createGain();
    this.warnGain.gain.value = 0;
    this.warnOsc.connect(wf).connect(this.warnGain).connect(this.interior);
    this.warnOsc.start();
    this.bindEvents();
  }

  private loop(kind: string, ftype: BiquadFilterType, freq: number, q: number, dest: AudioNode): Loop {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise[kind];
    src.loop = true;
    src.loopStart = Math.random();
    const filter = ctx.createBiquadFilter();
    filter.type = ftype;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(dest);
    src.start(0, Math.random() * 2);
    return { src, filter, gain };
  }

  /** one-shot filtered noise burst / tone */
  private burst(opts: { kind?: string; freq: number; q?: number; type?: BiquadFilterType; gain: number; attack?: number; decay: number; delay?: number; dest?: AudioNode; tone?: number; toneType?: OscillatorType; sweep?: number }): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(opts.gain, t0 + (opts.attack ?? 0.002));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + (opts.attack ?? 0.002) + opts.decay);
    g.connect(opts.dest ?? this.interior);
    if (opts.tone) {
      const o = ctx.createOscillator();
      o.type = opts.toneType ?? 'sine';
      o.frequency.setValueAtTime(opts.tone, t0);
      if (opts.sweep) o.frequency.exponentialRampToValueAtTime(Math.max(20, opts.tone * opts.sweep), t0 + opts.decay);
      o.connect(g);
      o.start(t0);
      o.stop(t0 + opts.decay + 0.1);
    } else {
      const s = ctx.createBufferSource();
      s.buffer = this.noise[opts.kind ?? 'white'];
      const f = ctx.createBiquadFilter();
      f.type = opts.type ?? 'bandpass';
      f.frequency.value = opts.freq;
      f.Q.value = opts.q ?? 2;
      s.connect(f).connect(g);
      s.start(t0, Math.random() * 2);
      s.stop(t0 + opts.decay + 0.1);
    }
  }

  private bindEvents(): void {
    events.on('switch', (e) => {
      if (!this.inCockpit) return;
      switch (e.kind) {
        case 'toggle':
          this.burst({ freq: 3200, q: 4, gain: 0.35, decay: 0.03 });
          this.burst({ freq: 1200, q: 2, gain: 0.2, decay: 0.05, delay: 0.004 });
          break;
        case 'button':
          this.burst({ freq: 2400, q: 3, gain: 0.18, decay: 0.025 });
          break;
        case 'rotary':
          this.burst({ freq: 4200, q: 6, gain: 0.12, decay: 0.015 });
          break;
        case 'guard':
          this.burst({ freq: 1800, q: 2, gain: 0.25, decay: 0.05 });
          break;
        case 'lever':
          this.burst({ kind: 'brown', freq: 500, q: 1, gain: 0.5, decay: 0.12 });
          this.burst({ freq: 2600, q: 3, gain: 0.25, decay: 0.04, delay: 0.05 });
          break;
      }
    });
    events.on('gear:transit', () => (this.hydTimer = 6.5));
    events.on('gear:locked', () => {
      this.burst({ kind: 'brown', freq: 180, q: 1, type: 'lowpass', gain: 0.9, decay: 0.25, dest: this.inCockpit ? this.interior : this.exterior });
      this.burst({ freq: 900, q: 2, gain: 0.3, decay: 0.08, delay: 0.02 });
      this.hydTimer = Math.min(this.hydTimer, 0.4);
    });
    events.on('flaps:move', () => (this.hydTimer = Math.max(this.hydTimer, 3)));
    events.on('airbrake:move', () => (this.hydTimer = Math.max(this.hydTimer, 1.6)));
    events.on('canopy:move', () => (this.hydTimer = Math.max(this.hydTimer, 5)));
    events.on('canopy:locked', (e) => {
      this.burst({ kind: 'brown', freq: 300, q: 1, type: 'lowpass', gain: 0.6, decay: 0.2 });
      if (!e.open) this.burst({ freq: 600, q: 1, gain: 0.3, decay: 0.4, delay: 0.05 });
    });
    events.on('touchdown', (e) => {
      const k = clamp(e.verticalSpeed / 3, 0.15, 1.5);
      this.burst({ kind: 'brown', freq: 140, q: 0.8, type: 'lowpass', gain: 0.9 * k, decay: 0.35, dest: this.inCockpit ? this.interior : this.exterior });
      if (e.groundSpeed > 30) this.burst({ freq: 1800, q: 1.5, gain: 0.4 * clamp(e.groundSpeed / 80, 0, 1), decay: 0.5, attack: 0.01, dest: this.exterior });
    });
    events.on('afterburner', (e) => {
      if (e.on) {
        this.burst({ kind: 'brown', freq: 90, q: 0.7, type: 'lowpass', gain: 1.2, decay: 0.6, dest: this.exterior });
        this.burst({ tone: 55, toneType: 'sine', freq: 0, gain: 0.6, decay: 0.3, sweep: 0.6, dest: this.exterior });
      }
    });
    events.on('engine:state', (e) => {
      if (e.state === 'LIGHTOFF') this.burst({ kind: 'brown', freq: 200, q: 0.7, type: 'lowpass', gain: 0.8, decay: 1.2, dest: this.exterior });
    });
    events.on('sonicboom', (e) => {
      if (this.inCockpit) return;
      const d = this.cameraPos.distanceTo(new Vector3(...e.position));
      const delay = Math.min(6, d / 343);
      for (const dt of [0, 0.11]) this.burst({ kind: 'brown', freq: 120, q: 0.5, type: 'lowpass', gain: 2.2, decay: 0.5, delay: delay + dt, dest: this.master });
    });
    events.on('crash', () => {
      this.burst({ kind: 'brown', freq: 200, q: 0.5, type: 'lowpass', gain: 2.5, decay: 2.5, dest: this.master });
      this.burst({ kind: 'white', freq: 1500, q: 0.5, gain: 0.8, decay: 1.2, dest: this.master });
    });
    events.on('lightning', (e) => {
      const delay = Math.min(12, e.distance / 343);
      this.burst({ kind: 'brown', freq: 90, q: 0.5, type: 'lowpass', gain: clamp(4000 / (e.distance + 1), 0.15, 1.2), decay: 3.5, attack: 0.3, delay, dest: this.master });
    });
    events.on('damage', (e) => {
      if (e.amount > 0.08) this.burst({ kind: 'brown', freq: 400, q: 1, gain: clamp(e.amount * 2, 0.2, 1.2), decay: 0.4, dest: this.master });
    });
    events.on('stress', () => this.creak(1));
  }

  private creak(strength: number): void {
    const f = 120 + Math.random() * 300;
    this.burst({ kind: 'brown', freq: f, q: 8, gain: 0.25 * strength, decay: 0.3 + Math.random() * 0.4, attack: 0.05 });
    this.burst({ freq: f * 7, q: 12, gain: 0.05 * strength, decay: 0.15, delay: 0.05 });
  }

  private setGain(node: GainNode, v: number, tc = 0.08): void {
    node.gain.setTargetAtTime(v, this.ctx!.currentTime, tc);
  }

  update(dt: number, ac: AircraftPhysics, cameraPos: Vector3, cameraInCockpit: boolean, opts: { canopy: number; warnings: string[]; masterCaution: boolean; rain: number; essentialBus: boolean; flash: number }): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.inCockpit = cameraInCockpit;
    this.cameraPos.copy(cameraPos);
    this.acPos.copy(ac.position);
    this.master.gain.setTargetAtTime(this.volume, now, 0.1);
    const e = ac.engine;
    const t = ac.t;
    const n2 = e.n2;
    const combusting = e.state === 'RUN' || e.state === 'LIGHTOFF';
    // ---- interior / exterior perspective
    const canopyOpen = opts.canopy;
    let distGain = 1;
    let doppler = 1;
    let aftness = 0;
    if (cameraInCockpit) {
      this.extFilter.frequency.setTargetAtTime(700 + canopyOpen * 9000, now, 0.1);
      this.setGain(this.exterior, 0.55 + canopyOpen * 0.35);
      this.setGain(this.interior, 1);
    } else {
      const rel = new Vector3().subVectors(cameraPos, ac.position);
      const d = Math.max(5, rel.length());
      distGain = clamp(28 / d, 0, 1.6);
      // Doppler from the closing speed along the line of sight
      const closing = -ac.velocity.dot(rel.clone().normalize());
      doppler = clamp(343 / Math.max(60, 343 - clamp(closing, -280, 280)), 0.55, 2.2);
      const aft = new Vector3(0, 0, 1).applyQuaternion(ac.quaternion);
      aftness = clamp(rel.normalize().dot(aft), -1, 1);
      this.extFilter.frequency.setTargetAtTime(clamp(16000 * Math.pow(distGain, 0.5), 1200, 18000), now, 0.1);
      this.setGain(this.exterior, distGain);
      this.setGain(this.interior, 0);
    }
    // ---- turbine whine (forward radiating)
    const bladeHz = 120 + n2 * 2600;
    for (const o of this.whine) o.frequency.setTargetAtTime(bladeHz * (o as unknown as { mult: number }).mult * doppler, now, 0.05);
    this.whineFilter.frequency.setTargetAtTime(bladeHz * 1.3 * doppler, now, 0.05);
    const whineLevel = smoothstep(0.05, 0.5, n2) * (0.18 + 0.12 * n2) * (cameraInCockpit ? 0.9 : 1 + 0.6 * Math.max(0, -aftness));
    this.setGain(this.whineGain, whineLevel);
    // ---- combustion roar & rumble (aft radiating)
    const thrustK = clamp(e.thrust / 79000, 0, 1.7);
    const aftBoost = cameraInCockpit ? 1 : 0.6 + 0.9 * Math.max(0, aftness);
    this.roar.filter.frequency.setTargetAtTime((350 + thrustK * 900) * doppler, now, 0.1);
    this.setGain(this.roar.gain, (combusting ? 0.05 + 0.45 * thrustK : 0) * aftBoost);
    this.rumble.filter.frequency.setTargetAtTime(90 + 120 * thrustK, now, 0.1);
    this.setGain(this.rumble.gain, (combusting ? 0.2 + 0.7 * thrustK : n2 * 0.2) * (cameraInCockpit ? 1.1 : aftBoost));
    // ---- afterburner with crackle
    const ab = e.abFraction;
    this.abCrackle = Math.max(0, this.abCrackle - dt * 12);
    if (ab > 0.2 && Math.random() < dt * 30) this.abCrackle = 0.5 + Math.random() * 0.5;
    this.setGain(this.ab.gain, ab * 1.4 * aftBoost);
    this.abMod.gain.setTargetAtTime(0.8 + this.abCrackle * 0.6, now, 0.01);
    this.ab.filter.frequency.setTargetAtTime(300 + ab * 400, now, 0.1);
    // ---- airflow: wind, canopy hiss, buffet, airbrake
    const q = t.qbar;
    const qn = clamp(q / 40000, 0, 2);
    const supersonicQuiet = t.mach > 1.02 ? 0.7 : 1;
    this.wind.filter.frequency.setTargetAtTime(250 + 900 * Math.sqrt(qn), now, 0.1);
    this.setGain(this.wind.gain, (0.04 + 0.6 * Math.sqrt(qn)) * (1 + ac.surfaces.airbrake * 0.8 + canopyOpen * 2) * supersonicQuiet);
    this.setGain(this.hiss.gain, (0.02 + 0.12 * Math.sqrt(qn)) * (1 + canopyOpen * 3));
    this.setGain(this.buffet.gain, clamp(t.buffet, 0, 1.5) * 0.9 + ac.surfaces.airbrake * qn * 0.6);
    // ---- runway rolling rumble
    const rollingLevel = ac.gear.weightOnWheels ? clamp(t.groundSpeed / 70, 0, 1.2) * 0.6 : 0;
    this.setGain(this.rolling.gain, rollingLevel);
    // ---- rain on the canopy
    this.setGain(this.rain.gain, opts.rain * (0.08 + 0.12 * clamp(t.tas / 150, 0, 1)) * (cameraInCockpit ? 1 : 0));
    // ---- cockpit systems: ECS and avionics hum
    this.setGain(this.ecs.gain, opts.essentialBus ? 0.035 : 0);
    this.setGain(this.humGain, opts.essentialBus ? 0.006 : 0);
    // ---- hydraulics
    this.hydTimer = Math.max(0, this.hydTimer - dt);
    this.setGain(this.hydGain, this.hydTimer > 0 ? 0.035 : 0, 0.15);
    this.hydraulic.frequency.setTargetAtTime(360 + 40 * Math.sin(now * 3), now, 0.1);
    // ---- breathing (oxygen mask), faster + strained under G
    if (cameraInCockpit && opts.essentialBus) {
      this.breathTimer -= dt;
      const g = Math.max(1, t.nz);
      if (this.breathTimer <= 0) {
        const rate = clamp(4.2 / Math.sqrt(g), 1.1, 4.2);
        this.breathTimer = rate;
        const strain = clamp((g - 5) / 4, 0, 1);
        this.burst({ kind: 'pink', freq: 900 + strain * 500, q: 1.2, gain: 0.045 + strain * 0.06, attack: 0.35, decay: 0.7 * rate * 0.35 });
        this.burst({ kind: 'pink', freq: 600, q: 1.0, gain: 0.03 + strain * 0.05, attack: 0.2, decay: 0.6 * rate * 0.3, delay: rate * 0.45 });
        if (strain > 0.4 && Math.random() < 0.5) this.burst({ tone: 110 + Math.random() * 30, toneType: 'sawtooth', freq: 0, gain: 0.03 * strain, decay: 0.35, attack: 0.05 });
      }
    }
    // ---- structural creaks under load
    this.creakTimer -= dt;
    const load = clamp((t.nz - 5.5) / 3.5, 0, 1) + clamp((q - 50000) / 40000, 0, 0.6);
    if (load > 0.05 && this.creakTimer <= 0 && cameraInCockpit) {
      this.creakTimer = 0.4 + Math.random() * 2 / (load + 0.2);
      this.creak(load);
    }
    // ---- warnings: tones + voice
    const w = opts.warnings[0] ?? (opts.masterCaution ? 'CAUTION' : '');
    let toneOn = 0, toneHz = 0;
    const ph = now % 1;
    if (opts.essentialBus && cameraInCockpit) {
      if (w === 'STALL') {
        toneHz = 1400;
        toneOn = ph % 0.25 < 0.12 ? 1 : 0;
      } else if (w === 'PULL UP') {
        toneHz = 700 + 500 * (ph % 0.5) * 2;
        toneOn = ph % 0.5 < 0.35 ? 1 : 0;
      } else if (w === 'GEAR' || w === 'FIRE') {
        toneHz = w === 'FIRE' ? 600 : 1000;
        toneOn = ph < 0.6 ? 1 : 0;
      } else if (w === 'CAUTION') {
        toneHz = ph < 0.25 ? 800 : 600;
        toneOn = ph < 0.5 ? 1 : 0;
      }
    }
    this.warnOsc.frequency.setTargetAtTime(toneHz || 800, now, 0.005);
    this.warnGain.gain.setTargetAtTime(toneOn * 0.05, now, 0.004);
    this.voiceTimer -= dt;
    if (this.voice && opts.warnings[0] && opts.warnings[0] !== this.lastWarn && this.voiceTimer <= 0 && cameraInCockpit && opts.essentialBus) {
      this.say(opts.warnings[0] === 'FIRE' ? 'Engine fire. Engine fire.' : opts.warnings[0] === 'GEAR' ? 'Landing gear' : opts.warnings[0].toLowerCase());
      this.voiceTimer = 3;
    }
    this.lastWarn = opts.warnings[0] ?? '';
  }

  private say(text: string): void {
    try {
      const s = window.speechSynthesis;
      if (!s) return;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.15;
      u.pitch = 1.1;
      u.volume = 0.7 * this.volume;
      const v = s.getVoices().find((x) => /female|zira|samantha|google uk english female/i.test(x.name));
      if (v) u.voice = v;
      s.cancel();
      s.speak(u);
    } catch {
      /* speech unavailable */
    }
  }
}
