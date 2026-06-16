import assert from "assert/strict";
import { describe, it } from "node:test";
import { VirtualNetwork } from "@/fluxport-controller/consensus/transport";
import { ManualClock } from "@/fluxport-controller/consensus/clock";
import {
  TokenRing,
  TokenRingConfig
} from "@/fluxport-controller/consensus/tokenRing";

const CONFIG: TokenRingConfig = {
  tokenRotationTarget: 10,
  tokenRetransmitTimeout: 50,
  maxTokenRetransmits: 3,
  tokenLossTimeout: 300
};

function makeWorld() {
  const net = new VirtualNetwork();
  const clock = new ManualClock();
  const order: string[] = []; // which node received the token, in order
  const lost = new Set<string>();
  const foreign = new Map<string, { msg: any; from: string }[]>();
  const joins = new Map<string, { msg: any; from: string }[]>();
  const rings = new Map<string, TokenRing>();
  const transports = new Map<string, ReturnType<VirtualNetwork["register"]>>();

  const add = (nid: string): TokenRing => {
    const transport = net.register(nid);
    foreign.set(nid, []);
    joins.set(nid, []);
    const ring = new TokenRing({
      self: nid,
      transport,
      clock,
      config: CONFIG,
      hooks: {
        onReceiveToken: () => order.push(nid),
        onTokenLost: () => lost.add(nid),
        onForeignMessage: (msg, from) => foreign.get(nid)!.push({ msg, from }),
        onJoin: (msg, from) => joins.get(nid)!.push({ msg, from })
      }
    });
    transport.start();
    ring.start();
    rings.set(nid, ring);
    transports.set(nid, transport);
    return ring;
  };

  return { net, clock, order, lost, foreign, joins, rings, transports, add };
}

describe("TokenRing", () => {
  it("bootstraps a singleton ring and keeps the token rotating to itself", () => {
    const w = makeWorld();
    const a = w.add("a:0");
    a.bootstrap();

    assert.equal(w.order.length, 1); // representative originated the token
    assert.equal(w.order[0], "a:0");
    assert.equal(a.holding, true);

    w.clock.advance(35); // ~3 more rotations at rotationTarget=10
    assert.ok(w.order.length >= 4);
    assert.ok(w.order.every((n) => n === "a:0"));
    assert.equal(w.lost.size, 0);
  });

  it("circulates the token through members in ring order", () => {
    const w = makeWorld();
    const members = ["a:0", "b:0", "c:0"];
    members.forEach((n) => w.add(n));
    members.forEach((n) =>
      w.rings.get(n)!.installRing({ rep: "a:0", seq: 1 }, members, true)
    );

    w.clock.advance(70);

    assert.deepEqual(w.order.slice(0, 7), [
      "a:0",
      "b:0",
      "c:0",
      "a:0",
      "b:0",
      "c:0",
      "a:0"
    ]);
    assert.equal(w.lost.size, 0);
  });

  it("detects token loss on the survivors when a member crashes", () => {
    const w = makeWorld();
    const members = ["a:0", "b:0", "c:0"];
    members.forEach((n) => w.add(n));
    members.forEach((n) =>
      w.rings.get(n)!.installRing({ rep: "a:0", seq: 1 }, members, true)
    );

    w.clock.advance(60);
    assert.equal(w.lost.size, 0);

    // crash c: stop its ring (clears timers) and its transport (stops delivery)
    w.rings.get("c:0")!.stop();
    w.transports.get("c:0")!.stop();

    w.clock.advance(1000);
    assert.ok(w.lost.has("a:0"), "a should detect token loss");
    assert.ok(w.lost.has("b:0"), "b should detect token loss");
    assert.ok(!w.lost.has("c:0"), "crashed node does not report");
  });

  it("retransmits a bounded number of times, then declares loss", () => {
    const w = makeWorld();
    const members = ["a:0", "b:0"];
    members.forEach((n) => w.add(n));

    let aToB = 0;
    w.net.setDropPredicate((from, to, msg) => {
      if (from === "a:0" && to === "b:0" && msg.kind === "TOKEN") {
        aToB += 1;
        return true; // always drop a->b token
      }
      return false;
    });

    members.forEach((n) =>
      w.rings.get(n)!.installRing({ rep: "a:0", seq: 1 }, members, true)
    );

    w.clock.advance(1000);

    // initial forward + at least one retransmit attempt were made and dropped
    assert.ok(aToB >= 2, `expected retransmits, saw ${aToB}`);
    // capped at maxTokenRetransmits (+1 initial forward)
    assert.ok(aToB <= CONFIG.maxTokenRetransmits + 1);
    assert.ok(w.lost.has("a:0"), "a gives up and declares loss");
  });

  it("routes a JOIN to the membership hook (the join trigger)", () => {
    const w = makeWorld();
    const a = w.add("a:0");
    a.bootstrap();

    const b = w.net.register("b:0");
    b.start();
    b.sendMulticast({
      kind: "JOIN",
      ringId: { rep: "b:0", seq: 1 },
      senderNid: "b:0",
      gathering: false,
      procSet: ["b:0"],
      failSet: []
    });

    const seen = w.joins.get("a:0")!;
    assert.equal(seen.length, 1);
    assert.equal(seen[0].msg.senderNid, "b:0");
    assert.equal(seen[0].from, "b:0");
  });

  it("flags foreign data-plane traffic via onForeignMessage", () => {
    const w = makeWorld();
    const a = w.add("a:0");
    a.bootstrap();

    const b = w.net.register("b:0");
    b.start();
    b.sendMulticast({
      kind: "MCAST",
      ringId: { rep: "b:0", seq: 1 },
      senderNid: "b:0",
      seq: 1,
      payload: "hi"
    });

    assert.equal(w.foreign.get("a:0")!.length, 1);
    assert.equal(w.foreign.get("a:0")![0].msg.kind, "MCAST");
  });
});
