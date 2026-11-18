/**
 * UpnpCoordinator against routers that do not behave like the specification: each test
 * runs the coordinator over a ModelRouter switched to one behaviour real routers show,
 * and asserts the outcome that matters — the port is mapped, stays mapped, and the router
 * is not written more than needed.
 */

import assert from "assert/strict";
import { describe, it } from "node:test";
import { ManualClock } from "@/fluxport-controller/consensus/clock";
import { UpnpCoordinator } from "@/fluxport-controller/upnp/upnpCoordinator";
import { makeCoordinator, makeWorld, settle } from "./coordinatorHarness";
import { ModelRouter, RouterBehaviour } from "./modelRouter";

const NODE = "10.0.0.11";

/** Advance the clock by `ms` in `step`s, letting async work run between steps. */
async function run(clock: ManualClock, ms: number, step = 100, each?: () => void): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    clock.advance(step);
    await settle();
    each?.();
  }
}

/** One node behind a ModelRouter, in SELF_CHECK (its slot drives repairs). */
async function loneNode(
  behaviour: RouterBehaviour,
  opts: { desired: number[]; ttl?: number; lowTtlThreshold?: number; routerTestPort?: number }
) {
  const w = makeWorld();
  const router = new ModelRouter(w.clock, behaviour);
  const client = router.clientFor(NODE);
  const failures: string[] = [];
  const node = w.makeNode(NODE);
  const { coordinator } = makeCoordinator(node, w.clock, {
    self: NODE,
    localAddress: NODE,
    client,
    ttl: opts.ttl,
    lowTtlThreshold: opts.lowTtlThreshold,
    routerTestPort: opts.routerTestPort,
    onMappingFailed: (port, reason) => failures.push(`${port}: ${reason}`)
  });
  coordinator.setDesiredPortSet(opts.desired);
  await node.start();
  return { w, router, client, coordinator, failures };
}

describe("UpnpCoordinator against real routers' behaviour", () => {
  describe("a lookup that does not answer 714 for a port the router does not hold", () => {
    for (const missingLookup of ["606", "501"] as const) {
      it(`maps the port when the lookup faults ${missingLookup}`, async () => {
        const { w, router } = await loneNode({ missingLookup }, { desired: [16127] });
        await run(w.clock, 1000);
        const held = router.held(16127);
        assert.ok(held, "the port is mapped");
        assert.equal(held.private.host, NODE);
      });
    }

    it("maps the port, and stops writing it, when every lookup answers the first entry", async () => {
      const w = makeWorld();
      const router = new ModelRouter(w.clock, { lookupAnswersFirst: true });
      // The router's first entry: this node's own mapping of another port. Every lookup,
      // of a port the router holds or not, answers with it.
      router.seed({ port: 16126, host: NODE });
      const client = router.clientFor(NODE);
      const node = w.makeNode(NODE);
      const { coordinator } = makeCoordinator(node, w.clock, {
        self: NODE,
        localAddress: NODE,
        client
      });
      coordinator.setDesiredPortSet([16126, 16127]);
      await node.start();
      await run(w.clock, 1000);
      assert.ok(router.held(16127), "16127 is mapped although every lookup answered 16126's entry");
      const adds = client.counts.adds;
      await run(w.clock, 2000);
      assert.equal(client.counts.adds, adds, "a held port is not written again");
    });

    it("maps the port when the lookup answers an empty success", async () => {
      const { w, router } = await loneNode({ missingLookup: "empty-success" }, { desired: [16127] });
      await run(w.clock, 1000);
      assert.equal(router.held(16127)?.private.host, NODE);
    });
  });

  describe("a router that refuses a leased mapping", () => {
    for (const timedLeaseFault of [725, 501, 718]) {
      it(`maps the port permanently when a lease is refused with ${timedLeaseFault}`, async () => {
        const { w, router } = await loneNode(
          { timedLeaseFault },
          { desired: [16127], routerTestPort: 16130 }
        );
        await run(w.clock, 120_000, 500);
        const held = router.held(16127);
        assert.ok(held, "the port is mapped");
        assert.equal(held.ttl, 0, "permanent");
      });
    }
  });

  describe("a router that does not renew a lease when the mapping is added again", () => {
    // FRITZ!OS 8.x: a re-add is accepted and changes nothing, and a lookup of an entry
    // that carries a lease answers 714.
    const fritz: RouterBehaviour = { renewsOnReadd: false, hidesLeasedEntries: true };

    it("keeps the port mapped through several lease lengths, written once", async () => {
      const { w, router, client } = await loneNode(fritz, {
        desired: [16127],
        ttl: 60,
        lowTtlThreshold: 15
      });
      await run(w.clock, 1000);
      assert.ok(router.held(16127), "mapped");
      const adds = client.counts.adds;
      let gaps = 0;
      await run(w.clock, 300_000, 500, () => {
        if (!router.held(16127)) gaps += 1;
      });
      assert.equal(gaps, 0, "never lapsed");
      assert.equal(client.counts.adds, adds, "never written again");
    });

    it("learns from the lease test not to lease, and keeps the port permanent", async () => {
      const { w, router, coordinator } = await loneNode(fritz, {
        desired: [16127],
        ttl: 60,
        lowTtlThreshold: 15,
        routerTestPort: 16130
      });
      await run(w.clock, 300_000, 500);
      assert.equal(coordinator.leaseRenews, false, "the lease test found the lease is not renewed");
      assert.equal(router.held(16127)?.ttl, 0, "the port is held permanently");
      assert.equal(router.held(16130), null, "the test mapping is gone");
    });
  });

  describe("a router that renews a lease when the mapping is added again", () => {
    it("leases the port once the lease test passes, and keeps it alive", async () => {
      const { w, router, coordinator, client } = await loneNode(
        {},
        { desired: [16127], ttl: 60, lowTtlThreshold: 20, routerTestPort: 16130 }
      );
      await run(w.clock, 120_000, 500);
      assert.equal(coordinator.leaseRenews, true, "the lease test passed");
      assert.ok((router.held(16127)?.ttl ?? 0) > 0, "the port carries a lease");
      assert.equal(router.held(16130), null, "the test mapping is removed");
      let gaps = 0;
      const adds = client.counts.adds;
      await run(w.clock, 300_000, 500, () => {
        if (!router.held(16127)) gaps += 1;
      });
      assert.equal(gaps, 0, "the lease never ran out");
      assert.ok(client.counts.adds - adds <= 300 / 40 + 1, "renewed about once per lease, not every pass");
    });

    it("maps permanently until the lease test has answered", async () => {
      const { w, router } = await loneNode(
        {},
        { desired: [16127], ttl: 60, lowTtlThreshold: 20, routerTestPort: 16130 }
      );
      await run(w.clock, 1000);
      assert.equal(router.held(16127)?.ttl, 0, "permanent before the test has answered");
    });

    it("maps permanently, for every port, once a leased write is refused", async () => {
      const { w, router, coordinator, client } = await loneNode(
        {},
        { desired: [16127, 16128], ttl: 60, lowTtlThreshold: 20, routerTestPort: 16130 }
      );
      await run(w.clock, 120_000, 500);
      assert.equal(coordinator.leaseRenews, true);
      // The router now refuses leases, and loses its table.
      router.behaviour.timedLeaseFault = 501;
      router.reboot();
      const adds = client.counts.adds;
      await run(w.clock, 5_000, 500);
      assert.equal(coordinator.leaseRenews, false, "the refusal ended leasing");
      assert.equal(router.held(16127)?.ttl, 0);
      assert.equal(router.held(16128)?.ttl, 0);
      assert.equal(client.counts.adds - adds, 3, "one refused leased write, then each port permanent");
    });

    it("keeps leasing when a write fails with no answer, or on another host's entry", async () => {
      const w = makeWorld();
      const router = new ModelRouter(w.clock, {});
      const inner = router.clientFor(NODE);
      let unanswered = false;
      let reads16128 = 0;
      let writes16128 = 0;
      const client = {
        ...inner,
        async getMapping(q: Parameters<typeof inner.getMapping>[0]) {
          if (q.public === 16128) reads16128 += 1;
          return inner.getMapping(q);
        },
        async createMapping(m: Parameters<typeof inner.createMapping>[0]): Promise<void> {
          if (m.public === 16128) writes16128 += 1;
          if (unanswered) throw new Error("socket hang up");
          return inner.createMapping(m);
        }
      };
      const node = w.makeNode(NODE);
      const { coordinator } = makeCoordinator(node, w.clock, {
        self: NODE,
        localAddress: NODE,
        client,
        ttl: 60,
        lowTtlThreshold: 20,
        routerTestPort: 16130
      });
      coordinator.setDesiredPortSet([16127, 16128]);
      await node.start();
      await run(w.clock, 120_000, 500);
      assert.equal(coordinator.leaseRenews, true);

      router.reboot();
      router.seed({ port: 16128, host: "10.0.0.99" }); // another machine holds 16128
      unanswered = true;
      await run(w.clock, 2_000, 500);
      unanswered = false;
      reads16128 = 0;
      writes16128 = 0;
      await run(w.clock, 2_000, 500);
      assert.ok(reads16128 > 0);
      assert.equal(writes16128, reads16128, "one write attempt per read of the conflicted port");
      assert.equal(coordinator.leaseRenews, true, "neither failure is a lease refusal");
      assert.ok((router.held(16127)?.ttl ?? 0) > 0, "16127 leased again");
      assert.equal(router.held(16128)?.private.host, "10.0.0.99", "16128 left to its holder");
    });

    it("does not lease on a router whose minimum lease hides renewal", async () => {
      const { w, router, coordinator } = await loneNode(
        { minimumLease: 900 },
        { desired: [16127], ttl: 60, lowTtlThreshold: 20, routerTestPort: 16130 }
      );
      await run(w.clock, 120_000, 500);
      assert.equal(coordinator.leaseRenews, false, "a 900 s lease at +70 s says nothing about renewal");
      assert.equal(router.held(16127)?.ttl, 0);
    });

    it("never leases without a lease-test port", async () => {
      const { w, router, coordinator } = await loneNode({}, { desired: [16127], ttl: 60 });
      await run(w.clock, 120_000, 500);
      assert.equal(coordinator.leaseRenews, null, "no test, no answer");
      assert.equal(router.held(16127)?.ttl, 0);
    });
  });

  describe("in a ring", () => {
    it("the leader's lease test reaches every node, and the test port is not pruned", async () => {
      const w = makeWorld();
      const router = new ModelRouter(w.clock, {});
      const leadAddr = "10.0.0.10";
      const peerAddr = "10.0.0.20";
      const lead = w.makeNode(leadAddr);
      const peer = w.makeNode(peerAddr);
      const leadClient = router.clientFor(leadAddr);
      const nodes: Array<{ coordinator: UpnpCoordinator }> = [];
      for (const [node, addr, client, routerTestPort] of [
        [lead, leadAddr, leadClient, 16130],
        [peer, peerAddr, router.clientFor(peerAddr), undefined]
      ] as const) {
        const { coordinator } = makeCoordinator(node, w.clock, {
          self: addr,
          localAddress: addr,
          client,
          ttl: 60,
          lowTtlThreshold: 20,
          routerTestPort,
          freshLaps: 50,
          orphanConfirmPasses: 0
        });
        nodes.push({ coordinator });
      }
      nodes[0].coordinator.setDesiredPortSet([16127]);
      nodes[1].coordinator.setDesiredPortSet([16137]);
      await lead.start();
      await peer.start();
      await run(w.clock, 90_000, 20);

      assert.equal(nodes[0].coordinator.isLeader, true);
      assert.equal(nodes[0].coordinator.leaseRenews, true, "the leader's test passed");
      assert.equal(nodes[1].coordinator.leaseRenews, true, "the peer took the answer from the leader");
      assert.ok((router.held(16137)?.ttl ?? 0) > 0, "the peer's port carries a lease");
      assert.deepEqual(
        leadClient.counts.removed.filter((p) => p === 16130),
        [16130],
        "the test port was removed once, by the test itself"
      );
    });
  });
});
