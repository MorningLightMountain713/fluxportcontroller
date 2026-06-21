/**
 * Integration test: the UPnP coordinator running for real — N containers, each a full
 * fluxport-controller node, behind ONE real miniupnpd "router" on a Docker bridge. The
 * unit tests drive the coordinator over a fake client; this is the end-to-end gate they
 * can't be — real SSDP discovery, real SOAP AddPortMapping/GetListOfPortMappings against
 * a real IGD, real multicast for the second consensus group.
 *
 * Verification is ground-truth: after the `ports` allocation converges, the test reads
 * the router's ACTUAL mapping table (a getMappings SOAP enumerate via a node's status
 * endpoint) and asserts each node mapped ONLY its own assigned port, pointing at its own
 * LAN IP (the self-map invariant), and that the slow-timing mode machine reaches
 * LEADER_CHECK over real multicast. Nodes run with UPNP_FAST so the minutes-scale
 * production cadence is scaled to seconds for the test window.
 */
import assert from "assert/strict";
import { after, before, describe, it } from "node:test";
import {
  ConsensusEnv,
  createConsensusEnv,
  waitForConvergence
} from "./framework/test-env";
import { UpnpMappingView } from "./framework/node-client";

const NODES = Number(process.env.UPNP_INT_NODES ?? 3);
const CONVERGE_TIMEOUT_MS = 90_000;
const MAP_TIMEOUT_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isFlux = (m: UpnpMappingView): boolean => /^Flux/i.test(m.description);

describe("UPnP coordination integration (real miniupnpd mappings)", () => {
  let env: ConsensusEnv;

  before(async () => {
    env = await createConsensusEnv({ nodes: NODES, env: { UPNP_FAST: "1" } });
  }, { timeout: 300_000 });

  after(async () => {
    await env?.teardown();
  }, { timeout: 60_000 });

  it(
    "each node maps ONLY its own assigned port on the real router (self-map invariant)",
    { timeout: CONVERGE_TIMEOUT_MS + MAP_TIMEOUT_MS + 30_000 },
    async () => {
      // 1) the ports allocation converges — each node wins a distinct port.
      let statuses;
      try {
        statuses = await waitForConvergence(env.nodes, NODES, CONVERGE_TIMEOUT_MS);
      } catch (err) {
        for (const n of env.nodes) console.error(`\n--- ${n.name} ---\n${await n.tailLogs(15)}`);
        throw err;
      }
      const portByNid = new Map(statuses.map((s) => [s.nid, s.port as number]));
      const ipByNid = new Map(env.nodes.map((n) => [n.expectedNid!, env.ipOf(n)]));

      // 2) wait until the router table holds a mapping for every node's assigned port,
      //    each pointing at THAT node's own IP — read as ground truth via a real
      //    getMappings enumerate through one node.
      const probe = env.nodes[0];
      const wanted = (table: UpnpMappingView[]): boolean =>
        [...portByNid].every(([nid, port]) =>
          table.some((m) => m.public.port === port && m.private.host === ipByNid.get(nid))
        );
      let table: UpnpMappingView[] = [];
      let lastErr: string | undefined;
      const deadline = Date.now() + MAP_TIMEOUT_MS;
      let ok = false;
      while (Date.now() < deadline) {
        const s = await probe.upnpStatus().catch(() => null);
        if (s) {
          table = s.upnpMappings;
          lastErr = s.upnpError;
        }
        if (wanted(table)) {
          ok = true;
          break;
        }
        await sleep(3000);
      }

      if (!ok) {
        console.error(`router table: ${JSON.stringify(table)}`);
        if (lastErr) console.error(`last getMappings error: ${lastErr}`);
        for (const n of env.nodes) console.error(`\n--- ${n.name} ---\n${await n.tailLogs(20)}`);
      }
      assert.ok(
        ok,
        `every node's assigned port mapped to its own IP within ${MAP_TIMEOUT_MS}ms` +
          (lastErr ? ` (last enumerate error: ${lastErr})` : "")
      );

      // 3) self-map invariant: every Flux mapping belongs to a known node and is exactly
      //    that node's OWN assigned port — no third-party / cross maps.
      const ipToNid = new Map([...ipByNid].map(([nid, ip]) => [ip, nid]));
      for (const m of table.filter(isFlux)) {
        const owner = ipToNid.get(m.private.host);
        assert.ok(owner, `Flux mapping ${m.public.port} -> ${m.private.host} has no known owner`);
        assert.equal(
          m.public.port,
          portByNid.get(owner),
          `node ${owner} mapped ${m.public.port}, not its own assigned port ${portByNid.get(owner)}`
        );
      }

      // 4) the slow-timing mode machine reached LEADER_CHECK over real multicast (the 5c
      //    health gate works end-to-end), not just the always-available self-check floor.
      const modes = await Promise.all(
        env.nodes.map((n) => n.upnpStatus().then((s) => s.upnpMode).catch(() => null))
      );
      assert.ok(
        modes.some((m) => m === "LEADER_CHECK"),
        `at least one node reached LEADER_CHECK on real multicast; modes=${JSON.stringify(modes)}`
      );
    }
  );
});
