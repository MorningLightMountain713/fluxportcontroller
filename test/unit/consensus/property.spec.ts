/**
 * Randomized property tests over the virtual network. Each property runs many
 * seeded scenarios and asserts the core invariants hold:
 *   - total-order agreement: all nodes deliver the identical sequence;
 *   - allocation agreement + uniqueness: all nodes agree on port→owner and no
 *     port is double-owned;
 *   - convergence through merges, partitions, and churn.
 *
 * Loss is modelled "drop-once" (each (recipient,seq) first attempt may be
 * dropped, retransmits get through), so the reliability/RTR path is exercised
 * deterministically without starving liveness. Membership-plane messages
 * (JOIN/COMMIT/TOKEN) are not dropped here — commit-token-loss hardening is a
 * documented follow-up — so these properties target the data plane + the SMs.
 */

import assert from "assert/strict";
import { describe, it } from "node:test";
import {
  VirtualNetwork,
  DropPredicate
} from "../../../src/fluxport-controller/consensus/transport";
import { ManualClock } from "../../../src/fluxport-controller/consensus/clock";
import {
  OrderedBroadcast,
  OrderedBroadcastConfig
} from "../../../src/fluxport-controller/consensus/orderedBroadcast";
import {
  PortAllocator,
  PortAllocatorConfig
} from "../../../src/fluxport-controller/consensus/portAllocator";

// deterministic PRNG (mulberry32) so any failure is reproducible by seed
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Drop-once predicate: first delivery of a (recipient, seq) may be dropped. */
function dropOnceMcast(rand: () => number, p: number): DropPredicate {
  const dropped = new Set<string>();
  return (_from, to, msg) => {
    if (msg.kind !== "MCAST") return false;
    const key = `${to}:${msg.seq}`;
    if (dropped.has(key)) return false;
    if (rand() < p) {
      dropped.add(key);
      return true;
    }
    return false;
  };
}

const OB_CONFIG: OrderedBroadcastConfig = {
  tokenRotationTarget: 5,
  tokenRetransmitTimeout: 80,
  maxTokenRetransmits: 8,
  tokenLossTimeout: 1_000_000,
  maxMessagesPerToken: 4
};

const ALLOC_TIMING = {
  tokenRotationTarget: 5,
  tokenRetransmitTimeout: 80,
  maxTokenRetransmits: 8,
  tokenLossTimeout: 300,
  maxMessagesPerToken: 6,
  announceInterval: 25,
  joinInterval: 12,
  joinTimeout: 50,
  commitTimeout: 2000
};

describe("property: ordered broadcast total-order agreement under loss", () => {
  for (let seed = 1; seed <= 12; seed++) {
    it(`seed ${seed}`, () => {
      const rand = rng(seed);
      const net = new VirtualNetwork();
      const clock = new ManualClock();
      const ids = ["a", "b", "c", "d"];
      const delivered = new Map<string, unknown[]>();
      const obs = new Map<string, OrderedBroadcast>();

      for (const id of ids) {
        const t = net.register(id);
        delivered.set(id, []);
        const ob = new OrderedBroadcast({
          self: id,
          transport: t,
          clock,
          config: OB_CONFIG,
          hooks: { onDeliver: (payload) => delivered.get(id)!.push(payload) }
        });
        t.start();
        ob.start();
        obs.set(id, ob);
      }
      net.setDropPredicate(dropOnceMcast(rand, 0.3));
      ids.forEach((id) =>
        obs.get(id)!.tokenRing.installRing({ rep: "a", seq: 1 }, ids, true)
      );

      // each node broadcasts a few uniquely-tagged messages
      const expected = new Set<string>();
      for (const id of ids) {
        const n = 1 + Math.floor(rand() * 3);
        for (let k = 0; k < n; k++) {
          const tag = `${id}-${k}`;
          expected.add(tag);
          obs.get(id)!.broadcast(tag);
        }
      }

      clock.advance(20000);

      // every node delivered the identical sequence, and it is the full set
      const ref = delivered.get("a")!;
      for (const id of ids) {
        assert.deepEqual(delivered.get(id), ref, `seed ${seed}: ${id} diverged`);
      }
      assert.deepEqual(new Set(ref), expected, `seed ${seed}: missing messages`);
    });
  }
});

describe("property: allocator agreement + uniqueness under loss", () => {
  for (let seed = 1; seed <= 12; seed++) {
    it(`seed ${seed}`, () => {
      const rand = rng(seed);
      const net = new VirtualNetwork();
      const clock = new ManualClock();
      const ports = [10, 20, 30, 40];
      const ids = ["a", "b", "c", "d"]; // |nodes| == |ports|
      const allocs = new Map<string, PortAllocator>();
      const confirmed = new Map<string, number | null>();

      for (const id of ids) {
        const t = net.register(id);
        confirmed.set(id, null);
        const cfg: PortAllocatorConfig = { ...ALLOC_TIMING, ports, priority: 100 };
        const a = new PortAllocator({
          self: id,
          transport: t,
          clock,
          config: cfg,
          hooks: { onPortConfirmed: (p) => confirmed.set(id, p) }
        });
        t.start();
        a.start();
        allocs.set(id, a);
      }
      net.setDropPredicate(dropOnceMcast(rand, 0.25));
      ids.forEach((id) => allocs.get(id)!.bootstrap());

      clock.advance(30000);

      // all in the same view, agree on the allocation, and ports are unique
      const views = ids.map((id) => allocs.get(id)!.viewId);
      assert.equal(new Set(views).size, 1, `seed ${seed}: views diverged ${views}`);

      const ref = allocs.get("a")!.snapshot();
      for (const id of ids) {
        assert.deepEqual(allocs.get(id)!.snapshot(), ref, `seed ${seed}: ${id} disagrees`);
      }
      const owners = Object.values(ref);
      assert.equal(new Set(owners).size, owners.length, `seed ${seed}: double-owned port`);

      // liveness: everyone got a distinct port
      const got = ids.map((id) => confirmed.get(id));
      assert.ok(got.every((p) => p != null), `seed ${seed}: unassigned ${got}`);
      assert.equal(new Set(got).size, ids.length, `seed ${seed}: duplicate ports ${got}`);
    });
  }
});

describe("property: convergence through partition then merge", () => {
  for (let seed = 1; seed <= 8; seed++) {
    it(`seed ${seed}`, () => {
      const rand = rng(seed);
      const net = new VirtualNetwork();
      const clock = new ManualClock();
      const ports = [10, 20, 30];
      const ids = ["a", "b", "c"];
      const allocs = new Map<string, PortAllocator>();

      for (const id of ids) {
        const t = net.register(id);
        const cfg: PortAllocatorConfig = {
          ...ALLOC_TIMING,
          ports,
          priority: 1 + Math.floor(rand() * 5) // varied priorities
        };
        const a = new PortAllocator({
          self: id,
          transport: t,
          clock,
          config: cfg
        });
        t.start();
        a.start();
        allocs.set(id, a);
      }

      // split a | b,c, let each side settle
      net.partition([["a"], ["b", "c"]]);
      ids.forEach((id) => allocs.get(id)!.bootstrap());
      clock.advance(5000);

      // heal and let them merge into one view
      net.heal();
      clock.advance(15000);

      const views = ids.map((id) => allocs.get(id)!.viewId);
      assert.equal(new Set(views).size, 1, `seed ${seed}: not merged ${views}`);
      assert.deepEqual(allocs.get("a")!.currentMembers, ["a", "b", "c"]);

      const ref = allocs.get("a")!.snapshot();
      for (const id of ids) {
        assert.deepEqual(allocs.get(id)!.snapshot(), ref, `seed ${seed}: ${id} disagrees`);
      }
      const owners = Object.values(ref);
      assert.equal(new Set(owners).size, owners.length, `seed ${seed}: double-owned`);
      assert.equal(owners.length, 3, `seed ${seed}: not all assigned`);
    });
  }
});

describe("property: convergence under join/crash churn", () => {
  for (let seed = 1; seed <= 8; seed++) {
    it(`seed ${seed}`, () => {
      const rand = rng(seed);
      const net = new VirtualNetwork();
      const clock = new ManualClock();
      const ports = [10, 20, 30, 40, 50];
      const ids = ["a", "b", "c", "d", "e"];
      const allocs = new Map<string, PortAllocator>();
      const transports = new Map<string, ReturnType<VirtualNetwork["register"]>>();
      const alive = new Set<string>();

      const spawn = (id: string) => {
        const t = net.register(id);
        const cfg: PortAllocatorConfig = { ...ALLOC_TIMING, ports, priority: 100 };
        const a = new PortAllocator({ self: id, transport: t, clock, config: cfg });
        t.start();
        a.start();
        a.bootstrap();
        allocs.set(id, a);
        transports.set(id, t);
        alive.add(id);
      };

      // bring nodes up one at a time
      for (const id of ids) {
        spawn(id);
        clock.advance(2000 + Math.floor(rand() * 2000));
      }

      // crash one or two at random, let it settle
      const crashCount = 1 + Math.floor(rand() * 2);
      for (let i = 0; i < crashCount; i++) {
        const live = [...alive];
        const victim = live[Math.floor(rand() * live.length)];
        allocs.get(victim)!.stop();
        transports.get(victim)!.stop();
        alive.delete(victim);
        clock.advance(6000);
      }
      clock.advance(8000);

      const live = [...alive];
      const views = live.map((id) => allocs.get(id)!.viewId);
      assert.equal(new Set(views).size, 1, `seed ${seed}: views diverged ${views}`);

      const ref = allocs.get(live[0])!.snapshot();
      for (const id of live) {
        assert.deepEqual(allocs.get(id)!.snapshot(), ref, `seed ${seed}: ${id} disagrees`);
      }
      const owners = Object.values(ref);
      assert.equal(new Set(owners).size, owners.length, `seed ${seed}: double-owned`);
      // every surviving node holds a distinct port (live <= ports)
      assert.equal(owners.length, live.length, `seed ${seed}: not all live assigned`);
    });
  }
});
