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
  const confirmCount = new Map<string, number>();
  const waiting = new Set<string>();
  const allocs = new Map<string, PortAllocator>();
  const transports = new Map<string, ReturnType<VirtualNetwork["register"]>>();

  const add = (
    nid: string,
    opts: { priorPort?: number | null; priority?: number } = {}
  ): PortAllocator => {
    const transport = net.register(nid);
    confirmed.set(nid, null);
    confirmCount.set(nid, 0);
    const config: PortAllocatorConfig = {
      ...TIMING,
      ports,
      priority: opts.priority ?? 1,
      priorPort: opts.priorPort ?? null
    };
    const a = new PortAllocator({
      self: nid,
      transport,
      clock,
      config,
      hooks: {
        onPortConfirmed: (port) => {
          confirmed.set(nid, port);
          confirmCount.set(nid, confirmCount.get(nid)! + 1);
          waiting.delete(nid);
        },
        onWaiting: () => waiting.add(nid)
      }
    });
    transport.start();
    a.start();
    allocs.set(nid, a);
    transports.set(nid, transport);
    return a;
  };

  const bootstrapAll = (nids: string[]) =>
    nids.forEach((n) => allocs.get(n)!.bootstrap());
  const crash = (nid: string) => {
    allocs.get(nid)!.stop();
    transports.get(nid)!.stop();
  };

  return {
    net,
    clock,
    confirmed,
    confirmCount,
    waiting,
    allocs,
    transports,
    add,
    bootstrapAll,
    crash
  };
}

describe("PortAllocator", () => {
  it("converges so every node holds a distinct port", () => {
    const w = makeWorld([10, 20, 30]);
    const nids = ["a:0", "b:0", "c:0"];
    nids.forEach((n) => w.add(n));
    w.bootstrapAll(nids);

    w.clock.advance(1000);

    const ports = nids.map((n) => w.confirmed.get(n));
    assert.ok(ports.every((p) => p != null), `all assigned: ${ports}`);
    assert.equal(new Set(ports).size, 3, `distinct: ${ports}`);
    assert.equal(w.allocs.get("a:0")!.currentMembers.length, 3);
  });

  it("keeps owners on their port when a new node joins (no churn)", () => {
    const w = makeWorld([10, 20, 30, 40]);
    w.add("a:0");
    w.add("b:0");
    w.bootstrapAll(["a:0", "b:0"]);
    w.clock.advance(1000);

    const pa = w.confirmed.get("a:0");
    const pb = w.confirmed.get("b:0");
    const ca = w.confirmCount.get("a:0");
    const cb = w.confirmCount.get("b:0");

    w.add("c:0");
    w.allocs.get("c:0")!.bootstrap();
    w.clock.advance(1000);

    // a and b kept the same port — and did not re-emit (sticky, no churn)
    assert.equal(w.confirmed.get("a:0"), pa);
    assert.equal(w.confirmed.get("b:0"), pb);
    assert.equal(w.confirmCount.get("a:0"), ca);
    assert.equal(w.confirmCount.get("b:0"), cb);
    const pc = w.confirmed.get("c:0");
    assert.ok(pc != null && pc !== pa && pc !== pb);
  });

  it("survivors keep their ports when a member crashes", () => {
    const w = makeWorld([10, 20, 30]);
    const nids = ["a:0", "b:0", "c:0"];
    nids.forEach((n) => w.add(n));
    w.bootstrapAll(nids);
    w.clock.advance(1000);

    const pa = w.confirmed.get("a:0");
    const pb = w.confirmed.get("b:0");

    w.crash("c:0");
    w.clock.advance(1500);

    assert.equal(w.confirmed.get("a:0"), pa);
    assert.equal(w.confirmed.get("b:0"), pb);
    assert.equal(w.allocs.get("a:0")!.currentMembers.length, 2);
  });

  it("parks extra nodes as WAITING and admits one when a port frees", () => {
    const w = makeWorld([10, 20]); // only two ports for three nodes
    const nids = ["a:0", "b:0", "c:0"];
    nids.forEach((n) => w.add(n));
    w.bootstrapAll(nids);
    w.clock.advance(1500);

    const owners = nids.filter((n) => w.confirmed.get(n) != null);
    const waiter = nids.find((n) => w.confirmed.get(n) == null)!;
    assert.equal(owners.length, 2);
    assert.ok(w.waiting.has(waiter));
    assert.equal(
      new Set(owners.map((n) => w.confirmed.get(n))).size,
      2,
      "owners on distinct ports"
    );

    // free a port: the waiter must claim it
    w.crash(owners[0]);
    w.clock.advance(2000);
    assert.ok(w.confirmed.get(waiter) != null, "waiter took the freed port");
  });

  it("resolves a merge conflict deterministically (lower nid keeps the port)", () => {
    const w = makeWorld([10, 20, 30]);
    // both singletons want port 10
    w.add("a:0", { priorPort: 10 });
    w.add("b:0", { priorPort: 10 });
    w.allocs.get("a:0")!.bootstrap();
    w.allocs.get("b:0")!.bootstrap();
    w.clock.advance(300); // each singleton claims 10 in its own ring

    w.clock.advance(1200); // discover + merge + reconcile

    assert.equal(w.allocs.get("a:0")!.currentMembers.length, 2);
    assert.equal(w.confirmed.get("a:0"), 10, "lower nid keeps the contested port");
    const pb = w.confirmed.get("b:0");
    assert.ok(pb != null && pb !== 10, `b moved off 10: ${pb}`);
  });
});
