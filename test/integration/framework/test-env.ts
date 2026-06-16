/**
 * testcontainers harness for the fluxport-controller consensus.
 *
 * Modeled on flux-dev/test-infra's testcontainers approach, but deliberately
 * simpler: this system needs NO static IPs. FluxOS fixes node IPs because IP is
 * identity there (deterministic list, IP-based peer dialing); here peers are
 * found via multicast, claim identity is the nid (not the IP), the node list is
 * stubbed, and the harness reaches each node over the Docker exec/logs API rather
 * than by address. So all we need is ONE shared bridge network (so multicast
 * frames cross) with ordinary dynamic IPs.
 *
 * It builds the node image once, starts a miniupnpd "router" (so the real UPnP
 * localAddress-discovery + multicast-bind path runs) and N node containers on the
 * network, then verifies convergence by PULLING each node's status endpoint.
 *
 * Beyond the convergence gate, the env exposes chaos primitives (kill / rejoin /
 * partition / heal / loss). Partition and loss are both done with iptables INSIDE
 * each container (so they need NET_ADMIN + iptables in the image), which leaves
 * each container's IP untouched. That is deliberate: the multicast
 * socket binds to the UPnP-discovered LAN IP at startup and is not re-discovered
 * (see transport.ts), so a Docker-level network disconnect/reconnect would change
 * the IP out from under that binding and silently break multicast — which is also
 * not how a real partition behaves. Dropping packets by peer source-IP keeps the
 * IP stable and is the faithful simulation of a partition / lossy link.
 */
import { GenericContainer, Network, Wait } from "testcontainers";
import type { StartedNetwork, StartedTestContainer } from "testcontainers";
import { NodeClient, NodeStatus } from "./node-client";

// `npm run inttest` runs from the package root, so the Docker build context (which
// must hold the Dockerfile + src) is just the cwd — no import.meta/__dirname,
// which keeps this compilable under the package's commonjs tsconfig.
const REPO_ROOT = process.cwd();

const IMAGE = "fluxport-controller-inttest";
const MINIUPNPD_IMAGE = "megachips/miniupnpd:entrypoint";
const MULTICAST_GROUP = "239.16.32.15";
const CONSENSUS_PORT = 33333;
const STATUS_PORT = 33334;
const LABELS = { "com.megachips.harness": "fluxport-inttest" };

// Build the node image once per process and reuse it across describe blocks.
let imagePromise: Promise<unknown> | undefined;
function buildImage(): Promise<unknown> {
  return (imagePromise ??= GenericContainer.fromDockerfile(REPO_ROOT).build(
    IMAGE,
    { deleteOnExit: false }
  ));
}

// One node container (unstarted), wired for the harness. NET_ADMIN lets the chaos
// helpers run iptables/tc in the container's own network namespace; it's inert
// for the plain convergence gate.
function nodeContainer(network: StartedNetwork, txHash: string): GenericContainer {
  return (
    new GenericContainer(IMAGE)
      .withNetwork(network)
      .withAddedCapabilities("NET_ADMIN")
      .withEnvironment({
        HARNESS: "1",
        MULTICAST_GROUP,
        PORT: String(CONSENSUS_PORT),
        STATUS_PORT: String(STATUS_PORT),
        TX_HASH: txHash
      })
      .withLabels(LABELS)
      // Gate start on the listening-log line (a Docker-API signal). We don't map
      // the status port to the host at all: both the start gate (this log line)
      // and the verification (NodeClient.status execs a loopback GET inside the
      // container) go through the Docker API, never the host port-forwarder —
      // which on Docker Desktop is the unreliable layer (a forward can die for a
      // whole run). The real HTTP check is not lost; it just doesn't traverse the
      // host boundary.
      .withWaitStrategy(Wait.forLogMessage(/status endpoint on/))
  );
}

export interface ConsensusEnv {
  /** Live nodes (a killed node is removed; a rejoined node is appended). */
  nodes: NodeClient[];
  /**
   * Launch one more node under a chosen TX_HASH (its nid becomes `${txHash}:0`).
   * Pass a crashed node's TX_HASH to rejoin under the SAME identity.
   */
  addNode(txHash: string): Promise<NodeClient>;
  /** Crash a node (stop its container) and drop it from `nodes`. */
  kill(node: NodeClient): Promise<void>;
  /**
   * Sever all traffic between two groups: in each node's own netns, DROP every
   * packet whose source is a node on the other side. This blocks the multicast
   * data/discovery plane (datagrams carry the sender's unicast source IP) AND
   * unicast token passing, in both directions, while leaving IPs untouched.
   */
  partition(groupA: NodeClient[], groupB: NodeClient[]): Promise<void>;
  /** Remove every partition rule (flush the INPUT chain on all live nodes). */
  heal(): Promise<void>;
  /**
   * Drop a random `lossPct`% of each target's INBOUND packets (iptables
   * `statistic` match). This is per-recipient loss — the same model as the
   * in-memory dropPredicate sweep — applied to real sockets. (tc/netem isn't an
   * option: Docker Desktop's kernel has no sch_netem.)
   */
  injectLoss(targets: NodeClient[], lossPct: number): Promise<void>;
  /** Remove injected loss on each target (flush its INPUT chain). */
  clearLoss(targets: NodeClient[]): Promise<void>;
  teardown(): Promise<void>;
}

export async function createConsensusEnv(opts: {
  nodes: number;
}): Promise<ConsensusEnv> {
  await buildImage();
  const network = await new Network().start();
  const networkName = network.getName();
  const started: StartedTestContainer[] = [];
  const nodes: NodeClient[] = [];

  const teardown = async (): Promise<void> => {
    for (const c of [...started].reverse()) await c.stop().catch(() => {});
    await network.stop().catch(() => {});
  };

  // Run a shell command inside a node's container; throw on a non-zero exit so a
  // mis-applied chaos rule fails the test loudly instead of silently no-op'ing.
  const exec = async (node: NodeClient, cmd: string): Promise<void> => {
    const res = await node.container.exec(["sh", "-c", cmd]);
    if (res.exitCode !== 0) {
      throw new Error(
        `exec failed on ${node.name} (exit ${res.exitCode}): ${cmd}\n${res.output}`
      );
    }
  };

  const ipOf = (node: NodeClient): string =>
    node.container.getIpAddress(networkName);

  const startNode = async (txHash: string): Promise<NodeClient> => {
    const c = await nodeContainer(network, txHash).start();
    started.push(c);
    const client = new NodeClient(c, STATUS_PORT, txHash);
    nodes.push(client);
    return client;
  };

  try {
    // miniupnpd's real interface is SSDP over UDP multicast, and its HTTP/SOAP
    // control port is randomly assigned each boot — so there's no fixed HTTP
    // endpoint to probe. Wait for its init log line instead. This gate isn't
    // load-bearing: nodes self-heal (test_entrypoint retries start() on a failed
    // UPnP discovery), so it only spares them an early retry cycle.
    const miniupnpd = await new GenericContainer(MINIUPNPD_IMAGE)
      .withNetwork(network)
      .withAddedCapabilities("NET_ADMIN")
      .withLabels(LABELS)
      .withWaitStrategy(Wait.forLogMessage(/HTTP listening on port/))
      .start();
    started.push(miniupnpd);

    // Start nodes concurrently; startNode tracks each the instant it starts so a
    // partial-failure teardown still stops everything already up.
    await Promise.all(
      Array.from({ length: opts.nodes }, (_, i) => startNode(`node-${i + 1}`))
    );

    return {
      nodes,
      addNode: startNode,
      async kill(node: NodeClient): Promise<void> {
        await node.container.stop().catch(() => {});
        const idx = nodes.indexOf(node);
        if (idx >= 0) nodes.splice(idx, 1);
      },
      async partition(
        groupA: NodeClient[],
        groupB: NodeClient[]
      ): Promise<void> {
        const aIps = groupA.map(ipOf);
        const bIps = groupB.map(ipOf);
        const dropRules = (peerIps: string[]): string =>
          peerIps.map((ip) => `iptables -A INPUT -s ${ip} -j DROP`).join(" && ");
        await Promise.all([
          ...groupA.map((n) => exec(n, dropRules(bIps))),
          ...groupB.map((n) => exec(n, dropRules(aIps)))
        ]);
      },
      async heal(): Promise<void> {
        await Promise.all(nodes.map((n) => exec(n, "iptables -F INPUT")));
      },
      async injectLoss(
        targets: NodeClient[],
        lossPct: number
      ): Promise<void> {
        const probability = (lossPct / 100).toFixed(4);
        await Promise.all(
          targets.map((n) =>
            exec(
              n,
              `iptables -A INPUT -m statistic --mode random --probability ${probability} -j DROP`
            )
          )
        );
      },
      async clearLoss(targets: NodeClient[]): Promise<void> {
        await Promise.all(targets.map((n) => exec(n, "iptables -F INPUT")));
      },
      teardown
    };
  } catch (err) {
    await teardown();
    throw err;
  }
}

/**
 * Poll every node's status until the allocation has converged: all N report a
 * numeric port, the ports are distinct, and all agree on a single view. Throws
 * with the last observed snapshot if it never converges.
 */
export async function waitForConvergence(
  nodes: NodeClient[],
  expected: number,
  timeoutMs: number,
  intervalMs = 1000
): Promise<NodeStatus[]> {
  const deadline = Date.now() + timeoutMs;
  let last: (NodeStatus | null)[] = [];
  while (Date.now() < deadline) {
    last = await Promise.all(nodes.map((n) => n.status().catch(() => null)));
    const ok = last.filter((s): s is NodeStatus => s !== null);
    if (ok.length === expected) {
      const ports = ok.map((s) => s.port);
      const views = ok.map((s) => s.view);
      const allAssigned = ports.every((p) => typeof p === "number");
      const distinct = new Set(ports).size === expected;
      const oneView = views[0] != null && new Set(views).size === 1;
      // Membership must also have settled to exactly `expected` members. This is
      // what distinguishes a real converged state from a STALE one: right after a
      // partition, each side still reports the old (larger) view — distinct ports
      // and one shared view both hold on that stale snapshot, so without this
      // check waitForConvergence would return before the split actually manifests.
      const fullMembers = ok.every((s) => s.members.length === expected);
      if (allAssigned && distinct && oneView && fullMembers) return ok;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `did not converge in ${timeoutMs}ms; last=${JSON.stringify(last)}`
  );
}
