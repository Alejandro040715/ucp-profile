// Priority job queue over a pool of terrain workers. Falls back to time-sliced
// main-thread generation when module workers are not available (e.g. strict
// sandboxes), so the world always streams in.

import { generateChunk, generateMap, generateVegetation, type ChunkRequest, type ChunkResult, type MapRequest, type MapResult, type VegRequest, type VegResult } from './TerrainGen.ts';

type Req = ChunkRequest | VegRequest | MapRequest;
export type JobRequest = Omit<ChunkRequest, 'id'> | Omit<VegRequest, 'id'> | Omit<MapRequest, 'id'>;
type Res = ChunkResult | VegResult | MapResult;

interface Job {
  req: Req;
  priority: number; // lower = sooner
  resolve: (r: Res) => void;
  cancelled: boolean;
}

export class WorkerPool {
  private workers: Worker[] = [];
  private busy: (Job | null)[] = [];
  private queue: Job[] = [];
  private nextId = 1;
  private useFallback = false;
  inFlight = 0;

  constructor(count: number) {
    try {
      for (let i = 0; i < count; i++) {
        const w = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' });
        const idx = i;
        w.onmessage = (e: MessageEvent<Res>) => this.onResult(idx, e.data);
        w.onerror = (ev) => {
          console.warn('Terrain worker failed, falling back to main thread', ev.message);
          this.useFallback = true;
        };
        this.workers.push(w);
        this.busy.push(null);
      }
    } catch (err) {
      console.warn('Workers unavailable, using main-thread generation', err);
      this.useFallback = true;
    }
  }

  get pending(): number {
    return this.queue.length + this.inFlight;
  }

  request<T extends Res>(req: JobRequest, priority: number): { promise: Promise<T>; cancel: () => void; setPriority: (p: number) => void } {
    const full = { ...req, id: this.nextId++ } as Req;
    let job!: Job;
    const promise = new Promise<T>((resolve) => {
      job = { req: full, priority, resolve: resolve as (r: Res) => void, cancelled: false };
    });
    this.queue.push(job);
    return { promise, cancel: () => (job.cancelled = true), setPriority: (p: number) => (job.priority = p) };
  }

  /** Re-prioritise and dispatch; call once per frame. */
  pump(budgetMs = 4): void {
    this.queue = this.queue.filter((j) => !j.cancelled);
    if (!this.queue.length) return;
    this.queue.sort((a, b) => a.priority - b.priority);
    if (this.useFallback || this.workers.length === 0) {
      const t0 = performance.now();
      while (this.queue.length && performance.now() - t0 < budgetMs) {
        const job = this.queue.shift()!;
        job.resolve(this.runLocal(job.req));
      }
      return;
    }
    for (let i = 0; i < this.workers.length; i++) {
      if (this.busy[i] || !this.queue.length) continue;
      const job = this.queue.shift()!;
      this.busy[i] = job;
      this.inFlight++;
      this.workers[i].postMessage(job.req);
    }
  }

  private runLocal(req: Req): Res {
    if (req.type === 'chunk') return generateChunk(req);
    if (req.type === 'veg') return generateVegetation(req);
    return generateMap(req);
  }

  private onResult(idx: number, res: Res): void {
    const job = this.busy[idx];
    this.busy[idx] = null;
    this.inFlight--;
    if (job && !job.cancelled) job.resolve(res);
    this.pump(0);
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
  }
}
