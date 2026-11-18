/**
 * EventWatch against a scripted router: each test decides exactly which SUBSCRIBE,
 * renewal and NOTIFY happen and when, on a ManualClock.
 */

import assert from "assert/strict";
import { describe, it } from "node:test";
import { ManualClock } from "@/fluxport-controller/consensus/clock";
import { EventWatch, EventWatchState } from "@/fluxport-controller/upnp/eventWatch";
import { RouterEvent, RouterEvents, Subscription } from "@/fluxport-controller/upnp/routerEvents";
import { settle } from "./coordinatorHarness";

/** A router whose every answer the test scripts. */
class ScriptedRouter implements RouterEvents {
  onEvent: ((e: RouterEvent) => void) | null = null;
  subscribes = 0;
  renews = 0;
  unsubscribed: string[] = [];
  /** What the next SUBSCRIBE does; `sid` resolves with that SID. */
  subscribeWith: (n: number) => Promise<Subscription> = async (n) => ({
    sid: `uuid:${n}`,
    timeoutSeconds: 1800
  });
  renewWith: (sid: string) => Promise<Subscription> = async (sid) => ({ sid, timeoutSeconds: 1800 });
  closed = false;

  async listen(onEvent: (e: RouterEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }
  subscribe(): Promise<Subscription> {
    this.subscribes += 1;
    return this.subscribeWith(this.subscribes);
  }
  renew(sid: string): Promise<Subscription> {
    this.renews += 1;
    return this.renewWith(sid);
  }
  async unsubscribe(sid: string): Promise<void> {
    this.unsubscribed.push(sid);
  }
  close(): void {
    this.closed = true;
  }
  notify(sid: string, seq: number): void {
    this.onEvent?.({ sid, seq, entries: null });
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
async function harness(opts: { notifyOnWrite?: boolean } = {}): Promise<Harness> {
  const clock = new ManualClock();
  const router = new ScriptedRouter();
  const h: Harness = { clock, router, watch: null!, states: [], changes: 0, adds: 0, removes: 0 };
  let seq = 0;
  const sidNow = (): string => `uuid:${router.subscribes}`;
  const notifyOnWrite = opts.notifyOnWrite ?? true;
  h.watch = new EventWatch({
    events: router,
    clock,
    addTestMapping: async () => {
      h.adds += 1;
      if (notifyOnWrite) router.notify(sidNow(), ++seq);
      return true;
    },
    removeTestMapping: async () => {
      h.removes += 1;
      if (notifyOnWrite) router.notify(sidNow(), ++seq);
      return true;
    },
    onChange: () => {
      h.changes += 1;
    },
    onStateChange: (state, reason) => h.states.push({ state, reason })
  });
  await h.watch.start();
  return h;
}

async function advance(clock: ManualClock, ms: number, step = 250): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    clock.advance(step);
    await settle();
  }
}

/** Subscriptions whose initial NOTIFY arrives before the SUBSCRIBE is answered. */
function initialFirst(router: ScriptedRouter): void {
  router.subscribeWith = async (n) => {
    router.notify(`uuid:${n}`, 0);
    return { sid: `uuid:${n}`, timeoutSeconds: 1800 };
  };
}

describe("EventWatch", () => {
  it("trusts a router that answers the subscription and both changes", async () => {
    const h = await harness();
    initialFirst(h.router);
    h.watch.engage();
    await advance(h.clock, 1000);
    assert.equal(h.watch.state, "trusted");
    assert.equal(h.adds, 1);
    assert.equal(h.removes, 1);
    assert.equal(h.changes, 1, "trusting asks for one read of the table");
  });

  it("counts an initial NOTIFY that arrives before the SUBSCRIBE is answered", async () => {
    const h = await harness();
    initialFirst(h.router);
    h.watch.engage();
    await advance(h.clock, 1000);
    assert.equal(h.watch.state, "trusted");
  });

  it("ignores a NOTIFY for another subscription", async () => {
    const h = await harness({ notifyOnWrite: false });
    h.router.subscribeWith = async (n) => {
      h.router.notify("uuid:someone-else", 0);
      return { sid: `uuid:${n}`, timeoutSeconds: 1800 };
    };
    h.watch.engage();
    await advance(h.clock, 6000);
    assert.equal(h.watch.state, "idle");
    assert.match(h.states.at(-1)!.reason, /no event on subscribing/);
  });

  for (const [name, script, reason] of [
    ["a refused subscription", (r: ScriptedRouter) => (r.subscribeWith = async () => Promise.reject(new Error("412"))), /subscribe failed/],
    ["a subscription with no initial NOTIFY", () => {}, /no event on subscribing/]
  ] as const) {
    it(`does not trust ${name}, and unsubscribes`, async () => {
      const h = await harness();
      script(h.router);
      h.watch.engage();
      await advance(h.clock, 6000);
      assert.equal(h.watch.state, "idle");
      assert.match(h.states.at(-1)!.reason, reason);
      assert.equal(h.adds, 0, "no test mapping without a working subscription");
    });
  }

  it("does not trust a router that is silent after the initial NOTIFY, and removes the test mapping", async () => {
    const h = await harness({ notifyOnWrite: false });
    initialFirst(h.router);
    h.watch.engage();
    await advance(h.clock, 12_000);
    assert.equal(h.watch.state, "idle");
    assert.match(h.states.at(-1)!.reason, /no event for an added mapping/);
    assert.equal(h.removes, 1, "the test mapping was removed");
    assert.deepEqual(h.router.unsubscribed, ["uuid:1"]);
  });

  it("tries again an hour after a failed test, not before", async () => {
    const h = await harness({ notifyOnWrite: false });
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

  it("renews at half the granted lifetime and stays trusted", async () => {
    const h = await harness();
    initialFirst(h.router);
    h.watch.engage();
    await advance(h.clock, 1000);
    await advance(h.clock, 900_000, 10_000);
    assert.equal(h.router.renews, 1);
    assert.equal(h.watch.state, "trusted");
  });

  it("renews every 15 minutes when the router grants an infinite subscription", async () => {
    const h = await harness();
    h.router.subscribeWith = async (n) => {
      h.router.notify(`uuid:${n}`, 0);
      return { sid: `uuid:${n}`, timeoutSeconds: null };
    };
    h.watch.engage();
    await advance(h.clock, 1000);
    await advance(h.clock, 900_000, 10_000);
    assert.equal(h.router.renews, 1);
  });

  it("answers a refused renewal with a new subscription and a read of the table", async () => {
    const h = await harness();
    initialFirst(h.router);
    h.watch.engage();
    await advance(h.clock, 1000);
    const changes = h.changes;
    h.router.renewWith = async () => Promise.reject(new Error("SUBSCRIBE answered 412"));
    await advance(h.clock, 905_000, 10_000);
    assert.equal(h.watch.state, "trusted");
    assert.equal(h.router.subscribes, 2);
    assert.equal(h.changes, changes + 1, "a read of the table after resubscribing");
  });

  it("stops trusting when a refused renewal cannot be replaced", async () => {
    const h = await harness();
    initialFirst(h.router);
    h.watch.engage();
    await advance(h.clock, 1000);
    h.router.renewWith = async () => Promise.reject(new Error("412"));
    h.router.subscribeWith = async () => Promise.reject(new Error("timed out"));
    await advance(h.clock, 905_000, 10_000);
    assert.equal(h.watch.state, "idle");
    assert.match(h.states.at(-1)!.reason, /resubscribing/);
  });

  it("stops trusting when a change it made brings no NOTIFY within 10 s", async () => {
    const h = await harness();
    initialFirst(h.router);
    h.watch.engage();
    await advance(h.clock, 1000);
    h.watch.expectChange(h.watch.received);
    await advance(h.clock, 9000);
    assert.equal(h.watch.state, "trusted", "still within the 10 s");
    await advance(h.clock, 2000);
    assert.equal(h.watch.state, "idle");
    assert.match(h.states.at(-1)!.reason, /no event for a change this node made/);
  });

  it("counts a NOTIFY that arrived before the change was reported", async () => {
    const h = await harness();
    initialFirst(h.router);
    h.watch.engage();
    await advance(h.clock, 1000);
    const mark = h.watch.received;
    h.router.notify("uuid:1", 99);
    h.watch.expectChange(mark);
    await advance(h.clock, 15_000);
    assert.equal(h.watch.state, "trusted");
  });

  it("asks for a read of the table on every NOTIFY while trusted", async () => {
    const h = await harness();
    initialFirst(h.router);
    h.watch.engage();
    await advance(h.clock, 1000);
    const changes = h.changes;
    h.router.notify("uuid:1", 3);
    h.router.notify("uuid:1", 7); // a gap: still one read per NOTIFY
    assert.equal(h.changes, changes + 2);
  });

  it("drops an in-flight test when disengaged, and unsubscribes", async () => {
    const h = await harness({ notifyOnWrite: false });
    initialFirst(h.router);
    h.watch.engage();
    await advance(h.clock, 500);
    assert.equal(h.watch.state, "testing");
    h.watch.disengage();
    await advance(h.clock, 12_000);
    assert.equal(h.watch.state, "idle");
    assert.ok(h.router.unsubscribed.includes("uuid:1"));
    h.watch.engage();
    await advance(h.clock, 500);
    assert.equal(h.router.subscribes, 2, "disengaging is not a failure: no hour's wait");
  });

  it("stop() unsubscribes and closes the listener", async () => {
    const h = await harness();
    initialFirst(h.router);
    h.watch.engage();
    await advance(h.clock, 1000);
    h.watch.stop();
    assert.deepEqual(h.router.unsubscribed, ["uuid:1"]);
    assert.equal(h.router.closed, true);
    h.watch.engage();
    await advance(h.clock, 1000);
    assert.equal(h.router.subscribes, 1, "a stopped watch does not engage");
  });

  it("never engages when the listener cannot start", async () => {
    const clock = new ManualClock();
    const router = new ScriptedRouter();
    router.listen = async () => Promise.reject(new Error("EADDRINUSE"));
    const watch = new EventWatch({
      events: router,
      clock,
      addTestMapping: async () => true,
      removeTestMapping: async () => true,
      onChange: () => {}
    });
    await assert.rejects(watch.start());
    watch.engage();
    await advance(clock, 1000);
    assert.equal(router.subscribes, 0);
  });
});
