/**
 * UpnpCoordinator (slice 5a) — the always-on correctness floor.
 *
 * Driven over a REAL Consensus/Group on the VirtualNetwork + ManualClock (so the
 * baton actually circulates under clock.advance) with a FAKE UpnpClientLike that
 * records calls and returns programmable results. Asserts the read-before-write
 * floor: maps a missing port, is idempotent when healthy, re-maps on a wrong host
 * or a low lease, is gated by the shared RateLimiter, surfaces failures via the
 * hook without throwing, and does nothing with no desired port.
 */

import assert from "assert/strict";
import { describe, it } from "node:test";
import { VirtualNetwork } from "@/fluxport-controller/consensus/transport";
import { ManualClock } from "@/fluxport-controller/consensus/clock";
import { Consensus, Group } from "@/fluxport-controller/consensus/consensus";
import { MembershipConfig } from "@/fluxport-controller/consensus/membership";
import {
  UpnpMapping,
  NewMapping,
  MappingQuery,
  UpnpClientLike,
  UpnpInfoLike
} from "@/fluxport-controller/upnpClient";
import { UpnpCoordinator } from "@/fluxport-controller/upnp/upnpCoordinator";

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
// The "upnp" group config the coordinator drives. Token rotation is NOT faster than
// the announce cadence so a healthy baton lap reliably hears peer multicast — the
// condition the 5c health gate needs to reach K CONSECUTIVE clean laps. (In
// production the rotation is similarly comparable to the announce interval; the raw
// FAST_TIMING rotation of 5ms vs announce 20ms is finer than any real cadence and
// would starve a higher-traffic node of per-lap multicast.) The timeout hierarchy
// (rotation ≪ retransmit < loss) is preserved.
const cfg: MembershipConfig = {
  ...FAST_TIMING,
  tokenRotationTarget: 30,
  tokenRetransmitTimeout: 120,
  tokenLossTimeout: 300
};

/** Let the async repair's microtasks run after advancing the clock (deterministic). */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * A fake serialized UPnP client: records getMapping/createMapping calls and returns
 * a programmable mapping. `mapping` is what getMapping returns; `failCreate` makes
 * createMapping reject. Only the read/write surface the coordinator uses is real.
 */
class FakeUpnpClient implements UpnpClientLike {
  getCalls: MappingQuery[] = [];
  getMappingsCalls = 0;
  createCalls: NewMapping[] = [];
  removeCalls: MappingQuery[] = [];
  /** Default getMapping result for a port NOT tracked in `byPort` — single-port tests
   *  set this directly. */
  mapping: UpnpMapping | null = null;
  /** Per-port mapping state — a real router is port-aware. getMapping consults this
   *  first (by public port) and only falls back to `mapping` for an untracked port, so
   *  single-port tests keep using `mapping`. `reflectCreates` writes here keyed by the
   *  created port, and `getMappings` (enumerate) returns its values. Set a port to null
   *  to model "this specific port is now gone". */
  byPort = new Map<number, UpnpMapping | null>();
  failCreate = false;
  /** When set, ONLY the first createMapping rejects with this message (a router that
   *  rejects a finite lease answers the first AddPortMapping then accepts ttl 0). */
  failFirstCreateWith: string | null = null;
  /** When set, a successful createMapping reflects into `byPort` (keyed by the created
   *  port) like a real router, so the next read-before-write sees its own write and
   *  skips — and OTHER ports are unaffected. */
  reflectCreates = false;
  /** A leader's enumerate (getMappings) returns this WHOLE-table view when set;
   *  otherwise it derives the table from what's been created/reflected. */
  table: UpnpMapping[] | null = null;
  /** When set, getMappings rejects — drives the leader's enumerate-failure path. */
  failGetMappings = false;
  /** createMapping rejects for any port in this set (an un-mappable port: conflict /
   *  ACL) — models a port that persistently fails its write while others succeed. */
  failCreatePorts = new Set<number>();
  /** removeMapping rejects for any port in this set (a delete that persistently fails). */
  failRemovePorts = new Set<number>();
  /** When set to a port, getMapping for THAT port suspends until releaseGet() is called —
   *  lets a test interleave a state mutation (e.g. a re-desire) mid-await. */
  gateGetPort: number | null = null;
  private gateResolve: (() => void) | null = null;

  async getGateway(): Promise<UpnpInfoLike> {
    throw new Error("unused");
  }
  async getMappings(): Promise<UpnpMapping[]> {
    this.getMappingsCalls += 1;
    if (this.failGetMappings) throw new Error("enumerate failed");
    if (this.table) return this.table;
    // Derive the table from per-port state (plus a lone `mapping` for single-port
    // tests that set it directly), so the enumerate is coherent with the writes.
    const out = [...this.byPort.values()].filter((m): m is UpnpMapping => m != null);
    if (this.mapping && !out.some((m) => m.public.port === this.mapping!.public.port)) {
      out.push(this.mapping);
    }
    return out;
  }
  async getMapping(q: MappingQuery): Promise<UpnpMapping | null> {
    this.getCalls.push(q);
    if (this.gateGetPort === q.public) {
      await new Promise<void>((resolve) => {
        this.gateResolve = resolve;
      });
    }
    if (this.byPort.has(q.public)) return this.byPort.get(q.public) ?? null;
    return this.mapping;
  }
  /** Release a getMapping suspended by gateGetPort (resolves it with current state). */
  releaseGet(): void {
    this.gateResolve?.();
    this.gateResolve = null;
  }
  async createMapping(m: NewMapping): Promise<void> {
    this.createCalls.push(m);
    if (this.failCreate) throw new Error("create failed");
    if (this.failCreatePorts.has(m.public)) throw new Error(`create failed for ${m.public}`);
    // Reject only the FIRST create (the finite-lease attempt); later creates succeed.
    if (this.failFirstCreateWith != null && this.createCalls.length === 1) {
      throw new Error(this.failFirstCreateWith);
    }
    if (this.reflectCreates) {
      this.byPort.set(m.public, {
        public: { host: "0.0.0.0", port: m.public },
        private: { ...m.private },
        protocol: m.protocol ?? "tcp",
        enabled: true,
        description: m.description ?? "Flux",
        ttl: m.ttl ?? 14400
      });
    }
  }
  async removeMapping(q: MappingQuery): Promise<void> {
    this.removeCalls.push(q);
    if (this.failRemovePorts.has(q.public)) throw new Error(`remove failed for ${q.public}`);
    // A real router drops the entry: the next read for this port returns null.
    this.byPort.set(q.public, null);
  }
}

function makeWorld() {
  const net = new VirtualNetwork();
  const clock = new ManualClock();
  const makeNode = (address: string): Consensus =>
    new Consensus(net.register(address), clock, {
      localAddress: address,
      resolveLocalAddress: async () => address,
      createTransport: (addr) => net.register(addr)
    });
  return { net, clock, makeNode };
}

function healthyMapping(port: number, host: string): UpnpMapping {
  return {
    public: { host: "0.0.0.0", port },
    private: { host, port },
    protocol: "tcp",
    enabled: true,
    description: "Flux",
    ttl: 14400
  };
}

/**
 * Build a coordinator over a freshly joined "upnp" group on the given node and
 * `start()` it (so the 5c mode machine runs). Defaults are tuned for determinism
 * under ManualClock: a SHORT self-check cycle with ONE window (slot 0) so a lone /
 * not-yet-LEADER_CHECK node repairs on its slot during the tests' small clock
 * advances, and a LONG token-stall window so the no-baton watchdog never fires
 * mid-test (the demotion tests set it explicitly). `start: false` opts out of the
 * lifecycle for the tests that assert pre-start behaviour.
 */
function makeCoordinator(
  c: Consensus,
  clock: ManualClock,
  opts: {
    self: string;
    localAddress: string;
    client: UpnpClientLike;
    rate?: number;
    capacity?: number;
    floorRate?: number;
    backoffFactor?: number;
    recoverFactor?: number;
    freshLaps?: number;
    enterLaps?: number;
    leaveLaps?: number;
    tokenStallMs?: number;
    selfCheckCycleMs?: number;
    selfCheckWindows?: number;
    orphanConfirmPasses?: number;
    start?: boolean;
    onMappingFailed?: (port: number, reason: string) => void;
  }
): { coordinator: UpnpCoordinator; group: Group } {
  const group = c.join("upnp", {
    config: cfg,
    hooks: { onDeliver: () => {}, onViewChange: () => {} }
  });
  const coordinator = new UpnpCoordinator({
    self: opts.self,
    group,
    client: opts.client,
    clock,
    localAddress: opts.localAddress,
    rate: opts.rate ?? 1000, // ample by default; specific tests pin it down
    capacity: opts.capacity ?? 1000,
    floorRate: opts.floorRate,
    backoffFactor: opts.backoffFactor,
    recoverFactor: opts.recoverFactor,
    freshLaps: opts.freshLaps,
    enterLaps: opts.enterLaps,
    leaveLaps: opts.leaveLaps,
    tokenStallMs: opts.tokenStallMs ?? 1_000_000, // effectively off unless overridden
    selfCheckCycleMs: opts.selfCheckCycleMs ?? 10,
    selfCheckWindows: opts.selfCheckWindows ?? 1,
    orphanConfirmPasses: opts.orphanConfirmPasses,
    hooks: { onMappingFailed: opts.onMappingFailed }
  });
  if (opts.start !== false) coordinator.start();
  return { coordinator, group };
}

describe("UpnpCoordinator", () => {
  it("maps a missing port exactly once on its baton turn", async () => {
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    const client = new FakeUpnpClient(); // getMapping -> null (missing)
    // Like a real router: after the create, the next read sees its own write and
    // skips — so the missing port is mapped exactly once across many baton turns.
    client.reflectCreates = true;
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "nidA",
      localAddress: "10.0.0.11",
      client
    });
    coordinator.setDesiredPortSet([16127]);

    await node.start();
    // Several turns, each settling the async repair, so a buggy non-idempotent
    // coordinator would write more than once.
    for (let i = 0; i < 6; i++) {
      w.clock.advance(50);
      await settle();
    }

    assert.equal(client.createCalls.length, 1, "mapped the missing port once");
    assert.deepEqual(client.createCalls[0].private, { host: "10.0.0.11", port: 16127 });
    assert.equal(client.createCalls[0].public, 16127);
    assert.ok(client.getCalls.length >= 1, "read before writing");
  });

  it("is idempotent: a healthy correct mapping is never re-written", async () => {
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    const client = new FakeUpnpClient();
    client.mapping = healthyMapping(16127, "10.0.0.11"); // right host, healthy ttl
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "nidA",
      localAddress: "10.0.0.11",
      client
    });
    coordinator.setDesiredPortSet([16127]);

    await node.start();
    // Many batons pass; read-before-write skips every one.
    w.clock.advance(500);
    await settle();
    w.clock.advance(500);
    await settle();

    assert.ok(client.getCalls.length > 1, "read on multiple turns");
    assert.equal(client.createCalls.length, 0, "no write for a healthy mapping");
  });

  it("re-maps when the existing mapping points at the wrong host", async () => {
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    const client = new FakeUpnpClient();
    client.mapping = healthyMapping(16127, "10.0.0.99"); // someone else's / stale
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "nidA",
      localAddress: "10.0.0.11",
      client
    });
    coordinator.setDesiredPortSet([16127]);

    await node.start();
    w.clock.advance(200);
    await settle();

    assert.ok(client.createCalls.length >= 1, "repaired the wrong-host mapping");
    assert.deepEqual(client.createCalls[0].private, { host: "10.0.0.11", port: 16127 });
  });

  it("re-maps when the existing mapping's lease is running low", async () => {
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    const client = new FakeUpnpClient();
    const low = healthyMapping(16127, "10.0.0.11");
    low.ttl = 10; // below the default lowTtlThreshold (14400/4 = 3600)
    client.mapping = low;
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "nidA",
      localAddress: "10.0.0.11",
      client
    });
    coordinator.setDesiredPortSet([16127]);

    await node.start();
    w.clock.advance(200);
    await settle();

    assert.ok(client.createCalls.length >= 1, "refreshed the low-ttl mapping");
  });

  it("rate-gates writes: with capacity 1, rate 0 only one write happens in the burst", async () => {
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    // getMapping stays null forever, so a write is "needed" on EVERY baton turn —
    // the only thing capping writes is the RateLimiter budget. With capacity 1 and
    // rate 0, exactly one token is ever available (no refill), so exactly one
    // createMapping happens no matter how many turns pass.
    const client = new FakeUpnpClient();
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "nidA",
      localAddress: "10.0.0.11",
      client,
      rate: 0,
      capacity: 1
    });
    coordinator.setDesiredPortSet([16127]);

    await node.start();
    // Many settled turns: getMapping never reflects a write, so a repair is needed
    // EVERY turn (reads keep climbing), yet the one token caps writes at one.
    for (let i = 0; i < 8; i++) {
      w.clock.advance(50);
      await settle();
    }

    assert.ok(client.getCalls.length > 2, "kept reading every turn (write always needed)");
    assert.equal(
      client.createCalls.length,
      1,
      "the single token caps writes at one until the budget would refill"
    );
  });

  it("surfaces a create failure via onMappingFailed without throwing", async () => {
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    const client = new FakeUpnpClient();
    client.failCreate = true; // getMapping null -> write attempted -> rejects
    const failed: Array<{ port: number; reason: string }> = [];
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "nidA",
      localAddress: "10.0.0.11",
      client,
      onMappingFailed: (port, reason) => failed.push({ port, reason })
    });
    coordinator.setDesiredPortSet([16127]);

    await node.start();
    w.clock.advance(200);
    await settle();

    assert.ok(client.createCalls.length >= 1, "a write was attempted");
    assert.ok(failed.length >= 1, "onMappingFailed fired");
    assert.equal(failed[0].port, 16127);
    assert.match(failed[0].reason, /create failed/);
  });

  it("does nothing when no desired port is set", async () => {
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    const client = new FakeUpnpClient();
    makeCoordinator(node, w.clock, {
      self: "nidA",
      localAddress: "10.0.0.11",
      client
    });
    // never call setDesiredPortSet

    await node.start();
    w.clock.advance(500);
    await settle();

    assert.equal(client.getCalls.length, 0, "no read with no desired port");
    assert.equal(client.createCalls.length, 0, "no write with no desired port");
  });
});

/**
 * UpnpCoordinator (desired port SET) — a node maintains its WHOLE desired set, not a
 * single port. Each port is read-before-written independently, the RateLimiter budget
 * is spent per WRITE across the set, dropping a port stops maintaining it, and the
 * per-router permanent-lease latch is shared across every port. Driven as lone
 * SELF_CHECK nodes (the slot timer paces the repairs) — the per-port leader-check skip
 * lives with the other 5b leader tests below.
 */
describe("UpnpCoordinator (desired port SET)", () => {
  /** Settle several slot laps so the lone node's slot-driven repairs run. */
  const runLaps = async (clock: ManualClock, n = 8): Promise<void> => {
    for (let i = 0; i < n; i++) {
      clock.advance(50);
      await settle();
    }
  };

  it("maps every missing port in the set exactly once", async () => {
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    const client = new FakeUpnpClient(); // every port reads missing until created
    client.reflectCreates = true; // each create sticks per-port, so it is mapped once
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "nidA",
      localAddress: "10.0.0.11",
      client
    });
    coordinator.setDesiredPortSet([16111, 16222, 16333]);

    await node.start();
    await runLaps(w.clock);

    const created = client.createCalls.map((c) => c.public).sort((a, b) => a - b);
    assert.deepEqual(created, [16111, 16222, 16333], "each missing port mapped exactly once");
    for (const c of client.createCalls) {
      assert.equal(c.private.host, "10.0.0.11", "self-map-only: every create points at us");
      assert.equal(c.private.port, c.public, "private port mirrors the public port");
    }
  });

  it("repairs only the unhealthy ports and leaves the healthy ones untouched", async () => {
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    const client = new FakeUpnpClient();
    client.reflectCreates = true;
    // 16111 already healthy; 16222 missing; 16333 points at the wrong host.
    client.byPort.set(16111, healthyMapping(16111, "10.0.0.11"));
    client.byPort.set(16222, null);
    client.byPort.set(16333, healthyMapping(16333, "10.0.0.99"));
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "nidA",
      localAddress: "10.0.0.11",
      client
    });
    coordinator.setDesiredPortSet([16111, 16222, 16333]);

    await node.start();
    await runLaps(w.clock);

    const created = client.createCalls.map((c) => c.public).sort((a, b) => a - b);
    assert.deepEqual(created, [16222, 16333], "wrote only the missing and the wrong-host ports");
    assert.ok(
      client.getCalls.some((q) => q.public === 16111),
      "still read the healthy port (read-before-write); it just needed no write"
    );
  });

  it("spends one rate token per WRITE across the set, not one per turn", async () => {
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    // All three ports read missing forever (no reflect), so a write is always needed;
    // capacity 1 + rate 0 means exactly ONE token ever exists, so across the WHOLE set
    // only one write happens — yet every port is still read every pass.
    const client = new FakeUpnpClient();
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "nidA",
      localAddress: "10.0.0.11",
      client,
      rate: 0,
      capacity: 1
    });
    coordinator.setDesiredPortSet([16111, 16222, 16333]);

    await node.start();
    await runLaps(w.clock);

    assert.equal(client.createCalls.length, 1, "the single token caps writes across the whole set");
    for (const port of [16111, 16222, 16333]) {
      assert.ok(
        client.getCalls.some((q) => q.public === port),
        `read ${port} before writing — the budget gates the write, not the read`
      );
    }
  });

  it("prunes a port dropped from the set (read-before-delete) and never re-maps it", async () => {
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    const client = new FakeUpnpClient();
    client.reflectCreates = true;
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "nidA",
      localAddress: "10.0.0.11",
      client,
      orphanConfirmPasses: 0 // prune promptly so the delete is observed without the grace
    });
    coordinator.setDesiredPortSet([16111, 16222]);

    await node.start();
    await runLaps(w.clock);
    assert.deepEqual(
      client.createCalls.map((c) => c.public).sort((a, b) => a - b),
      [16111, 16222],
      "both ports mapped while desired"
    );

    // Drop 16222: it is now an orphan — its OWN mapping is pruned on a later turn, and it
    // is never re-mapped. 16111 stays maintained.
    coordinator.setDesiredPortSet([16111]);
    client.getCalls.length = 0;
    client.createCalls.length = 0;
    await runLaps(w.clock);

    assert.deepEqual(
      client.removeCalls.map((q) => q.public),
      [16222],
      "the dropped port's own mapping was deleted, exactly once"
    );
    assert.ok(
      client.getCalls.some((q) => q.public === 16111),
      "the still-desired port is still maintained (read-before-write)"
    );
    assert.equal(
      client.createCalls.length,
      0,
      "nothing was re-mapped — neither the healthy 16111 nor the pruned 16222"
    );
    assert.deepEqual(coordinator.pendingUnmaps, [], "the orphan queue drained");
  });

  it("shares the permanent-lease latch across every port (one 725 covers the whole set)", async () => {
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    const client = new FakeUpnpClient(); // both ports missing
    // The FIRST create (16111, finite) is rejected 725; the latch then makes 16222 go
    // straight to ttl 0 — a 725 is a per-ROUTER property, not per-port.
    client.failFirstCreateWith = "soap:Client 725 OnlyPermanentLeasesSupported";
    client.reflectCreates = true;
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "nidA",
      localAddress: "10.0.0.11",
      client
    });
    coordinator.setDesiredPortSet([16111, 16222]); // 16111 is iterated first (insertion order)

    await node.start();
    await runLaps(w.clock);

    assert.equal(coordinator.leasePermanent, true, "the 725 latched permanent for the node");
    const for16111 = client.createCalls.filter((c) => c.public === 16111).map((c) => c.ttl);
    const for16222 = client.createCalls.filter((c) => c.public === 16222).map((c) => c.ttl);
    assert.deepEqual(for16111, [14400, 0], "16111: finite attempt, then the permanent retry");
    assert.deepEqual(for16222, [0], "16222: created permanent directly — no second 725");
  });

  it("shares a constrained rate budget FAIRLY — a failing front port does not starve the rest", async () => {
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    const client = new FakeUpnpClient(); // every port missing
    client.reflectCreates = true;
    // 16111 is un-mappable: its create ALWAYS throws, so it spends (sinks) a token every
    // time it is attempted. With a tight budget (capacity 1) and a FIXED front-to-back
    // walk, 16111 would consume the lone token every pass and 16222/16333 would NEVER be
    // written. The rotating cursor must rotate the head so the tail ports still get mapped.
    client.failCreatePorts = new Set([16111]);
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "nidA",
      localAddress: "10.0.0.11",
      client,
      rate: 1000, // refills the bucket each pass...
      capacity: 1 // ...but only ever ONE token at a time, so one write per pass
    });
    coordinator.setDesiredPortSet([16111, 16222, 16333]);

    await node.start();
    await runLaps(w.clock, 12);

    const n = (port: number): number => client.createCalls.filter((c) => c.public === port).length;
    assert.ok(n(16111) >= 1, "the un-mappable front port kept being attempted");
    assert.equal(n(16222), 1, "the tail port 16222 was still mapped (once) despite the token sink");
    assert.equal(n(16333), 1, "the tail port 16333 was still mapped (once) despite the token sink");
  });

  it("re-maps a port evicted mid-run (router reboot) and leaves the others untouched", async () => {
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    const client = new FakeUpnpClient();
    client.reflectCreates = true;
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "nidA",
      localAddress: "10.0.0.11",
      client
    });
    coordinator.setDesiredPortSet([16111, 16222, 16333]);

    await node.start();
    await runLaps(w.clock);
    assert.equal(client.createCalls.length, 3, "all three mapped, then steady (zero further writes)");
    client.createCalls.length = 0;
    client.getCalls.length = 0;

    // The router drops ONLY 16222 (a targeted eviction); read-before-write must re-map
    // exactly that port and leave the two still-healthy ones untouched.
    client.byPort.set(16222, null);
    await runLaps(w.clock);

    assert.deepEqual(
      client.createCalls.map((c) => c.public),
      [16222],
      "re-mapped only the evicted port, exactly once"
    );
  });
});

/**
 * UpnpCoordinator (slice 5b) — leader-check read reduction.
 *
 * Drives 2+ nodes on ONE VirtualNetwork so a REAL representative is elected. The
 * membership identity is the LAN address (as in production, where `self` ===
 * localAddress), so the lowest address is the ring representative and thus the
 * leader. We pick addresses to control which node leads. Each node has its OWN
 * FakeUpnpClient so per-node reads/writes are asserted independently — the key win
 * being that a non-leader does ZERO targeted reads (getMapping) when a fresh leader
 * enumerate already shows its port healthy.
 */
describe("UpnpCoordinator (5b leader-check)", () => {
  /** Settle several baton laps so the leader broadcasts and peers act on it. */
  const runLaps = async (clock: ManualClock, n = 12): Promise<void> => {
    for (let i = 0; i < n; i++) {
      clock.advance(20);
      await settle();
    }
  };

  /**
   * Advance until the cohort has merged into ONE ring, every node has entered
   * LEADER_CHECK (K clean laps — multicast actually flowing), AND every non-leader
   * has received a fresh leader broadcast, then zero the per-client counters. During
   * bootstrap each node is briefly a singleton in SELF_CHECK — its own leader, doing
   * slot-driven self-checks — and a non-leader's first turns precede the first
   * OBSERVED; both are correct but irrelevant to the steady-state skip we assert, so
   * we measure only after the ring has formed, the mode is LEADER_CHECK (so the slot
   * timer is dormant and adds no stray reads), and the broadcast has landed.
   */
  const formRingAndReset = async (
    clock: ManualClock,
    nodes: Array<{ coordinator: UpnpCoordinator; client: FakeUpnpClient }>
  ): Promise<void> => {
    const settled = (): boolean => {
      const rep = nodes[0].coordinator.representative;
      const oneRing = rep != null && nodes.every((n) => n.coordinator.representative === rep);
      const inLeaderCheck = nodes.every((n) => n.coordinator.currentMode === "LEADER_CHECK");
      const fed = nodes.every((n) => n.coordinator.isLeader || n.coordinator.observedFresh);
      return oneRing && inLeaderCheck && fed;
    };
    for (let i = 0; i < 80 && !settled(); i++) {
      clock.advance(20);
      await settle();
    }
    assert.ok(settled(), "ring formed and the leader broadcast reached the non-leaders");
    // Exactly one node leads the formed ring.
    assert.equal(nodes.filter((n) => n.coordinator.isLeader).length, 1, "one leader once the ring forms");
    for (const n of nodes) {
      n.client.getCalls.length = 0;
      n.client.createCalls.length = 0;
      n.client.getMappingsCalls = 0;
    }
  };

  it("elects the lowest-address node leader; leader enumerates + broadcasts, non-leader receives", async () => {
    const w = makeWorld();
    // .10 < .20 so .10 is the representative (leader). self === localAddress so the
    // coordinator's leader check (representative === self) matches the ring.
    const lead = w.makeNode("10.0.0.10");
    const peer = w.makeNode("10.0.0.20");
    const leadClient = new FakeUpnpClient();
    const peerClient = new FakeUpnpClient();
    // Leader's enumerate returns the whole table, including the peer's healthy port.
    leadClient.table = [
      healthyMapping(16111, "10.0.0.10"),
      healthyMapping(16222, "10.0.0.20")
    ];
    leadClient.mapping = healthyMapping(16111, "10.0.0.10"); // leader's own read sees itself

    const lc = makeCoordinator(lead, w.clock, {
      self: "10.0.0.10",
      localAddress: "10.0.0.10",
      client: leadClient
    });
    const pc = makeCoordinator(peer, w.clock, {
      self: "10.0.0.20",
      localAddress: "10.0.0.20",
      client: peerClient,
      // The leader broadcasts once per ring lap and the peer may take several turns
      // between; a generous freshness window keeps one broadcast trusted across the
      // measured laps so the skip is observed cleanly (expiry is covered elsewhere).
      freshLaps: 50
    });
    lc.coordinator.setDesiredPortSet([16111]);
    pc.coordinator.setDesiredPortSet([16222]);

    await lead.start();
    await peer.start();
    await formRingAndReset(w.clock, [
      { coordinator: lc.coordinator, client: leadClient },
      { coordinator: pc.coordinator, client: peerClient }
    ]);
    await runLaps(w.clock);

    assert.equal(lc.coordinator.isLeader, true, "lowest address is the leader");
    assert.equal(pc.coordinator.isLeader, false, "the other node is a non-leader");
    assert.ok(leadClient.getMappingsCalls >= 1, "leader enumerated the whole table");
    // The peer received the broadcast and trusted it: it skipped its own read.
    assert.equal(peerClient.getCalls.length, 0, "non-leader received OBSERVED and skipped its read");
    // The leader keeps its OWN mapping via its own read-before-write, never via the
    // broadcast it sent (it ignores its own OBSERVED) — its targeted read still ran.
    assert.ok(leadClient.getCalls.length >= 1, "leader checks its own port itself, not via its broadcast");
  });

  it("non-leader SKIPS the targeted read when OBSERVED shows its port healthy", async () => {
    const w = makeWorld();
    const lead = w.makeNode("10.0.0.10");
    const peer = w.makeNode("10.0.0.20");
    const leadClient = new FakeUpnpClient();
    const peerClient = new FakeUpnpClient();
    // Enumerate shows the peer's port healthy; the peer must therefore do NO I/O.
    leadClient.table = [healthyMapping(16222, "10.0.0.20")];

    const lc = makeCoordinator(lead, w.clock, {
      self: "10.0.0.10",
      localAddress: "10.0.0.10",
      client: leadClient
    });
    lc.coordinator.setDesiredPortSet([16111]);
    const pc = makeCoordinator(peer, w.clock, {
      self: "10.0.0.20",
      localAddress: "10.0.0.20",
      client: peerClient,
      freshLaps: 50 // one broadcast stays trusted across the measured laps (see above)
    });
    pc.coordinator.setDesiredPortSet([16222]);

    await lead.start();
    await peer.start();
    await formRingAndReset(w.clock, [
      { coordinator: lc.coordinator, client: leadClient },
      { coordinator: pc.coordinator, client: peerClient }
    ]);
    await runLaps(w.clock);

    assert.equal(peerClient.getCalls.length, 0, "the read-reduction win: no targeted read");
    assert.equal(peerClient.createCalls.length, 0, "and no write — its port was already healthy");
    assert.equal(peerClient.getMappingsCalls, 0, "a non-leader never enumerates either");
  });

  it("non-leader REPAIRS via its own read-before-write when OBSERVED omits its port", async () => {
    const w = makeWorld();
    const lead = w.makeNode("10.0.0.10");
    const peer = w.makeNode("10.0.0.20");
    const leadClient = new FakeUpnpClient();
    const peerClient = new FakeUpnpClient();
    // Enumerate WITHOUT the peer's port — only the leader's own. The broadcast tells
    // the peer "you're not mapped", so it falls back to its 5a read-before-write.
    leadClient.table = [healthyMapping(16111, "10.0.0.10")];
    peerClient.mapping = null; // the peer's own read confirms its port is missing
    peerClient.reflectCreates = true; // a real router: the create then sticks (mapped once)

    const lc = makeCoordinator(lead, w.clock, {
      self: "10.0.0.10",
      localAddress: "10.0.0.10",
      client: leadClient
    });
    lc.coordinator.setDesiredPortSet([16111]);
    const pc = makeCoordinator(peer, w.clock, {
      self: "10.0.0.20",
      localAddress: "10.0.0.20",
      client: peerClient
    });
    pc.coordinator.setDesiredPortSet([16222]);

    await lead.start();
    await peer.start();
    // The leader's table never reflects the peer's create, so each post-ring lap the
    // OBSERVED still omits the peer's port — it can never skip; it must repair itself.
    await formRingAndReset(w.clock, [
      { coordinator: lc.coordinator, client: leadClient },
      { coordinator: pc.coordinator, client: peerClient }
    ]);
    // Re-clear this port's reflected mapping so the post-reset read confirms it missing.
    peerClient.byPort.set(16222, null);
    await runLaps(w.clock);

    assert.ok(peerClient.getCalls.length >= 1, "non-leader did its OWN read-before-write");
    assert.equal(peerClient.createCalls.length, 1, "and repaired its missing port exactly once");
    assert.deepEqual(peerClient.createCalls[0].private, { host: "10.0.0.20", port: 16222 });
  });

  it("falls back to the 5a self-check when no OBSERVED is fresh", async () => {
    const w = makeWorld();
    // A lone node with no leader peer driving it: there is never an OBSERVED to
    // trust, so even though it is itself the (singleton) representative it keeps the
    // 5a floor. We give it a missing mapping and confirm it reads-then-writes.
    const node = w.makeNode("10.0.0.30");
    const client = new FakeUpnpClient();
    client.reflectCreates = true; // mapped once, then steady
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "10.0.0.30",
      localAddress: "10.0.0.30",
      client
    });
    coordinator.setDesiredPortSet([16333]);

    await node.start();
    await runLaps(w.clock);

    // A singleton IS its own representative, so it enumerates AND keeps its own
    // mapping via the 5a read-before-write — never trusting any (absent) broadcast.
    assert.equal(coordinator.isLeader, true, "a singleton is its own representative");
    assert.ok(client.getCalls.length >= 1, "self-check read happened (no OBSERVED to skip on)");
    assert.equal(client.createCalls.length, 1, "mapped its missing port once via the 5a floor");
  });

  it("decides the skip PER PORT — skips a healthy observed port, repairs an omitted one", async () => {
    const w = makeWorld();
    const lead = w.makeNode("10.0.0.10");
    const peer = w.makeNode("10.0.0.20");
    const leadClient = new FakeUpnpClient();
    const peerClient = new FakeUpnpClient();
    // The leader's enumerate shows the peer's 16221 healthy but OMITS its 16222, so the
    // peer must skip ONE port's read and fall back to read-before-write for the other.
    leadClient.table = [
      healthyMapping(16110, "10.0.0.10"),
      healthyMapping(16221, "10.0.0.20")
    ];
    leadClient.mapping = healthyMapping(16110, "10.0.0.10");
    peerClient.reflectCreates = true;
    peerClient.byPort.set(16221, healthyMapping(16221, "10.0.0.20")); // healthy if ever read
    peerClient.byPort.set(16222, null); // missing — the peer must repair it itself

    const lc = makeCoordinator(lead, w.clock, {
      self: "10.0.0.10",
      localAddress: "10.0.0.10",
      client: leadClient
    });
    lc.coordinator.setDesiredPortSet([16110]);
    const pc = makeCoordinator(peer, w.clock, {
      self: "10.0.0.20",
      localAddress: "10.0.0.20",
      client: peerClient,
      freshLaps: 50 // one broadcast stays trusted across the measured laps
    });
    pc.coordinator.setDesiredPortSet([16221, 16222]);

    await lead.start();
    await peer.start();
    await formRingAndReset(w.clock, [
      { coordinator: lc.coordinator, client: leadClient },
      { coordinator: pc.coordinator, client: peerClient }
    ]);
    // The peer may have already mapped 16222 during ring formation; re-clear it so the
    // post-reset read confirms it missing and the single repair is observed cleanly.
    peerClient.byPort.set(16222, null);
    await runLaps(w.clock);

    assert.equal(
      peerClient.getCalls.filter((q) => q.public === 16221).length,
      0,
      "skipped the read for the port a fresh OBSERVED showed healthy"
    );
    assert.ok(
      peerClient.getCalls.filter((q) => q.public === 16222).length >= 1,
      "read-before-write the port OBSERVED omitted"
    );
    assert.deepEqual(
      peerClient.createCalls.map((c) => c.public),
      [16222],
      "and repaired only that omitted port, exactly once"
    );
  });

  it("does NOT skip on a same-port entry of a DIFFERENT protocol (protocol-scoped skip)", async () => {
    const w = makeWorld();
    const lead = w.makeNode("10.0.0.10");
    const peer = w.makeNode("10.0.0.20");
    const leadClient = new FakeUpnpClient();
    const peerClient = new FakeUpnpClient();
    // The enumerate carries a UDP mapping for the peer on the SAME port number it wants
    // on TCP. That must NOT count as the peer's TCP port being healthy — the skip is as
    // protocol-scoped as the targeted read it short-circuits, so the peer must still
    // read-before-write its genuinely-missing TCP mapping.
    leadClient.table = [
      healthyMapping(16110, "10.0.0.10"),
      { ...healthyMapping(16222, "10.0.0.20"), protocol: "udp" }
    ];
    leadClient.mapping = healthyMapping(16110, "10.0.0.10");
    peerClient.reflectCreates = true;
    peerClient.byPort.set(16222, null); // its TCP 16222 is actually missing

    const lc = makeCoordinator(lead, w.clock, {
      self: "10.0.0.10",
      localAddress: "10.0.0.10",
      client: leadClient
    });
    lc.coordinator.setDesiredPortSet([16110]);
    const pc = makeCoordinator(peer, w.clock, {
      self: "10.0.0.20",
      localAddress: "10.0.0.20",
      client: peerClient,
      freshLaps: 50
    });
    pc.coordinator.setDesiredPortSet([16222]); // protocol defaults to tcp

    await lead.start();
    await peer.start();
    await formRingAndReset(w.clock, [
      { coordinator: lc.coordinator, client: leadClient },
      { coordinator: pc.coordinator, client: peerClient }
    ]);
    peerClient.byPort.set(16222, null); // re-confirm missing after any formation write
    await runLaps(w.clock);

    assert.ok(
      peerClient.getCalls.filter((q) => q.public === 16222).length >= 1,
      "the UDP entry did NOT satisfy the TCP skip — the peer still read its own port"
    );
    assert.deepEqual(
      peerClient.createCalls.map((c) => c.public),
      [16222],
      "and repaired its genuinely-missing TCP mapping (the protocol-blind false-skip is gone)"
    );
    assert.equal(peerClient.createCalls[0].protocol, "tcp", "self-mapped on its own protocol");
  });

  it("leader maintains its WHOLE own multi-port set — maps each missing own port once, healthy ones untouched", async () => {
    const w = makeWorld();
    const lead = w.makeNode("10.0.0.10");
    const peer = w.makeNode("10.0.0.20");
    const leadClient = new FakeUpnpClient();
    const peerClient = new FakeUpnpClient();
    leadClient.reflectCreates = true;
    // The leader holds three OWN ports: 16110 healthy, 16111 missing, 16112 wrong-host.
    leadClient.byPort.set(16110, healthyMapping(16110, "10.0.0.10"));
    leadClient.byPort.set(16111, null);
    leadClient.byPort.set(16112, healthyMapping(16112, "10.0.0.99"));
    peerClient.byPort.set(16220, healthyMapping(16220, "10.0.0.20")); // peer stays quiet

    const lc = makeCoordinator(lead, w.clock, {
      self: "10.0.0.10",
      localAddress: "10.0.0.10",
      client: leadClient
    });
    lc.coordinator.setDesiredPortSet([16110, 16111, 16112]);
    const pc = makeCoordinator(peer, w.clock, {
      self: "10.0.0.20",
      localAddress: "10.0.0.20",
      client: peerClient,
      freshLaps: 50
    });
    pc.coordinator.setDesiredPortSet([16220]);

    await lead.start();
    await peer.start();
    await formRingAndReset(w.clock, [
      { coordinator: lc.coordinator, client: leadClient },
      { coordinator: pc.coordinator, client: peerClient }
    ]);
    // Re-establish the leader's repair targets after the reset (ring formation may have
    // mapped them) so the steady-state leader scan provably maps each missing own port.
    leadClient.byPort.set(16111, null);
    leadClient.byPort.set(16112, healthyMapping(16112, "10.0.0.99"));
    await runLaps(w.clock);

    assert.equal(lc.coordinator.isLeader, true, "lowest address is the leader");
    assert.ok(leadClient.getMappingsCalls >= 1, "the leader enumerated the whole table for the cohort");
    assert.deepEqual(
      leadClient.createCalls.map((c) => c.public).sort((a, b) => a - b),
      [16111, 16112],
      "leader mapped ONLY its missing/wrong-host own ports, each once (16110 healthy, untouched)"
    );
    for (const c of leadClient.createCalls) {
      assert.equal(c.private.host, "10.0.0.10", "self-map-only: the leader maps only its own host");
    }
  });
});

/**
 * UpnpCoordinator (5c mode machine) — LEADER_CHECK / SELF_CHECK with asymmetric
 * hysteresis and the autonomous self-check slot.
 *
 * Two test styles, by what each one needs to control:
 *  - The "enters LEADER_CHECK after K clean laps" and "self-check repairs on the
 *    slot" tests drive a REAL Consensus/Group ring (multicast genuinely flows, the
 *    slot timer genuinely fires) — the highest-fidelity proof.
 *  - The deaf-latent / token-stall / anti-flap tests need to drive batons WHILE
 *    controlling the multicast-evidence count precisely (a deaf-but-latent node:
 *    unicast token keeps arriving, peer multicast does not). Reproducing "token in,
 *    multicast stalled" against a real Group over a virtual net is not directly
 *    controllable, so they use a thin FakeGroup seam that captures the coordinator's
 *    onTokenGranted hook and exposes a settable `multicastReceivedCount`. The seam
 *    is the SAME surface the real Group exposes (bindHooks/broadcast/representative/
 *    members/multicastReceivedCount), so it exercises the real mode machine — only
 *    the ring-health SOURCE is faked, which is exactly the variable under test.
 */

/** Minimal stand-in for `Group` exposing only what UpnpCoordinator uses, with a
 *  settable multicast count and a captured token-grant hook to "deliver" batons. */
class FakeGroup {
  private granted: () => void = () => {};
  private delivered: (payload: unknown) => void = () => {};
  multicast = 0; // the controllable ring-health evidence
  rep: string | null = null;
  memberList: string[] = [];
  broadcasts: unknown[] = [];

  bindHooks(hooks: {
    onTokenGranted?: () => void;
    onDeliver?: (payload: unknown) => void;
  }): void {
    if (hooks.onTokenGranted) this.granted = hooks.onTokenGranted;
    if (hooks.onDeliver) this.delivered = hooks.onDeliver;
  }
  /** Deliver an ordered-broadcast payload (e.g. a leader's OBSERVED) to the coordinator. */
  deliver(payload: unknown): void {
    this.delivered(payload);
  }
  broadcast(payload: unknown): void {
    this.broadcasts.push(payload);
  }
  get representative(): string | null {
    return this.rep;
  }
  get members(): string[] {
    return this.memberList;
  }
  get multicastReceivedCount(): number {
    return this.multicast;
  }
  /** Deliver one baton (a "lap"); the coordinator samples health against `multicast`. */
  baton(): void {
    this.granted();
  }
}

describe("UpnpCoordinator (5c mode machine)", () => {
  /** Build a coordinator over a FakeGroup seam (deterministic ring-health control). */
  const seamCoordinator = (
    clock: ManualClock,
    opts: {
      self?: string;
      client?: UpnpClientLike;
      enterLaps?: number;
      leaveLaps?: number;
      tokenStallMs?: number;
      selfCheckCycleMs?: number;
      selfCheckWindows?: number;
    } = {}
  ): { coordinator: UpnpCoordinator; group: FakeGroup; client: FakeUpnpClient } => {
    const group = new FakeGroup();
    const client = (opts.client as FakeUpnpClient) ?? new FakeUpnpClient();
    const coordinator = new UpnpCoordinator({
      self: opts.self ?? "nidA",
      group: group as unknown as Group,
      client,
      clock,
      localAddress: "10.0.0.11",
      rate: 1000,
      capacity: 1000,
      enterLaps: opts.enterLaps,
      leaveLaps: opts.leaveLaps,
      tokenStallMs: opts.tokenStallMs ?? 1_000_000,
      selfCheckCycleMs: opts.selfCheckCycleMs ?? 1_000_000,
      selfCheckWindows: opts.selfCheckWindows ?? 1
    });
    return { coordinator, group, client };
  };

  /** Deliver one clean lap: advance the multicast count, then a baton. */
  const cleanLap = (group: FakeGroup): void => {
    group.multicast += 1;
    group.baton();
  };
  /** Deliver one deaf lap: a baton arrives but the multicast count does NOT advance. */
  const deafLap = (group: FakeGroup): void => {
    group.baton();
  };

  it("starts in SELF_CHECK and enters LEADER_CHECK only after K clean laps on a healthy ring", async () => {
    // High-fidelity: a real 2-node ring so multicast genuinely flows and the count
    // advances; assert the startup mode and the K-clean-laps transition.
    const w = makeWorld();
    const a = w.makeNode("10.0.0.10");
    const b = w.makeNode("10.0.0.20");
    const ca = makeCoordinator(a, w.clock, {
      self: "10.0.0.10",
      localAddress: "10.0.0.10",
      client: new FakeUpnpClient(),
      enterLaps: 3
    });
    const cb = makeCoordinator(b, w.clock, {
      self: "10.0.0.20",
      localAddress: "10.0.0.20",
      client: new FakeUpnpClient(),
      enterLaps: 3
    });
    ca.coordinator.setDesiredPortSet([16111]);
    cb.coordinator.setDesiredPortSet([16222]);

    // Default: never trust a ring we have not seen circulate.
    assert.equal(ca.coordinator.currentMode, "SELF_CHECK", "node A starts in SELF_CHECK");
    assert.equal(cb.coordinator.currentMode, "SELF_CHECK", "node B starts in SELF_CHECK");

    await a.start();
    await b.start();
    // Drive enough laps for the ring to form and K clean laps to accrue.
    const bothInLeaderCheck = (): boolean =>
      ca.coordinator.currentMode === "LEADER_CHECK" &&
      cb.coordinator.currentMode === "LEADER_CHECK";
    for (let i = 0; i < 60 && !bothInLeaderCheck(); i++) {
      w.clock.advance(20);
      await settle();
    }
    assert.equal(ca.coordinator.currentMode, "LEADER_CHECK", "A entered LEADER_CHECK on a healthy ring");
    assert.equal(cb.coordinator.currentMode, "LEADER_CHECK", "B entered LEADER_CHECK on a healthy ring");
  });

  it("self-check repairs on its slot with no leader or peer (bootstrap correctness)", async () => {
    // A lone node, never reaching LEADER_CHECK, still repairs autonomously on its
    // wall-clock slot — zero external info needed. We use a real lone node + the slot
    // timer (NOT the seam) so the slot derivation/arming is genuinely exercised.
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    const client = new FakeUpnpClient(); // getMapping -> null (missing)
    client.reflectCreates = true; // a real router: mapped once, then steady
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "nidLone",
      localAddress: "10.0.0.11",
      client,
      selfCheckCycleMs: 800,
      selfCheckWindows: 4
    });
    coordinator.setDesiredPortSet([16127]);

    await node.start();
    assert.equal(coordinator.currentMode, "SELF_CHECK", "a lone node never trusts a ring");

    const slot = coordinator.selfCheckSlot;
    assert.ok(slot >= 0 && slot < 4, "slot is within the window count");

    // Advance past two full cycles so this node's slot fires at least once.
    for (let i = 0; i < 5; i++) {
      w.clock.advance(800);
      await settle();
    }

    assert.equal(coordinator.currentMode, "SELF_CHECK", "still SELF_CHECK — no ring ever seen");
    assert.ok(client.getCalls.length >= 1, "self-check read happened on the slot");
    assert.equal(client.createCalls.length, 1, "mapped its missing port once via the slot self-check");
    assert.deepEqual(client.createCalls[0].private, { host: "10.0.0.11", port: 16127 });
  });

  it("demotes a deaf-but-latent node LEADER_CHECK -> SELF_CHECK after M deaf laps, then self-checks on its slot", async () => {
    // The motivating scenario: the unicast token keeps arriving (batons fire) but the
    // multicast count STOPS advancing. The token alone must NOT keep the node in
    // LEADER_CHECK — the multicast-evidence gate catches the deaf node. The seam lets
    // us hold `multicast` fixed while still delivering batons.
    const clock = new ManualClock();
    const client = new FakeUpnpClient();
    client.reflectCreates = true;
    const { coordinator, group } = seamCoordinator(clock, {
      client,
      enterLaps: 3,
      leaveLaps: 5,
      selfCheckCycleMs: 100,
      selfCheckWindows: 1
    });
    coordinator.setDesiredPortSet([16127]);
    coordinator.start();

    // Climb into LEADER_CHECK on clean laps.
    for (let i = 0; i < 3; i++) cleanLap(group);
    assert.equal(coordinator.currentMode, "LEADER_CHECK", "K clean laps -> LEADER_CHECK");

    // Now deaf-but-latent: batons keep arriving, multicast count frozen. Below M it
    // must still be LEADER_CHECK (the token is still circulating).
    for (let i = 0; i < 4; i++) deafLap(group);
    assert.equal(coordinator.currentMode, "LEADER_CHECK", "4 deaf laps (< M=5) does not demote");

    // The Mth consecutive deaf lap demotes — the deaf node abandons the ring.
    deafLap(group);
    assert.equal(coordinator.currentMode, "SELF_CHECK", "M deaf laps -> SELF_CHECK despite live batons");

    // And it now repairs autonomously on its slot (clear any prior write first).
    client.createCalls.length = 0;
    client.byPort.set(16127, null); // drop the reflected mapping so the slot re-maps
    clock.advance(100); // cross the slot
    await settle();
    assert.ok(client.createCalls.length >= 1, "demoted node self-checks on its slot");
  });

  it("demotes to SELF_CHECK when the baton stalls (token stops circulating)", async () => {
    const clock = new ManualClock();
    const { coordinator, group } = seamCoordinator(clock, {
      enterLaps: 3,
      leaveLaps: 5,
      tokenStallMs: 200,
      selfCheckCycleMs: 1_000_000 // keep the slot out of the way
    });
    coordinator.setDesiredPortSet([16127]);
    coordinator.start();

    for (let i = 0; i < 3; i++) cleanLap(group);
    assert.equal(coordinator.currentMode, "LEADER_CHECK", "healthy laps -> LEADER_CHECK");

    // No more batons: the token-stall watchdog should fire and demote.
    clock.advance(200);
    assert.equal(coordinator.currentMode, "SELF_CHECK", "no baton for tokenStallMs -> SELF_CHECK");
  });

  it("anti-flap: a single deaf lap below M does not demote", async () => {
    const clock = new ManualClock();
    const { coordinator, group } = seamCoordinator(clock, {
      enterLaps: 3,
      leaveLaps: 5
    });
    coordinator.setDesiredPortSet([16127]);
    coordinator.start();

    for (let i = 0; i < 3; i++) cleanLap(group);
    assert.equal(coordinator.currentMode, "LEADER_CHECK", "in LEADER_CHECK");

    // One deaf lap (a routine reconfiguration blip) then clean again: stays put.
    deafLap(group);
    assert.equal(coordinator.currentMode, "LEADER_CHECK", "one deaf lap does not flip the mode");
    cleanLap(group);
    assert.equal(coordinator.currentMode, "LEADER_CHECK", "and a clean lap keeps it");
  });
});

/**
 * UpnpCoordinator (5d lease fallback) — the OnlyPermanentLeasesSupported escape.
 *
 * Most routers honour the finite lease we request (ttl 14400) so a crashed node's
 * mapping self-expires. Some IGDs (e.g. MikroTik) REJECT a finite lease with SOAP
 * fault 725 and require a permanent one; the coordinator must detect that, fall back
 * to a permanent mapping (ttl 0), and stay permanent for the rest of its life on that
 * router. A lone node (its own representative, SELF_CHECK) drives the writes on its
 * short self-check slot — the same single-node pattern the 5a/5c lone tests use.
 */
describe("UpnpCoordinator (5d lease fallback)", () => {
  it("requests a finite lease by default and stays non-permanent", async () => {
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    const client = new FakeUpnpClient(); // getMapping -> null (missing)
    client.reflectCreates = true; // mapped once, then steady
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "nidA",
      localAddress: "10.0.0.11",
      client
    });
    coordinator.setDesiredPortSet([16127]);

    await node.start();
    for (let i = 0; i < 6; i++) {
      w.clock.advance(50);
      await settle();
    }

    assert.equal(client.createCalls.length, 1, "mapped the missing port once");
    assert.equal(client.createCalls[0].ttl, 14400, "default create uses the finite ttl");
    assert.equal(coordinator.leasePermanent, false, "no 725 seen -> stays non-permanent");
  });

  it("falls back to a permanent lease (ttl 0) on a 725 OnlyPermanentLeasesSupported fault", async () => {
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    const client = new FakeUpnpClient(); // getMapping -> null (missing)
    // The router rejects the FIRST (finite) AddPortMapping with 725, then accepts.
    client.failFirstCreateWith = "soap:Client 725 OnlyPermanentLeasesSupported";
    client.reflectCreates = true;
    const failed: Array<{ port: number; reason: string }> = [];
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "nidA",
      localAddress: "10.0.0.11",
      client,
      onMappingFailed: (port, reason) => failed.push({ port, reason })
    });
    coordinator.setDesiredPortSet([16127]);

    await node.start();
    for (let i = 0; i < 6; i++) {
      w.clock.advance(50);
      await settle();
    }

    assert.equal(client.createCalls.length, 2, "the finite attempt then the permanent retry");
    assert.equal(client.createCalls[0].ttl, 14400, "first attempt requested the finite lease");
    assert.equal(client.createCalls[1].ttl, 0, "retried the SAME write with a permanent lease");
    assert.deepEqual(client.createCalls[1].private, { host: "10.0.0.11", port: 16127 });
    assert.equal(coordinator.leasePermanent, true, "latched permanent after the 725");
    assert.equal(failed.length, 0, "the retry succeeded, so no failure surfaced");
  });

  it("is sticky: after the fallback a later needed write uses ttl 0 with no second 725", async () => {
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    const client = new FakeUpnpClient();
    client.failFirstCreateWith = "725"; // only the first create is rejected
    client.reflectCreates = true;
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "nidA",
      localAddress: "10.0.0.11",
      client
    });
    coordinator.setDesiredPortSet([16127]);

    await node.start();
    for (let i = 0; i < 4; i++) {
      w.clock.advance(50);
      await settle();
    }
    assert.equal(coordinator.leasePermanent, true, "latched permanent on the first 725");
    const writesAfterFallback = client.createCalls.length;

    // Force a later write by dropping this port's reflected mapping: it must go
    // straight to ttl 0 (no second 725 needed) and stay permanent.
    client.byPort.set(16127, null);
    for (let i = 0; i < 4; i++) {
      w.clock.advance(50);
      await settle();
    }

    assert.ok(client.createCalls.length > writesAfterFallback, "a later write happened");
    for (const c of client.createCalls.slice(writesAfterFallback)) {
      assert.equal(c.ttl, 0, "every post-fallback write uses the permanent lease directly");
    }
    assert.equal(coordinator.leasePermanent, true, "permanence is sticky");
  });

  it("does not flip to permanent on an unrelated create error", async () => {
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    const client = new FakeUpnpClient();
    client.failCreate = true; // a generic, non-725 failure on every create
    const failed: Array<{ port: number; reason: string }> = [];
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "nidA",
      localAddress: "10.0.0.11",
      client,
      onMappingFailed: (port, reason) => failed.push({ port, reason })
    });
    coordinator.setDesiredPortSet([16127]);

    await node.start();
    for (let i = 0; i < 4; i++) {
      w.clock.advance(50);
      await settle();
    }

    assert.ok(failed.length >= 1, "the unrelated failure surfaced via onMappingFailed");
    assert.match(failed[0].reason, /create failed/);
    assert.equal(coordinator.leasePermanent, false, "a non-725 error never latches permanent");
    for (const c of client.createCalls) {
      assert.equal(c.ttl, 14400, "and no create silently used a permanent lease");
    }
  });
});

/**
 * UpnpCoordinator (leader-set adaptive back-off) — the closed-loop completion of the
 * rate limiter. ONLY the leader talks to the router enough to judge its health, and
 * ONLY the leader adjusts the shared rate (a setRate SET every node folds in total
 * order); non-leaders just obey the folded value. The leader's per-cycle getMappings
 * enumerate is the stress proxy: a clean scan eases the WHOLE segment back toward
 * baseline, a failed scan backs it off, AIMD-flavoured (sharp cut, gentle rise) so it
 * cannot flap. Driven over a REAL 2-node ring (lowest address leads) so the SET
 * genuinely round-trips through ordered broadcast and updates currentRate on delivery.
 */
describe("UpnpCoordinator (leader-set adaptive back-off)", () => {
  /**
   * Form ONE ring with both nodes in LEADER_CHECK (so the leader's scanAndBroadcast
   * actually runs). Unlike the 5b formRingAndReset this does NOT require the peer to be
   * `observedFresh` — a failing leader never broadcasts OBSERVED, so that would never
   * settle; entering LEADER_CHECK depends only on the multicast-health gate, which a
   * failed enumerate does not affect.
   */
  const formLeaderCheckRing = async (
    clock: ManualClock,
    coords: UpnpCoordinator[]
  ): Promise<void> => {
    const settled = (): boolean => {
      const rep = coords[0].representative;
      const oneRing = rep != null && coords.every((c) => c.representative === rep);
      const inLeaderCheck = coords.every((c) => c.currentMode === "LEADER_CHECK");
      return oneRing && inLeaderCheck;
    };
    for (let i = 0; i < 120 && !settled(); i++) {
      clock.advance(20);
      await settle();
    }
    assert.ok(settled(), "ring formed and both nodes reached LEADER_CHECK");
    assert.equal(
      coords.filter((c) => c.isLeader).length,
      1,
      "exactly one leader once the ring forms"
    );
  };

  /** Run laps, settling each so the leader's async scan + the folded SET round-trip. */
  const runLaps = async (clock: ManualClock, n = 24): Promise<void> => {
    for (let i = 0; i < n; i++) {
      clock.advance(20);
      await settle();
    }
  };

  it("backs the group off on a failing leader scan, multiplicatively, floored", async () => {
    const w = makeWorld();
    const lead = w.makeNode("10.0.0.10");
    const peer = w.makeNode("10.0.0.20");
    const leadClient = new FakeUpnpClient();
    const peerClient = new FakeUpnpClient();
    // The leader's enumerate keeps failing: every leader baton backs the group off.
    leadClient.failGetMappings = true;

    const lc = makeCoordinator(lead, w.clock, {
      self: "10.0.0.10",
      localAddress: "10.0.0.10",
      client: leadClient,
      rate: 800,
      capacity: 1000
      // floorRate defaults to baseline/8 = 100; backoffFactor defaults to 0.5.
    });
    const pc = makeCoordinator(peer, w.clock, {
      self: "10.0.0.20",
      localAddress: "10.0.0.20",
      client: peerClient,
      rate: 800,
      capacity: 1000
    });
    lc.coordinator.setDesiredPortSet([16111]);
    pc.coordinator.setDesiredPortSet([16222]);

    await lead.start();
    await peer.start();
    await formLeaderCheckRing(w.clock, [lc.coordinator, pc.coordinator]);
    assert.equal(lc.coordinator.isLeader, true, "lowest address leads");
    assert.equal(lc.coordinator.currentRate, 800, "starts at baseline before any scan");

    await runLaps(w.clock);

    // It dropped below baseline (multiplicative decrease) and never below the floor,
    // and the non-leader folded the SAME SET (the leader paced the whole segment).
    assert.ok(lc.coordinator.currentRate < 800, "the failing scan cut the shared rate");
    assert.ok(lc.coordinator.currentRate >= 100, "never below the floor (floorRate)");
    assert.equal(
      pc.coordinator.currentRate,
      lc.coordinator.currentRate,
      "the non-leader folded the leader's SET — same group-wide rate"
    );
  });

  it("recovers toward baseline on clean scans, capped at baseline", async () => {
    const w = makeWorld();
    const lead = w.makeNode("10.0.0.10");
    const peer = w.makeNode("10.0.0.20");
    const leadClient = new FakeUpnpClient();
    const peerClient = new FakeUpnpClient();
    // The leader's enumerate succeeds (returns the table) so every leader baton is a
    // clean scan that nudges the rate UP toward baseline.
    leadClient.table = [
      healthyMapping(16111, "10.0.0.10"),
      healthyMapping(16222, "10.0.0.20")
    ];
    leadClient.mapping = healthyMapping(16111, "10.0.0.10");

    const lc = makeCoordinator(lead, w.clock, {
      self: "10.0.0.10",
      localAddress: "10.0.0.10",
      client: leadClient,
      rate: 800,
      capacity: 1000,
      // Start the limiter at the floor so the climb back to baseline is observable.
      floorRate: 100
    });
    const pc = makeCoordinator(peer, w.clock, {
      self: "10.0.0.20",
      localAddress: "10.0.0.20",
      client: peerClient,
      rate: 800,
      capacity: 1000,
      freshLaps: 50
    });
    lc.coordinator.setDesiredPortSet([16111]);
    pc.coordinator.setDesiredPortSet([16222]);

    await lead.start();
    await peer.start();
    await formLeaderCheckRing(w.clock, [lc.coordinator, pc.coordinator]);

    // Drive the rate down to the floor first (a transient stress), then heal it.
    leadClient.failGetMappings = true;
    await runLaps(w.clock);
    assert.ok(lc.coordinator.currentRate <= 200, "transient stress drove it down near the floor");
    const low = lc.coordinator.currentRate;

    // Now the router is healthy again: clean scans must raise the rate back up. The
    // climb is ×1.5 per LEADER baton (~every other lap in a 2-node ring), so 100 ->
    // baseline takes several leader scans; run amply so it provably saturates and pins.
    leadClient.failGetMappings = false;
    await runLaps(w.clock, 120);

    assert.ok(lc.coordinator.currentRate > low, "clean scans raised the rate back up");
    assert.ok(
      lc.coordinator.currentRate <= 800,
      "and never exceeded the baseline (capped)"
    );
    // Ample clean laps reach the baseline exactly and pin there (recover() caps at
    // baseline and then skips its broadcast, so it never overshoots).
    assert.equal(lc.coordinator.currentRate, 800, "recovered fully to baseline");
    assert.equal(
      pc.coordinator.currentRate,
      800,
      "the non-leader folded the recovery too — whole segment back at baseline"
    );
  });

  it("is a no-op at baseline: a healthy leader never raises the rate above baseline", async () => {
    const w = makeWorld();
    const lead = w.makeNode("10.0.0.10");
    const peer = w.makeNode("10.0.0.20");
    const leadClient = new FakeUpnpClient();
    const peerClient = new FakeUpnpClient();
    leadClient.table = [
      healthyMapping(16111, "10.0.0.10"),
      healthyMapping(16222, "10.0.0.20")
    ];
    leadClient.mapping = healthyMapping(16111, "10.0.0.10");

    const lc = makeCoordinator(lead, w.clock, {
      self: "10.0.0.10",
      localAddress: "10.0.0.10",
      client: leadClient,
      rate: 800,
      capacity: 1000
    });
    const pc = makeCoordinator(peer, w.clock, {
      self: "10.0.0.20",
      localAddress: "10.0.0.20",
      client: peerClient,
      rate: 800,
      capacity: 1000,
      freshLaps: 50
    });
    lc.coordinator.setDesiredPortSet([16111]);
    pc.coordinator.setDesiredPortSet([16222]);

    await lead.start();
    await peer.start();
    await formLeaderCheckRing(w.clock, [lc.coordinator, pc.coordinator]);

    // Many clean leader scans at baseline: recover() skips the broadcast when already
    // at baseline, so the rate stays pinned exactly at baseline and never overshoots.
    await runLaps(w.clock, 30);

    assert.equal(lc.coordinator.currentRate, 800, "stays exactly at baseline — no overshoot");
    assert.equal(pc.coordinator.currentRate, 800, "and so does the non-leader's folded rate");
  });

  it("a non-leader never adjusts the group rate, even with a failing client", async () => {
    const w = makeWorld();
    const lead = w.makeNode("10.0.0.10");
    const peer = w.makeNode("10.0.0.20");
    const leadClient = new FakeUpnpClient();
    const peerClient = new FakeUpnpClient();
    // Leader is HEALTHY (clean scans, already at baseline -> no SET). The NON-leader's
    // client fails its enumerate — but a non-leader never takes the scan path, so it
    // must never touch the shared rate. Only the leader's scan drives back-off.
    leadClient.table = [
      healthyMapping(16111, "10.0.0.10"),
      healthyMapping(16222, "10.0.0.20")
    ];
    leadClient.mapping = healthyMapping(16111, "10.0.0.10");
    peerClient.failGetMappings = true;
    peerClient.mapping = healthyMapping(16222, "10.0.0.20"); // its own port is fine

    const lc = makeCoordinator(lead, w.clock, {
      self: "10.0.0.10",
      localAddress: "10.0.0.10",
      client: leadClient,
      rate: 800,
      capacity: 1000
    });
    const pc = makeCoordinator(peer, w.clock, {
      self: "10.0.0.20",
      localAddress: "10.0.0.20",
      client: peerClient,
      rate: 800,
      capacity: 1000,
      freshLaps: 50
    });
    lc.coordinator.setDesiredPortSet([16111]);
    pc.coordinator.setDesiredPortSet([16222]);

    await lead.start();
    await peer.start();
    await formLeaderCheckRing(w.clock, [lc.coordinator, pc.coordinator]);
    assert.equal(pc.coordinator.isLeader, false, "the failing-client node is the non-leader");

    await runLaps(w.clock, 30);

    // The non-leader's failing enumerate never ran (it is not the leader), so the
    // shared rate is untouched — still baseline on both nodes.
    assert.equal(pc.coordinator.currentRate, 800, "the non-leader did not back the group off");
    assert.equal(lc.coordinator.currentRate, 800, "and the healthy leader kept it at baseline");
  });

  it("reports an enumerate failure under the -1 sentinel and still repairs its own port", async () => {
    const w = makeWorld();
    const lead = w.makeNode("10.0.0.10");
    const peer = w.makeNode("10.0.0.20");
    const leadClient = new FakeUpnpClient();
    const peerClient = new FakeUpnpClient();
    // The leader cannot enumerate, but its OWN port is missing — the enumerate failure
    // must surface as onMappingFailed(-1) (a whole-table read fault, not a single port),
    // while the leader's own read-before-write still runs and maps its own port.
    leadClient.failGetMappings = true;
    leadClient.reflectCreates = true;
    leadClient.byPort.set(16110, null);
    peerClient.byPort.set(16220, healthyMapping(16220, "10.0.0.20")); // peer quiet

    const failed: Array<{ port: number; reason: string }> = [];
    const lc = makeCoordinator(lead, w.clock, {
      self: "10.0.0.10",
      localAddress: "10.0.0.10",
      client: leadClient,
      rate: 800,
      capacity: 1000,
      onMappingFailed: (port, reason) => failed.push({ port, reason })
    });
    const pc = makeCoordinator(peer, w.clock, {
      self: "10.0.0.20",
      localAddress: "10.0.0.20",
      client: peerClient,
      rate: 800,
      capacity: 1000
    });
    lc.coordinator.setDesiredPortSet([16110]);
    pc.coordinator.setDesiredPortSet([16220]);

    await lead.start();
    await peer.start();
    await formLeaderCheckRing(w.clock, [lc.coordinator, pc.coordinator]);
    assert.equal(lc.coordinator.isLeader, true, "lowest address leads");

    await runLaps(w.clock);

    assert.ok(
      failed.some((f) => f.port === -1),
      "the enumerate failure surfaced under the -1 sentinel (not attributed to a port)"
    );
    assert.deepEqual(
      leadClient.createCalls.map((c) => c.public),
      [16110],
      "and the leader still repaired its OWN port despite the failed enumerate"
    );
  });
});

/**
 * UpnpCoordinator (orphan cleanup) — a node prunes its OWN mappings that are no longer
 * desired (an uninstalled app, a reassigned port). Strict-mode delete is self-only, so a
 * node only ever deletes a mapping pointing at ITSELF; the delete is paced exactly like a
 * repair (token-gated, read-before-delete, one SOAP in flight). Orphans surface two ways:
 * a port DROPPED from the desired set (any mode) and a LEFTOVER spotted in the leader's
 * OBSERVED whole-table broadcast (leader-check, e.g. a mapping from before a restart).
 *
 * Most tests drive the same FakeGroup seam the 5c block uses — it now also exposes a
 * deliver() for ordered-broadcast payloads (a leader's OBSERVED) — so each cleanup pass
 * is controlled exactly; the broadcast/delivery transport itself is already proven by 5b.
 * One end-to-end test runs a real 2-node ring for fidelity.
 */
describe("UpnpCoordinator (orphan cleanup)", () => {
  const OBSERVED_TYPE = "UPNP_OBSERVED";
  const observed = (by: string, mappings: UpnpMapping[]): unknown => ({
    type: OBSERVED_TYPE,
    by,
    mappings
  });

  /** Build a coordinator over a FakeGroup seam as a NON-leader (rep != self) so a baton
   *  runs the non-leader checkAndRepair (repair + orphan cleanup) path deterministically.
   *  self is "nidA" and localAddress "10.0.0.11" (a leader "leaderNid" broadcasts to us). */
  const seam = (
    clock: ManualClock,
    opts: {
      client?: FakeUpnpClient;
      orphanConfirmPasses?: number;
      orphanMaxDeleteAttempts?: number;
      rate?: number;
      capacity?: number;
      onMappingFailed?: (port: number, reason: string) => void;
    } = {}
  ): { coordinator: UpnpCoordinator; group: FakeGroup; client: FakeUpnpClient } => {
    const group = new FakeGroup();
    group.rep = "leaderNid"; // someone else leads -> this node is a non-leader
    const client = opts.client ?? new FakeUpnpClient();
    const coordinator = new UpnpCoordinator({
      self: "nidA",
      group: group as unknown as Group,
      client,
      clock,
      localAddress: "10.0.0.11",
      rate: opts.rate ?? 1000,
      capacity: opts.capacity ?? 1000,
      enterLaps: 3,
      leaveLaps: 5,
      tokenStallMs: 1_000_000,
      selfCheckCycleMs: 1_000_000, // slot off — cleanup is driven via batons in LEADER_CHECK
      selfCheckWindows: 1,
      orphanConfirmPasses: opts.orphanConfirmPasses,
      orphanMaxDeleteAttempts: opts.orphanMaxDeleteAttempts,
      hooks: { onMappingFailed: opts.onMappingFailed }
    });
    return { coordinator, group, client };
  };

  /** Drive K=3 clean laps so the seam node enters LEADER_CHECK (batons then run repair +
   *  cleanup). The mode flips synchronously in sampleLap; settle drains any async work. */
  const enterLeaderCheck = async (
    coordinator: UpnpCoordinator,
    group: FakeGroup
  ): Promise<void> => {
    for (let i = 0; i < 3; i++) {
      group.multicast += 1;
      group.baton();
    }
    await settle();
    assert.equal(coordinator.currentMode, "LEADER_CHECK", "entered LEADER_CHECK on clean laps");
  };

  /** One cleanup pass: a clean baton, a small clock advance (so a time-based rate budget
   *  can refill), then settle the async repair/cleanup. */
  const pass = async (group: FakeGroup, clock: ManualClock, ms = 10): Promise<void> => {
    group.multicast += 1;
    group.baton();
    clock.advance(ms);
    await settle();
  };

  it("prunes its own leftover seen in the leader's OBSERVED broadcast", async () => {
    const clock = new ManualClock();
    const client = new FakeUpnpClient();
    // 16127 is desired & healthy; 16999 is a leftover from a prior life — a Flux mapping
    // pointing at us on a port we no longer desire. The router still holds both.
    client.byPort.set(16127, healthyMapping(16127, "10.0.0.11"));
    client.byPort.set(16999, healthyMapping(16999, "10.0.0.11"));
    const { coordinator, group } = seam(clock, { client, orphanConfirmPasses: 0 });
    coordinator.setDesiredPortSet([16127]);
    coordinator.start();
    await enterLeaderCheck(coordinator, group);

    group.deliver(
      observed("leaderNid", [
        healthyMapping(16127, "10.0.0.11"),
        healthyMapping(16999, "10.0.0.11")
      ])
    );
    assert.deepEqual(coordinator.pendingUnmaps, [16999], "the leftover was queued for prune");

    await pass(group, clock);

    assert.deepEqual(
      client.removeCalls.map((q) => q.public),
      [16999],
      "deleted only the undesired leftover"
    );
    assert.deepEqual(coordinator.pendingUnmaps, [], "the orphan queue drained");
    assert.equal(client.createCalls.length, 0, "never re-created anything (16127 stayed healthy)");
  });

  it("never deletes a mapping owned by another host (a departed node's orphan)", async () => {
    const clock = new ManualClock();
    const { coordinator, group, client } = seam(clock, { orphanConfirmPasses: 0 });
    client.byPort.set(16127, healthyMapping(16127, "10.0.0.11"));
    coordinator.setDesiredPortSet([16127]);
    coordinator.start();
    await enterLeaderCheck(coordinator, group);

    // A Flux orphan on 16999, but it points at 10.0.0.99 — not us. Strict-mode delete is
    // self-only, so it is not ours to prune (and could not be deleted anyway).
    group.deliver(observed("leaderNid", [healthyMapping(16999, "10.0.0.99")]));
    assert.deepEqual(coordinator.pendingUnmaps, [], "another host's orphan is never queued");

    await pass(group, clock);
    await pass(group, clock);
    assert.equal(client.removeCalls.length, 0, "and it is never deleted");
  });

  it("never deletes a non-Flux mapping on one of our own ports", async () => {
    const clock = new ManualClock();
    const { coordinator, group, client } = seam(clock, { orphanConfirmPasses: 0 });
    client.byPort.set(16127, healthyMapping(16127, "10.0.0.11"));
    coordinator.setDesiredPortSet([16127]);
    coordinator.start();
    await enterLeaderCheck(coordinator, group);

    // A manual port forward on 16999 pointing at us, OUTSIDE the Flux namespace — cleanup
    // must never touch a mapping it does not own by description.
    group.deliver(
      observed("leaderNid", [{ ...healthyMapping(16999, "10.0.0.11"), description: "BitTorrent" }])
    );
    assert.deepEqual(coordinator.pendingUnmaps, [], "a non-Flux mapping is never an orphan candidate");

    await pass(group, clock);
    assert.equal(client.removeCalls.length, 0, "and is never deleted");
  });

  it("does not prune anything until a desired set has been declared (startup latch)", async () => {
    const clock = new ManualClock();
    const { coordinator, group, client } = seam(clock, { orphanConfirmPasses: 0 });
    coordinator.start();
    await enterLeaderCheck(coordinator, group);

    // No desired set fed yet: a leftover in OBSERVED must NOT be treated as an orphan (the
    // empty set is "not configured yet", not "I want nothing mapped").
    group.deliver(observed("leaderNid", [healthyMapping(16127, "10.0.0.11")]));
    assert.deepEqual(coordinator.pendingUnmaps, [], "no pruning before the desired set is known");

    // Once FluxOS declares the desired set, a genuinely-undesired leftover IS an orphan.
    coordinator.setDesiredPortSet([16127]);
    client.byPort.set(16127, healthyMapping(16127, "10.0.0.11"));
    client.byPort.set(16999, healthyMapping(16999, "10.0.0.11"));
    group.deliver(
      observed("leaderNid", [
        healthyMapping(16127, "10.0.0.11"),
        healthyMapping(16999, "10.0.0.11")
      ])
    );
    assert.deepEqual(
      coordinator.pendingUnmaps,
      [16999],
      "after the set is declared, the undesired leftover is an orphan"
    );
  });

  it("serves a confirm grace before pruning a dropped port", async () => {
    const clock = new ManualClock();
    const { coordinator, group, client } = seam(clock); // default grace = 2
    client.byPort.set(16127, healthyMapping(16127, "10.0.0.11"));
    coordinator.setDesiredPortSet([16127]);
    coordinator.start();
    await enterLeaderCheck(coordinator, group);

    coordinator.setDesiredPortSet([]); // drop -> queued, but held through the confirm grace
    assert.deepEqual(coordinator.pendingUnmaps, [16127], "queued on drop");

    await pass(group, clock); // grace pass 1
    await pass(group, clock); // grace pass 2
    assert.equal(client.removeCalls.length, 0, "not deleted during the confirm grace");
    assert.deepEqual(coordinator.pendingUnmaps, [16127], "still queued");

    await pass(group, clock); // confirmed -> delete
    assert.deepEqual(
      client.removeCalls.map((q) => q.public),
      [16127],
      "deleted once the confirm grace elapsed"
    );
    assert.deepEqual(coordinator.pendingUnmaps, [], "queue drained");
  });

  it("never prunes a port dropped then re-added (drop-then-re-add)", async () => {
    const clock = new ManualClock();
    const { coordinator, group, client } = seam(clock, { orphanConfirmPasses: 0 });
    client.byPort.set(16127, healthyMapping(16127, "10.0.0.11"));
    coordinator.setDesiredPortSet([16127]);
    coordinator.start();
    await enterLeaderCheck(coordinator, group);

    coordinator.setDesiredPortSet([]); // drop -> queued
    assert.deepEqual(coordinator.pendingUnmaps, [16127], "queued on drop");
    coordinator.setDesiredPortSet([16127]); // re-add -> candidacy cancelled at once
    assert.deepEqual(coordinator.pendingUnmaps, [], "re-add cancels the orphan candidacy");

    await pass(group, clock);
    await pass(group, clock);
    assert.equal(client.removeCalls.length, 0, "the re-added port is never deleted");
  });

  it("read-before-delete: a port a peer reclaimed since is not deleted", async () => {
    const clock = new ManualClock();
    const { coordinator, group, client } = seam(clock, { orphanConfirmPasses: 0 });
    client.byPort.set(16127, healthyMapping(16127, "10.0.0.11"));
    client.byPort.set(16999, healthyMapping(16999, "10.0.0.11")); // ours while desired
    coordinator.setDesiredPortSet([16127, 16999]);
    coordinator.start();
    await enterLeaderCheck(coordinator, group);

    // Drop 16999 -> queued as our orphan. But before we delete it, a peer reclaims the
    // port: the router now shows it pointing at 10.0.0.22. Read-before-delete must see it
    // is no longer ours and leave it alone (strict mode would 606 us anyway).
    coordinator.setDesiredPortSet([16127]);
    assert.deepEqual(coordinator.pendingUnmaps, [16999], "queued on drop");
    client.byPort.set(16999, healthyMapping(16999, "10.0.0.22"));

    await pass(group, clock);

    assert.equal(client.removeCalls.length, 0, "did not delete a mapping that is no longer ours");
    assert.deepEqual(coordinator.pendingUnmaps, [], "and dropped it from the queue");
  });

  it("a persistently-failing unmap does not starve the other orphans (rotating cursor)", async () => {
    const clock = new ManualClock();
    const client = new FakeUpnpClient();
    client.byPort.set(16127, healthyMapping(16127, "10.0.0.11"));
    client.byPort.set(16500, healthyMapping(16500, "10.0.0.11"));
    client.byPort.set(16600, healthyMapping(16600, "10.0.0.11"));
    client.failRemovePorts = new Set([16500]); // 16500's delete ALWAYS fails (sinks a token)
    const failed: Array<{ port: number; reason: string }> = [];
    const { coordinator, group } = seam(clock, {
      client,
      orphanConfirmPasses: 0,
      orphanMaxDeleteAttempts: 100, // keep 16500 queued the whole test — isolate the cursor
      rate: 1000, // refills the bucket each pass...
      capacity: 1, // ...but only ONE token at a time, so one delete attempt per pass
      onMappingFailed: (port, reason) => failed.push({ port, reason })
    });
    coordinator.setDesiredPortSet([16127, 16500, 16600]);
    coordinator.start();
    await enterLeaderCheck(coordinator, group);

    // Drop both app ports: both are orphans. 16500's delete always fails and sinks the
    // lone token; with a FIXED walk it would be attempted first every pass and 16600 would
    // never be deleted — the rotating cursor must let the tail orphan through. (The retry
    // bound is set high here so this test isolates cursor fairness; the bound is tested
    // separately below.)
    coordinator.setDesiredPortSet([16127]);
    for (let i = 0; i < 8; i++) await pass(group, clock);

    assert.ok(
      failed.some((f) => f.port === 16500),
      "the failing unmap surfaced via onMappingFailed"
    );
    assert.ok(
      client.removeCalls.some((q) => q.public === 16600),
      "the deletable tail orphan WAS pruned despite the token sink (cursor rotated)"
    );
    assert.ok(
      coordinator.pendingUnmaps.includes(16500),
      "the un-deletable orphan stays queued (retried), not silently dropped"
    );
  });

  it("serves repairs before orphan deletes under a tight budget", async () => {
    const clock = new ManualClock();
    const client = new FakeUpnpClient();
    client.reflectCreates = true;
    client.byPort.set(16127, healthyMapping(16127, "10.0.0.11"));
    client.byPort.set(16500, healthyMapping(16500, "10.0.0.11"));
    const { coordinator, group } = seam(clock, {
      client,
      orphanConfirmPasses: 0,
      rate: 0,
      capacity: 1 // exactly ONE token ever
    });
    coordinator.setDesiredPortSet([16127, 16500]);
    coordinator.start();
    await enterLeaderCheck(coordinator, group);

    // Now make 16127 (still desired) need a re-map AND drop 16500 to an orphan. With one
    // token total, the repair must win it — a wanted port up beats a dead one removed.
    coordinator.setDesiredPortSet([16127]);
    client.byPort.set(16127, null);
    for (let i = 0; i < 5; i++) await pass(group, clock);

    assert.deepEqual(
      client.createCalls.map((c) => c.public),
      [16127],
      "the repair won the only token"
    );
    assert.equal(client.removeCalls.length, 0, "the orphan delete was not served (repairs first)");
    assert.ok(
      coordinator.pendingUnmaps.includes(16500),
      "the orphan stays queued for when the budget allows"
    );
  });

  it("does not delete a port re-desired DURING the awaited unmap (in-flight re-desire race)", async () => {
    const clock = new ManualClock();
    const client = new FakeUpnpClient();
    client.byPort.set(16127, healthyMapping(16127, "10.0.0.11"));
    client.byPort.set(16999, healthyMapping(16999, "10.0.0.11"));
    const { coordinator, group } = seam(clock, { client, orphanConfirmPasses: 0 });
    coordinator.setDesiredPortSet([16127, 16999]);
    coordinator.start();
    await enterLeaderCheck(coordinator, group);

    // Drop 16999 -> queued. Gate its read-before-delete so the unmap parks mid-await.
    coordinator.setDesiredPortSet([16127]);
    assert.deepEqual(coordinator.pendingUnmaps, [16999], "queued on drop");
    client.gateGetPort = 16999;

    // Fire the cleanup baton; unmapPort(16999) suspends at the gated getMapping.
    group.multicast += 1;
    group.baton();
    await settle();

    // FluxOS re-desires 16999 WHILE the unmap is suspended (the realistic interleave —
    // setDesiredPortSet runs on the same loop, concurrent with the awaited SOAP read).
    coordinator.setDesiredPortSet([16127, 16999]);
    // Release the read; the unmap must now ABORT the delete — 16999 is wanted again.
    client.gateGetPort = null;
    client.releaseGet();
    await settle();

    assert.equal(client.removeCalls.length, 0, "the re-desired live port was NOT torn down");
    assert.ok(coordinator.desired.includes(16999), "16999 is desired again");
    assert.ok(client.byPort.get(16999) != null, "and its mapping is still on the router");
  });

  it("bounds retries on a permanently-failing unmap, then re-surfaces it via a later OBSERVED", async () => {
    const clock = new ManualClock();
    const client = new FakeUpnpClient();
    client.byPort.set(16500, healthyMapping(16500, "10.0.0.11"));
    client.failRemovePorts = new Set([16500]); // its delete ALWAYS fails
    const failed: Array<{ port: number; reason: string }> = [];
    const { coordinator, group } = seam(clock, {
      client,
      orphanConfirmPasses: 0,
      orphanMaxDeleteAttempts: 3,
      onMappingFailed: (port, reason) => failed.push({ port, reason })
    });
    coordinator.setDesiredPortSet([16500]);
    coordinator.start();
    await enterLeaderCheck(coordinator, group);

    coordinator.setDesiredPortSet([]); // drop -> orphan
    assert.deepEqual(coordinator.pendingUnmaps, [16500], "queued on drop");

    // It keeps failing; after the attempt cap it is dropped (the orphan lingers — accepted).
    for (let i = 0; i < 6; i++) await pass(group, clock);
    assert.equal(
      failed.filter((f) => f.port === 16500).length,
      3,
      "retried exactly the capped number of times, not forever"
    );
    assert.deepEqual(coordinator.pendingUnmaps, [], "dropped after the cap — no perpetual token sink");

    // A later leader OBSERVED still showing the leftover re-surfaces it (a spaced retry).
    group.deliver(observed("leaderNid", [healthyMapping(16500, "10.0.0.11")]));
    assert.deepEqual(
      coordinator.pendingUnmaps,
      [16500],
      "re-surfaced by a fresh OBSERVED for a spaced retry"
    );
  });

  it("in SELF_CHECK, ignores an OBSERVED-seeded leftover (trusts nobody; discovery needs leader-check)", async () => {
    const clock = new ManualClock();
    const { coordinator, group, client } = seam(clock, { orphanConfirmPasses: 0 });
    client.byPort.set(16999, healthyMapping(16999, "10.0.0.11"));
    coordinator.setDesiredPortSet([16127]);
    coordinator.start();
    // Deliberately do NOT enter LEADER_CHECK — stay in the startup SELF_CHECK.
    assert.equal(coordinator.currentMode, "SELF_CHECK", "still self-check");

    group.deliver(observed("leaderNid", [healthyMapping(16999, "10.0.0.11")]));
    assert.deepEqual(
      coordinator.pendingUnmaps,
      [],
      "a self-check node does not act on a peer's broadcast for leftover discovery"
    );
  });

  it("prunes a realistic Flux_App_<name> leftover but spares a near-miss non-namespace description", async () => {
    const clock = new ManualClock();
    const client = new FakeUpnpClient();
    client.byPort.set(16127, healthyMapping(16127, "10.0.0.11"));
    // A realistic uninstalled-app leftover, and a near-miss whose description merely
    // CONTAINS "Flux" but is not in the namespace (must be spared — the match is anchored).
    client.byPort.set(16800, { ...healthyMapping(16800, "10.0.0.11"), description: "Flux_App_someapp" });
    client.byPort.set(16801, { ...healthyMapping(16801, "10.0.0.11"), description: "MyFluxThing" });
    const { coordinator, group } = seam(clock, { client, orphanConfirmPasses: 0 });
    coordinator.setDesiredPortSet([16127]);
    coordinator.start();
    await enterLeaderCheck(coordinator, group);

    group.deliver(
      observed("leaderNid", [
        { ...healthyMapping(16800, "10.0.0.11"), description: "Flux_App_someapp" },
        { ...healthyMapping(16801, "10.0.0.11"), description: "MyFluxThing" }
      ])
    );
    assert.deepEqual(coordinator.pendingUnmaps, [16800], "only the Flux-namespace leftover is an orphan");

    await pass(group, clock);
    assert.deepEqual(
      client.removeCalls.map((q) => q.public),
      [16800],
      "pruned the Flux_App_ leftover"
    );
    assert.ok(
      client.removeCalls.every((q) => q.public !== 16801),
      "spared the non-namespace mapping"
    );
  });

  it("end-to-end: each node prunes its OWN leftover (peer via broadcast, leader via its own enumerate)", async () => {
    const w = makeWorld();
    const lead = w.makeNode("10.0.0.10");
    const peer = w.makeNode("10.0.0.20");
    const leadClient = new FakeUpnpClient();
    const peerClient = new FakeUpnpClient();
    // The leader enumerates a table with each node's healthy desired port AND two Flux
    // leftovers: 16998 pointing at the LEADER itself, 16999 pointing at the PEER (both
    // uninstalled apps from before). Each owner must prune its OWN leftover only.
    leadClient.table = [
      healthyMapping(16110, "10.0.0.10"),
      healthyMapping(16998, "10.0.0.10"), // the LEADER's own leftover (undesired)
      healthyMapping(16222, "10.0.0.20"),
      healthyMapping(16999, "10.0.0.20") // the PEER's leftover (undesired)
    ];
    leadClient.mapping = healthyMapping(16110, "10.0.0.10");
    leadClient.byPort.set(16110, healthyMapping(16110, "10.0.0.10")); // leader read-before-write
    leadClient.byPort.set(16998, healthyMapping(16998, "10.0.0.10")); // leader read-before-delete
    peerClient.byPort.set(16222, healthyMapping(16222, "10.0.0.20"));
    peerClient.byPort.set(16999, healthyMapping(16999, "10.0.0.20")); // peer read-before-delete

    const lc = makeCoordinator(lead, w.clock, {
      self: "10.0.0.10",
      localAddress: "10.0.0.10",
      client: leadClient,
      orphanConfirmPasses: 0
    });
    lc.coordinator.setDesiredPortSet([16110]);
    const pc = makeCoordinator(peer, w.clock, {
      self: "10.0.0.20",
      localAddress: "10.0.0.20",
      client: peerClient,
      freshLaps: 50,
      orphanConfirmPasses: 0
    });
    pc.coordinator.setDesiredPortSet([16222]);

    await lead.start();
    await peer.start();
    // Drive until the ring forms, the leader broadcasts, and both prune their own leftover.
    for (let i = 0; i < 160; i++) {
      w.clock.advance(20);
      await settle();
    }

    assert.equal(lc.coordinator.isLeader, true, "lowest address leads");
    assert.ok(
      peerClient.removeCalls.some((q) => q.public === 16999),
      "the peer pruned its own leftover, spotted in the leader's broadcast"
    );
    assert.ok(
      leadClient.removeCalls.some((q) => q.public === 16998),
      "the leader pruned its OWN leftover, discovered via its own enumerate"
    );
    assert.ok(
      leadClient.removeCalls.every((q) => q.public !== 16110) &&
        peerClient.removeCalls.every((q) => q.public !== 16222),
      "neither node ever deleted its still-desired port"
    );
    assert.ok(
      leadClient.removeCalls.every((q) => q.public !== 16222 && q.public !== 16999),
      "the leader never deleted a peer-owned mapping (strict-mode self-only)"
    );
  });
});

/**
 * UpnpCoordinator (requestMap) — the urgent install-time path. FluxOS calls this the
 * instant an app is installed: map the port NOW (bypass the baton cadence) but STILL
 * through the serialized client + rate budget, add it to the maintained desired set, and
 * remember its description so a routine re-map keeps the app name.
 */
describe("UpnpCoordinator (requestMap — urgent install-time map)", () => {
  it("maps the port IMMEDIATELY (off-baton) and adds it to the desired set", async () => {
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    const client = new FakeUpnpClient(); // getMapping -> null (missing)
    client.reflectCreates = true;
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "nidA",
      localAddress: "10.0.0.11",
      client
    });

    await node.start();
    // No clock advance, no baton, no slot — requestMap must map right now.
    await coordinator.requestMap(16127, "Flux_App_myapp");

    assert.deepEqual(
      client.createCalls.map((c) => c.public),
      [16127],
      "mapped immediately, without waiting for a baton/slot"
    );
    assert.equal(client.createCalls[0].description, "Flux_App_myapp", "used the given description");
    assert.deepEqual(client.createCalls[0].private, { host: "10.0.0.11", port: 16127 });
    assert.deepEqual(coordinator.desired, [16127], "joined the maintained desired set");
  });

  it("remembers the description so a routine re-map keeps it (not the default Flux)", async () => {
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    const client = new FakeUpnpClient();
    client.reflectCreates = true;
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "nidA",
      localAddress: "10.0.0.11",
      client
    });

    await node.start();
    await coordinator.requestMap(16500, "Flux_App_myapp");
    assert.equal(client.createCalls[0].description, "Flux_App_myapp");

    // The router drops it -> the routine self-check slot re-maps it, keeping the app name.
    client.byPort.set(16500, null);
    client.createCalls.length = 0;
    for (let i = 0; i < 6; i++) {
      w.clock.advance(50);
      await settle();
    }
    assert.ok(client.createCalls.length >= 1, "the routine loop re-mapped the dropped port");
    assert.ok(
      client.createCalls.every((c) => c.description === "Flux_App_myapp"),
      "every re-map kept the requestMap description, not the default"
    );
  });

  it("still respects the rate budget — no token means it waits for the routine loop", async () => {
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    const client = new FakeUpnpClient();
    client.reflectCreates = true;
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "nidA",
      localAddress: "10.0.0.11",
      client,
      rate: 0,
      capacity: 1 // exactly one token ever
    });

    await node.start();
    await coordinator.requestMap(16127); // spends the one token -> mapped now
    await coordinator.requestMap(16222); // no token left -> not mapped immediately

    assert.deepEqual(
      client.createCalls.map((c) => c.public),
      [16127],
      "the budget gated the second urgent map (urgency is cadence, not flooding the router)"
    );
    assert.deepEqual(
      coordinator.desired,
      [16127, 16222],
      "but both are desired — the routine loop maps the second once budget allows"
    );
  });

  it("clears a pending orphan candidacy when a dropped port is re-requested", async () => {
    const w = makeWorld();
    const node = w.makeNode("10.0.0.11");
    const client = new FakeUpnpClient();
    client.reflectCreates = true;
    const { coordinator } = makeCoordinator(node, w.clock, {
      self: "nidA",
      localAddress: "10.0.0.11",
      client
    });

    coordinator.setDesiredPortSet([16127]);
    coordinator.setDesiredPortSet([]); // drop 16127 -> queued as an orphan
    assert.deepEqual(coordinator.pendingUnmaps, [16127], "queued for prune after the drop");

    await node.start();
    await coordinator.requestMap(16127); // re-requested -> no longer an orphan

    assert.deepEqual(coordinator.pendingUnmaps, [], "the re-request cancelled the orphan candidacy");
    assert.deepEqual(coordinator.desired, [16127], "and it is desired again");
    assert.ok(
      client.createCalls.some((c) => c.public === 16127),
      "and it was mapped immediately"
    );
  });
});
