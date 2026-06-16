import assert from "assert/strict";
import { describe, it, beforeEach } from "node:test";
import { FluxServer, Message } from "../../src/fluxport-controller/fluxServer";

// FluxServer is abstract in spirit (runSocketServer throws), but the framing /
// helper logic lives here and is exercised by both the gossip and echo servers.
// We test it directly via a minimal concrete subclass.
class TestServer extends FluxServer {}

describe("FluxServer.ipv4ToNumber", () => {
  let server: TestServer;
  beforeEach(() => (server = new TestServer()));

  it("converts boundary and ordinary addresses", () => {
    assert.strictEqual(server.ipv4ToNumber("0.0.0.0"), 0);
    assert.strictEqual(server.ipv4ToNumber("255.255.255.255"), 4294967295);
    assert.strictEqual(server.ipv4ToNumber("1.1.1.1"), 16843009);
    assert.strictEqual(server.ipv4ToNumber("0.0.0.255"), 255);
    assert.strictEqual(server.ipv4ToNumber("0.0.1.0"), 256);
  });

  it("produces an unsigned result for high addresses (no sign flip)", () => {
    // 128.0.0.0 has the top bit set; a naive shift would go negative
    assert.strictEqual(server.ipv4ToNumber("128.0.0.0"), 2147483648);
    assert.ok(server.ipv4ToNumber("240.0.0.0") > 0);
  });

  it("orders addresses numerically when used as a sort key", () => {
    const hosts = ["10.0.0.2", "10.0.0.10", "9.255.255.255"];
    const sorted = [...hosts].sort(
      (a, b) => server.ipv4ToNumber(a) - server.ipv4ToNumber(b)
    );
    assert.deepEqual(sorted, ["9.255.255.255", "10.0.0.2", "10.0.0.10"]);
  });
});

describe("FluxServer.preparePayload", () => {
  let server: TestServer;
  beforeEach(() => (server = new TestServer()));

  it("wraps the JSON in separators by default", () => {
    const sep = server.MESSAGE_SEPARATOR;
    const payload = server.preparePayload({ type: 1, id: "a", host: "h" });
    const str = payload.toString();
    assert.ok(str.startsWith(sep));
    assert.ok(str.endsWith(sep));
    assert.deepEqual(JSON.parse(str.slice(sep.length, -sep.length)), {
      type: 1,
      id: "a",
      host: "h"
    });
  });

  it("omits separators when addSeparator is false", () => {
    const sep = server.MESSAGE_SEPARATOR;
    const payload = server.preparePayload({ type: 1, id: "a", host: "h" }, false);
    const str = payload.toString();
    assert.ok(!str.startsWith(sep));
    assert.deepEqual(JSON.parse(str), { type: 1, id: "a", host: "h" });
  });
});

describe("FluxServer.filter", () => {
  let server: TestServer;
  beforeEach(() => (server = new TestServer()));

  it("keeps only entries matching the predicate", () => {
    const obj = { a: 1, b: 2, c: 3 };
    const result = server.filter(obj, ([, v]) => v > 1);
    assert.deepEqual(result, { b: 2, c: 3 });
  });

  it("returns an empty object when nothing matches", () => {
    assert.deepEqual(server.filter({ a: 1 }, () => false), {});
  });
});

describe("FluxServer.decodeMessages (framing)", () => {
  let server: TestServer;
  let sep: string;
  beforeEach(() => {
    server = new TestServer();
    sep = server.MESSAGE_SEPARATOR;
  });

  const msg = (overrides: Partial<Message> = {}): Message => ({
    type: 1,
    id: "test",
    host: "1.1.1.1",
    ...overrides
  });

  it("decodes a single complete message", () => {
    const result = server.decodeMessages("peer", server.preparePayload(msg()));
    assert.deepEqual(result, [msg()]);
  });

  it("decodes two messages concatenated in one datagram", () => {
    const m1 = msg({ id: "one" });
    const m2 = msg({ id: "two" });
    const data = Buffer.concat([
      server.preparePayload(m1),
      server.preparePayload(m2)
    ]);
    const result = server.decodeMessages("peer", data);
    assert.deepEqual(result, [m1, m2]);
  });

  it("discards a non-standard message that does not start with a separator", () => {
    const result = server.decodeMessages("peer", Buffer.from("garbage"));
    assert.deepEqual(result, []);
  });

  it("buffers a partial message and completes it on the next call", () => {
    const full = server.preparePayload(msg({ id: "split" })).toString();
    // split a few chars into the JSON body so part 1 starts-with but does
    // not end-with the separator
    const cut = sep.length + 4;
    const part1 = Buffer.from(full.slice(0, cut));
    const part2 = Buffer.from(full.slice(cut));

    assert.deepEqual(server.decodeMessages("peer", part1), []);
    assert.deepEqual(server.decodeMessages("peer", part2), [
      msg({ id: "split" })
    ]);
  });

  it("drops a buffered partial when a fresh message arrives mid-stream", () => {
    const full = server.preparePayload(msg({ id: "lost" })).toString();
    const part1 = Buffer.from(full.slice(0, sep.length + 4));
    // part1 is buffered (no trailing separator)
    assert.deepEqual(server.decodeMessages("peer", part1), []);

    // a brand new, complete message arrives starting with a separator: the
    // stale partial must be discarded and only the new message returned
    const fresh = msg({ id: "fresh" });
    const result = server.decodeMessages("peer", server.preparePayload(fresh));
    assert.deepEqual(result, [fresh]);
  });

  it("skips unparseable JSON between separators without throwing", () => {
    const data = Buffer.from(`${sep}not-json${sep}`);
    assert.deepEqual(server.decodeMessages("peer", data), []);
  });

  it("keeps per-peer buffers independent", () => {
    const full = server.preparePayload(msg({ id: "a" })).toString();
    const part1 = Buffer.from(full.slice(0, sep.length + 4));
    const part2 = Buffer.from(full.slice(sep.length + 4));

    // peerA gets a partial; peerB sends a complete message in between
    assert.deepEqual(server.decodeMessages("peerA", part1), []);
    assert.deepEqual(
      server.decodeMessages("peerB", server.preparePayload(msg({ id: "b" }))),
      [msg({ id: "b" })]
    );
    // peerA's buffer is untouched by peerB and completes correctly
    assert.deepEqual(server.decodeMessages("peerA", part2), [msg({ id: "a" })]);
  });
});
