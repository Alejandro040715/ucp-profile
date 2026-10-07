// Device-agnostic input layer. Physical devices (keyboard, mouse, gamepad,
// generic joystick/HOTAS) feed named axes and actions through a binding table.
// Game systems only read actions, so new devices can be added without
// touching gameplay code.

import { approach, clamp, damp } from '../core/math.ts';

export type ButtonAction =
  | 'gear' | 'flaps' | 'flapsUp' | 'airbrake' | 'brakes' | 'parkingBrake'
  | 'cameraNext' | 'cameraPrev' | 'cam1' | 'cam2' | 'cam3' | 'cam4' | 'cam5' | 'cam6'
  | 'interact' | 'pause' | 'photo' | 'replay' | 'debug' | 'debugVectors' | 'hud' | 'help'
  | 'mfdLeft' | 'mfdRight' | 'autostart' | 'canopy' | 'landingLight' | 'navLights' | 'cockpitLights'
  | 'fcsMode' | 'trimUp' | 'trimDown' | 'timeForward' | 'timeBack' | 'weatherNext' | 'centerView'
  | 'throttleUp' | 'throttleDown' | 'afterburnerToggle' | 'zoomIn' | 'zoomOut' | 'lookBack' | 'map'
  | 'pitchUp' | 'pitchDown' | 'rollLeft' | 'rollRight' | 'yawLeft' | 'yawRight' | 'respawn';

export type AxisAction = 'pitch' | 'roll' | 'yaw' | 'lookX' | 'lookY';

const KEY_BINDINGS: Record<string, ButtonAction[]> = {
  KeyW: ['pitchDown'],
  KeyS: ['pitchUp'],
  KeyA: ['rollLeft'],
  KeyD: ['rollRight'],
  KeyQ: ['yawLeft'],
  KeyE: ['yawRight'],
  ArrowUp: ['pitchDown'],
  ArrowDown: ['pitchUp'],
  ArrowLeft: ['rollLeft'],
  ArrowRight: ['rollRight'],
  ShiftLeft: ['throttleUp'],
  ShiftRight: ['throttleUp'],
  ControlLeft: ['throttleDown'],
  ControlRight: ['throttleDown'],
  Equal: ['throttleUp'],
  Minus: ['throttleDown'],
  NumpadAdd: ['throttleUp'],
  NumpadSubtract: ['throttleDown'],
  Tab: ['afterburnerToggle'],
  KeyG: ['gear'],
  KeyF: ['flaps'],
  KeyB: ['airbrake'],
  Space: ['brakes'],
  KeyZ: ['parkingBrake'],
  KeyC: ['cameraNext'],
  Digit1: ['cam1'],
  Digit2: ['cam2'],
  Digit3: ['cam3'],
  Digit4: ['cam4'],
  Digit5: ['cam5'],
  Digit6: ['cam6'],
  Escape: ['pause'],
  KeyP: ['photo'],
  KeyR: ['replay'],
  Backquote: ['debug'],
  F3: ['debug'],
  F4: ['debugVectors'],
  KeyU: ['hud'],
  KeyH: ['help'],
  F1: ['help'],
  BracketLeft: ['mfdLeft'],
  BracketRight: ['mfdRight'],
  KeyO: ['autostart'],
  KeyK: ['canopy'],
  KeyL: ['landingLight'],
  KeyN: ['navLights'],
  KeyJ: ['cockpitLights'],
  KeyX: ['fcsMode'],
  Comma: ['trimDown'],
  Period: ['trimUp'],
  KeyT: ['timeForward'],
  KeyY: ['weatherNext'],
  KeyV: ['centerView'],
  KeyM: ['map'],
  KeyI: ['lookBack'],
  Backspace: ['respawn'],
};

/** Standard-mapping gamepad buttons */
const PAD_BUTTONS: Record<number, ButtonAction[]> = {
  0: ['interact'], // A
  1: ['airbrake'], // B
  2: ['flaps'], // X
  3: ['cameraNext'], // Y
  4: ['yawLeft'], // LB (held)
  5: ['yawRight'], // RB
  8: ['hud'], // View/Back
  9: ['pause'], // Start/Menu
  10: ['afterburnerToggle'], // L3
  11: ['centerView'], // R3
  12: ['gear'], // D-up
  13: ['brakes'], // D-down
  14: ['mfdLeft'], // D-left
  15: ['mfdRight'], // D-right
};

export interface JoystickProfile {
  rollAxis: number;
  pitchAxis: number;
  yawAxis: number;
  throttleAxis: number;
  invertPitch: boolean;
  invertThrottle: boolean;
  deadzone: number;
  buttons: Record<number, ButtonAction>;
}

export const DEFAULT_JOYSTICK: JoystickProfile = {
  rollAxis: 0,
  pitchAxis: 1,
  yawAxis: 5,
  throttleAxis: 2,
  invertPitch: false,
  invertThrottle: true,
  deadzone: 0.04,
  buttons: { 0: 'interact', 1: 'airbrake', 2: 'gear', 3: 'flaps', 4: 'cameraNext', 5: 'brakes' },
};

export class InputSystem {
  readonly axes: Record<AxisAction, number> = { pitch: 0, roll: 0, yaw: 0, lookX: 0, lookY: 0 };
  /** throttle state 0..1 (dry), afterburner engaged flag */
  throttle = 0;
  afterburner = false;
  brake = 0;
  /** accumulated mouse movement this frame (pixels) */
  mouseDX = 0;
  mouseDY = 0;
  mouseX = 0;
  mouseY = 0;
  wheel = 0;
  pointerLocked = false;
  mouseButtons = 0;
  invertPitch = false;
  sensitivity = 1;
  lastDevice: 'keyboard' | 'gamepad' | 'joystick' = 'keyboard';
  joystick: JoystickProfile = { ...DEFAULT_JOYSTICK };

  private keys = new Set<string>();
  private held = new Set<ButtonAction>();
  private prevHeld = new Set<ButtonAction>();
  private pressedQueue = new Set<ButtonAction>();
  private abDetentTimer = 0;
  private lastJoyThrottle = -2;
  private gamepadIndex = -1;
  private canvas: HTMLElement;
  enabled = true;
  /** blocks flight controls while a menu or photo mode has focus */
  flightControlsEnabled = true;

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const binds = KEY_BINDINGS[e.code];
      if (binds || e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'F1' || e.code === 'F3' || e.code === 'F4') e.preventDefault();
      if (!e.repeat && binds) for (const b of binds) this.pressedQueue.add(b);
      this.keys.add(e.code);
      this.lastDevice = 'keyboard';
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('mousemove', (e) => {
      if (this.pointerLocked) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      } else if (this.mouseButtons & 2) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
      const r = canvas.getBoundingClientRect();
      this.mouseX = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.mouseY = -(((e.clientY - r.top) / r.height) * 2 - 1);
    });
    canvas.addEventListener('mousedown', (e) => {
      this.mouseButtons |= 1 << e.button;
      if (e.button === 0) this.pressedQueue.add('interact');
    });
    window.addEventListener('mouseup', (e) => {
      this.mouseButtons &= ~(1 << e.button);
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.wheel += Math.sign(e.deltaY);
    }, { passive: false });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === canvas;
    });
  }

  requestPointerLock(): void {
    if (!this.pointerLocked) {
      try {
        const p = (this.canvas as HTMLCanvasElement).requestPointerLock?.() as unknown as Promise<void> | undefined;
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {
        /* pointer lock unavailable (iframe sandbox) — cursor mode still works */
      }
    }
  }

  exitPointerLock(): void {
    if (this.pointerLocked) document.exitPointerLock();
  }

  /** Edge-triggered action (true once per press). */
  pressed(a: ButtonAction): boolean {
    return this.pressedQueue.has(a);
  }

  isHeld(a: ButtonAction): boolean {
    return this.held.has(a);
  }

  /** raw key state by KeyboardEvent.code (photo-mode camera, menus) */
  isKeyDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** Called once per frame before game systems read input. */
  update(dt: number): void {
    this.prevHeld = new Set(this.held);
    this.held.clear();
    for (const k of this.keys) {
      const b = KEY_BINDINGS[k];
      if (b) for (const a of b) this.held.add(a);
    }
    // ---- gamepads / joysticks
    let padPitch = 0, padRoll = 0, padYaw = 0, padLookX = 0, padLookY = 0;
    let padThrottleRate = 0;
    let joyActive = false;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      const dz = (v: number, d = 0.12) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));
      if (gp.mapping === 'standard') {
        padRoll = dz(gp.axes[0] ?? 0);
        padPitch = dz(gp.axes[1] ?? 0); // stick forward (negative) = nose down; pitch is + nose up
        padLookX = dz(gp.axes[2] ?? 0, 0.15);
        padLookY = dz(gp.axes[3] ?? 0, 0.15);
        const rt = gp.buttons[7]?.value ?? 0;
        const lt = gp.buttons[6]?.value ?? 0;
        padThrottleRate = rt - lt;
        gp.buttons.forEach((btn, i) => {
          if (btn.pressed) {
            const acts = PAD_BUTTONS[i];
            if (acts) for (const a of acts) this.held.add(a);
          }
        });
        if (Math.abs(padRoll) + Math.abs(padPitch) + rt + lt > 0.05) this.lastDevice = 'gamepad';
        this.gamepadIndex = gp.index;
      } else {
        // generic joystick / HOTAS
        const j = this.joystick;
        const ax = (i: number) => dz(gp.axes[i] ?? 0, j.deadzone);
        padRoll = ax(j.rollAxis);
        padPitch = ax(j.pitchAxis) * (j.invertPitch ? -1 : 1);
        padYaw = ax(j.yawAxis);
        const thrRaw = gp.axes[j.throttleAxis];
        if (thrRaw !== undefined) {
          const thr = (j.invertThrottle ? -thrRaw : thrRaw) * 0.5 + 0.5;
          if (Math.abs(thr - this.lastJoyThrottle) > 0.01) {
            this.lastJoyThrottle = thr;
            // top 8% of travel = afterburner detent
            this.throttle = clamp(thr / 0.92, 0, 1);
            this.afterburner = thr > 0.95;
          }
        }
        gp.buttons.forEach((btn, i) => {
          if (btn.pressed && j.buttons[i]) this.held.add(j.buttons[i]);
        });
        joyActive = true;
        if (Math.abs(padRoll) + Math.abs(padPitch) > 0.05) this.lastDevice = 'joystick';
      }
    }
    // edge detection for held buttons from pads
    for (const a of this.held) {
      if (!this.prevHeld.has(a) && !this.keyHeldOnly(a)) this.pressedQueue.add(a);
    }

    // ---- flight axes: keyboard with smoothed ramps, pads proportional
    const kPitch = (this.held.has('pitchUp') ? 1 : 0) - (this.held.has('pitchDown') ? 1 : 0);
    const kRoll = (this.held.has('rollRight') ? 1 : 0) - (this.held.has('rollLeft') ? 1 : 0);
    const kYaw = (this.held.has('yawRight') ? 1 : 0) - (this.held.has('yawLeft') ? 1 : 0);
    const ramp = (cur: number, target: number, up: number, down: number) => {
      const rate = Math.abs(target) > Math.abs(cur) && Math.sign(target) === Math.sign(cur || target) ? up : down;
      return approach(cur, target, rate * dt);
    };
    const fc = this.flightControlsEnabled;
    const inv = this.invertPitch ? -1 : 1;
    const pitchT = fc ? (kPitch !== 0 ? kPitch : padPitch) * inv : 0;
    const rollT = fc ? (kRoll !== 0 ? kRoll : padRoll) : 0;
    const yawT = fc ? (kYaw !== 0 ? kYaw : padYaw) : 0;
    if (kPitch !== 0 || padPitch === 0) this.axes.pitch = ramp(this.axes.pitch, pitchT, 2.2, 4.5);
    else this.axes.pitch = pitchT;
    if (kRoll !== 0 || padRoll === 0) this.axes.roll = ramp(this.axes.roll, rollT, 3.5, 6);
    else this.axes.roll = rollT;
    this.axes.yaw = kYaw !== 0 || padYaw === 0 ? ramp(this.axes.yaw, yawT, 2.5, 4) : yawT;
    // gamepad curve for precision
    if (this.lastDevice !== 'keyboard') {
      this.axes.pitch = Math.sign(this.axes.pitch) * Math.pow(Math.abs(this.axes.pitch), 1.6);
      this.axes.roll = Math.sign(this.axes.roll) * Math.pow(Math.abs(this.axes.roll), 1.5);
    }

    // ---- throttle (stateful) with afterburner detent
    if (fc) {
      let rate = 0;
      if (this.held.has('throttleUp')) rate += 0.45;
      if (this.held.has('throttleDown')) rate -= 0.55;
      rate += padThrottleRate * 0.5;
      if (rate > 0 && this.throttle >= 1) {
        this.abDetentTimer += dt;
        if (this.abDetentTimer > 0.45 && !this.afterburner) this.afterburner = true;
      } else this.abDetentTimer = 0;
      if (rate < 0 && this.afterburner) {
        this.afterburner = false;
        rate = 0;
      }
      if (!joyActive || rate !== 0) this.throttle = clamp(this.throttle + rate * dt, 0, 1);
      if (this.pressed('afterburnerToggle')) {
        if (this.afterburner) this.afterburner = false;
        else {
          this.throttle = 1;
          this.afterburner = true;
        }
      }
    }
    this.brake = damp(this.brake, this.held.has('brakes') ? 1 : 0, 10, dt);

    // ---- look axes
    this.axes.lookX = padLookX;
    this.axes.lookY = padLookY;
    if (this.wheel !== 0) {
      if (this.wheel < 0) this.pressedQueue.add('zoomIn');
      else this.pressedQueue.add('zoomOut');
    }
  }

  private keyHeldOnly(a: ButtonAction): boolean {
    // keyboard presses already queued on keydown
    for (const k of this.keys) {
      const b = KEY_BINDINGS[k];
      if (b && b.includes(a)) return true;
    }
    return false;
  }

  /** Called at the end of a frame to clear per-frame state. */
  endFrame(): void {
    this.pressedQueue.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }

  get gamepadConnected(): boolean {
    return this.gamepadIndex >= 0;
  }

  /** Rumble on supported gamepads (touchdown, stress). */
  rumble(strong: number, weak: number, ms: number): void {
    if (this.gamepadIndex < 0) return;
    const gp = navigator.getGamepads?.()[this.gamepadIndex] as (Gamepad & { vibrationActuator?: { playEffect: (t: string, p: object) => Promise<unknown> } }) | null;
    gp?.vibrationActuator?.playEffect('dual-rumble', { duration: ms, strongMagnitude: clamp(strong, 0, 1), weakMagnitude: clamp(weak, 0, 1) }).catch(() => {});
  }
}

export const KEY_HELP: [string, string][] = [
  ['W / S', 'Pitch (S = pull)'],
  ['A / D', 'Roll'],
  ['Q / E', 'Yaw / nose-wheel steering'],
  ['Shift / Ctrl', 'Throttle up / down (hold Shift at 100% for afterburner)'],
  ['Tab', 'Afterburner toggle'],
  ['G', 'Landing gear'],
  ['F', 'Flaps UP / TO / LDG'],
  ['B', 'Airbrake'],
  ['Space', 'Wheel brakes (hold)'],
  ['Z', 'Parking brake'],
  ['O', 'Quick start-up sequence'],
  ['K', 'Canopy'],
  ['L / N / J', 'Landing / nav / cockpit lights'],
  ['X', 'FCS mode ASSIST / DIRECT'],
  [', / .', 'Pitch trim (DIRECT mode)'],
  ['C, 1-6', 'Cameras'],
  ['Mouse', 'Free look (click to capture), wheel = zoom'],
  ['LMB', 'Press cockpit control under gaze / cursor'],
  ['V', 'Center view'],
  ['I', 'Look back'],
  ['[ / ]', 'Cycle left / right MFD page'],
  ['M', 'Map page on right MFD'],
  ['U', 'HUD mode'],
  ['T / Y', 'Advance time / next weather (free flight)'],
  ['P', 'Photo mode (WASD/QE move, F depth of field)'],
  ['` or F3', 'Debug overlay   F4: force vectors'],
  ['Backspace', 'Respawn'],
  ['H', 'This help'],
  ['Esc', 'Pause menu'],
];
