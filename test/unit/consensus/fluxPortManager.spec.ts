import assert from "assert/strict";
import { describe, it } from "node:test";
import { VirtualNetwork } from "../../../src/fluxport-controller/consensus/transport";
import { ManualClock } from "../../../src/fluxport-controller/consensus/clock";
import {
  FluxPortManager,
  NodeInfo
} from "../../../src/fluxport-controller/fluxPortManager";

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

  const make = (
    txhash: string,
    address: string,
    info: NodeInfo = { priorPort: null, priority: 100 }
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
        createTransport: (addr) => net.register(addr),
        getPublicIp: async () => "1.2.3.4",
        resolveNodeInfo: async () => info
      }
    );
    m.on("portConfirmed", (p: number) => confirmed.set(txhash, p));
    m.on("routerIpConfirmed", (ip: string) => routerIp.set(txhash, ip));
    return m;
  };

  return { net, clock, confirmed, routerIp, make };
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
});
