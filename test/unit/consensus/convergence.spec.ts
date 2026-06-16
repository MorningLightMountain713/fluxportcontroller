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
});
