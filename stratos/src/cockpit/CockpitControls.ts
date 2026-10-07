// Interactive cockpit controls with physical animation: toggle switches
// (2/3 position, with spring snap), guarded switches, push buttons with
// annunciator legends, rotary knobs with detents, levers (gear handle) and
// MFD bezel buttons. Each control exposes an invisible hit volume for
// gaze/cursor picking and a subtle hover highlight.

import {
  BoxGeometry, CanvasTexture, Color, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, SphereGeometry,
  TorusGeometry, type Material, SRGBColorSpace,
} from 'three';
import { Spring } from '../core/math.ts';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { events } from '../core/EventBus.ts';
import { worldMaterial } from '../render/Materials.ts';

/** Every lit cockpit material must go through the factory (CSM cascades, curvature). */
export function ck<T extends Material>(m: T, key = 'ck'): T {
  return worldMaterial(m, { key });
}

export type ControlKind = 'toggle' | 'button' | 'rotary' | 'guard' | 'lever';

const metal = ck(new MeshStandardMaterial({ color: 0xb8bcbf, roughness: 0.32, metalness: 0.9 }));
const darkMetal = ck(new MeshStandardMaterial({ color: 0x24272a, roughness: 0.45, metalness: 0.6 }));
const blackPlastic = ck(new MeshStandardMaterial({ color: 0x111214, roughness: 0.6, metalness: 0.0 }));
const knobMat = ck(new MeshStandardMaterial({ color: 0x18191b, roughness: 0.45, metalness: 0.1 }));
const guardMat = ck(new MeshStandardMaterial({ color: 0xa3150d, roughness: 0.45, metalness: 0.0, transparent: true, opacity: 0.92 }));
const hitMat = new MeshBasicMaterial({ visible: false });

export abstract class CockpitControl {
  readonly id: string;
  readonly kind: ControlKind;
  readonly root = new Group();
  readonly hit: Mesh;
  label: string;
  /** current logical value */
  value: number;
  positions: number;
  hovered = false;
  private highlightMats: MeshStandardMaterial[] = [];
  onChange: ((v: number, c: CockpitControl) => void) | null = null;
  /** values that are labels per position (for tooltips) */
  posLabels: string[];

  constructor(id: string, kind: ControlKind, label: string, hitSize: [number, number, number], positions: number, initial: number, posLabels: string[] = []) {
    this.id = id;
    this.kind = kind;
    this.label = label;
    this.positions = positions;
    this.value = initial;
    this.posLabels = posLabels;
    this.hit = new Mesh(new BoxGeometry(...hitSize), hitMat);
    this.hit.userData.control = this;
    this.root.add(this.hit);
  }

  /** register a material that glows when hovered (cloned per control) */
  protected highlightable<T extends Material>(m: T): T {
    if (m instanceof MeshStandardMaterial) {
      const c = ck((m as MeshStandardMaterial).clone(), 'ckh');
      this.highlightMats.push(c);
      return c as unknown as T;
    }
    return m;
  }

  get tooltip(): string {
    const pl = this.posLabels[this.value];
    return pl ? `${this.label}: ${pl}` : this.label;
  }

  /** primary action (left click / gamepad A) */
  activate(dir = 1): void {
    this.set(this.positions > 1 ? (((this.value + dir) % this.positions) + this.positions) % this.positions : this.value, true);
  }

  set(v: number, user = false): void {
    if (v === this.value) return;
    this.value = v;
    events.emit('switch', { id: this.id, kind: this.kind === 'guard' ? 'toggle' : this.kind, value: v });
    if (this.onChange) this.onChange(v, this);
    void user;
  }

  update(dt: number, time: number): void {
    const glow = this.hovered ? 0.18 + 0.08 * Math.sin(time * 8) : 0;
    for (const m of this.highlightMats) m.emissive.setRGB(glow * 0.6, glow * 0.75, glow);
    this.animate(dt);
  }

  protected abstract animate(dt: number): void;
}

/** Bat-handle toggle switch, 2 or 3 positions (0 = down/aft, top = up/forward). */
export class ToggleSwitch extends CockpitControl {
  private lever = new Group();
  private spring: Spring;
  private throwAngle = 0.42;

  constructor(id: string, label: string, positions: 2 | 3, initial: number, posLabels: string[] = []) {
    super(id, 'toggle', label, [0.03, 0.045, 0.05], positions, initial, posLabels);
    const nut = new Mesh(new CylinderGeometry(0.0075, 0.0075, 0.005, 6), metal);
    nut.rotation.x = Math.PI / 2;
    nut.position.z = 0.0025;
    this.root.add(nut);
    const collar = new Mesh(new CylinderGeometry(0.0055, 0.0065, 0.006, 12), darkMetal);
    collar.rotation.x = Math.PI / 2;
    collar.position.z = 0.007;
    this.root.add(collar);
    const handle = new Mesh(new CylinderGeometry(0.0022, 0.0032, 0.022, 10), this.highlightable(metal));
    handle.position.y = 0.011;
    const tip = new Mesh(new SphereGeometry(0.0034, 10, 8), this.highlightable(metal));
    tip.position.y = 0.022;
    this.lever.add(handle, tip);
    this.lever.position.z = 0.008;
    this.lever.rotation.x = Math.PI / 2; // points out of the panel
    this.root.add(this.lever);
    this.spring = new Spring(this.targetAngle());
  }

  private targetAngle(): number {
    if (this.positions === 3) return (this.value - 1) * -this.throwAngle;
    return (this.value === 1 ? -1 : 1) * this.throwAngle;
  }

  protected animate(dt: number): void {
    const a = this.spring.update(this.targetAngle(), 70, 0.45, dt);
    this.lever.rotation.x = Math.PI / 2 + a;
  }
}

/** Red spring-loaded guard over a toggle: first action lifts the guard, second flips the switch. */
export class GuardedSwitch extends CockpitControl {
  private inner: ToggleSwitch;
  private guard = new Group();
  private guardSpring = new Spring(0);
  guardOpen = false;
  private closeTimer = 0;

  constructor(id: string, label: string, initial: number, posLabels: string[] = []) {
    super(id, 'guard', label, [0.04, 0.06, 0.05], 2, initial, posLabels);
    this.inner = new ToggleSwitch(id + '_sw', label, 2, initial, posLabels);
    this.inner.root.remove(this.inner.hit);
    this.root.add(this.inner.root);
    const g = new BoxGeometry(0.03, 0.045, 0.028);
    g.translate(0, 0.0225, 0.014);
    const cover = new Mesh(g, this.highlightable(guardMat));
    this.guard.add(cover);
    this.guard.position.set(0, -0.022, 0.0);
    this.root.add(this.guard);
  }

  override get tooltip(): string {
    return `${this.label}: ${this.posLabels[this.value] ?? ''}${this.guardOpen ? '' : '  (guard closed)'}`;
  }

  override activate(): void {
    if (!this.guardOpen) {
      this.guardOpen = true;
      this.closeTimer = 6;
      events.emit('switch', { id: this.id + '_guard', kind: 'guard', value: 1 });
      return;
    }
    this.closeTimer = 6;
    this.inner.set(1 - this.inner.value);
    this.set(this.inner.value, true);
  }

  protected animate(dt: number): void {
    if (this.guardOpen) {
      this.closeTimer -= dt;
      if (this.closeTimer <= 0 && this.value === 0) {
        this.guardOpen = false;
        events.emit('switch', { id: this.id + '_guard', kind: 'guard', value: 0 });
      }
    }
    this.inner.value = this.value;
    this.inner.update(dt, 0);
    const a = this.guardSpring.update(this.guardOpen ? -1.9 : 0, 40, 0.6, dt);
    this.guard.rotation.x = a;
  }
}

function legendTexture(text: string, color: string, w = 128, h = 64): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0b0c0d';
  g.fillRect(0, 0, w, h);
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const lines = text.split('\n');
  const fs = lines.length > 1 ? h * 0.34 : h * 0.42;
  g.font = `700 ${fs}px "Arial Narrow", Arial, sans-serif`;
  lines.forEach((l, i) => g.fillText(l, w / 2, h / 2 + (i - (lines.length - 1) / 2) * fs * 1.05));
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** Square push button with an illuminated legend; can latch (on/off) or be momentary. */
export class PushButton extends CockpitControl {
  private cap: Mesh;
  private press = new Spring(0);
  private pressTimer = 0;
  readonly legendMat: MeshStandardMaterial;
  lit = 0;
  latching: boolean;
  litColor: Color;

  constructor(id: string, label: string, legend: string, size: [number, number], latching = false, color = '#ffb020', initial = 0) {
    super(id, 'button', label, [size[0] + 0.006, size[1] + 0.006, 0.03], latching ? 2 : 1, initial);
    this.latching = latching;
    this.litColor = new Color(color);
    const housing = new Mesh(new BoxGeometry(size[0] + 0.004, size[1] + 0.004, 0.006), blackPlastic);
    housing.position.z = 0.003;
    this.root.add(housing);
    const tex = legendTexture(legend, color);
    this.legendMat = this.highlightable(new MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new Color(0, 0, 0), roughness: 0.25, metalness: 0 }));
    this.cap = new Mesh(new BoxGeometry(size[0], size[1], 0.006), [blackPlastic, blackPlastic, blackPlastic, blackPlastic, this.legendMat, blackPlastic]);
    this.cap.position.z = 0.008;
    this.root.add(this.cap);
  }

  /** true while the button is held in after a press */
  get pressing(): boolean {
    return this.pressTimer > 0;
  }

  override activate(): void {
    this.pressTimer = 0.12;
    if (this.latching) this.set(1 - this.value, true);
    else {
      events.emit('switch', { id: this.id, kind: 'button', value: 1 });
      if (this.onChange) this.onChange(1, this);
    }
  }

  protected animate(dt: number): void {
    this.pressTimer -= dt;
    const d = this.press.update(this.pressTimer > 0 ? 1 : 0, 90, 0.7, dt);
    this.cap.position.z = 0.008 - d * 0.003;
    const on = this.latching ? Math.max(this.value, this.lit) : this.lit;
    // emissive must also exceed the hover glow channel
    this.legendMat.emissive.copy(this.litColor).multiplyScalar(on * 2.2 + 0.03);
  }
}

/** Rotary knob with detents (or continuous). */
export class RotaryKnob extends CockpitControl {
  private knob = new Group();
  private spring: Spring;
  readonly continuous: boolean;
  private sweep: number;

  constructor(id: string, label: string, positions: number, initial: number, posLabels: string[] = [], continuous = false, radius = 0.011, sweep = 4.2) {
    super(id, 'rotary', label, [radius * 2.6, radius * 2.6, 0.035], positions, initial, posLabels);
    this.continuous = continuous;
    this.sweep = sweep;
    const skirt = new Mesh(new CylinderGeometry(radius * 1.2, radius * 1.25, 0.004, 24), darkMetal);
    skirt.rotation.x = Math.PI / 2;
    skirt.position.z = 0.002;
    this.root.add(skirt);
    const body = new Mesh(new CylinderGeometry(radius * 0.92, radius, 0.014, 20), this.highlightable(knobMat));
    body.rotation.x = Math.PI / 2;
    body.position.z = 0.011;
    this.knob.add(body);
    // knurl ridges (merged into one mesh) + pointer line
    const ridges = [];
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      const g = new BoxGeometry(0.0012, 0.0012, 0.012);
      g.translate(Math.cos(a) * radius * 0.97, Math.sin(a) * radius * 0.97, 0.011);
      ridges.push(g);
    }
    this.knob.add(new Mesh(mergeGeometries(ridges), knobMat));
    const pointer = new Mesh(new BoxGeometry(0.0016, radius * 0.9, 0.001), ck(new MeshStandardMaterial({ color: 0xffffff, emissive: new Color(0.6, 0.6, 0.55), roughness: 0.4 })));
    pointer.position.set(0, radius * 0.45, 0.0185);
    this.knob.add(pointer);
    this.root.add(this.knob);
    this.spring = new Spring(this.angleFor(initial));
  }

  private angleFor(v: number): number {
    const t = this.positions > 1 ? v / (this.positions - 1) : 0;
    return this.sweep * 0.5 - t * this.sweep;
  }

  /** normalised value 0..1 */
  get fraction(): number {
    return this.positions > 1 ? this.value / (this.positions - 1) : 0;
  }

  override activate(dir = 1): void {
    const v = Math.max(0, Math.min(this.positions - 1, this.value + dir));
    this.set(v, true);
  }

  protected animate(dt: number): void {
    this.knob.rotation.z = this.spring.update(this.angleFor(this.value), 60, 0.8, dt);
  }
}

/** Landing-gear style lever with a wheel-shaped knob (up/down). */
export class GearLever extends CockpitControl {
  private arm = new Group();
  private spring: Spring;
  readonly knobLight: MeshStandardMaterial;

  constructor(id: string, label: string, initial: number) {
    super(id, 'lever', label, [0.06, 0.13, 0.08], 2, initial, ['UP', 'DOWN']);
    const slot = new Mesh(new BoxGeometry(0.014, 0.11, 0.004), blackPlastic);
    this.root.add(slot);
    const rod = new Mesh(new CylinderGeometry(0.004, 0.004, 0.07, 8), this.highlightable(metal));
    rod.rotation.x = Math.PI / 2;
    rod.position.z = 0.035;
    this.knobLight = this.highlightable(ck(new MeshStandardMaterial({ color: 0xdedede, roughness: 0.35, emissive: new Color(0, 0, 0) })));
    const wheel = new Mesh(new TorusGeometry(0.016, 0.0075, 10, 24), this.knobLight);
    wheel.position.z = 0.07;
    this.arm.add(rod, wheel);
    this.root.add(this.arm);
    this.spring = new Spring(this.target());
  }

  private target(): number {
    return this.value === 1 ? -0.035 : 0.035;
  }

  protected animate(dt: number): void {
    this.arm.position.y = this.spring.update(this.target(), 30, 0.65, dt);
  }
}

export function makeHitOnly(o: Object3D): void {
  o.traverse((c) => {
    if ((c as Mesh).isMesh) (c as Mesh).material = hitMat;
  });
}
