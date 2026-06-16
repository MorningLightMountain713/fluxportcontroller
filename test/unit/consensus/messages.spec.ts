import assert from "assert/strict";
import { describe, it } from "node:test";
import {
  PROTOCOL_VERSION,
  SEPARATOR,
  encode,
  decodeDatagram,
  McastMessage,
  TokenMessage,
  JoinMessage,
  CommitTokenMessage
} from "@/fluxport-controller/consensus/messages";

const ring = { rep: "a:0", seq: 1 };

const mcast: McastMessage = {
  kind: "MCAST",
  ringId: ring,
  senderNid: "a:0",
  seq: 7,
  payload: { type: "CLAIM", nid: "a:0", port: 16197, incarnation: 3 }
};
const token: TokenMessage = {
  kind: "TOKEN",
  ringId: ring,
  tokenSeq: 42,
  seq: 7,
  safe: 4,
  aru: 5,
  aruId: "b:0",
  rtr: [6, 7],
  fcc: 2
};
const join: JoinMessage = {
  kind: "JOIN",
  ringId: ring,
  senderNid: "a:0",
  gathering: true,
  procSet: ["a:0", "b:0"],
  failSet: ["c:0"]
};
const commit: CommitTokenMessage = {
  kind: "COMMIT_TOKEN",
  ringId: ring,
  phase: "collect",
  originator: "a:0",
  members: ["a:0", "b:0"],
  memberStates: [
    { nid: "a:0", oldRing: ring, aru: 5 },
    { nid: "b:0", oldRing: ring, aru: 4 }
  ],
  visited: ["a:0"]
};

describe("messages codec", () => {
  it("round-trips every message kind (version injected then stripped)", () => {
    for (const msg of [mcast, token, join, commit]) {
      const decoded = decodeDatagram(encode(msg));
      assert.equal(decoded.length, 1);
      assert.deepEqual(decoded[0], msg);
    }
  });

  it("injects the protocol version onto the wire", () => {
    const onWire = JSON.parse(
      encode(token).toString().split(SEPARATOR).filter(Boolean)[0]
    );
    assert.equal(onWire.version, PROTOCOL_VERSION);
  });

  it("decodes several messages coalesced in one datagram", () => {
    const datagram = Buffer.concat([encode(token), encode(mcast)]);
    const decoded = decodeDatagram(datagram);
    assert.equal(decoded.length, 2);
    assert.deepEqual(decoded[0], token);
    assert.deepEqual(decoded[1], mcast);
  });

  it("returns nothing for an empty datagram", () => {
    assert.deepEqual(decodeDatagram(Buffer.from("")), []);
  });

  it("drops a malformed fragment but keeps a valid neighbour", () => {
    const datagram = Buffer.from(
      `${SEPARATOR}{not json${SEPARATOR}` +
        `${JSON.stringify({ version: PROTOCOL_VERSION, ...token })}${SEPARATOR}`
    );
    const decoded = decodeDatagram(datagram);
    assert.equal(decoded.length, 1);
    assert.deepEqual(decoded[0], token);
  });

  it("drops a message with a mismatched protocol version", () => {
    const datagram = Buffer.from(
      `${SEPARATOR}${JSON.stringify({ version: 999, ...token })}${SEPARATOR}`
    );
    assert.deepEqual(decodeDatagram(datagram), []);
  });

  it("drops a message of unknown kind", () => {
    const datagram = Buffer.from(
      `${SEPARATOR}${JSON.stringify({ version: PROTOCOL_VERSION, kind: "BOGUS", ringId: ring })}${SEPARATOR}`
    );
    assert.deepEqual(decodeDatagram(datagram), []);
  });

  it("gives each decode an independent object (no shared payload reference)", () => {
    const buf = encode(mcast);
    const a = decodeDatagram(buf)[0] as McastMessage;
    const b = decodeDatagram(buf)[0] as McastMessage;
    assert.notEqual(a, b);
    assert.notEqual(a.payload, b.payload);
    assert.deepEqual(a.payload, b.payload);
  });
});
