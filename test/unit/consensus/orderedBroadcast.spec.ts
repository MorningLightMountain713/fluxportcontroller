import assert from "assert/strict";
import { describe, it } from "node:test";
import { VirtualNetwork } from "@/fluxport-controller/consensus/transport";
import { ManualClock } from "@/fluxport-controller/consensus/clock";
import {
  OrderedBroadcast,
  OrderedBroadcastConfig
} from "@/fluxport-controller/consensus/orderedBroadcast";

const CONFIG: OrderedBroadcastConfig = {
  tokenRotationTarget: 10,
  tokenRetransmitTimeout: 40,
  maxTokenRetransmits: 5,
  tokenLossTimeout: 1_000_000, // effectively never; these tests don't kill nodes
  maxMessagesPerToken: 4
};

function makeWorld() {
  const net = new VirtualNetwork();
  const clock = new ManualClock();
  const delivered = new Map<string, { seq: number; payload: unknown }[]>();
  const obs = new Map<string, OrderedBroadcast>();

  const add = (nid: string): OrderedBroadcast => {
    const transport = net.register(nid);
    delivered.set(nid, []);
    const ob = new OrderedBroadcast({
      self: nid,
      transport,
      clock,
      config: CONFIG,
      hooks: {
        onDeliver: (payload, seq) => delivered.get(nid)!.push({ seq, payload })
      }
    });
    transport.start();
    ob.start();
    obs.set(nid, ob);
    return ob;
  };

  const installAll = (members: string[]) =>
    members.forEach((n) =>
      obs.get(n)!.tokenRing.installRing({ rep: members[0], seq: 1 }, members, true)
    );

  const payloads = (nid: string) => delivered.get(nid)!.map((d) => d.payload);
  const seqs = (nid: string) => delivered.get(nid)!.map((d) => d.seq);

  return { net, clock, delivered, obs, add, installAll, payloads, seqs };
}

describe("OrderedBroadcast", () => {
  it("delivers messages from many senders in one agreed total order", () => {
    const w = makeWorld();
    const members = ["a:0", "b:0", "c:0"];
    members.forEach(w.add);
    w.installAll(members);

    w.obs.get("a:0")!.broadcast("a1");
    w.obs.get("b:0")!.broadcast("b1");
    w.obs.get("c:0")!.broadcast("c1");
    w.obs.get("a:0")!.broadcast("a2");

    w.clock.advance(2000);

    // every node delivered the identical sequence
    assert.deepEqual(w.payloads("a:0"), w.payloads("b:0"));
    assert.deepEqual(w.payloads("b:0"), w.payloads("c:0"));
    // all four messages, contiguous seqs 1..4
    assert.equal(w.payloads("a:0").length, 4);
    assert.deepEqual([...w.payloads("a:0")].sort(), ["a1", "a2", "b1", "c1"]);
    assert.deepEqual(w.seqs("a:0"), [1, 2, 3, 4]);
  });

  it("recovers a dropped message via retransmission, preserving order", () => {
    const w = makeWorld();
    const members = ["a:0", "b:0", "c:0"];
    members.forEach(w.add);

    let dropped = false;
    w.net.setDropPredicate((_from, to, msg) => {
      if (!dropped && to === "c:0" && msg.kind === "MCAST" && msg.seq === 1) {
        dropped = true; // drop the first copy of seq 1 to c, once
        return true;
      }
      return false;
    });

    w.installAll(members);
    w.obs.get("a:0")!.broadcast("m1");
    w.obs.get("a:0")!.broadcast("m2");

    w.clock.advance(3000);

    assert.deepEqual(w.payloads("c:0"), ["m1", "m2"]);
    assert.deepEqual(w.payloads("a:0"), ["m1", "m2"]);
    assert.deepEqual(w.payloads("b:0"), ["m1", "m2"]);
  });

  it("never delivers a message until every member has it (safe gate)", () => {
    const w = makeWorld();
    const members = ["a:0", "b:0", "c:0"];
    members.forEach(w.add);

    // c can NEVER receive seq 1: safe must stall everywhere
    w.net.setDropPredicate(
      (_from, to, msg) => to === "c:0" && msg.kind === "MCAST" && msg.seq === 1
    );

    w.installAll(members);
    w.obs.get("a:0")!.broadcast("m1");
    w.obs.get("a:0")!.broadcast("m2");
    w.clock.advance(3000);

    // a and b hold m1 and m2 but must not deliver: c is missing m1
    assert.equal(w.payloads("a:0").length, 0);
    assert.equal(w.payloads("b:0").length, 0);
    assert.equal(w.payloads("c:0").length, 0);

    // heal: c recovers m1 via rtr and everyone delivers in order
    w.net.setDropPredicate(null);
    w.clock.advance(3000);
    assert.deepEqual(w.payloads("a:0"), ["m1", "m2"]);
    assert.deepEqual(w.payloads("b:0"), ["m1", "m2"]);
    assert.deepEqual(w.payloads("c:0"), ["m1", "m2"]);
  });

  it("delivers a singleton's own broadcasts in order", () => {
    const w = makeWorld();
    const a = w.add("a:0");
    a.bootstrap();
    a.broadcast("x");
    a.broadcast("y");

    w.clock.advance(200);
    assert.deepEqual(w.payloads("a:0"), ["x", "y"]);
    assert.deepEqual(w.seqs("a:0"), [1, 2]);
  });

  it("respects the per-token flow-control window across rotations", () => {
    const w = makeWorld();
    const members = ["a:0", "b:0", "c:0"];
    members.forEach(w.add);
    w.installAll(members);

    const sent = Array.from({ length: 10 }, (_, i) => `m${i}`);
    sent.forEach((p) => w.obs.get("a:0")!.broadcast(p)); // 10 > maxMessagesPerToken=4

    w.clock.advance(5000);

    assert.deepEqual(w.payloads("a:0"), sent);
    assert.deepEqual(w.payloads("b:0"), sent);
    assert.deepEqual(w.payloads("c:0"), sent);
    assert.deepEqual(w.seqs("a:0"), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
