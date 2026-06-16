/**
 * Integration chaos tests: the consensus surviving real failures across real
 * containers/sockets — a node crashing and rejoining, a network partition and
 * heal, and sustained packet loss during a membership change. The in-memory
 * property/sweep tests already cover these mechanisms deterministically; the
 * value here is proving they hold over real UDP multicast, a real Docker network
 * boundary, real iptables/tc, and real failure-detection timing.
 *
 * Each test builds its own fresh cluster (the image is built once and reused) so
 * a mutated membership never leaks between scenarios. Allocations are compared by
 * nid, never by index, so they're robust to node ordering.
 */
import assert from "assert/strict";
import { describe, it } from "node:test";
import {
  ConsensusEnv,
  createConsensusEnv,
  waitForConvergence
} from "./framework/test-env";
import { NodeClient, NodeStatus } from "./framework/node-client";

const NODES = Number(process.env.CHAOS_NODES ?? 5);
const T = 90_000; // per-phase convergence budget

/** {nid: port} from a converged snapshot. */
function allocByNid(statuses: NodeStatus[]): Record<string, number | null> {
  return Object.fromEntries(statuses.map((s) => [s.nid, s.port]));
}

/** The node with the largest nid — it loses every priority tie (the hard case). */
function largestNid(nodes: NodeClient[]): NodeClient {
  return [...nodes].sort((a, b) =>
    (a.expectedNid ?? "") < (b.expectedNid ?? "") ? 1 : -1
  )[0];
}

/** Converge a (sub)set of nodes, dumping their logs if it never settles. */
async function converge(
  nodes: NodeClient[],
  expected: number,
  label: string
): Promise<NodeStatus[]> {
  try {
    return await waitForConvergence(nodes, expected, T);
  } catch (err) {
    console.error(`\n=== ${label}: convergence failed ===`);
    for (const n of nodes) {
      console.error(`\n--- ${n.name} ---\n${await n.tailLogs(20)}`);
    }
    throw err;
  }
}

describe("consensus chaos (real containers: kill / partition / loss)", () => {
  it(
    "kill + rejoin: survivors free the port (none displaced); same-nid rejoiner reclaims it",
    { timeout: 5 * T },
    async () => {
      const env: ConsensusEnv = await createConsensusEnv({ nodes: NODES });
      try {
        const before = allocByNid(await converge(env.nodes, NODES, "initial"));

        const victim = largestNid(env.nodes);
        const victimNid = victim.expectedNid!;
        const victimTxHash = victim.txHash!;
        const victimPort = before[victimNid];
        assert.equal(typeof victimPort, "number", "victim had no port to start");

        // crash it -> survivors must detect the token loss and reconfigure
        await env.kill(victim);
        const afterKill = await converge(env.nodes, NODES - 1, "after-kill");

        for (const s of afterKill) {
          assert.equal(
            s.port,
            before[s.nid],
            `survivor ${s.nid} was displaced from its port`
          );
        }
        assert.ok(
          afterKill.every((s) => s.port !== victimPort),
          `victim's port ${victimPort} was not freed`
        );

        // rejoin under the SAME identity
        const rejoined = await env.addNode(victimTxHash);
        assert.equal(rejoined.expectedNid, victimNid, "rejoiner identity drifted");
        const afterRejoin = allocByNid(await converge(env.nodes, NODES, "after-rejoin"));

        for (const nid of Object.keys(before)) {
          assert.equal(
            afterRejoin[nid],
            before[nid],
            `${nid} changed port across the crash/rejoin episode`
          );
        }
        assert.equal(
          afterRejoin[victimNid],
          victimPort,
          "rejoiner did not reclaim its original port"
        );
      } finally {
        await env.teardown();
      }
    }
  );

  it(
    "partition + heal: split-brain holds disjoint ports (no conflict), then heals to one view",
    { timeout: 5 * T },
    async () => {
      const env: ConsensusEnv = await createConsensusEnv({ nodes: NODES });
      try {
        const before = allocByNid(await converge(env.nodes, NODES, "initial"));

        const mid = Math.floor(NODES / 2);
        const groupA = env.nodes.slice(0, mid);
        const groupB = env.nodes.slice(mid);
        await env.partition(groupA, groupB);

        // each side reconfigures to its own ring and keeps its already-distinct ports
        const aConv = await converge(groupA, groupA.length, "partition-A");
        const bConv = await converge(groupB, groupB.length, "partition-B");

        for (const s of [...aConv, ...bConv]) {
          assert.equal(
            s.port,
            before[s.nid],
            `${s.nid} was displaced under partition`
          );
        }
        // genuinely split: two distinct views ...
        assert.notEqual(
          aConv[0].view,
          bConv[0].view,
          "the groups did not split into separate views"
        );
        // ... yet holding disjoint ports — the split-brain safety property: two
        // uncoordinated rings cannot collide because each kept its prior (distinct) port.
        const aPorts = new Set(aConv.map((s) => s.port));
        assert.ok(
          bConv.every((s) => !aPorts.has(s.port)),
          "partitioned groups hold conflicting ports"
        );

        // heal -> the rings rediscover via announce, merge, and re-assert
        await env.heal();
        const healed = allocByNid(await converge(env.nodes, NODES, "healed"));
        for (const nid of Object.keys(before)) {
          assert.equal(
            healed[nid],
            before[nid],
            `${nid} changed port across the partition/heal`
          );
        }
      } finally {
        await env.teardown();
      }
    }
  );

  it(
    "loss under churn: sustained 15% packet loss + a crash still reconverges",
    { timeout: 5 * T },
    async () => {
      const env: ConsensusEnv = await createConsensusEnv({ nodes: NODES });
      try {
        const before = allocByNid(await converge(env.nodes, NODES, "initial"));

        // 15% per-recipient inbound loss on every node — the same drop model as
        // the in-memory sweep (100% convergent at 20%), so 15% sits comfortably
        // inside tolerance and keeps the gate non-flaky, now over real sockets.
        await env.injectLoss(env.nodes, 15);

        // perturb membership UNDER loss
        const victim = largestNid(env.nodes);
        const victimPort = before[victim.expectedNid!];
        await env.kill(victim);

        const afterKill = await converge(env.nodes, NODES - 1, "after-kill-under-loss");
        for (const s of afterKill) {
          assert.equal(
            s.port,
            before[s.nid],
            `survivor ${s.nid} was displaced under loss`
          );
        }
        assert.ok(
          afterKill.every((s) => s.port !== victimPort),
          `victim's port ${victimPort} was not freed under loss`
        );
      } finally {
        await env.teardown();
      }
    }
  );

  it(
    "live IP change: a node's address changes; it self-heals and reclaims its port",
    { timeout: 5 * T },
    async () => {
      // user-IPAM subnet so the victim can be reconnected at a chosen static IP
      const env: ConsensusEnv = await createConsensusEnv({
        nodes: NODES,
        subnet: "10.88.0.0/24"
      });
      try {
        const before = allocByNid(await converge(env.nodes, NODES, "initial"));
        const victim = largestNid(env.nodes);

        // change the victim's IP out from under its bound multicast socket — the
        // container keeps running, so this is the real live-IP-change path: the
        // node must detect it (transport error / isolation), re-discover the new
        // address over real UPnP, rebuild, rejoin under the same nid, reclaim.
        const { oldIp, newIp } = await env.changeAddress(victim);
        assert.notEqual(oldIp, newIp, "the IP actually changed");

        const after = allocByNid(await converge(env.nodes, NODES, "after-ip-change"));
        for (const nid of Object.keys(before)) {
          assert.equal(
            after[nid],
            before[nid],
            `${nid} changed port across the IP change`
          );
        }
      } finally {
        await env.teardown();
      }
    }
  );
});
