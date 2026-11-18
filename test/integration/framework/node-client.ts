/**
 * Pull-based client for one node container. The node serves its consensus state
 * on STATUS_PORT (see test_entrypoint.ts); the harness fetches it by exec'ing a
 * loopback GET INSIDE the container (over Docker's exec API), NOT through a
 * host-mapped port.
 *
 * Why not the mapped host port: on Docker Desktop the host->container
 * port-forwarder is unreliable — a single container's forward can die for an
 * entire run, so its status() throws for 90s even though consensus has fully
 * converged (observed: 4/5 nodes agreeing on a 5-member view while the 5th was
 * simply unreachable from the host). exec'ing 127.0.0.1 inside the container
 * routes around that layer entirely while still doing a real HTTP GET of the
 * real status endpoint.
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
  // Sync UPnP fields (harness only; no SOAP, so they ride the plain status poll and stay
  // readable even when a test has blocked the node's router access).
  upnpMode?: string | null;
  upnpRate?: number | null;
  upnpIsLeader?: boolean;
  desiredUpnpPorts?: number[];
  /** Cumulative router writes/deletes this node has issued (steady-state assertion). */
  upnpWrites?: number;
  upnpDeletes?: number;
  /** Cumulative whole-table reads and single-port lookups this node has made. */
  upnpReads?: number;
  upnpLookups?: number;
  /** The node's use of the router's events: off, idle, testing or trusted. */
  upnpEvents?: string | null;
}

/** A router mapping as the node reads it back (a subset of the package's UpnpMapping). */
export interface UpnpMappingView {
  public: { host: string; port: number };
  private: { host: string; port: number };
  protocol: string;
  description: string;
  ttl: number;
  enabled: boolean;
}

/** Plain status PLUS the REAL router table (a getMappings SOAP enumerate). */
export interface UpnpNodeStatus extends NodeStatus {
  upnpMappings: UpnpMappingView[];
  /** Present if the getMappings SOAP enumerate failed. */
  upnpError?: string;
}

export class NodeClient {
  constructor(
    readonly container: StartedTestContainer,
    private readonly statusPort: number,
    /**
     * The TX_HASH the harness started this container with. The node's claim
     * identity is `${txHash}:0` (OUT_IDX defaults to 0), so a chaos test can
     * predict a node's nid without a status round-trip and can re-launch a
     * crashed node under the SAME identity (see ConsensusEnv.addNode).
     */
    readonly txHash?: string
  ) {}

  get name(): string {
    return this.container.getName();
  }

  /** The claim identity this node will report (`${txHash}:0`). */
  get expectedNid(): string | undefined {
    return this.txHash != null ? `${this.txHash}:0` : undefined;
  }

  /** Fetch the node's current consensus state (loopback GET inside the container). */
  async status(): Promise<NodeStatus> {
    const script =
      `fetch('http://127.0.0.1:${this.statusPort}/',{signal:AbortSignal.timeout(3000)})` +
      `.then(r=>r.text()).then(t=>process.stdout.write(t))` +
      `.catch(e=>{process.stderr.write(String(e&&e.message||e));process.exit(1)})`;
    const res = await this.container.exec(["node", "--no-warnings", "-e", script]);
    if (res.exitCode !== 0) {
      throw new Error(
        `status fetch failed on ${this.name} (exit ${res.exitCode}): ${res.stderr || res.output}`
      );
    }
    return JSON.parse(res.stdout) as NodeStatus;
  }

  /**
   * Fetch status PLUS the live UPnP view — mode, desired set, and the REAL router table
   * (a getMappings SOAP enumerate inside the container). Slower than status() because it
   * hits the router, so callers poll it sparingly. Times out generously for the SOAP call.
   */
  async upnpStatus(): Promise<UpnpNodeStatus> {
    const script =
      `fetch('http://127.0.0.1:${this.statusPort}/?upnp=1',{signal:AbortSignal.timeout(8000)})` +
      `.then(r=>r.text()).then(t=>process.stdout.write(t))` +
      `.catch(e=>{process.stderr.write(String(e&&e.message||e));process.exit(1)})`;
    const res = await this.container.exec(["node", "--no-warnings", "-e", script]);
    if (res.exitCode !== 0) {
      throw new Error(
        `upnp status fetch failed on ${this.name} (exit ${res.exitCode}): ${res.stderr || res.output}`
      );
    }
    return JSON.parse(res.stdout) as UpnpNodeStatus;
  }

  /** Remove a mapping from the router, as another machine on the LAN would. */
  async unmap(port: number): Promise<void> {
    const script =
      `fetch('http://127.0.0.1:${this.statusPort}/?unmap=${port}',{signal:AbortSignal.timeout(8000)})` +
      `.then(r=>r.json()).then(j=>{if(j.unmapError){process.stderr.write(j.unmapError);process.exit(1)}})` +
      `.catch(e=>{process.stderr.write(String(e&&e.message||e));process.exit(1)})`;
    const res = await this.container.exec(["node", "--no-warnings", "-e", script]);
    if (res.exitCode !== 0) {
      throw new Error(`unmap ${port} failed on ${this.name}: ${res.stderr || res.output}`);
    }
  }

  /** Recent container logs (for diagnosing a failed convergence). */
  async tailLogs(lines = 40): Promise<string> {
    const chunks: string[] = [];
    try {
      const stream = await this.container.logs();
      return await new Promise<string>((resolve) => {
        const finish = (): void =>
          resolve(
            chunks.join("").trimEnd().split("\n").slice(-lines).join("\n")
          );
        // Bound the read so a never-ending stream can't hang (or, via an
        // unhandled 'error', crash) the diagnostic and swallow the dump.
        const timer = setTimeout(finish, 5000);
        const done = (): void => {
          clearTimeout(timer);
          finish();
        };
        stream.on("data", (c) => chunks.push(c.toString()));
        stream.on("end", done);
        stream.on("error", done);
      });
    } catch (err) {
      return `<failed to read logs: ${(err as Error).message}>`;
    }
  }
}
