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
  mapping: UpnpMapping | null = null;
  failCreate = false;
  /** When set, ONLY the first createMapping rejects with this message (a router that
   *  rejects a finite lease answers the first AddPortMapping then accepts ttl 0). */
  failFirstCreateWith: string | null = null;
  /** When set, a successful createMapping reflects into `mapping` like a real router
   *  (so the next read-before-write sees its own write and skips). */
  reflectCreates = false;
  /** A leader's enumerate (getMappings) returns this WHOLE-table view when set;
   *  otherwise it falls back to the single `mapping` (5a behaviour). */
  table: UpnpMapping[] | null = null;
  /** When set, getMappings rejects — drives the leader's enumerate-failure path. */
  failGetMappings = false;

  async getGateway(): Promise<UpnpInfoLike> {
    throw new Error("unused");
  }
  async getMappings(): Promise<UpnpMapping[]> {
    this.getMappingsCalls += 1;
    if (this.failGetMappings) throw new Error("enumerate failed");
    if (this.table) return this.table;
    return this.mapping ? [this.mapping] : [];
  }
  async getMapping(q: MappingQuery): Promise<UpnpMapping | null> {
    this.getCalls.push(q);
    return this.mapping;
  }
  async createMapping(m: NewMapping): Promise<void> {
    this.createCalls.push(m);
    if (this.failCreate) throw new Error("create failed");
    // Reject only the FIRST create (the finite-lease attempt); later creates succeed.
    if (this.failFirstCreateWith != null && this.createCalls.length === 1) {
      throw new Error(this.failFirstCreateWith);
    }
    if (this.reflectCreates) {
      this.mapping = {
        public: { host: "0.0.0.0", port: m.public },
        private: { ...m.private },
        protocol: m.protocol ?? "tcp",
        enabled: true,
        description: m.description ?? "Flux",
        ttl: m.ttl ?? 14400
      };
    }
  }
  async removeMapping(): Promise<void> {
    throw new Error("unused");
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
    coordinator.setDesiredPort(16127);

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
    coordinator.setDesiredPort(16127);

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
    coordinator.setDesiredPort(16127);

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
    coordinator.setDesiredPort(16127);

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
    coordinator.setDesiredPort(16127);

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
    coordinator.setDesiredPort(16127);

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
    // never call setDesiredPort

    await node.start();
    w.clock.advance(500);
    await settle();

    assert.equal(client.getCalls.length, 0, "no read with no desired port");
    assert.equal(client.createCalls.length, 0, "no write with no desired port");
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
    lc.coordinator.setDesiredPort(16111);
    pc.coordinator.setDesiredPort(16222);

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
    lc.coordinator.setDesiredPort(16111);
    const pc = makeCoordinator(peer, w.clock, {
      self: "10.0.0.20",
      localAddress: "10.0.0.20",
      client: peerClient,
      freshLaps: 50 // one broadcast stays trusted across the measured laps (see above)
    });
    pc.coordinator.setDesiredPort(16222);

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
    lc.coordinator.setDesiredPort(16111);
    const pc = makeCoordinator(peer, w.clock, {
      self: "10.0.0.20",
      localAddress: "10.0.0.20",
      client: peerClient
    });
    pc.coordinator.setDesiredPort(16222);

    await lead.start();
    await peer.start();
    // The leader's table never reflects the peer's create, so each post-ring lap the
    // OBSERVED still omits the peer's port — it can never skip; it must repair itself.
    await formRingAndReset(w.clock, [
      { coordinator: lc.coordinator, client: leadClient },
      { coordinator: pc.coordinator, client: peerClient }
    ]);
    // Re-clear the reflected mapping so the post-reset read confirms it missing again.
    peerClient.mapping = null;
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
    coordinator.setDesiredPort(16333);

    await node.start();
    await runLaps(w.clock);

    // A singleton IS its own representative, so it enumerates AND keeps its own
    // mapping via the 5a read-before-write — never trusting any (absent) broadcast.
    assert.equal(coordinator.isLeader, true, "a singleton is its own representative");
    assert.ok(client.getCalls.length >= 1, "self-check read happened (no OBSERVED to skip on)");
    assert.equal(client.createCalls.length, 1, "mapped its missing port once via the 5a floor");
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
  multicast = 0; // the controllable ring-health evidence
  rep: string | null = null;
  memberList: string[] = [];
  broadcasts: unknown[] = [];

  bindHooks(hooks: { onTokenGranted?: () => void }): void {
    if (hooks.onTokenGranted) this.granted = hooks.onTokenGranted;
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
    ca.coordinator.setDesiredPort(16111);
    cb.coordinator.setDesiredPort(16222);

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
    coordinator.setDesiredPort(16127);

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
    coordinator.setDesiredPort(16127);
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
    client.mapping = null;
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
    coordinator.setDesiredPort(16127);
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
    coordinator.setDesiredPort(16127);
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
    coordinator.setDesiredPort(16127);

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
    coordinator.setDesiredPort(16127);

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
    coordinator.setDesiredPort(16127);

    await node.start();
    for (let i = 0; i < 4; i++) {
      w.clock.advance(50);
      await settle();
    }
    assert.equal(coordinator.leasePermanent, true, "latched permanent on the first 725");
    const writesAfterFallback = client.createCalls.length;

    // Force a later write by dropping the reflected mapping: it must go straight to
    // ttl 0 (no second 725 needed) and stay permanent.
    client.mapping = null;
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
    coordinator.setDesiredPort(16127);

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
    lc.coordinator.setDesiredPort(16111);
    pc.coordinator.setDesiredPort(16222);

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
    lc.coordinator.setDesiredPort(16111);
    pc.coordinator.setDesiredPort(16222);

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
    lc.coordinator.setDesiredPort(16111);
    pc.coordinator.setDesiredPort(16222);

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
    lc.coordinator.setDesiredPort(16111);
    pc.coordinator.setDesiredPort(16222);

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
});
