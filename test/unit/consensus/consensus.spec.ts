/**
 * Multi-group self-heal policy (Consensus owns the node-level heal).
 *
 * The self-heal detector lives in Consensus, not in any one consumer. Its deaf
 * policy is NODE-WIDE: a rebuild fires only when the node has actually gone deaf —
 * EVERY joined group has collapsed to a singleton, having previously had at least
 * one multi-member group — or the re-resolved address changed, or the socket
 * errored. A single group shrinking to a singleton while ANOTHER stays multi is
 * NOT deafness and must not rebuild.
 *
 * This builds nodes directly over the VirtualNetwork (no FluxPortManager / UPnP):
 * node X joins TWO groups "a" and "b"; Y (and Z) join only "b". The seams
 * (createTransport / resolveLocalAddress) re-register the SAME VirtualNetwork
 * address on a rebuild and report the address unchanged, so the only way to a
 * rebuild here is the node-deaf branch — exercising the multi-group policy.
 */

import assert from "assert/strict";
import { describe, it } from "node:test";
import {
  VirtualNetwork,
  VirtualTransport
} from "@/fluxport-controller/consensus/transport";
import { ManualClock } from "@/fluxport-controller/consensus/clock";
import { Consensus } from "@/fluxport-controller/consensus/consensus";
import { MembershipConfig } from "@/fluxport-controller/consensus/membership";

/** Let the async heal chain (re-resolve + rebuild) settle on real microtasks. */
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

const cfg: MembershipConfig = { ...FAST_TIMING };

function makeWorld() {
  const net = new VirtualNetwork();
  const clock = new ManualClock();
  // The live VirtualTransport per address (updated on each rebuild), so a test can
  // reach in and goDeaf() the current socket.
  const transports = new Map<string, VirtualTransport>();

  const makeNode = (address: string): Consensus => {
    const initial = net.register(address);
    transports.set(address, initial);
    return new Consensus(initial, clock, {
      localAddress: address,
      // The re-resolve reports NO change: the only rebuild path here is node-deaf.
      resolveLocalAddress: async () => address,
      // A rebuild re-registers the SAME address (the old socket is stopped first).
      createTransport: (addr) => {
        const t = net.register(addr);
        transports.set(addr, t);
        return t;
      }
    });
  };

  return { net, clock, transports, makeNode };
}

describe("Consensus multi-group self-heal", () => {
  it("does NOT rebind when one group is a singleton but another stays multi", async () => {
    const w = makeWorld();
    // X is in both "a" (alone) and "b" (with Y, Z); Y and Z are only in "b".
    const x = w.makeNode("10.0.0.11");
    const y = w.makeNode("10.0.0.12");
    const z = w.makeNode("10.0.0.13");

    const noop = { onDeliver: () => {}, onViewChange: () => {} };
    const ga = x.join("a", { config: cfg, hooks: noop });
    const gxb = x.join("b", { config: cfg, hooks: noop });
    const gyb = y.join("b", { config: cfg, hooks: noop });
    const gzb = z.join("b", { config: cfg, hooks: noop });

    const reboundX: Array<{ from: string | null; to: string }> = [];
    x.on("rebound", (e) => reboundX.push(e));

    await x.start();
    await y.start();
    await z.start();
    w.clock.advance(2000);
    const originalXTransport = w.transports.get("10.0.0.11");

    // "b" converged to all three; "a" is X alone.
    assert.equal(gxb.members.length, 3, `b not converged: ${gxb.members}`);
    assert.equal(gyb.members.length, 3);
    assert.equal(gzb.members.length, 3);
    assert.equal(ga.members.length, 1, "a is a lone singleton");

    // X's group "a" has been a singleton the whole time, while "b" is multi.
    // The node is NOT deaf, so no rebuild may have fired.
    assert.deepEqual(reboundX, [], "no rebind: a is singleton but b is multi");
    assert.equal(
      w.transports.get("10.0.0.11"),
      originalXTransport,
      "shared transport not rebuilt"
    );
  });

  it("rebinds and rejoins when the node goes fully deaf (all groups collapse)", async () => {
    const w = makeWorld();
    const x = w.makeNode("10.0.0.11");
    const y = w.makeNode("10.0.0.12");
    const z = w.makeNode("10.0.0.13");

    const noop = { onDeliver: () => {}, onViewChange: () => {} };
    const ga = x.join("a", { config: cfg, hooks: noop });
    const gxb = x.join("b", { config: cfg, hooks: noop });
    y.join("b", { config: cfg, hooks: noop });
    z.join("b", { config: cfg, hooks: noop });

    const reboundX: Array<{ from: string | null; to: string }> = [];
    x.on("rebound", (e) => reboundX.push(e));

    await x.start();
    await y.start();
    await z.start();
    w.clock.advance(2000);

    assert.equal(gxb.members.length, 3, "b started multi-member");
    assert.equal(ga.members.length, 1, "a started as a lone singleton");
    const originalTransport = w.transports.get("10.0.0.11");

    // X goes silently deaf on its shared socket: it stops hearing ALL inbound, so
    // "b" loses the token and reconfigures down to a singleton. Now BOTH "a" and
    // "b" are singletons and "b" had been multi -> the node is deaf -> rebuild.
    w.transports.get("10.0.0.11")!.goDeaf();
    w.clock.advance(1000);
    await settle();

    assert.deepEqual(
      reboundX,
      [{ from: "10.0.0.11", to: "10.0.0.11" }],
      "rebound in place on the unchanged address after going deaf"
    );
    assert.notEqual(
      w.transports.get("10.0.0.11"),
      originalTransport,
      "the deaf socket was replaced by a fresh one"
    );

    // The fresh (hearing) socket lets X rejoin "b" with Y and Z.
    w.clock.advance(3000);
    assert.equal(gxb.members.length, 3, "X rejoined b after the rebind");
    assert.equal(ga.members.length, 1, "a is still a lone singleton");
  });
});
