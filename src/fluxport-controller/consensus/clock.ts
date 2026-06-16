/**
 * Time seam. The protocol's timers (token loss, retransmit, pacing) go through a
 * `Clock` so tests can drive virtual time deterministically with `ManualClock`
 * instead of waiting on the wall clock.
 */

export type TimerId = number;

export interface Clock {
  /** Monotonic milliseconds. */
  now(): number;
  setTimer(ms: number, cb: () => void): TimerId;
  clearTimer(id: TimerId): void;
}

/** Production clock backed by setTimeout and a monotonic time source. */
export class SystemClock implements Clock {
  private readonly timers = new Map<TimerId, NodeJS.Timeout>();
  private nextId = 1;

  now(): number {
    return performance.now();
  }

  setTimer(ms: number, cb: () => void): TimerId {
    const id = this.nextId++;
    const handle = setTimeout(() => {
      this.timers.delete(id);
      cb();
    }, ms);
    this.timers.set(id, handle);
    return id;
  }

  clearTimer(id: TimerId): void {
    const handle = this.timers.get(id);
    if (handle) {
      clearTimeout(handle);
      this.timers.delete(id);
    }
  }
}

/** Deterministic test clock: timers fire only when `advance` crosses their deadline. */
export class ManualClock implements Clock {
  private t = 0;
  private readonly timers = new Map<TimerId, { at: number; cb: () => void }>();
  private nextId = 1;

  now(): number {
    return this.t;
  }

  setTimer(ms: number, cb: () => void): TimerId {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + Math.max(0, ms), cb });
    return id;
  }

  clearTimer(id: TimerId): void {
    this.timers.delete(id);
  }

  /** How many timers are currently scheduled (for assertions). */
  get pending(): number {
    return this.timers.size;
  }

  /**
   * Advance virtual time by `ms`, firing every due timer in chronological order.
   * Timers scheduled by callbacks within the window also fire if they fall due,
   * so a self-rescheduling timer (e.g. token rotation) progresses naturally.
   */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let dueId: TimerId | null = null;
      let dueAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueAt = timer.at;
          dueId = id;
        }
      }
      if (dueId === null) break;
      const timer = this.timers.get(dueId)!;
      this.timers.delete(dueId);
      this.t = timer.at;
      timer.cb();
    }
    this.t = target;
  }
}
