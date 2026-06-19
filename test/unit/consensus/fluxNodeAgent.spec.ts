import assert from "assert/strict";
import { describe, it } from "node:test";
import {
  VirtualNetwork,
  VirtualTransport
} from "@/fluxport-controller/consensus/transport";
import { ManualClock } from "@/fluxport-controller/consensus/clock";
import { FluxNodeAgent } from "@/fluxport-controller/fluxNodeAgent";
import { UpnpClientLike } from "@/fluxport-controller/upnpClient";
import { NodeInfo } from "@/fluxport-controller/nodeList";

/** Let the async heal chain (re-resolve + rebuild) settle; ManualClock drives the
 *  consensus timers, but the heal itself runs on real microtasks. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

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
  const routerIp = new Map<string, string>();
  const transports = new Map<string, VirtualTransport>();

  const make = (
    txhash: string,
    address: string,
    info: NodeInfo = { priorPort: null, priority: 100 },
    healAddress?: string // address the self-heal re-resolve should report
  ): FluxNodeAgent => {
    confirmed.set(txhash, null);
    // The agent only exercises getGateway/close; the read/write surface is stubbed
    // to satisfy the widened UpnpClientLike (never called on this path).
    const fakeUpnp: UpnpClientLike = {
      getGateway: async () => ({
        gateway: { description: "http://10.0.0.1:5000/rootDesc.xml" },
        getLocalAddress: async () => address
      }),
      getMappings: async () => [],
      getMapping: async () => null,
      createMapping: async () => {},
      removeMapping: async () => {},
      close() {}
    };
    const m = new FluxNodeAgent(
      { txhash, outidx: "0" },
      {
        ...FAST_TIMING,
        ports,
        clock,
        upnpClient: fakeUpnp,
        createTransport: (addr) => {
          const t = net.register(addr);
          transports.set(addr, t);
          return t;
        },
        getPublicIp: async () => "1.2.3.4",
        resolveNodeInfo: async () => info,
        ...(healAddress ? { resolveLocalAddress: async () => healAddress } : {})
      }
    );
    m.on("portConfirmed", (p: number) => confirmed.set(txhash, p));
    m.on("routerIpConfirmed", (ip: string) => routerIp.set(txhash, ip));
    return m;
  };

  return { net, clock, confirmed, routerIp, transports, make };
}

describe("FluxNodeAgent", () => {
  it("two nodes behind one router converge to distinct ports", async () => {
    const w = makeWorld([16197, 16187, 16177]);
    const a = w.make("aaa", "10.0.0.11");
    const b = w.make("bbb", "10.0.0.12");

    assert.equal(await a.start(), true);
    assert.equal(await b.start(), true);

    w.clock.advance(1500);

    const pa = w.confirmed.get("aaa");
    const pb = w.confirmed.get("bbb");
    assert.ok(pa != null && pb != null, `both assigned: ${pa}, ${pb}`);
    assert.notEqual(pa, pb);
    // router IP was resolved and surfaced
    assert.equal(w.routerIp.get("aaa"), "10.0.0.1");
  });

  it("reuses a node's prior port (sticky)", async () => {
    const w = makeWorld([16197, 16187, 16177]);
    const a = w.make("aaa", "10.0.0.11", { priorPort: 16187, priority: 100 });
    const b = w.make("bbb", "10.0.0.12", { priorPort: 16177, priority: 100 });

    await a.start();
    await b.start();
    w.clock.advance(1500);

    assert.equal(w.confirmed.get("aaa"), 16187);
    assert.equal(w.confirmed.get("bbb"), 16177);
  });

  it("lower confirmed_height keeps a contested prior port", async () => {
    const w = makeWorld([16197, 16187, 16177]);
    // both want 16197; node a is older (lower confirmed_height) so it wins
    const a = w.make("aaa", "10.0.0.11", { priorPort: 16197, priority: 50 });
    const b = w.make("bbb", "10.0.0.12", { priorPort: 16197, priority: 900 });

    await a.start();
    await b.start();
    w.clock.advance(2000);

    assert.equal(w.confirmed.get("aaa"), 16197, "older node keeps contested port");
    const pb = w.confirmed.get("bbb");
    assert.ok(pb != null && pb !== 16197, `b moved off 16197: ${pb}`);
  });

  // ---- self-heal on a live LAN-IP change ----

  it("rebinds on a transport error and reclaims its port (same nid, new address)", async () => {
    const w = makeWorld([16197, 16187, 16177]);
    const a = w.make("aaa", "10.0.0.11", { priorPort: null, priority: 100 }, "10.0.0.99");
    const b = w.make("bbb", "10.0.0.12");

    await a.start();
    await b.start();
    w.clock.advance(1500);

    const portA = a.assignedPort;
    const portB = b.assignedPort;
    assert.ok(portA != null && portB != null, `both converged: ${portA}, ${portB}`);

    const rebound: Array<{ from: string | null; to: string }> = [];
    a.on("rebound", (e) => rebound.push(e));

    // simulate the bound interface's IP vanishing -> a post-start socket error
    w.transports.get("10.0.0.11")!.failWith(
      Object.assign(new Error("cannot assign requested address"), {
        code: "EADDRNOTAVAIL"
      })
    );
    await settle();

    assert.ok(w.transports.has("10.0.0.99"), "rebuilt the transport on the new address");
    assert.deepEqual(rebound, [{ from: "10.0.0.11", to: "10.0.0.99" }]);

    // rejoins B under the new address, reclaims its exact port, displaces no one
    w.clock.advance(3000);
    assert.equal(a.assignedPort, portA, "reclaimed its port after rebinding");
    assert.equal(b.assignedPort, portB, "B was not displaced");
    assert.equal(a.members.length, 2, "merged back into a 2-member view");
  });

  it("rebinds when a collapse to a singleton signals the node went deaf", async () => {
    const w = makeWorld([16197, 16187, 16177]);
    const a = w.make("aaa", "10.0.0.11", { priorPort: null, priority: 100 }, "10.0.0.77");
    const b = w.make("bbb", "10.0.0.12");

    await a.start();
    await b.start();
    w.clock.advance(1500);
    const portA = a.assignedPort;
    assert.ok(portA != null);

    const rebound: Array<{ from: string | null; to: string }> = [];
    a.on("rebound", (e) => rebound.push(e));

    // B disappears; A loses the token and reconfigures down to a singleton view —
    // the reliable "I've gone deaf" signal — which triggers the rebind.
    b.stop();
    w.clock.advance(1000);
    await settle();

    assert.deepEqual(rebound, [{ from: "10.0.0.11", to: "10.0.0.77" }]);
    assert.ok(w.transports.has("10.0.0.77"), "rebound to the new address on isolation");

    w.clock.advance(1000);
    assert.equal(a.assignedPort, portA, "kept its port through the isolation rebind");
  });

  it("rebinds in place on a lone-ring collapse at an unchanged address", async () => {
    // The fix's heal logic at the unit level: a collapse to a one-member ring while
    // the re-resolved address is UNCHANGED means reception is broken (not an IP
    // change), so the node rebinds IN PLACE rather than no-op'ing. goDeaf() forces
    // that collapse deterministically by cutting all inbound. (In production the
    // realistic path to this same collapse is a multicast-membership loss after an
    // interface recreate, where the deaf node is excluded at the next view change —
    // exercised end-to-end by the chaos integration test.)
    const w = makeWorld([16197, 16187, 16177]);
    // healAddress === the node's own address: the re-resolve reports NO change.
    const a = w.make("aaa", "10.0.0.11", { priorPort: null, priority: 100 }, "10.0.0.11");
    const b = w.make("bbb", "10.0.0.12");

    await a.start();
    await b.start();
    w.clock.advance(1500);

    const portA = a.assignedPort;
    const portB = b.assignedPort;
    assert.ok(portA != null && portB != null, `both converged: ${portA}, ${portB}`);
    assert.equal(a.members.length, 2, "started in a 2-member view");

    const rebound: Array<{ from: string | null; to: string }> = [];
    a.on("rebound", (e) => rebound.push(e));

    // A loses all inbound and reconfigures to a lone ring — the "I've gone deaf"
    // signal — and, because the address is unchanged, rebinds IN PLACE (a fresh
    // transport that can hear) rather than no-op'ing.
    w.transports.get("10.0.0.11")!.goDeaf();

    w.clock.advance(1000);
    await settle();

    assert.deepEqual(
      rebound,
      [{ from: "10.0.0.11", to: "10.0.0.11" }],
      "rebound in place on the unchanged address"
    );

    // the fresh transport restored reception: A rejoins B, reclaims its exact port,
    // and displaces no one.
    w.clock.advance(3000);
    assert.equal(a.assignedPort, portA, "reclaimed its port after the in-place rebind");
    assert.equal(b.assignedPort, portB, "B was not displaced");
    assert.equal(a.members.length, 2, "merged back into a 2-member view");
  });

  it("does NOT rebind on a transient error while the ring is still healthy", async () => {
    const w = makeWorld([16197, 16187, 16177]);
    // healAddress === own address: a heal trigger here must find nothing to do.
    const a = w.make("aaa", "10.0.0.11", { priorPort: null, priority: 100 }, "10.0.0.11");
    const b = w.make("bbb", "10.0.0.12");

    await a.start();
    await b.start();
    w.clock.advance(1500);
    const portA = a.assignedPort;
    assert.ok(portA != null);
    assert.equal(a.members.length, 2, "healthy 2-member view");

    const rebound: Array<{ from: string | null; to: string }> = [];
    a.on("rebound", (e) => rebound.push(e));
    const originalTransport = w.transports.get("10.0.0.11");

    // A transient socket error fires while A is still hearing its peer (members > 1)
    // and its address is unchanged: the heal must be an idempotent no-op.
    w.transports.get("10.0.0.11")!.failWith(
      Object.assign(new Error("transient"), { code: "ENETUNREACH" })
    );
    w.clock.advance(500);
    await settle();

    assert.deepEqual(rebound, [], "no rebind on a transient error with peers still present");
    assert.equal(w.transports.get("10.0.0.11"), originalTransport, "transport not rebuilt");
    assert.equal(a.assignedPort, portA, "port unchanged");
    assert.equal(a.members.length, 2, "still a 2-member view");
  });
});
