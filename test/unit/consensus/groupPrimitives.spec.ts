/**
 * Generic Group coordination primitives: the turn-taking baton (`onTokenGranted`)
 * and the ring-health evidence (`multicastReceivedCount`). Both are exposed at the
 * Group seam for any consumer (the UPnP coordinator is the first); the port feature
 * uses neither, so these assert the substrate surface directly over the
 * VirtualNetwork — no FluxNodeAgent / UPnP.
 *
 * The deaf-but-latent signature these enable — the unicast token keeps granting the
 * baton while peer multicast stalls — is shown here in miniature by a lone holder
 * (grants fire, peer-multicast count stays 0). Its realistic transition (an
 * interface recreate, exclusion at the next view change) is the same-IP chaos
 * integration scenario.
 */

import assert from "assert/strict";
import { describe, it } from "node:test";
import { VirtualNetwork } from "@/fluxport-controller/consensus/transport";
import { ManualClock } from "@/fluxport-controller/consensus/clock";
import { Consensus, Group } from "@/fluxport-controller/consensus/consensus";
import { MembershipConfig } from "@/fluxport-controller/consensus/membership";

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
  const makeNode = (address: string): Consensus =>
    new Consensus(net.register(address), clock, {
      localAddress: address,
      resolveLocalAddress: async () => address,
      createTransport: (addr) => net.register(addr)
    });
  return { net, clock, makeNode };
}

function joinCounting(
  c: Consensus,
  name: string
): { group: Group; grants: () => number } {
  let grants = 0;
  const group = c.join(name, {
    config: cfg,
    hooks: {
      onDeliver: () => {},
      onViewChange: () => {},
      onTokenGranted: () => {
        grants += 1;
      }
    }
  });
  return { group, grants: () => grants };
}

describe("Group coordination primitives", () => {
  it("grants the baton to the token holder each rotation", async () => {
    const w = makeWorld();
    const x = w.makeNode("10.0.0.11");
    const { grants } = joinCounting(x, "solo");
    await x.start();

    w.clock.advance(100);
    const after100 = grants();
    assert.ok(after100 > 0, `lone holder was granted the token: ${after100}`);

    // the baton keeps coming as the token rotates back to itself
    w.clock.advance(100);
    assert.ok(grants() > after100, "more grants accrue as the token keeps rotating");
  });

  it("a lone holder hears no peer multicast (the deaf-latent signature in miniature)", async () => {
    const w = makeWorld();
    const x = w.makeNode("10.0.0.11");
    const { group, grants } = joinCounting(x, "solo");
    await x.start();
    // well past announceInterval: it multicasts its own announces the whole time
    w.clock.advance(200);

    assert.ok(grants() > 0, "still granted the token (unicast) every rotation");
    assert.equal(
      group.multicastReceivedCount,
      0,
      "its own announces are not peer multicast — the count stalls with no peers"
    );
  });

  it("isolates a throwing consumer hook — the ring keeps rotating", async () => {
    const w = makeWorld();
    const x = w.makeNode("10.0.0.11");
    let grants = 0;
    x.join("solo", {
      config: cfg,
      hooks: {
        onDeliver: () => {},
        onViewChange: () => {},
        onTokenGranted: () => {
          grants += 1;
          throw new Error("consumer bug");
        }
      }
    });
    await x.start();
    w.clock.advance(100);

    // the handler throws on every grant, yet the throw is contained at the Group
    // boundary so the token keeps rotating and granting (it never reaches the ring).
    assert.ok(grants > 1, `ring kept granting through the throw: ${grants}`);
  });

  it("two peers each hear the other's multicast and both take turns with the token", async () => {
    const w = makeWorld();
    const a = w.makeNode("10.0.0.11");
    const b = w.makeNode("10.0.0.12");
    const ca = joinCounting(a, "pair");
    const cb = joinCounting(b, "pair");

    await a.start();
    await b.start();
    w.clock.advance(2000);

    assert.equal(ca.group.members.length, 2, "converged to a 2-member ring");
    assert.equal(cb.group.members.length, 2);

    // both take turns holding the token
    assert.ok(
      ca.grants() > 0 && cb.grants() > 0,
      `both granted the baton: ${ca.grants()}, ${cb.grants()}`
    );
    // both hear the OTHER's announces -> the health evidence advances on both
    assert.ok(
      ca.group.multicastReceivedCount > 0 && cb.group.multicastReceivedCount > 0,
      `both heard peer multicast: ${ca.group.multicastReceivedCount}, ${cb.group.multicastReceivedCount}`
    );
  });
});
