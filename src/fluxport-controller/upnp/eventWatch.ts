/**
 * Whether this node can rely on the router's events. Routers that advertise eventing
 * still fail to deliver it in several ways (no SID, NOTIFYs dropped by the node's
 * firewall, a NOTIFY on subscribing and none after), so events are trusted only after a
 * test on this router and this node: a subscription with a SID, the NOTIFY it starts
 * with, and a NOTIFY each for a mapping added and removed on the test port. While
 * trusted, every NOTIFY means "read the table" (`onChange`). Trust ends, until a retest
 * an hour later, when a lost subscription cannot be replaced, when a change this node
 * made brings no NOTIFY within 10 s, or when the caller finds the table changed without
 * one (`distrust`).
 */

import { Clock, TimerId } from "../consensus/clock";
import { RouterEvent, RouterEvents, Subscription } from "./routerEvents";

export type EventWatchState = "idle" | "testing" | "trusted";

const INITIAL_WAIT_MS = 5_000;
const CHANGE_WAIT_MS = 5_000;
const CANARY_MS = 10_000;
const RETRY_MS = 3_600_000;
const RENEW_FRACTION = 0.5;
const MIN_RENEW_MS = 30_000;
/** Renewed as if granted this when the router grants "infinite": a reboot forgets it anyway. */
const INFINITE_RENEW_SECONDS = 1800;

export interface EventWatchDeps {
  events: RouterEvents;
  clock: Clock;
  /** Map the test port: true once mapped; false when the router refused; null when the
   *  test could not go ahead (no rate budget, no answer). */
  addTestMapping(): Promise<boolean | null>;
  removeTestMapping(): Promise<boolean | null>;
  /** The router's table changed, or may have. */
  onChange(): void;
  onStateChange?(state: EventWatchState, reason: string): void;
}

export class EventWatch {
  private readonly events: RouterEvents;
  private readonly clock: Clock;
  private readonly deps: EventWatchDeps;
  private current: EventWatchState = "idle";
  private listening = false;
  private sub: Subscription | null = null;
  // NOTIFYs that arrive while a SUBSCRIBE is in flight carry a SID not known yet.
  private subscribing = false;
  private early: RouterEvent[] = [];
  // Bumped whenever the subscription is dropped, so an in-flight test or renewal stops.
  private generation = 0;
  private notBefore = 0;
  private renewTimer: TimerId | null = null;
  private canaryTimer: TimerId | null = null;
  private canaryMark = 0;
  private waiters: Array<{ mark: number; resolve: (ok: boolean) => void; timer: TimerId }> = [];
  private count = 0;

  constructor(deps: EventWatchDeps) {
    this.events = deps.events;
    this.clock = deps.clock;
    this.deps = deps;
  }

  get state(): EventWatchState {
    return this.current;
  }

  get trusted(): boolean {
    return this.current === "trusted";
  }

  /** NOTIFYs received for this node's subscriptions so far. */
  get received(): number {
    return this.count;
  }

  /** Start the listener. Rejects when it cannot listen; the watch then never engages. */
  async start(): Promise<void> {
    await this.events.listen((e) => this.onEvent(e));
    this.listening = true;
  }

  stop(): void {
    this.drop();
    this.listening = false;
    this.events.close();
  }

  /** This node is the one to watch the router. */
  engage(): void {
    if (!this.listening || this.current !== "idle" || this.clock.now() < this.notBefore) return;
    void this.test();
  }

  /** This node is no longer the one to watch the router. */
  disengage(): void {
    if (this.current === "idle") return;
    this.drop();
    this.setState("idle", "no longer watching the router");
  }

  distrust(reason: string): void {
    if (this.current !== "trusted") return;
    this.fail(reason);
  }

  /**
   * This node changed the table's size: a NOTIFY must follow. `mark` is `received`
   * taken before the change, so a NOTIFY that arrived before this call counts.
   */
  expectChange(mark: number): void {
    if (this.current !== "trusted" || this.count > mark || this.canaryTimer != null) return;
    this.canaryMark = mark;
    this.canaryTimer = this.clock.setTimer(CANARY_MS, () => {
      this.canaryTimer = null;
      if (this.count <= this.canaryMark) this.fail("no event for a change this node made");
    });
  }

  private async test(): Promise<void> {
    const gen = ++this.generation;
    this.setState("testing", "testing the router's events");
    const ok = await this.subscribeAndHear(gen);
    if (gen !== this.generation) return;
    if (!ok.heard) return this.fail(ok.reason);

    const mark = this.count;
    const added = await this.deps.addTestMapping();
    if (gen !== this.generation) return;
    if (added !== true) {
      return this.fail(added === false ? "the router refused the test mapping" : "the test could not run");
    }
    const heardAdd = await this.eventAfter(mark, CHANGE_WAIT_MS);
    if (gen !== this.generation) return;
    const removeMark = this.count;
    const removed = await this.deps.removeTestMapping();
    if (gen !== this.generation) return;
    if (!heardAdd) return this.fail("no event for an added mapping");
    if (removed !== true) return this.fail("the test mapping could not be removed");
    if (!(await this.eventAfter(removeMark, CHANGE_WAIT_MS))) {
      if (gen === this.generation) this.fail("no event for a removed mapping");
      return;
    }
    if (gen !== this.generation) return;
    this.armRenew();
    this.setState("trusted", "the router's events passed the test");
    this.deps.onChange();
  }

  private async subscribeAndHear(gen: number): Promise<{ heard: boolean; reason: string }> {
    const mark = this.count;
    this.sub = null; // a NOTIFY arriving before the answer belongs to the new subscription
    this.subscribing = true;
    this.early = [];
    try {
      this.sub = await this.events.subscribe();
    } catch (err) {
      return { heard: false, reason: `subscribe failed: ${String(err)}` };
    } finally {
      this.subscribing = false;
    }
    const early = this.early;
    this.early = [];
    if (gen !== this.generation) return { heard: false, reason: "dropped" };
    for (const e of early) this.onEvent(e);
    const heard = await this.eventAfter(mark, INITIAL_WAIT_MS);
    return { heard, reason: "no event on subscribing" };
  }

  private armRenew(): void {
    if (this.renewTimer != null) this.clock.clearTimer(this.renewTimer);
    const lifetime = this.sub?.timeoutSeconds ?? INFINITE_RENEW_SECONDS;
    const ms = Math.max(MIN_RENEW_MS, lifetime * 1000 * RENEW_FRACTION);
    this.renewTimer = this.clock.setTimer(ms, () => {
      this.renewTimer = null;
      void this.renew();
    });
  }

  private async renew(): Promise<void> {
    const gen = this.generation;
    const sid = this.sub?.sid;
    if (!sid || this.current !== "trusted") return;
    try {
      const renewed = await this.events.renew(sid);
      if (gen !== this.generation) return;
      this.sub = { sid, timeoutSeconds: renewed.timeoutSeconds };
      this.armRenew();
      return;
    } catch {
      // The router forgot the subscription (a reboot): its table may have changed too,
      // and the new subscription's initial NOTIFY asks for a read.
    }
    if (gen !== this.generation) return;
    const ok = await this.subscribeAndHear(gen);
    if (gen !== this.generation) return;
    if (!ok.heard) return this.fail(`resubscribing: ${ok.reason}`);
    this.armRenew();
  }

  private onEvent(e: RouterEvent): void {
    if (this.subscribing && this.sub === null) {
      this.early.push(e);
      return;
    }
    if (this.sub === null || e.sid !== this.sub.sid) return;
    this.count += 1;
    for (const w of this.waiters.filter((w) => this.count > w.mark)) {
      this.clock.clearTimer(w.timer);
      w.resolve(true);
    }
    this.waiters = this.waiters.filter((w) => this.count <= w.mark);
    if (this.current === "trusted") this.deps.onChange();
  }

  /** Resolves true once a NOTIFY beyond `mark` has arrived, false after `ms` without one. */
  private eventAfter(mark: number, ms: number): Promise<boolean> {
    if (this.count > mark) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = {
        mark,
        resolve,
        timer: this.clock.setTimer(ms, () => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve(false);
        })
      };
      this.waiters.push(waiter);
    });
  }

  private fail(reason: string): void {
    this.drop();
    this.notBefore = this.clock.now() + RETRY_MS;
    this.setState("idle", reason);
  }

  /** In-flight work sees the new generation and stops. */
  private drop(): void {
    this.generation += 1;
    if (this.renewTimer != null) this.clock.clearTimer(this.renewTimer);
    if (this.canaryTimer != null) this.clock.clearTimer(this.canaryTimer);
    this.renewTimer = null;
    this.canaryTimer = null;
    for (const w of this.waiters) {
      this.clock.clearTimer(w.timer);
      w.resolve(false);
    }
    this.waiters = [];
    const sid = this.sub?.sid;
    this.sub = null;
    if (sid) this.events.unsubscribe(sid).catch(() => {});
  }

  private setState(state: EventWatchState, reason: string): void {
    this.current = state;
    this.deps.onStateChange?.(state, reason);
  }
}
