/**
 * Direct test of the slimmed `FluxPortManager` port-feature peer: it owns no
 * node-level concerns (no UPnP, node-list, socket, or self-heal — those moved to
 * `FluxNodeAgent`). Here we build the shared `Consensus` over the VirtualNetwork,
 * join the `ports` group ourselves, construct `FluxPortManager` on that group, drive
 * the clock, and assert the peer claims a port and surfaces it via its getters and
 * the `onPortConfirmed` hook.
 */

import assert from "assert/strict";
import { describe, it } from "node:test";
import { VirtualNetwork } from "@/fluxport-controller/consensus/transport";
import { ManualClock } from "@/fluxport-controller/consensus/clock";
import { Consensus } from "@/fluxport-controller/consensus/consensus";
import { PortAllocatorConfig } from "@/fluxport-controller/consensus/portAllocator";
import { FluxPortManager } from "@/fluxport-controller/fluxPortManager";

const FAST_TIMING = {
  tokenRotationTarget: 5,
  tokenRetransmitTimeout: 60,
  maxTokenRetransmits: 5,
  tokenLossTimeout: 150,
  maxMessagesPerToken: 8,
  announceInterval: 20,
  joinInterval: 10,
  joinTimeout: 40,
  commitTimeout: 1000
};

function makeWorld(ports: number[]) {
  const net = new VirtualNetwork();
  const clock = new ManualClock();
  const confirmed = new Map<string, number | null>();
  const managers = new Map<string, FluxPortManager>();
  const consensuses = new Map<string, Consensus>();

  const add = (
    address: string,
    opts: { priorPort?: number | null; priority?: number } = {}
  ): FluxPortManager => {
    const consensus = new Consensus(net.register(address), clock, {
      localAddress: address,
      resolveLocalAddress: async () => address,
      createTransport: (addr) => net.register(addr)
    });
    const config: PortAllocatorConfig = {
      ...FAST_TIMING,
      ports,
      identity: address,
      priority: opts.priority ?? 100,
      priorPort: opts.priorPort ?? null
    };
    const group = consensus.join("ports", {
      config,
      hooks: { onDeliver: () => {}, onViewChange: () => {} }
    });
    confirmed.set(address, null);
    const m = new FluxPortManager({
      self: address,
      group,
      config,
      hooks: {
        onPortConfirmed: (port) => confirmed.set(address, port),
        onWaiting: () => {}
      }
    });
    managers.set(address, m);
    consensuses.set(address, consensus);
    return m;
  };

  const startAll = async () => {
    for (const c of consensuses.values()) await c.start();
  };

  return { net, clock, confirmed, managers, add, startAll };
}

describe("FluxPortManager (port-feature peer)", () => {
  it("claims a port and surfaces it via the hook and getters", async () => {
    const w = makeWorld([16197, 16187, 16177]);
    const a = w.add("10.0.0.11");

    await w.startAll();
    w.clock.advance(1000);

    const port = a.assignedPort;
    assert.ok(port != null && [16197, 16187, 16177].includes(port), `claimed a port: ${port}`);
    assert.equal(w.confirmed.get("10.0.0.11"), port, "surfaced the same port via onPortConfirmed");
    assert.equal(a.members.length, 1, "lone member sees itself");
    assert.ok(a.viewId, "exposes the current view id");
  });

  it("two peers converge to distinct ports over the shared group", async () => {
    const w = makeWorld([16197, 16187, 16177]);
    const a = w.add("10.0.0.11");
    const b = w.add("10.0.0.12");

    await w.startAll();
    w.clock.advance(1500);

    const pa = a.assignedPort;
    const pb = b.assignedPort;
    assert.ok(pa != null && pb != null, `both assigned: ${pa}, ${pb}`);
    assert.notEqual(pa, pb, "distinct ports");
    assert.equal(a.members.length, 2, "merged into a 2-member view");
  });
});
