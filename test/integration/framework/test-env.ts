/**
 * testcontainers harness for the fluxport-controller consensus.
 *
 * Modeled on flux-dev/test-infra's testcontainers approach, but deliberately
 * simpler: this system needs NO static IPs. FluxOS fixes node IPs because IP is
 * identity there (deterministic list, IP-based peer dialing); here peers are
 * found via multicast, claim identity is the nid (not the IP), the node list is
 * stubbed, and the harness reaches each node through its testcontainers handle.
 * So all we need is ONE shared bridge network (so multicast frames cross) with
 * ordinary dynamic IPs.
 *
 * It builds the node image once, starts a miniupnpd "router" (so the real UPnP
 * localAddress-discovery + multicast-bind path runs) and N node containers on the
 * network, then verifies convergence by PULLING each node's status endpoint.
 */
import { GenericContainer, Network, Wait } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";
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

export interface ConsensusEnv {
  nodes: NodeClient[];
  teardown(): Promise<void>;
}

export async function createConsensusEnv(opts: {
  nodes: number;
}): Promise<ConsensusEnv> {
  await buildImage();
  const network = await new Network().start();
  const started: StartedTestContainer[] = [];

  const teardown = async (): Promise<void> => {
    for (const c of [...started].reverse()) await c.stop().catch(() => {});
    await network.stop().catch(() => {});
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

    // Start nodes concurrently; each is tracked the instant it starts so a
    // partial-failure teardown still stops everything already up.
    const nodes = await Promise.all(
      Array.from({ length: opts.nodes }, (_, i) =>
        new GenericContainer(IMAGE)
          .withNetwork(network)
          .withExposedPorts(STATUS_PORT)
          .withEnvironment({
            HARNESS: "1",
            MULTICAST_GROUP,
            PORT: String(CONSENSUS_PORT),
            STATUS_PORT: String(STATUS_PORT),
            TX_HASH: `node-${i + 1}`
          })
          .withLabels(LABELS)
          // Gate start on the listening-log line (a Docker-API signal), NOT
          // Wait.forHttp: at N=8, forHttp's host-side probe races the concurrent
          // port-forward setup on Docker Desktop and times out — even though the
          // endpoint is listening in ~1s and host-reachable in ~1s (measured).
          // The real HTTP check is not skipped: waitForConvergence GETs each
          // node's status endpoint once all containers are up.
          .withWaitStrategy(Wait.forLogMessage(/status endpoint on/))
          .start()
          .then((c) => {
            started.push(c);
            return new NodeClient(c, STATUS_PORT);
          })
      )
    );
    return { nodes, teardown };
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
      if (allAssigned && distinct && oneView) return ok;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `did not converge in ${timeoutMs}ms; last=${JSON.stringify(last)}`
  );
}
