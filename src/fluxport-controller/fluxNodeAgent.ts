/**
 * Public entry point + composition root: assigns this Fluxnode a unique UPnP port
 * via the token-ring atomic-broadcast consensus, with no router lock and no FluxOS
 * coupling.
 *
 * It wires the real world onto the consensus stack and hosts the feature peers:
 *  - UPnP gateway discovery (nat-upnp 2.x) → the LAN interface to bind multicast
 *    on, and the router IP (emitted for observability);
 *  - the Flux deterministic node list (a public API the package already uses) →
 *    this node's prior port (sticky reuse) and `confirmed_height` (the conflict
 *    priority — globally known, stable across restarts, no local state);
 *  - a multicast transport on that interface feeding a single shared `Consensus`,
 *    onto which the `FluxPortManager` port-feature peer joins the `ports` group.
 *
 * Emits `routerIpConfirmed`, `portConfirmed(port)`, `noPortAvailable`,
 * `startError`, and `rebound({from,to})`. FluxOS just constructs it and listens —
 * nothing to persist.
 *
 * Self-heal on a transport break: the multicast socket pins reception and egress
 * to the UPnP-discovered LAN IP (addMembership + setMulticastInterface). It cannot
 * recover on its own if that IP changes under it, and the kernel does not
 * transparently restore reception when the bound address is removed and restored
 * to the SAME value, or the interface is recreated (a bare link down/up, by
 * contrast, the kernel self-heals — it retains and re-announces the membership).
 * That heal is a NODE-LEVEL concern over the one shared socket, so it lives in
 * `Consensus`, not here: this agent just hands Consensus two seams it already
 * owns — `resolveLocalAddress` (re-resolve the LAN IP via fresh UPnP discovery)
 * and `createTransport(localAddress)` (a fresh multicast socket) — and re-emits
 * Consensus's `rebound { from, to }` as its own. The persistent allocator's sticky
 * preference reclaims the held port on the rejoin.
 *
 * Every external dependency is injectable so the whole flow is testable over the
 * in-memory virtual network with no sockets, UPnP, or HTTP.
 */

import { EventEmitter } from "node:events";
import { lookup } from "node:dns/promises";

import { Clock, SystemClock } from "./consensus/clock";
import { Transport, MulticastTransport } from "./consensus/transport";
import { Consensus, Group } from "./consensus/consensus";
import { logController } from "./log";
import {
  UpnpClientLike,
  createDefaultUpnpClient
} from "./upnpClient";
import {
  OutPoint,
  NodeInfo,
  NODE_LIST_ADDRESS_APIS,
  fetchPublicIp,
  fetchNodeInfo
} from "./nodeList";
import { FluxPortManager } from "./fluxPortManager";

/** The single consensus group the port feature runs the allocation over. */
const PORTS_GROUP = "ports";

const logger = logController.getLogger();

export const ALL_FLUXPORTS = [
  16197, 16187, 16177, 16167, 16157, 16147, 16137, 16127
];

export interface Timing {
  tokenRotationTarget: number;
  tokenRetransmitTimeout: number;
  maxTokenRetransmits: number;
  tokenLossTimeout: number;
  maxMessagesPerToken: number;
  announceInterval: number;
  joinInterval: number;
  joinTimeout: number;
  commitTimeout: number;
}

// Timing relationship (a full rotation ≈ |members| × tokenRotationTarget + latency):
//   tokenRetransmitTimeout ≈ one rotation — small enough to recover a dropped
//     token within ~a rotation (token dedup makes the occasional early/duplicate
//     retransmit harmless), large enough that the normal return usually beats it.
//     This is what makes the ring loss-tolerant: a lost token is refilled before
//     tokenLossTimeout fires, so packet loss does NOT trigger a reconfiguration.
//   tokenLossTimeout ≈ several rotations — only a genuinely dead ring (no token
//     for many laps) reconfigures.
// Sized for the max ring of 8 (~320ms rotation). Measured to hold ~100% to 20%
// packet loss and ~95% at 30%.
export const DEFAULT_TIMING: Timing = {
  tokenRotationTarget: 40,
  tokenRetransmitTimeout: 400, // ≈ one rotation
  maxTokenRetransmits: 10,
  tokenLossTimeout: 2000, // ≈ several rotations
  maxMessagesPerToken: 16,
  announceInterval: 1000,
  joinInterval: 200,
  joinTimeout: 1000,
  commitTimeout: 5000
};

export interface FluxNodeAgentOptions extends Partial<Timing> {
  multicastGroup?: string;
  port?: number;
  ports?: number[];
  addressApis?: string[];
  // injectable seams (primarily for tests)
  clock?: Clock;
  upnpClient?: UpnpClientLike;
  createTransport?: (
    localAddress: string,
    multicastGroup: string,
    port: number
  ) => Transport;
  resolveNodeInfo?: (publicIp: string, outPoint: OutPoint) => Promise<NodeInfo>;
  getPublicIp?: () => Promise<string>;
  /**
   * Re-resolve this node's LAN address (used by the self-heal path). Must perform
   * a FRESH lookup each call — the default re-runs UPnP discovery (the client is
   * created with cacheGateway:false, since getLocalAddress is memoized per
   * gateway, so a cached gateway would return the stale pre-change address).
   */
  resolveLocalAddress?: () => Promise<string>;
}

export class FluxNodeAgent extends EventEmitter {
  private readonly outPoint: OutPoint;
  private readonly multicastGroup: string;
  private readonly port: number;
  private readonly ports: number[];
  private readonly addressApis: string[];
  private readonly timing: Timing;
  private readonly clock: Clock;
  private readonly upnpClient: UpnpClientLike;
  private readonly createTransport: (
    localAddress: string,
    multicastGroup: string,
    port: number
  ) => Transport;
  private readonly resolveNodeInfo: (
    publicIp: string,
    outPoint: OutPoint
  ) => Promise<NodeInfo>;
  private readonly getPublicIp: () => Promise<string>;
  private readonly resolveLocalAddress: () => Promise<string>;

  private consensus: Consensus | null = null;
  private portManager: FluxPortManager | null = null;

  private cachedPriority = Number.MAX_SAFE_INTEGER;

  constructor(outPoint: OutPoint, options: FluxNodeAgentOptions = {}) {
    super();
    this.outPoint = outPoint;
    this.multicastGroup = options.multicastGroup ?? "239.112.233.123";
    this.port = options.port ?? 16137;
    this.ports = options.ports ?? ALL_FLUXPORTS;
    this.addressApis = options.addressApis ?? NODE_LIST_ADDRESS_APIS;
    this.timing = {
      tokenRotationTarget: options.tokenRotationTarget ?? DEFAULT_TIMING.tokenRotationTarget,
      tokenRetransmitTimeout:
        options.tokenRetransmitTimeout ?? DEFAULT_TIMING.tokenRetransmitTimeout,
      maxTokenRetransmits: options.maxTokenRetransmits ?? DEFAULT_TIMING.maxTokenRetransmits,
      tokenLossTimeout: options.tokenLossTimeout ?? DEFAULT_TIMING.tokenLossTimeout,
      maxMessagesPerToken: options.maxMessagesPerToken ?? DEFAULT_TIMING.maxMessagesPerToken,
      announceInterval: options.announceInterval ?? DEFAULT_TIMING.announceInterval,
      joinInterval: options.joinInterval ?? DEFAULT_TIMING.joinInterval,
      joinTimeout: options.joinTimeout ?? DEFAULT_TIMING.joinTimeout,
      commitTimeout: options.commitTimeout ?? DEFAULT_TIMING.commitTimeout
    };
    this.clock = options.clock ?? new SystemClock();
    this.upnpClient = options.upnpClient ?? createDefaultUpnpClient();
    this.createTransport =
      options.createTransport ??
      ((localAddress, group, port) =>
        new MulticastTransport({ localAddress, multicastGroup: group, port }));
    this.resolveNodeInfo =
      options.resolveNodeInfo ??
      ((ip, op) => fetchNodeInfo(ip, op));
    this.getPublicIp =
      options.getPublicIp ??
      (() => fetchPublicIp(this.outPoint, this.addressApis));
    this.resolveLocalAddress =
      options.resolveLocalAddress ??
      (async () => (await this.upnpClient.getGateway()).getLocalAddress());
  }

  get nid(): string {
    return `${this.outPoint.txhash}:${this.outPoint.outidx}`;
  }
  get assignedPort(): number | null {
    return this.portManager?.assignedPort ?? null;
  }
  get members(): string[] {
    return this.portManager?.members ?? [];
  }
  get viewId(): string | null {
    return this.portManager?.viewId ?? null;
  }

  async start(): Promise<boolean> {
    try {
      const publicIp = await this.getPublicIp();

      const gateway = await this.upnpClient.getGateway();
      const localAddress = await gateway.getLocalAddress();
      if (!localAddress) {
        logger.error("Could not determine local interface from UPnP gateway");
        this.emit("startError");
        return false;
      }

      // best-effort router IP for observability (an IP literal resolves offline)
      try {
        const host = new URL(gateway.gateway.description).hostname;
        const resolved = await lookup(host);
        this.emit("routerIpConfirmed", resolved.address);
      } catch {
        // non-fatal
      }

      const info = await this.resolveNodeInfo(publicIp, this.outPoint);
      this.cachedPriority = info.priority;
      logger.info(
        `Node info: priorPort=${info.priorPort}, priority=${info.priority}`
      );

      await this.buildAndStart(localAddress, info.priorPort);
      return true;
    } catch (err) {
      logger.warn(`Error starting FluxNodeAgent: ${err}`);
      this.emit("startError");
      return false;
    }
  }

  stop(): void {
    this.consensus?.stop();
    try {
      this.upnpClient.close?.();
    } catch {
      // already closed
    }
  }

  // ---- consensus + feature construction (the initial build) ----

  /**
   * Build the shared `Consensus`, join the single `ports` group, and construct the
   * `FluxPortManager` port-feature peer on it. Consensus owns the socket, drives
   * start/bootstrap, and owns the transport self-heal — it rebuilds the socket (via
   * the `createTransport` + `resolveLocalAddress` seams handed to it) and all groups
   * rejoin; this agent just re-emits Consensus's `rebound`. The persistent
   * allocator's sticky `desiredPort` reclaims the held port on the rejoin.
   */
  private async buildAndStart(
    localAddress: string,
    priorPort: number | null
  ): Promise<void> {
    const transport = this.createTransport(
      localAddress,
      this.multicastGroup,
      this.port
    );
    const consensus = new Consensus(transport, this.clock, {
      localAddress,
      resolveLocalAddress: this.resolveLocalAddress,
      // Adapt the node-level seam (address only) to this agent's group+port-aware
      // transport factory.
      createTransport: (addr) =>
        this.createTransport(addr, this.multicastGroup, this.port)
    });
    this.consensus = consensus;

    // Consensus owns the node-level self-heal; surface its rebind as our own event.
    consensus.on("rebound", (e: { from: string | null; to: string }) =>
      this.emit("rebound", e)
    );

    const config = {
      ...this.timing,
      ports: this.ports,
      identity: this.nid,
      priority: this.cachedPriority,
      priorPort
    };

    const group: Group = consensus.join(PORTS_GROUP, {
      config,
      // Placeholder hooks: the PortAllocator rebinds them to its own delivery /
      // view-change logic at construction.
      hooks: { onDeliver: () => {}, onViewChange: () => {} }
    });

    this.portManager = new FluxPortManager({
      self: localAddress,
      group,
      config,
      hooks: {
        onPortConfirmed: (port) => this.emit("portConfirmed", port),
        onWaiting: () => this.emit("noPortAvailable")
      }
    });

    await consensus.start();
  }
}
