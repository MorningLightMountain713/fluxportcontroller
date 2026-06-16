/**
 * Pull-based client for one node container. The node serves its consensus state
 * on STATUS_PORT (see test_entrypoint.ts); the harness reaches it through the
 * testcontainers-mapped host port — no static IP needed, because we query the
 * container by its handle rather than by a pre-known address.
 */
import type { StartedTestContainer } from "testcontainers";

export interface NodeStatus {
  /** Stable claim identity (txhash:outidx). */
  nid: string;
  /** Confirmed UPnP port, or null until the node has won one. */
  port: number | null;
  /** Current ring/view id ("rep:seq"), or null before bootstrap. */
  view: string | null;
  /** Members of the current view. */
  members: string[];
}

export class NodeClient {
  constructor(
    readonly container: StartedTestContainer,
    private readonly statusPort: number
  ) {}

  get name(): string {
    return this.container.getName();
  }

  /** Fetch the node's current consensus state. */
  async status(): Promise<NodeStatus> {
    const host = this.container.getHost();
    const port = this.container.getMappedPort(this.statusPort);
    const res = await fetch(`http://${host}:${port}/`, {
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) throw new Error(`status ${res.status} from ${this.name}`);
    return (await res.json()) as NodeStatus;
  }

  /** Recent container logs (for diagnosing a failed convergence). */
  async tailLogs(lines = 40): Promise<string> {
    const stream = await this.container.logs();
    const chunks: string[] = [];
    return new Promise((resolve) => {
      stream.on("data", (c) => chunks.push(c.toString()));
      stream.on("end", () =>
        resolve(chunks.join("").trimEnd().split("\n").slice(-lines).join("\n"))
      );
      stream.on("err", () => resolve(chunks.join("")));
    });
  }
}
