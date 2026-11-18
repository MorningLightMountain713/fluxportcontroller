/**
 * UpnpCoordinator with the router's events: a real ring on the VirtualNetwork, every node
 * behind one ModelRouter, each node with its own router test port and event listener. The
 * lowest address leads, so it is the one that tests and watches the router's events.
 */

import assert from "assert/strict";
import { describe, it } from "node:test";
import { ManualClock } from "@/fluxport-controller/consensus/clock";
import { Consensus } from "@/fluxport-controller/consensus/consensus";
import { UpnpCoordinator } from "@/fluxport-controller/upnp/upnpCoordinator";
import { EventWatchState } from "@/fluxport-controller/upnp/eventWatch";
import { MembershipConfig } from "@/fluxport-controller/consensus/membership";
import { makeCoordinator, makeWorld, settle, slowCfg } from "./coordinatorHarness";
import { ClientCounts, ModelRouter, RouterBehaviour } from "./modelRouter";

interface RingNode {
  address: string;
  port: number;
  node: Consensus;
  coordinator: UpnpCoordinator;
  counts: ClientCounts;
  failures: Array<{ port: number; reason: string }>;
  states: Array<{ state: EventWatchState; reason: string }>;
}

const NODES = [
  { address: "10.0.0.10", port: 16127, testPort: 40001 },
  { address: "10.0.0.20", port: 16137, testPort: 40002 },
  { address: "10.0.0.30", port: 16147, testPort: 40003 }
];

async function run(clock: ManualClock, ms: number, each?: () => void): Promise<void> {
  for (let t = 0; t < ms; t += 20) {
    clock.advance(20);
    await settle();
    each?.();
  }
}

async function ring(
  behaviour: RouterBehaviour = {},
  opts: {
    nodes?: number;
    safetyNetMs?: number;
    ttl?: number;
    lowTtlThreshold?: number;
    config?: MembershipConfig;
  } = {}
) {
  const w = makeWorld();
  const router = new ModelRouter(w.clock, { subscriptionSeconds: 60, ...behaviour });
  const nodes: RingNode[] = [];
  for (const spec of NODES.slice(0, opts.nodes ?? 2)) {
    const client = router.clientFor(spec.address);
    const node = w.makeNode(spec.address);
    const failures: RingNode["failures"] = [];
    const states: RingNode["states"] = [];
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: spec.address,
      localAddress: spec.address,
      client,
      routerTestPort: spec.testPort,
      events: router.eventsFor(spec.address),
      eventsSafetyNetMs: opts.safetyNetMs ?? 20_000,
      ttl: opts.ttl,
      lowTtlThreshold: opts.lowTtlThreshold,
      freshLaps: 50,
      config: opts.config,
      onMappingFailed: (port, reason) => failures.push({ port, reason }),
      onEventsStateChange: (state, reason) => states.push({ state, reason })
    });
    coordinator.setDesiredPortSet([spec.port]);
    nodes.push({ address: spec.address, port: spec.port, node, coordinator, counts: client.counts, failures, states });
  }
  for (const n of nodes) await n.node.start();
  return { w, router, nodes, lead: nodes[0], peer: nodes[1] };
}

/** Run until the leader trusts the router's events; then let the trusted read land. */
async function untilTrusted(r: Awaited<ReturnType<typeof ring>>, maxMs = 150_000): Promise<void> {
  for (let t = 0; t < maxMs && r.lead.coordinator.eventsState !== "trusted"; t += 20) {
    r.w.clock.advance(20);
    await settle();
  }
  assert.equal(r.lead.coordinator.eventsState, "trusted", `states: ${JSON.stringify(r.lead.states)}`);
  await run(r.w.clock, 2000);
}

describe("UpnpCoordinator with the router's events", () => {
  it("stops reading the table on the leader's turns once events are trusted", async () => {
    const r = await ring();
    await untilTrusted(r);
    assert.equal(r.lead.coordinator.isLeader, true);
    const walks = r.lead.counts.walks;
    const leadLookups = r.lead.counts.lookups;
    const lookups = r.peer.counts.lookups;
    await run(r.w.clock, 10_000);
    assert.equal(r.lead.counts.walks, walks, "no table read in 10 s of turns");
    assert.equal(r.lead.counts.lookups, leadLookups, "nor a lookup of the leader's own port");
    assert.equal(r.peer.counts.lookups, lookups, "the peer still trusts the leader's table");
    assert.ok(r.router.held(16127) && r.router.held(16137), "both ports held");
  });

  it("reads the table on an event and repairs a removed mapping within a second", async () => {
    const r = await ring();
    await untilTrusted(r);
    const walks = r.lead.counts.walks;
    r.router.drop(16137); // another machine removes the peer's mapping
    // The NOTIFY lands 5 ms later; the leader reads at once, not on its next turn.
    for (let t = 0; t < 7; t++) {
      r.w.clock.advance(1);
      await settle();
    }
    assert.ok(r.lead.counts.walks > walks, "the event made the leader read the table at once");
    await run(r.w.clock, 1000);
    assert.ok(r.router.held(16137), "restored");
  });

  for (const eventing of ["no-answer", "no-sid", "initial-only", "callback-blocked"] as const) {
    it(`keeps reading on every turn when the router's events are "${eventing}"`, async () => {
      const r = await ring({ eventing });
      let sawTrusted = false;
      await run(r.w.clock, 150_000, () => {
        if (r.lead.coordinator.eventsState === "trusted") sawTrusted = true;
      });
      assert.equal(sawTrusted, false, "never trusted");
      assert.equal(r.lead.coordinator.eventsState, "idle");
      const walks = r.lead.counts.walks;
      await run(r.w.clock, 5000);
      assert.ok(r.lead.counts.walks - walks > 10, "the leader reads the table on its turns");
      assert.equal(r.router.held(40001), null, "no test mapping left");
      assert.equal(r.router.subscriptionsFor("10.0.0.10"), 0, "no subscription left");
      assert.ok(r.router.held(16127) && r.router.held(16137), "both ports held");
    });
  }

  it("resubscribes after a router reboot, and restores every mapping", async () => {
    const r = await ring({}, { safetyNetMs: 600_000 });
    await untilTrusted(r);
    const subscribes = r.router.eventCounts.subscribes;
    r.router.reboot(); // the table and the subscription are gone, and nothing is signalled
    await run(r.w.clock, 40_000);
    assert.ok(r.router.eventCounts.subscribes > subscribes, "subscribed again");
    assert.equal(r.lead.coordinator.eventsState, "trusted", JSON.stringify(r.lead.states));
    assert.ok(r.router.held(16127) && r.router.held(16137), "both ports mapped again");
  });

  it("finds a lost event at the safety-net read, stops trusting, and repairs", async () => {
    const r = await ring({}, { safetyNetMs: 20_000 });
    await untilTrusted(r);
    r.router.dropNextEvent = true;
    r.router.drop(16137);
    await run(r.w.clock, 2000);
    assert.equal(r.router.held(16137), null, "the lost event hid the removal");
    await run(r.w.clock, 22_000);
    assert.equal(r.lead.coordinator.eventsState, "idle");
    assert.match(r.lead.states.at(-1)!.reason, /changed without an event/);
    await run(r.w.clock, 2000);
    assert.ok(r.router.held(16137), "restored once the table was read");
  });

  it("stops trusting when a change the leader makes brings no event", async () => {
    const r = await ring({}, { safetyNetMs: 600_000 });
    await untilTrusted(r);
    r.router.behaviour.eventing = "initial-only"; // the router's events stop
    r.lead.coordinator.setDesiredPortSet([16127, 16128]);
    await run(r.w.clock, 12_000);
    assert.equal(r.lead.coordinator.eventsState, "idle");
    assert.match(r.lead.states.at(-1)!.reason, /no event for a change this node made/);
    assert.ok(r.router.held(16128), "the new port is mapped");
  });

  it("sees a mapping taken over at the same size at the safety-net read, and keeps trusting", async () => {
    const r = await ring({}, { safetyNetMs: 20_000 });
    await untilTrusted(r);
    r.router.seed({ port: 16137, host: "10.0.0.99" }); // another machine takes the peer's port
    await run(r.w.clock, 2000);
    assert.equal(r.peer.failures.length, 0, "not signalled: unseen until the safety net");
    await run(r.w.clock, 22_000);
    assert.ok(r.peer.failures.some((f) => f.port === 16137), "the peer tried to take it back");
    assert.equal(r.lead.coordinator.eventsState, "trusted", "a same-size change is no lost event");
  });

  it("sees a mapping taken over at once on a router that signals it", async () => {
    const r = await ring({ replaceSignalled: true }, { safetyNetMs: 600_000 });
    await untilTrusted(r);
    r.router.seed({ port: 16137, host: "10.0.0.99" });
    await run(r.w.clock, 2000);
    assert.ok(r.peer.failures.some((f) => f.port === 16137), "the peer tried to take it back");
  });

  it("keeps leased mappings alive while trusted", async () => {
    const r = await ring({}, { ttl: 60, lowTtlThreshold: 20 });
    await untilTrusted(r);
    assert.equal(r.lead.coordinator.leaseRenews, true);
    await run(r.w.clock, 3000);
    let gaps = 0;
    const adds = r.lead.counts.added.filter((p) => p === 16127).length;
    await run(r.w.clock, 300_000, () => {
      if (!r.router.held(16127) || !r.router.held(16137)) gaps += 1;
    });
    assert.equal(gaps, 0, "no lease ran out");
    const renewals = r.lead.counts.added.filter((p) => p === 16127).length - adds;
    assert.ok(renewals <= 300 / 40 + 1, `the leader renewed about once per lease, not every turn (${renewals})`);
    assert.equal(r.lead.coordinator.eventsState, "trusted");
  });

  it("tests events only after the lease test, and only on the leader", async () => {
    const r = await ring();
    let early = 0;
    let peerSubscribed = 0;
    await run(r.w.clock, 150_000, () => {
      if (r.lead.coordinator.leaseRenews === null && r.router.eventCounts.subscribes > 0) early += 1;
      peerSubscribed = Math.max(peerSubscribed, r.router.subscriptionsFor("10.0.0.20"));
    });
    assert.equal(early, 0, "no subscription before the lease test answered");
    assert.equal(peerSubscribed, 0, "the non-leader never subscribed");
    assert.equal(r.lead.coordinator.eventsState, "trusted");
  });

  it("reads again when an event arrives while the table is being read", async () => {
    // Slow turns, so a read on the next turn cannot pass for the read that must follow.
    const r = await ring({ walkDelayMs: 200 }, { safetyNetMs: 600_000, config: slowCfg });
    await untilTrusted(r);
    const walks = r.lead.counts.walks;
    r.router.drop(16137); // starts a read that answers with the table before the next change
    await run(r.w.clock, 100);
    r.router.drop(16127); // lands while that read is in flight
    await run(r.w.clock, 120);
    assert.equal(r.lead.counts.walks - walks, 2, "a second read straight after the first");
    await run(r.w.clock, 5000);
    assert.ok(r.router.held(16137) && r.router.held(16127), "both restored");
    assert.equal(r.lead.coordinator.eventsState, "trusted", JSON.stringify(r.lead.states));
  });

  it("drops its subscription when a lower address joins and takes the lead", async () => {
    const w = makeWorld();
    const router = new ModelRouter(w.clock, { subscriptionSeconds: 60 });
    const make = (address: string, port: number, testPort: number) => {
      const node = w.makeNode(address);
      const { coordinator } = makeCoordinator(node, w.clock, {
        self: address,
        localAddress: address,
        client: router.clientFor(address),
        routerTestPort: testPort,
        events: router.eventsFor(address),
        eventsSafetyNetMs: 20_000,
        freshLaps: 50
      });
      coordinator.setDesiredPortSet([port]);
      return { node, coordinator };
    };
    const b = make("10.0.0.20", 16137, 40002);
    const c = make("10.0.0.30", 16147, 40003);
    await b.node.start();
    await c.node.start();
    for (let t = 0; t < 150_000 && b.coordinator.eventsState !== "trusted"; t += 20) {
      w.clock.advance(20);
      await settle();
    }
    assert.equal(b.coordinator.eventsState, "trusted");
    const a = make("10.0.0.10", 16127, 40001);
    await a.node.start();
    // It leads at once, before any table of b's reaches it: it runs its own lease test.
    await run(w.clock, 120_000);
    assert.equal(a.coordinator.isLeader, true);
    assert.equal(b.coordinator.eventsState, "idle", "the former leader stopped watching");
    assert.equal(router.subscriptionsFor("10.0.0.20"), 0, "and unsubscribed");
    assert.equal(a.coordinator.eventsState, "trusted");
  });

  it("hands the watch to the next leader when the leader stops", async () => {
    const r = await ring({}, { nodes: 3 });
    await untilTrusted(r);
    r.lead.coordinator.stop();
    r.lead.node.stop();
    assert.equal(r.router.subscriptionsFor("10.0.0.10"), 0, "the stopped leader unsubscribed");
    await run(r.w.clock, 30_000);
    assert.equal(r.peer.coordinator.isLeader, true, "the next address leads");
    assert.equal(r.peer.coordinator.eventsState, "trusted", JSON.stringify(r.peer.states));
    assert.equal(r.nodes[2].coordinator.eventsState, "idle");
  });
});
