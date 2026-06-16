import assert from "assert/strict";
import { describe, it } from "node:test";
import { VirtualNetwork } from "../../../src/fluxport-controller/consensus/transport";
import { ManualClock } from "../../../src/fluxport-controller/consensus/clock";
import {
  Membership,
  MembershipConfig,
  View
} from "../../../src/fluxport-controller/consensus/membership";

const CONFIG: MembershipConfig = {
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

function makeWorld() {
  const net = new VirtualNetwork();
  const clock = new ManualClock();
  const deliveries = new Map<string, unknown[]>();
  const views = new Map<string, View[]>();
  const members = new Map<string, Membership>();
  const transports = new Map<string, ReturnType<VirtualNetwork["register"]>>();

  const add = (nid: string): Membership => {
    const transport = net.register(nid);
    deliveries.set(nid, []);
    views.set(nid, []);
    const m = new Membership({
      self: nid,
      transport,
      clock,
      config: CONFIG,
      hooks: {
        onDeliver: (payload) => deliveries.get(nid)!.push(payload),
        onViewChange: (view) => views.get(nid)!.push(view)
      }
    });
    transport.start();
    m.start();
    members.set(nid, m);
    transports.set(nid, transport);
    return m;
  };

  const bootstrapAll = (nids: string[]) => nids.forEach((n) => members.get(n)!.bootstrap());
  const lastView = (nid: string): View => {
    const v = views.get(nid)!;
    return v[v.length - 1];
  };
  const crash = (nid: string) => {
    members.get(nid)!.stop();
    transports.get(nid)!.stop();
  };

  return {
    net,
    clock,
    deliveries,
    views,
    members,
    transports,
    add,
    bootstrapAll,
    lastView,
    crash
  };
}

describe("Membership", () => {
  it("merges two singletons into one agreed view", () => {
    const w = makeWorld();
    ["a:0", "b:0"].forEach(w.add);
    w.bootstrapAll(["a:0", "b:0"]);

    w.clock.advance(400);

    assert.deepEqual(w.lastView("a:0").members, ["a:0", "b:0"]);
    assert.deepEqual(w.lastView("b:0").members, ["a:0", "b:0"]);
    assert.deepEqual(w.lastView("a:0").ringId, w.lastView("b:0").ringId);
    assert.equal(w.members.get("a:0")!.currentState, "OPERATIONAL");
    assert.equal(w.members.get("b:0")!.currentState, "OPERATIONAL");

    // the merged ring carries application traffic to both
    w.members.get("b:0")!.broadcast("hello");
    w.clock.advance(400);
    assert.deepEqual(w.deliveries.get("a:0"), ["hello"]);
    assert.deepEqual(w.deliveries.get("b:0"), ["hello"]);
  });

  it("admits a new node into an existing view", () => {
    const w = makeWorld();
    ["a:0", "b:0"].forEach(w.add);
    w.bootstrapAll(["a:0", "b:0"]);
    w.clock.advance(400);

    w.add("c:0");
    w.members.get("c:0")!.bootstrap();
    w.clock.advance(500);

    assert.deepEqual(w.lastView("a:0").members, ["a:0", "b:0", "c:0"]);
    assert.deepEqual(w.lastView("c:0").members, ["a:0", "b:0", "c:0"]);
  });

  it("reconfigures to the survivors when a member crashes", () => {
    const w = makeWorld();
    ["a:0", "b:0", "c:0"].forEach(w.add);
    w.bootstrapAll(["a:0", "b:0", "c:0"]);
    w.clock.advance(600);
    assert.deepEqual(w.lastView("a:0").members, ["a:0", "b:0", "c:0"]);

    w.crash("c:0");
    w.clock.advance(1000);

    assert.deepEqual(w.lastView("a:0").members, ["a:0", "b:0"]);
    assert.deepEqual(w.lastView("b:0").members, ["a:0", "b:0"]);
  });

  it("preserves delivered messages across a view change (virtual synchrony)", () => {
    const w = makeWorld();
    ["a:0", "b:0", "c:0"].forEach(w.add);
    w.bootstrapAll(["a:0", "b:0", "c:0"]);
    w.clock.advance(600);

    w.members.get("a:0")!.broadcast("before");
    w.clock.advance(600);
    assert.deepEqual(w.deliveries.get("a:0"), ["before"]);
    assert.deepEqual(w.deliveries.get("b:0"), ["before"]);
    assert.deepEqual(w.deliveries.get("c:0"), ["before"]);

    w.crash("c:0");
    w.clock.advance(1000);

    // the pre-change message stays delivered exactly once; survivors reconfigured
    assert.deepEqual(w.deliveries.get("a:0"), ["before"]);
    assert.deepEqual(w.deliveries.get("b:0"), ["before"]);
    assert.deepEqual(w.lastView("a:0").members, ["a:0", "b:0"]);

    // the new view keeps working
    w.members.get("b:0")!.broadcast("after");
    w.clock.advance(600);
    assert.deepEqual(w.deliveries.get("a:0"), ["before", "after"]);
    assert.deepEqual(w.deliveries.get("b:0"), ["before", "after"]);
  });
});
