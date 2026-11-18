/**
 * EventWatch against a scripted router: each test decides exactly which SUBSCRIBE, NOTIFY
 * and lost subscription happen and when, on a ManualClock.
 */

import assert from "assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { ManualClock } from "@/fluxport-controller/consensus/clock";
import { EventWatch, EventWatchState } from "@/fluxport-controller/upnp/eventWatch";
import { RouterEvents, RouterSubscription } from "@/fluxport-controller/upnp/routerEvents";
import { settle } from "./coordinatorHarness";

/** A subscription as nat-upnp's behaves: nothing is emitted once it has ended. */
class ScriptedSubscription extends EventEmitter implements RouterSubscription {
  /** subscribe() resolved with it. */
  handedOut = false;
  ended = false;
  closed = false;

  constructor(readonly n: number) {
    super();
  }

  notify(): void {
    if (!this.ended) this.emit("event");
  }

  lose(reason: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.emit("lost", reason);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.ended = true;
  }
}

/** A router whose every answer the test scripts. */
class ScriptedRouter implements RouterEvents {
  subs: ScriptedSubscription[] = [];
  /** What the next SUBSCRIBE does; by default it subscribes, and the initial NOTIFY follows
   *  on a later tick, as nat-upnp delivers it. */
  subscribeWith: (sub: ScriptedSubscription) => Promise<ScriptedSubscription> = async (sub) => {
    setImmediate(() => sub.notify());
    return sub;
  };

  get subscribes(): number {
    return this.subs.length;
  }

  get current(): ScriptedSubscription {
    return this.subs.at(-1)!;
  }

  subscribe(): Promise<RouterSubscription> {
    const sub = new ScriptedSubscription(this.subs.length + 1);
    this.subs.push(sub);
    return this.subscribeWith(sub).then((s) => {
      s.handedOut = true;
      return s;
    });
  }

  /** Subscriptions subscribe() resolved with that have not ended. */
  get open(): number {
    return this.subs.filter((s) => s.handedOut && !s.ended).length;
  }
}

interface Harness {
  clock: ManualClock;
  router: ScriptedRouter;
  watch: EventWatch;
  states: Array<{ state: EventWatchState; reason: string }>;
  changes: number;
  adds: number;
  removes: number;
}

/**
 * A watch whose test mapping succeeds, and whose router (by default) answers every change
 * with a NOTIFY on the current subscription.
 */
function harness(opts: { notifyOnWrite?: boolean } = {}): Harness {
  const clock = new ManualClock();
  const router = new ScriptedRouter();
  const h: Harness = { clock, router, watch: null!, states: [], changes: 0, adds: 0, removes: 0 };
  const notifyOnWrite = opts.notifyOnWrite ?? true;
  h.watch = new EventWatch({
    events: router,
    clock,
    addTestMapping: async () => {
      h.adds += 1;
      if (notifyOnWrite) router.current.notify();
      return true;
    },
    removeTestMapping: async () => {
      h.removes += 1;
      if (notifyOnWrite) router.current.notify();
      return true;
    },
    onChange: () => {
      h.changes += 1;
    },
    onStateChange: (state, reason) => h.states.push({ state, reason })
  });
  return h;
}

async function advance(clock: ManualClock, ms: number, step = 250): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    clock.advance(step);
    await settle();
  }
}

async function trusted(): Promise<Harness> {
  const h = harness();
  h.watch.engage();
  await advance(h.clock, 1000);
  assert.equal(h.watch.state, "trusted");
  return h;
}

describe("EventWatch", () => {
  it("trusts a router that answers the subscription and both changes", async () => {
    const h = await trusted();
    assert.equal(h.adds, 1);
    assert.equal(h.removes, 1);
    assert.equal(h.changes, 1, "trusting asks for one read of the table");
  });

  for (const [name, script, reason] of [
    ["a refused subscription", (r: ScriptedRouter) => (r.subscribeWith = async () => Promise.reject(new Error("412"))), /subscribe failed: Error: 412/],
    ["a subscription with no initial NOTIFY", (r: ScriptedRouter) => (r.subscribeWith = async (sub) => sub), /no event on subscribing/]
  ] as const) {
    it(`does not trust ${name}`, async () => {
      const h = harness();
      script(h.router);
      h.watch.engage();
      await advance(h.clock, 6000);
      assert.equal(h.watch.state, "idle");
      assert.match(h.states.at(-1)!.reason, reason);
      assert.equal(h.adds, 0, "no test mapping without a working subscription");
      assert.equal(h.router.open, 0, "no subscription left open");
    });
  }

  it("does not trust a router that is silent after the initial NOTIFY, removes the test mapping, and closes the subscription", async () => {
    const h = harness({ notifyOnWrite: false });
    h.watch.engage();
    await advance(h.clock, 12_000);
    assert.equal(h.watch.state, "idle");
    assert.match(h.states.at(-1)!.reason, /no event for an added mapping/);
    assert.equal(h.removes, 1, "the test mapping was removed");
    assert.equal(h.router.current.closed, true);
  });

  it("tries again an hour after a failed test, not before", async () => {
    const h = harness({ notifyOnWrite: false });
    h.router.subscribeWith = async (sub) => sub;
    h.watch.engage();
    await advance(h.clock, 6000);
    assert.equal(h.watch.state, "idle");
    h.watch.engage();
    await advance(h.clock, 1000);
    assert.equal(h.router.subscribes, 1, "no retry within the hour");
    await advance(h.clock, 3_600_000, 60_000);
    h.watch.engage();
    await advance(h.clock, 1000);
    assert.equal(h.router.subscribes, 2, "retried after the hour");
  });

  it("answers a lost subscription with a new one and a read of the table", async () => {
    const h = await trusted();
    const changes = h.changes;
    h.router.current.lose(new Error("SUBSCRIBE answered 412"));
    await advance(h.clock, 1000);
    assert.equal(h.watch.state, "trusted");
    assert.equal(h.router.subscribes, 2);
    assert.equal(h.changes, changes + 1, "a read of the table after resubscribing");
    h.router.current.notify();
    assert.equal(h.changes, changes + 2, "the new subscription's NOTIFYs are heard");
  });

  for (const [name, script] of [
    ["is refused", (r: ScriptedRouter) => (r.subscribeWith = async () => Promise.reject(new Error("timed out")))],
    ["brings no initial NOTIFY", (r: ScriptedRouter) => (r.subscribeWith = async (sub) => sub)]
  ] as const) {
    it(`stops trusting when the subscription replacing a lost one ${name}`, async () => {
      const h = await trusted();
      script(h.router);
      h.router.current.lose(new Error("SUBSCRIBE answered 412"));
      await advance(h.clock, 6000);
      assert.equal(h.watch.state, "idle");
      assert.match(h.states.at(-1)!.reason, /^resubscribing: /);
      assert.equal(h.router.open, 0, "no subscription left open");
    });
  }

  it("fails the test when the subscription is lost during it", async () => {
    const h = harness({ notifyOnWrite: false });
    h.watch.engage();
    await advance(h.clock, 500);
    assert.equal(h.watch.state, "testing");
    h.router.current.lose(new Error("listener: EMFILE"));
    await advance(h.clock, 500);
    assert.equal(h.watch.state, "idle");
    assert.equal(h.states.at(-1)!.reason, "the subscription was lost: listener: EMFILE");
    assert.equal(h.router.subscribes, 1, "not replaced while untrusted");
  });

  it("stops trusting when a change it made brings no NOTIFY within 10 s", async () => {
    const h = await trusted();
    h.watch.expectChange(h.watch.received);
    await advance(h.clock, 9000);
    assert.equal(h.watch.state, "trusted", "still within the 10 s");
    await advance(h.clock, 2000);
    assert.equal(h.watch.state, "idle");
    assert.match(h.states.at(-1)!.reason, /no event for a change this node made/);
    assert.equal(h.router.current.closed, true);
  });

  it("counts a NOTIFY that arrived before the change was reported", async () => {
    const h = await trusted();
    const mark = h.watch.received;
    h.router.current.notify();
    h.watch.expectChange(mark);
    await advance(h.clock, 15_000);
    assert.equal(h.watch.state, "trusted");
  });

  it("asks for a read of the table on every NOTIFY while trusted", async () => {
    const h = await trusted();
    const changes = h.changes;
    h.router.current.notify();
    h.router.current.notify();
    assert.equal(h.changes, changes + 2);
  });

  it("drops an in-flight test when disengaged, and closes the subscription", async () => {
    const h = harness({ notifyOnWrite: false });
    h.watch.engage();
    await advance(h.clock, 500);
    assert.equal(h.watch.state, "testing");
    h.watch.disengage();
    await advance(h.clock, 12_000);
    assert.equal(h.watch.state, "idle");
    assert.equal(h.router.subs[0].closed, true);
    h.watch.engage();
    await advance(h.clock, 500);
    assert.equal(h.router.subscribes, 2, "disengaging is not a failure: no hour's wait");
  });

  it("closes a subscription that is answered after the watch let it go", async () => {
    const h = harness();
    let answer: (() => void) | null = null;
    h.router.subscribeWith = (sub) => new Promise((resolve) => (answer = () => resolve(sub)));
    h.watch.engage();
    await settle();
    h.watch.disengage();
    answer!();
    await settle();
    assert.equal(h.router.subs[0].closed, true);
    assert.equal(h.watch.state, "idle");
  });

  it("stop() closes the subscription", async () => {
    const h = await trusted();
    h.watch.stop();
    assert.equal(h.router.current.closed, true);
  });

  it("a stopped watch never engages", async () => {
    const h = harness();
    h.watch.stop();
    h.watch.engage();
    await advance(h.clock, 1000);
    assert.equal(h.router.subscribes, 0);
    assert.equal(h.watch.state, "idle");
  });
});
