import assert from "assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  VirtualNetwork,
  VirtualTransport
} from "../../../src/fluxport-controller/consensus/transport";
import {
  ProtocolMessage,
  TokenMessage
} from "../../../src/fluxport-controller/consensus/messages";

const ring = { rep: "a", seq: 1 };
const tok = (overrides: Partial<TokenMessage> = {}): TokenMessage => ({
  kind: "TOKEN",
  ringId: ring,
  tokenSeq: 1,
  seq: 0,
  safe: 0,
  aru: 0,
  aruId: null,
  rtr: [],
  fcc: 0,
  ...overrides
});

type Inbox = { msg: ProtocolMessage; from: string }[];

function collect(t: VirtualTransport): Inbox {
  const inbox: Inbox = [];
  t.onMessage((msg, from) => inbox.push({ msg, from }));
  return inbox;
}

describe("VirtualNetwork", () => {
  let net: VirtualNetwork;
  let a: VirtualTransport, b: VirtualTransport, c: VirtualTransport;
  let inA: Inbox, inB: Inbox, inC: Inbox;

  beforeEach(async () => {
    net = new VirtualNetwork();
    a = net.register("a");
    b = net.register("b");
    c = net.register("c");
    inA = collect(a);
    inB = collect(b);
    inC = collect(c);
    await Promise.all([a.start(), b.start(), c.start()]);
  });

  it("delivers multicast to every other endpoint but not the sender", () => {
    a.sendMulticast(tok());
    assert.equal(inA.length, 0);
    assert.equal(inB.length, 1);
    assert.equal(inC.length, 1);
    assert.equal(inB[0].from, "a");
    assert.deepEqual(inB[0].msg, tok());
  });

  it("delivers unicast only to the addressed endpoint", () => {
    a.sendUnicast(tok(), "b");
    assert.equal(inB.length, 1);
    assert.equal(inC.length, 0);
    assert.equal(inA.length, 0);
  });

  it("delivers unicast to self (singleton-ring token pass)", () => {
    a.sendUnicast(tok(), "a");
    assert.equal(inA.length, 1);
    assert.equal(inA[0].from, "a");
  });

  it("rejects duplicate address registration", () => {
    assert.throws(() => net.register("a"));
  });

  it("isolates partitions for multicast and unicast", () => {
    net.partition([["a"], ["b", "c"]]);
    a.sendMulticast(tok());
    assert.equal(inB.length, 0);
    assert.equal(inC.length, 0);

    b.sendMulticast(tok());
    assert.equal(inC.length, 1); // same partition
    assert.equal(inA.length, 0); // across partition

    a.sendUnicast(tok(), "b");
    assert.equal(inB.length, 0); // unicast across partition blocked
  });

  it("heals partitions", () => {
    net.partition([["a"], ["b", "c"]]);
    net.heal();
    a.sendMulticast(tok());
    assert.equal(inB.length, 1);
    assert.equal(inC.length, 1);
  });

  it("drops messages matching the drop predicate", () => {
    net.setDropPredicate((from, to) => to === "c");
    a.sendMulticast(tok());
    assert.equal(inB.length, 1);
    assert.equal(inC.length, 0);
    net.setDropPredicate(null);
    a.sendMulticast(tok());
    assert.equal(inC.length, 1);
  });

  it("stops delivering to a stopped endpoint", () => {
    b.stop();
    a.sendMulticast(tok());
    assert.equal(inB.length, 0);
    assert.equal(inC.length, 1);
  });
});
