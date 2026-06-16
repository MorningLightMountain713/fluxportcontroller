import assert from "assert/strict";
import { describe, it } from "node:test";
import {
  VirtualNetwork,
  VirtualTransport
} from "@/fluxport-controller/consensus/transport";
import { ManualClock } from "@/fluxport-controller/consensus/clock";
import {
  FluxPortManager,
  NodeInfo
} from "@/fluxport-controller/fluxPortManager";

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
  ): FluxPortManager => {
    confirmed.set(txhash, null);
    const fakeUpnp = {
      getGateway: async () => ({
        gateway: { description: "http://10.0.0.1:5000/rootDesc.xml" },
        getLocalAddress: async () => address
      }),
      close() {}
    };
    const m = new FluxPortManager(
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

describe("FluxPortManager", () => {
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
});
