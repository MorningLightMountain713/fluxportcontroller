/**
 * Restart-rejoin: a node that crashes and comes back with the SAME nid must
 * rejoin without breaking the allocation. On a real restart the node re-reads its
 * prior port from the deterministic list (the port it last held), so the sticky
 * preference should hand it back the same port; in every case the group must end
 * with one stable view, distinct ports, full agreement, and — crucially — no
 * survivor displaced from the port it already held.
 *
 * The victim is the largest nid, so it loses every priority tie: if a restart
 * could disturb the allocation, this is the case that would show it.
 */

import assert from "assert/strict";
import { describe, it } from "node:test";
import {
  VirtualNetwork,
  VirtualTransport
} from "@/fluxport-controller/consensus/transport";
import { ManualClock } from "@/fluxport-controller/consensus/clock";
import {
  PortAllocator,
  PortAllocatorConfig
} from "@/fluxport-controller/consensus/portAllocator";

// Fast token retransmit (≈ one rotation) + a loss timeout a node stays "down"
// past, so the survivors actually reconfigure during the gap.
const TIMING = {
  tokenRotationTarget: 5,
  tokenRetransmitTimeout: 50,
  maxTokenRetransmits: 8,
  tokenLossTimeout: 2000,
  maxMessagesPerToken: 8,
  announceInterval: 25,
  joinInterval: 12,
  joinTimeout: 60,
  commitTimeout: 1500
};
const PORTS = [16197, 16187, 16177, 16167, 16157, 16147, 16137, 16127];
const NIDS = ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"];
const VICTIM = "n8";

function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ownerPort = (
  snap: Record<number, string>,
  nid: string
): number | undefined =>
  Number(Object.entries(snap).find(([, o]) => o === nid)?.[0]) || undefined;

type Mode = "evict" | "cold" | "flap";

interface Outcome {
  distinct: number;
  owned: number;
  agree: boolean;
  oneView: boolean;
  victimPort: number;
  victimFinalPort: number;
  portFreedWhileDown: boolean;
  survivorsMoved: number;
}

function runRestart(mode: Mode, seed: number): Outcome {
  const clock = new ManualClock();
  const net = new VirtualNetwork({
    clock,
    rng: seededRng(seed),
    minLatency: 1,
    maxLatency: 30
  });
  const transports = new Map<string, VirtualTransport>();
  const allocs = new Map<string, PortAllocator>();

  const make = (nid: string, priorPort: number | null): PortAllocator => {
    const cfg: PortAllocatorConfig = {
      ...TIMING,
      ports: PORTS,
      priority: 100,
      priorPort
    };
    const a = new PortAllocator({
      self: nid,
      transport: transports.get(nid)!,
      clock,
      config: cfg
    });
    a.start();
    return a;
  };

  for (const nid of NIDS) {
    const t = net.register(nid);
    transports.set(nid, t);
    t.start();
    allocs.set(nid, make(nid, null));
  }
  NIDS.forEach((n) => allocs.get(n)!.bootstrap());
  clock.advance(20000);

  const before = allocs.get("n1")!.snapshot();
  const victimPort = ownerPort(before, VICTIM)!;
  const survivors = NIDS.filter((n) => n !== VICTIM);

  // crash
  allocs.get(VICTIM)!.stop();
  transports.get(VICTIM)!.stop();

  let portFreedWhileDown = true;
  if (mode === "flap") {
    clock.advance(200); // < tokenLossTimeout: survivors have not reconfigured yet
    portFreedWhileDown = false; // n/a — the port was never released
  } else {
    clock.advance(6000); // > tokenLossTimeout: survivors free the port
    portFreedWhileDown =
      allocs.get("n1")!.snapshot()[victimPort] === undefined;
  }

  // restart on the same transport address; realistic restarts know the prior port
  transports.get(VICTIM)!.start();
  allocs.set(VICTIM, make(VICTIM, mode === "cold" ? null : victimPort));
  allocs.get(VICTIM)!.bootstrap();
  clock.advance(20000);

  const after = allocs.get("n1")!.snapshot();
  let survivorsMoved = 0;
  for (const n of survivors) {
    if (ownerPort(before, n) !== ownerPort(after, n)) survivorsMoved += 1;
  }
  return {
    distinct: new Set(Object.values(after)).size,
    owned: Object.keys(after).length,
    agree: NIDS.every(
      (n) => JSON.stringify(allocs.get(n)!.snapshot()) === JSON.stringify(after)
    ),
    oneView: new Set(NIDS.map((n) => allocs.get(n)!.viewId)).size === 1,
    victimPort,
    victimFinalPort: ownerPort(after, VICTIM)!,
    portFreedWhileDown,
    survivorsMoved
  };
}

function assertSafe(r: Outcome, seed: number): void {
  assert.equal(r.owned, NIDS.length, `seed ${seed}: not all ports owned`);
  assert.equal(r.distinct, NIDS.length, `seed ${seed}: duplicate ports`);
  assert.ok(r.agree, `seed ${seed}: nodes disagree on allocation`);
  assert.ok(r.oneView, `seed ${seed}: more than one view`);
  assert.equal(r.survivorsMoved, 0, `seed ${seed}: a survivor was displaced`);
}

describe("restart-rejoin (same nid)", () => {
  it("evicted node rejoins and reclaims its exact prior port", () => {
    for (let seed = 1; seed <= 5; seed++) {
      const r = runRestart("evict", seed);
      assert.ok(
        r.portFreedWhileDown,
        `seed ${seed}: survivors did not free the port while the node was down`
      );
      assertSafe(r, seed);
      assert.equal(
        r.victimFinalPort,
        r.victimPort,
        `seed ${seed}: did not reclaim prior port (${r.victimFinalPort} != ${r.victimPort})`
      );
    }
  });

  it("rejoins safely even with no prior-port hint (cold restart)", () => {
    for (let seed = 1; seed <= 5; seed++) {
      assertSafe(runRestart("cold", seed), seed);
    }
  });

  it("immediate rejoin before eviction (flap) keeps the port and disturbs no one", () => {
    for (let seed = 1; seed <= 5; seed++) {
      const r = runRestart("flap", seed);
      assertSafe(r, seed);
      assert.equal(
        r.victimFinalPort,
        r.victimPort,
        `seed ${seed}: flap lost the port (${r.victimFinalPort} != ${r.victimPort})`
      );
    }
  });
});
