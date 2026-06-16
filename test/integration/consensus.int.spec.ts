/**
 * Integration test: the consensus running for real — N containers, each a full
 * fluxport-controller node doing real UPnP discovery (against a miniupnpd router)
 * and real UDP multicast across a Docker bridge. Verification is pull-based: the
 * harness queries each node's status endpoint and asserts the allocation has
 * converged. This is the end-to-end gate the in-memory unit tests can't be — real
 * sockets, real packet timing, a real network boundary.
 */
import assert from "assert/strict";
import { after, before, describe, it } from "node:test";
import {
  ConsensusEnv,
  createConsensusEnv,
  waitForConvergence
} from "./framework/test-env";

const NODES = Number(process.env.INT_NODES ?? 8);
const CONVERGE_TIMEOUT_MS = 90_000;

describe("consensus integration (real UPnP + multicast, N containers)", () => {
  let env: ConsensusEnv;

  before(async () => {
    env = await createConsensusEnv({ nodes: NODES });
  }, { timeout: 300_000 });

  after(async () => {
    await env?.teardown();
  }, { timeout: 60_000 });

  it(
    "converges to N distinct ports in one agreed view",
    { timeout: CONVERGE_TIMEOUT_MS + 30_000 },
    async () => {
      let statuses;
      try {
        statuses = await waitForConvergence(env.nodes, NODES, CONVERGE_TIMEOUT_MS);
      } catch (err) {
        for (const n of env.nodes) {
          console.error(`\n--- ${n.name} ---\n${await n.tailLogs(15)}`);
        }
        throw err;
      }

      const ports = statuses.map((s) => s.port);
      assert.ok(
        ports.every((p) => typeof p === "number"),
        `a node has no confirmed port: ${JSON.stringify(ports)}`
      );
      assert.equal(
        new Set(ports).size,
        NODES,
        `ports are not all distinct: ${JSON.stringify(ports)}`
      );

      const views = new Set(statuses.map((s) => s.view));
      assert.equal(views.size, 1, `nodes hold more than one view: ${[...views]}`);

      for (const s of statuses) {
        assert.equal(
          s.members.length,
          NODES,
          `${s.nid} sees ${s.members.length} members, expected ${NODES}`
        );
      }
    }
  );
});
