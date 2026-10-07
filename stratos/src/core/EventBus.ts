// Typed publish/subscribe bus. Systems never hold references to each other just
// to notify; they emit events here (switch flipped, touchdown, damage, etc.).

export interface GameEvents {
  'switch': { id: string; kind: 'toggle' | 'button' | 'rotary' | 'lever' | 'guard'; value: number };
  'gear:transit': { down: boolean };
  'gear:locked': { down: boolean };
  'flaps:move': { target: number };
  'airbrake:move': { open: boolean };
  'canopy:move': { open: boolean };
  'canopy:locked': { open: boolean };
  'touchdown': { wheel: 'nose' | 'left' | 'right'; verticalSpeed: number; groundSpeed: number };
  'landed': { verticalSpeed: number; distanceFromAim: number; centerlineOffset: number; groundSpeed: number };
  'takeoff': { speed: number };
  'damage': { component: string; amount: number; health: number };
  'crash': { speed: number; reason: string };
  'engine:state': { state: string };
  'afterburner': { on: boolean };
  'warning': { id: string; active: boolean };
  'sonicboom': { position: [number, number, number] };
  'mach': { supersonic: boolean };
  'lightning': { position: [number, number, number]; distance: number };
  'weather:change': { state: string };
  'checkpoint': { index: number; total: number; error: number };
  'objective': { id: string; text: string; index: number };
  'mission:complete': { score: number };
  'camera:mode': { mode: string };
  'message': { text: string; duration?: number; kind?: 'info' | 'warn' | 'good' };
  'scrape': { intensity: number };
  'stress': { g: number };
  'respawn': {};
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof GameEvents, Set<Handler<any>>>();

  on<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of set) fn(payload);
  }
}

export const events = new EventBus();
