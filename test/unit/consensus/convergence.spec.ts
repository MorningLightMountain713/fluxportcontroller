/**
 * Reproduces the 8-node convergence/churn the docker run exposed: many singletons
 * booting at once must settle into ONE stable view with distinct ports, and the
 * view must stop changing (no perpetual re-gather cascade).
 */

import assert from "assert/strict";
import { describe, it } from "node:test";
import { VirtualNetwork } from "@/fluxport-controller/consensus/transport";
import { ManualClock } from "@/fluxport-controller/consensus/clock";
import {
  PortAllocator,
  PortAllocatorConfig
} from "@/fluxport-controller/consensus/portAllocator";

const TIMING = {
  tokenRotationTarget: 5,
  tokenRetransmitTimeout: 60,
  maxTokenRetransmits: 8,
  tokenLossTimeout: 200,
  maxMessagesPerToken: 8,
  announceInterval: 25,
  joinInterval: 12,
  joinTimeout: 60,
  commitTimeout: 1500
};

describe("8-node convergence (no churn)", () => {
  it("settles into one stable view with distinct ports", () => {
    const net = new VirtualNetwork();
    const clock = new ManualClock();
    const ports = [16197, 16187, 16177, 16167, 16157, 16147, 16137, 16127];
    const nids = ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"];
    const allocs = new Map<string, PortAllocator>();

    for (const nid of nids) {
      const t = net.register(nid);
      const cfg: PortAllocatorConfig = { ...TIMING, ports, priority: 100 };
      const a = new PortAllocator({ self: nid, transport: t, clock, config: cfg });
      t.start();
      a.start();
      allocs.set(nid, a);
    }
    // all bootstrap at once (the contended case)
    nids.forEach((nid) => allocs.get(nid)!.bootstrap());

    clock.advance(20000);
    const view1 = nids.map((n) => allocs.get(n)!.viewId);
    clock.advance(20000);
    const view2 = nids.map((n) => allocs.get(n)!.viewId);

    // all agree on one view...
    assert.equal(new Set(view1).size, 1, `not one view: ${[...new Set(view1)]}`);
    // ...and it stopped changing (no churn)
    assert.deepEqual(view2, view1, `view kept changing (churn): ${view1[0]} -> ${view2[0]}`);

    // distinct ports, everyone assigned
    const snap = allocs.get("n1")!.snapshot();
    const ownedPorts = Object.keys(snap);
    assert.equal(ownedPorts.length, 8, `not all ports owned: ${JSON.stringify(snap)}`);
    assert.equal(new Set(Object.values(snap)).size, 8, "owners not distinct");
    for (const nid of nids) {
      assert.deepEqual(allocs.get(nid)!.snapshot(), snap, `${nid} disagrees`);
    }
  });

  // Closes the coverage gap that let the docker run find bugs the synchronous
  // virtual network couldn't: real UDP reorders/delays packets. With timeouts
  // sized above a full rotation, 8 nodes must still converge to one stable,
  // distinct, agreed allocation under reordered delivery.
  it("converges under packet reorder (variable latency)", () => {
    const ports = [16197, 16187, 16177, 16167, 16157, 16147, 16137, 16127];
    const nids = ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"];
    // timeouts > worst-case rotation (8 hops * 5ms hold + up to 30ms latency)
    const cfg: PortAllocatorConfig = {
      ...TIMING,
      ports,
      priority: 100,
      tokenRetransmitTimeout: 500,
      tokenLossTimeout: 2000
    };

    for (let seed = 1; seed <= 8; seed++) {
      let s = seed >>> 0;
      const rand = () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const clock = new ManualClock();
      const net = new VirtualNetwork({ clock, rng: rand, minLatency: 1, maxLatency: 30 });
      const allocs = new Map<string, PortAllocator>();
      for (const nid of nids) {
        const t = net.register(nid);
        const a = new PortAllocator({ self: nid, transport: t, clock, config: cfg });
        t.start();
        a.start();
        allocs.set(nid, a);
      }
      nids.forEach((nid) => allocs.get(nid)!.bootstrap());

      clock.advance(20000);
      const v1 = nids.map((n) => allocs.get(n)!.viewId);
      clock.advance(20000);
      const v2 = nids.map((n) => allocs.get(n)!.viewId);

      assert.equal(new Set(v2).size, 1, `seed ${seed}: not one view ${[...new Set(v2)]}`);
      assert.deepEqual(v2, v1, `seed ${seed}: churn ${v1[0]} -> ${v2[0]}`);
      const snap = allocs.get("n1")!.snapshot();
      assert.equal(Object.keys(snap).length, 8, `seed ${seed}: incomplete ${JSON.stringify(snap)}`);
      assert.equal(new Set(Object.values(snap)).size, 8, `seed ${seed}: duplicate ports`);
      for (const nid of nids) {
        assert.deepEqual(allocs.get(nid)!.snapshot(), snap, `seed ${seed}: ${nid} disagrees`);
      }
    }
  });

  // Reorder AND 10% packet loss. The key was a fast token retransmit (≈ one
  // rotation, made safe by token dedup): a dropped token is refilled before the
  // loss timer fires, so loss doesn't churn the ring. Measured ~100% to 20% loss.
  it("converges under reorder + 10% packet loss", () => {
    const ports = [16197, 16187, 16177, 16167, 16157, 16147, 16137, 16127];
    const nids = ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"];
    const cfg: PortAllocatorConfig = {
      ...TIMING,
      ports,
      priority: 100,
      tokenRetransmitTimeout: 50, // ≈ one rotation (8 * 5ms hold) — fast loss recovery
      tokenLossTimeout: 2000
    };

    for (let seed = 1; seed <= 6; seed++) {
      let s = seed >>> 0;
      const rand = () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const clock = new ManualClock();
      const net = new VirtualNetwork({ clock, rng: rand, minLatency: 1, maxLatency: 30 });
      let s2 = (seed * 7 + 1) >>> 0;
      const lossRand = () => {
        s2 = (s2 + 0x6d2b79f5) | 0;
        let t = Math.imul(s2 ^ (s2 >>> 15), 1 | s2);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      net.setDropPredicate(() => lossRand() < 0.1); // 10% drop of any message

      const allocs = new Map<string, PortAllocator>();
      for (const nid of nids) {
        const t = net.register(nid);
        const a = new PortAllocator({ self: nid, transport: t, clock, config: cfg });
        t.start();
        a.start();
        allocs.set(nid, a);
      }
      nids.forEach((nid) => allocs.get(nid)!.bootstrap());
      clock.advance(40000);

      // core safety: one agreed allocation, every node a distinct port
      const snap = allocs.get("n1")!.snapshot();
      assert.equal(Object.keys(snap).length, 8, `seed ${seed}: incomplete under loss ${JSON.stringify(snap)}`);
      assert.equal(new Set(Object.values(snap)).size, 8, `seed ${seed}: duplicate under loss`);
      for (const nid of nids) {
        assert.deepEqual(allocs.get(nid)!.snapshot(), snap, `seed ${seed}: ${nid} disagrees under loss`);
      }
    }
  });
});
