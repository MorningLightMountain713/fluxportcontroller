/**
 * Integration test: the UPnP coordinator running for real — N containers, each a full
 * fluxport-controller node, behind ONE real miniupnpd "router" on a Docker bridge. The
 * unit tests drive the coordinator over a fake client; this is the end-to-end gate they
 * can't be — real SSDP discovery, real SOAP AddPortMapping/GetListOfPortMappings against
 * a real IGD, real multicast for the second consensus group.
 *
 * Verification is ground-truth: after the `ports` allocation converges, the test reads
 * the router's ACTUAL mapping table (a getMappings SOAP enumerate via a node's status
 * endpoint). Nodes run with UPNP_FAST so the minutes-scale production cadence is scaled
 * to seconds for the test window.
 *
 * Coverage: each node maps only its own port (self-map invariant) + reaches LEADER_CHECK;
 * steady-state zero writes (map rarely, check often); a departed node leaves no orphaned
 * obligation on the survivors; the leader's adaptive back-off cuts the group rate when the
 * router goes unreachable and recovers when it returns; and a stuck UPnP SOAP call on one
 * node never wedges the token or the `ports` group (the §5 fire-and-forget + isolation).
 */
import assert from "assert/strict";
import { after, before, describe, it } from "node:test";
import {
  ConsensusEnv,
  createConsensusEnv,
  waitForConvergence
} from "./framework/test-env";
import { NodeClient, UpnpMappingView } from "./framework/node-client";

const NODES = Number(process.env.UPNP_INT_NODES ?? 3);
const CONVERGE_TIMEOUT_MS = 90_000;
const MAP_TIMEOUT_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isFlux = (m: UpnpMappingView): boolean => /^Flux/i.test(m.description);

/** Read one node's full router table (ground truth), tolerating a transient fetch error. */
async function routerTable(probe: NodeClient): Promise<UpnpMappingView[]> {
  const s = await probe.upnpStatus().catch(() => null);
  return s?.upnpMappings ?? [];
}

/** Poll until `pred(table)` holds or the deadline passes; returns the last table seen. */
async function waitForTable(
  probe: NodeClient,
  pred: (t: UpnpMappingView[]) => boolean,
  timeoutMs: number
): Promise<{ ok: boolean; table: UpnpMappingView[] }> {
  const deadline = Date.now() + timeoutMs;
  let table: UpnpMappingView[] = [];
  while (Date.now() < deadline) {
    table = await routerTable(probe);
    if (pred(table)) return { ok: true, table };
    await sleep(3000);
  }
  return { ok: false, table };
}

describe("UPnP coordination integration (real miniupnpd mappings)", () => {
  let env: ConsensusEnv;
  let portByNid: Map<string, number>;
  let ipByNid: Map<string, string>;

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
      let statuses;
      try {
        statuses = await waitForConvergence(env.nodes, NODES, CONVERGE_TIMEOUT_MS);
      } catch (err) {
        for (const n of env.nodes) console.error(`\n--- ${n.name} ---\n${await n.tailLogs(15)}`);
        throw err;
      }
      portByNid = new Map(statuses.map((s) => [s.nid, s.port as number]));
      ipByNid = new Map(env.nodes.map((n) => [n.expectedNid!, env.ipOf(n)]));

      const wanted = (table: UpnpMappingView[]): boolean =>
        [...portByNid].every(([nid, port]) =>
          table.some((m) => m.public.port === port && m.private.host === ipByNid.get(nid))
        );
      const { ok, table } = await waitForTable(env.nodes[0], wanted, MAP_TIMEOUT_MS);
      if (!ok) {
        console.error(`router table: ${JSON.stringify(table)}`);
        for (const n of env.nodes) console.error(`\n--- ${n.name} ---\n${await n.tailLogs(20)}`);
      }
      assert.ok(ok, `every node's assigned port mapped to its own IP within ${MAP_TIMEOUT_MS}ms`);

      // self-map invariant: every Flux mapping is exactly its owner's OWN assigned port, or
      // its own lease-test port (40000 + N for node-N) while a lease test runs.
      const ipToNid = new Map([...ipByNid].map(([nid, ip]) => [ip, nid]));
      const leaseTestPortOf = (nid: string): number =>
        40000 + Number(/^node-(\d+):/.exec(nid)![1]);
      for (const m of table.filter(isFlux)) {
        const owner = ipToNid.get(m.private.host);
        assert.ok(owner, `Flux mapping ${m.public.port} -> ${m.private.host} has no known owner`);
        if (m.description === "Flux_Lease_Test") {
          assert.equal(m.public.port, leaseTestPortOf(owner), `node ${owner} tested on a foreign port`);
          continue;
        }
        assert.equal(m.public.port, portByNid.get(owner), `node ${owner} mapped a foreign port`);
      }

      // the slow-timing mode machine reached LEADER_CHECK over real multicast (5c gate).
      const live = await Promise.all(env.nodes.map((n) => n.status().catch(() => null)));
      assert.ok(
        live.some((s) => s?.upnpMode === "LEADER_CHECK"),
        `at least one node reached LEADER_CHECK; modes=${JSON.stringify(live.map((s) => s?.upnpMode))}`
      );
    }
  );

  it(
    "map rarely, check often: steady state holds at ZERO further router writes",
    { timeout: 210_000 },
    async () => {
      // The end state first: every lease test done (its mapping removed) and every
      // assigned port converted to a lease, so no write is still due.
      const leasedAndTested = (table: UpnpMappingView[]): boolean =>
        !table.some((m) => m.description === "Flux_Lease_Test") &&
        [...portByNid].every(([nid, port]) =>
          table.some(
            (m) => m.public.port === port && m.private.host === ipByNid.get(nid) && m.ttl > 0
          )
        );
      const leased = await waitForTable(env.nodes[0], leasedAndTested, 120_000);
      assert.ok(leased.ok, `ports leased and lease tests done; table=${JSON.stringify(leased.table)}`);

      // Wait until every node's write count has stopped climbing.
      const writesOf = async (): Promise<number[]> =>
        Promise.all(env.nodes.map((n) => n.status().then((s) => s.upnpWrites ?? 0)));
      let prev = await writesOf();
      const settleDeadline = Date.now() + 30_000;
      for (;;) {
        await sleep(4000);
        const now = await writesOf();
        if (now.every((w, i) => w === prev[i]) && now.every((w) => w > 0)) break;
        prev = now;
        assert.ok(Date.now() < settleDeadline, "write counts never settled");
      }

      // Now the steady-state assertion: across several more scan cycles, NO node writes
      // again — a healthy leased mapping is re-read, never re-written.
      const before = await writesOf();
      await sleep(15_000);
      const afterWrites = await writesOf();
      assert.deepEqual(
        afterWrites,
        before,
        `steady state must be zero writes; before=${before} after=${afterWrites}`
      );
    }
  );

  // MUST be last in this describe: it kills a node, shrinking env.nodes.
  it(
    "a departed node leaves no mapping obligation on the survivors (self-map-only)",
    { timeout: CONVERGE_TIMEOUT_MS + 120_000 },
    async () => {
      const victim = env.nodes[env.nodes.length - 1];
      const victimNid = victim.expectedNid!;
      const victimPort = portByNid.get(victimNid)!;
      const survivors = env.nodes.filter((n) => n !== victim);
      const survivorNids = new Set(survivors.map((n) => n.expectedNid!));

      await env.kill(victim);
      // The ports ring reconverges to the survivors.
      await waitForConvergence(env.nodes, NODES - 1, CONVERGE_TIMEOUT_MS);

      // Each survivor still holds its OWN port; no survivor ever maps the victim's port
      // (strict self-map-only — nobody maps on a departed node's behalf).
      const survivorIps = new Set(survivors.map((n) => env.ipOf(n)));
      // Held, and leased: miniupnpd renews a lease on a re-add, so once a lease test
      // has answered (70 s) every survivor's mapping carries one.
      const stillMineLeased = (table: UpnpMappingView[]): boolean =>
        survivors.every((n) =>
          table.some(
            (m) =>
              m.public.port === portByNid.get(n.expectedNid!) &&
              m.private.host === env.ipOf(n) &&
              m.ttl > 0
          )
        );
      const { ok, table } = await waitForTable(survivors[0], stillMineLeased, 120_000);
      assert.ok(ok, `survivors keep their own leased mappings; table=${JSON.stringify(table)}`);

      for (const m of table.filter(isFlux)) {
        if (m.public.port === victimPort && !survivorIps.has(m.private.host)) continue; // victim's lingering own mapping
        assert.ok(survivorIps.has(m.private.host), `unexpected mapping owner ${m.private.host}`);
        assert.notEqual(m.public.port, victimPort, "a survivor wrongly took over the victim's port");
        // finite lease => a departed node's mapping self-cleans (no orphan accrual).
        assert.ok(m.ttl > 0, `survivor mapping ${m.public.port} must carry a finite lease`);
      }
    }
  );
});

describe("UPnP coordination integration (router stress: back-off + stall isolation)", () => {
  let env: ConsensusEnv;

  before(async () => {
    env = await createConsensusEnv({ nodes: NODES, env: { UPNP_FAST: "1" } });
    await waitForConvergence(env.nodes, NODES, CONVERGE_TIMEOUT_MS);
  }, { timeout: 300_000 });

  after(async () => {
    await env?.teardown();
  }, { timeout: 60_000 });

  /** Poll the plain status (no SOAP — safe when the router is blocked) until pred holds. */
  const waitForStatus = async (
    node: NodeClient,
    pred: (s: Awaited<ReturnType<NodeClient["status"]>>) => boolean,
    timeoutMs: number
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await node.status().catch(() => null);
      if (s && pred(s)) return true;
      await sleep(2000);
    }
    return false;
  };

  it(
    "the leader backs the group rate off when the router goes unreachable, and recovers when it returns",
    { timeout: 150_000 },
    async () => {
      // Find the elected leader (lowest LAN address) once a ring is healthy.
      const leaderUp = await waitForStatus(
        env.nodes[0],
        () => env.nodes.length > 0,
        1000
      );
      assert.ok(leaderUp);
      let leader: NodeClient | null = null;
      const findDeadline = Date.now() + 60_000;
      while (!leader && Date.now() < findDeadline) {
        for (const n of env.nodes) {
          const s = await n.status().catch(() => null);
          if (s?.upnpIsLeader) {
            leader = n;
            break;
          }
        }
        if (!leader) await sleep(2000);
      }
      assert.ok(leader, "an upnp leader was elected");
      const peer = env.nodes.find((n) => n !== leader)!;

      const baseline = (await leader.status()).upnpRate!;
      assert.ok(baseline > 0, `leader has a baseline rate: ${baseline}`);

      // Cut the leader off from the router: its per-cycle enumerate now fails, so it
      // multiplicatively backs the WHOLE segment off (a setRate every node folds).
      await env.blockRouter(leader);
      const droppedLeader = await waitForStatus(
        leader,
        (s) => (s.upnpRate ?? Infinity) < baseline,
        90_000
      );
      assert.ok(droppedLeader, "the failing leader scan cut the shared rate below baseline");
      // The non-leader folded the SAME lower rate (the leader paced the whole segment).
      const droppedPeer = await waitForStatus(
        peer,
        (s) => (s.upnpRate ?? Infinity) < baseline,
        30_000
      );
      assert.ok(droppedPeer, "the non-leader folded the leader's backed-off rate");

      // Restore the router: clean scans must ease the rate back up toward baseline.
      await env.unblockRouter(leader);
      const recovered = await waitForStatus(
        leader,
        (s) => (s.upnpRate ?? 0) >= baseline,
        90_000
      );
      assert.ok(recovered, "clean scans recovered the rate to baseline after the router returned");
    }
  );

  it(
    "a stuck UPnP SOAP call on one node never wedges the token or the ports group (§5 isolation)",
    { timeout: 120_000 },
    async () => {
      const victim = env.nodes[0];
      // Block ONLY this node's router access — its UPnP SOAP calls now stall/fail. The
      // coordinator fires repair off the baton (never awaited on the token path) and one
      // SOAP is in flight at a time, so a stuck call must not stop the token or affect the
      // separate `ports` consensus on the shared socket.
      await env.blockRouter(victim);

      // Through the stall, the ports group stays fully converged (the production-critical
      // path is untouched), proven via the plain status (no SOAP).
      await sleep(20_000);
      const conv = await waitForConvergence(env.nodes, NODES, 30_000).catch(() => null);
      assert.ok(conv, "the ports group stayed converged despite a stuck UPnP SOAP call");
      const vs = await victim.status();
      assert.equal(vs.members.length, NODES, "the stalled node is still a full ring member");
      assert.ok(vs.upnpMode != null, "the stalled node's coordinator did not wedge");

      // Recovery: once the router returns, the node resumes a working enumerate.
      await env.unblockRouter(victim);
      const back = await env.nodes[0]
        .upnpStatus()
        .then((s) => !s.upnpError && s.upnpMappings.length > 0)
        .catch(() => false);
      assert.ok(back, "router enumerate works again after the block is cleared");
    }
  );
});
