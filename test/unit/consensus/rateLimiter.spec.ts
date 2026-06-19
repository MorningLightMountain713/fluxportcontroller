/**
 * Generic distributed token-bucket RateLimiter (local-bucket model). These drive it
 * directly over in-memory buses that stand in for a group's broadcast: each node
 * holds its own bucket on a shared ManualClock, debits its own action at acquire,
 * and folds peers' consumes on delivery. An `immediate` bus delivers a broadcast to
 * every node at once, a `buffered` bus defers delivery (to exercise concurrency /
 * debt), and a `dropping` bus loses broadcasts entirely (to prove leak-freeness with
 * NO onViewChange — the property the local-bucket model buys).
 */

import assert from "assert/strict";
import { describe, it } from "node:test";
import { ManualClock } from "@/fluxport-controller/consensus/clock";
import { RateLimiter } from "@/fluxport-controller/consensus/rateLimiter";

function immediateBus(clock: ManualClock) {
  const limiters: RateLimiter[] = [];
  const add = (self: string, rate: number, capacity: number, tokens?: number) => {
    const rl = new RateLimiter({
      self,
      clock,
      rate,
      capacity,
      tokens,
      broadcast: (p) => {
        for (const x of limiters) x.onDeliver(p);
      }
    });
    limiters.push(rl);
    return rl;
  };
  return { add };
}

function bufferedBus(clock: ManualClock) {
  const limiters: RateLimiter[] = [];
  const queue: unknown[] = [];
  const add = (self: string, rate: number, capacity: number, tokens?: number) => {
    const rl = new RateLimiter({
      self,
      clock,
      rate,
      capacity,
      tokens,
      broadcast: (p) => queue.push(p)
    });
    limiters.push(rl);
    return rl;
  };
  const flush = () => {
    while (queue.length) {
      const p = queue.shift();
      for (const x of limiters) x.onDeliver(p);
    }
  };
  return { add, flush };
}

/** A bus that loses every broadcast — models a totally-dropped consume (view change). */
function droppingBus(clock: ManualClock) {
  const limiters: RateLimiter[] = [];
  const add = (self: string, rate: number, capacity: number, tokens?: number) => {
    const rl = new RateLimiter({
      self,
      clock,
      rate,
      capacity,
      tokens,
      broadcast: () => {} // dropped: never delivered to anyone
    });
    limiters.push(rl);
    return rl;
  };
  return { add };
}

describe("RateLimiter", () => {
  it("enforces a group-wide cap: total permits across nodes = capacity", () => {
    const clock = new ManualClock();
    const bus = immediateBus(clock);
    const a = bus.add("a", 0, 3); // no refill, burst of 3 shared across the group
    const b = bus.add("b", 0, 3);
    const c = bus.add("c", 0, 3);

    let ok = 0;
    for (const rl of [a, b, c, a, b, c]) if (rl.acquire()) ok += 1;
    assert.equal(ok, 3, "exactly `capacity` permits granted across the whole group");
    assert.equal(a.acquire(), false, "group budget exhausted");
    assert.ok(b.available < 1, "every node sees the shared bucket empty");
  });

  it("refills at the configured rate over time", () => {
    const clock = new ManualClock();
    const a = immediateBus(clock).add("a", 2, 2); // 2 tokens/sec, burst 2

    assert.ok(a.acquire() && a.acquire(), "drains the initial burst");
    assert.equal(a.acquire(), false, "empty");

    clock.advance(1000); // +2 tokens
    assert.ok(a.acquire(), "refilled after 1s");
    assert.ok(a.acquire(), "two tokens were refilled");
    assert.equal(a.acquire(), false, "and empty again");
  });

  it("propagates a back-off (setRate) to the whole group", () => {
    const clock = new ManualClock();
    const bus = immediateBus(clock);
    const a = bus.add("a", 100, 5);
    const b = bus.add("b", 100, 5);

    a.setRate(0, 0); // a (acting as the leader) backs the segment off to nothing
    assert.equal(b.currentRate, 0, "b applied the new rate");
    assert.equal(b.currentCapacity, 0);
    assert.equal(b.acquire(), false, "no permits under a zero budget");
  });

  it("caps a flood: while(acquire()) stops at capacity (own debit applied immediately)", () => {
    const clock = new ManualClock();
    const a = immediateBus(clock).add("a", 0, 5);

    let grants = 0;
    while (a.acquire()) grants += 1; // a tight loop, no delivery gap relied upon
    assert.equal(grants, 5, "a single node cannot over-issue past capacity in one instant");
  });

  it("re-converges to an identical level after delivery (asymmetric spend)", () => {
    const clock = new ManualClock();
    const bus = bufferedBus(clock);
    const a = bus.add("a", 0, 10);
    const b = bus.add("b", 0, 10);
    const c = bus.add("c", 0, 10);

    a.acquire();
    a.acquire();
    a.acquire(); // a spends 3
    b.acquire(); // b spends 1, c spends 0
    // during the in-flight gap the local buckets diverge (own-applied-early)
    assert.notEqual(a.available, c.available, "buckets diverge before delivery");

    bus.flush(); // every consume folded by everyone
    assert.equal(a.available, b.available, "a and b re-converge");
    assert.equal(b.available, c.available, "b and c re-converge");
    assert.equal(c.available, 6, "all settle to capacity minus the 4 group consumes");
  });

  it("repays optimistic over-issue as debt (a transient concurrent burst self-corrects)", () => {
    const clock = new ManualClock();
    const bus = bufferedBus(clock);
    const a = bus.add("a", 1, 1); // 1 token/sec, burst 1
    const b = bus.add("b", 1, 1);

    // concurrent: both grab the single permit before either consume is delivered
    assert.equal(a.acquire(), true);
    assert.equal(b.acquire(), true); // optimistic over-issue: 2 on a 1-burst bucket
    bus.flush(); // each folds the other's consume -> tokens -1 (debt, floored at -capacity)

    clock.advance(1000);
    assert.equal(a.acquire(), false, "still repaying the over-issue at +1s (debt -1 -> 0)");
    clock.advance(1000);
    assert.equal(a.acquire(), true, "permit granted only after the debt is repaid (+2s)");
  });

  it("is leak-free with NO onViewChange: dropped broadcasts never starve a node", () => {
    const clock = new ManualClock();
    const a = droppingBus(clock).add("a", 1, 4); // EVERY consume it broadcasts is lost

    let grants = 0;
    while (a.acquire()) grants += 1; // drains the burst; all broadcasts dropped
    assert.equal(grants, 4, "self-paces on its own bucket: the burst, charged locally");

    // despite every own consume being dropped (the Model-A leak scenario), the node
    // keeps earning ~rate permits forever with NO onViewChange and never goes stingy
    for (let i = 0; i < 5; i += 1) {
      clock.advance(1000);
      assert.equal(a.acquire(), true, `still live after a dropped consume, cycle ${i}`);
    }
  });

  it("clamps negative rate/capacity to zero", () => {
    const clock = new ManualClock();
    const a = immediateBus(clock).add("a", 5, 5);
    a.setRate(-10, -3); // nonsense back-off
    assert.equal(a.currentRate, 0, "negative rate clamped to 0");
    assert.equal(a.currentCapacity, 0, "negative capacity clamped to 0");
    assert.equal(a.acquire(), false, "no permits, no negative-capacity corruption");

    const b = new RateLimiter({ self: "b", clock, rate: -1, capacity: -1, broadcast: () => {} });
    assert.equal(b.currentRate, 0, "constructor clamps a negative rate");
    assert.equal(b.currentCapacity, 0, "constructor clamps a negative capacity");
  });

  it("identifies its own payloads and ignores foreign ones", () => {
    assert.equal(RateLimiter.owns({ type: "RATE_CONSUME", by: "x" }), true);
    assert.equal(RateLimiter.owns({ type: "RATE_SET", rate: 1, capacity: 1 }), true);
    assert.equal(RateLimiter.owns({ type: "CLAIM", port: 16127 }), false);
    assert.equal(RateLimiter.owns(null), false);
    assert.equal(RateLimiter.owns("nope"), false);

    const clock = new ManualClock();
    const a = new RateLimiter({ self: "a", clock, rate: 0, capacity: 1, broadcast: () => {} });
    a.onDeliver({ type: "CLAIM", port: 16127 }); // a co-tenant feature's payload
    assert.equal(a.available, 1, "a foreign payload did not touch the bucket");
  });
});
