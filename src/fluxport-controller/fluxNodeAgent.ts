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
  UpnpMapping,
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
import { UpnpCoordinator } from "./upnp/upnpCoordinator";
import { GenaRouterEvents, RouterEvents } from "./upnp/routerEvents";

/** The consensus group the port-allocation feature runs over. */
const PORTS_GROUP = "ports";
/** The second consensus group: UPnP router-access coordination (paced leader-check). */
const UPNP_GROUP = "upnp";

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

// UPnP runs on a SLOW cadence — router mappings carry a long lease, so the routine op
// is a cheap read every few minutes, not a write. The relationships that matter (same
// shape as DEFAULT_TIMING, scaled up): announceInterval ≪ the per-node baton interval
// (≈ |members| × tokenRotationTarget) so peer multicast advances between a node's batons
// — the evidence the 5c health gate needs to reach LEADER_CHECK without flapping. These
// are starting values to VALIDATE against a real router in the miniupnpd harness (§7.5),
// not tuned constants; everything is overridable via options.
export const DEFAULT_UPNP_TIMING: Timing = {
  tokenRotationTarget: 20_000, // ~20s/hop -> ~40s rotation (2 nodes) .. ~2.7min (8)
  tokenRetransmitTimeout: 180_000, // ≈ one max-ring rotation
  maxTokenRetransmits: 10,
  tokenLossTimeout: 600_000, // ≈ several rotations — only a dead ring reconfigures
  maxMessagesPerToken: 16,
  announceInterval: 8_000, // ≪ the baton interval (the 5c multicast-evidence gate)
  joinInterval: 4_000,
  joinTimeout: 30_000,
  commitTimeout: 60_000
};

/** Coordinator knobs the agent defaults to SLOW values (the coordinator's own defaults
 *  are sized for the fast `ports` cadence and would flap the mode machine here). All
 *  optional; unset ones fall back to the coordinator's defaults. */
export interface UpnpCoordinatorTuning {
  /** RateLimiter sustained rate — router WRITES/sec (soft pacing; slow). */
  rate?: number;
  /** RateLimiter burst capacity (a small burst for a router-reboot mass-repair). */
  capacity?: number;
  /** No-baton window before dropping to SELF_CHECK — MUST exceed the baton interval. */
  tokenStallMs?: number;
  /** The autonomous self-check repair cycle (minutes range). */
  selfCheckCycleMs?: number;
  selfCheckWindows?: number;
  freshLaps?: number;
  enterLaps?: number;
  leaveLaps?: number;
  orphanConfirmPasses?: number;
  orphanMaxDeleteAttempts?: number;
  /** A port of this node's own that no app uses (FluxOS: api port + 3), on which the
   *  coordinator tests whether the router renews leases. Without it mappings stay
   *  permanent. Must differ from every other node's behind the same router. */
  routerTestPort?: number;
  /** The port this node listens on for the router's events (UPnP eventing). The node's
   *  firewall must let the gateway reach it. Used with `routerTestPort`; without it the
   *  leader reads the router's table on every turn. */
  eventPort?: number;
  /** The longest the leader goes without reading the table while it trusts events. */
  eventsSafetyNetMs?: number;
}

export const DEFAULT_UPNP_TUNING: Required<
  Pick<UpnpCoordinatorTuning, "rate" | "capacity" | "tokenStallMs" | "selfCheckCycleMs">
> = {
  rate: 0.5, // ~one router write / 2s sustained
  capacity: 4, // absorb a small mass-repair burst
  tokenStallMs: 240_000, // > the max baton interval, so a slow rotation never trips it
  selfCheckCycleMs: 300_000 // 5-minute autonomous repair cadence
};

export interface FluxNodeAgentOptions extends Partial<Timing> {
  multicastGroup?: string;
  port?: number;
  ports?: number[];
  addressApis?: string[];
  /** Run the UPnP coordination group (a second consensus group on the same socket).
   *  Default true. */
  enableUpnp?: boolean;
  /** Override the SLOW timing of the `upnp` group (defaults to DEFAULT_UPNP_TIMING). */
  upnpTiming?: Partial<Timing>;
  /** Override the UPnP coordinator's slow tuning (rate, stall, self-check cycle, …). */
  upnpTuning?: UpnpCoordinatorTuning;
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
  /** The router's events for a gateway description URL, a LAN address and a listening
   *  port. Default: GENA over HTTP. */
  createRouterEvents?: (descriptionUrl: string, localAddress: string, port: number) => RouterEvents;
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
  private readonly createRouterEvents: (
    descriptionUrl: string,
    localAddress: string,
    port: number
  ) => RouterEvents;
  private gatewayDescription: string | null = null;
  private readonly enableUpnp: boolean;
  private readonly upnpTiming: Timing;
  private readonly upnpTuning: UpnpCoordinatorTuning;

  private consensus: Consensus | null = null;
  private portManager: FluxPortManager | null = null;
  private upnpCoordinator: UpnpCoordinator | null = null;
  // The desired UPnP port set FluxOS has declared (its 4 Fluxports ∪ app ports). The
  // agent always also maintains its OWN assigned port, so the coordinator's desired set
  // is the union — see refreshUpnpDesired.
  private fluxosDesiredUpnp: number[] = [];

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
    this.createRouterEvents =
      options.createRouterEvents ??
      ((descriptionUrl, localAddress, port) =>
        new GenaRouterEvents({ descriptionUrl, localAddress, port }));
    this.enableUpnp = options.enableUpnp ?? true;
    this.upnpTiming = { ...DEFAULT_UPNP_TIMING, ...options.upnpTiming };
    this.upnpTuning = { ...options.upnpTuning };
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
      this.gatewayDescription = gateway.gateway.description;
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
    this.upnpCoordinator?.stop();
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
        onPortConfirmed: (port) => {
          this.emit("portConfirmed", port);
          this.refreshUpnpDesired(); // keep our assigned port in the UPnP desired set
        },
        onWaiting: () => this.emit("noPortAvailable")
      }
    });

    // Join the SECOND consensus group on the same socket and build the UPnP coordinator
    // over it — before start(), so it shares the one start/bootstrap/self-heal lifecycle.
    if (this.enableUpnp) this.buildUpnpCoordinator(consensus, localAddress);

    await consensus.start();
    // Arm the coordinator's mode-machine timers AFTER start, so the baton can drive health
    // laps (a node that never sees a baton stays in the default SELF_CHECK).
    this.upnpCoordinator?.start();
  }

  /**
   * Join the `upnp` group on the shared socket and construct the UpnpCoordinator over it.
   * `self` is the LAN address — the ring identity the token is unicast to, which is what
   * leader-check compares against (NOT the nid; the nid is an ownership key the ring never
   * uses). The agent's own serialized UPnP client and clock are reused so every SOAP call
   * funnels through one queue. Slow timing + tuning keep the mode machine from flapping
   * against the minutes-scale cadence. Failures surface as the agent's `mappingFailed`.
   */
  private buildUpnpCoordinator(consensus: Consensus, localAddress: string): void {
    const group: Group = consensus.join(UPNP_GROUP, {
      config: { ...this.upnpTiming },
      hooks: { onDeliver: () => {}, onViewChange: () => {} }
    });
    const t = this.upnpTuning;
    this.upnpCoordinator = new UpnpCoordinator({
      self: localAddress,
      group,
      client: this.upnpClient,
      clock: this.clock,
      localAddress,
      rate: t.rate ?? DEFAULT_UPNP_TUNING.rate,
      capacity: t.capacity ?? DEFAULT_UPNP_TUNING.capacity,
      tokenStallMs: t.tokenStallMs ?? DEFAULT_UPNP_TUNING.tokenStallMs,
      selfCheckCycleMs: t.selfCheckCycleMs ?? DEFAULT_UPNP_TUNING.selfCheckCycleMs,
      selfCheckWindows: t.selfCheckWindows,
      freshLaps: t.freshLaps,
      enterLaps: t.enterLaps,
      leaveLaps: t.leaveLaps,
      orphanConfirmPasses: t.orphanConfirmPasses,
      orphanMaxDeleteAttempts: t.orphanMaxDeleteAttempts,
      routerTestPort: t.routerTestPort,
      events:
        t.eventPort != null && this.gatewayDescription != null
          ? this.createRouterEvents(this.gatewayDescription, localAddress, t.eventPort)
          : undefined,
      eventsSafetyNetMs: t.eventsSafetyNetMs,
      hooks: {
        onMappingFailed: (port, reason) => this.emit("mappingFailed", port, reason),
        onEventsStateChange: (state, reason) => this.emit("upnpEvents", state, reason)
      }
    });
    this.refreshUpnpDesired();
  }

  /**
   * FluxOS declares the full desired UPnP set (its 4 Fluxports ∪ app ports). The agent
   * maintains the UNION of that and its own assigned port (last-writer-wins into the
   * coordinator). Safe to call before start() — it is applied once the coordinator exists.
   */
  setDesiredUpnpPorts(ports: number[]): void {
    this.fluxosDesiredUpnp = [...ports];
    this.refreshUpnpDesired();
  }

  /**
   * Urgent install-time UPnP map: declare a port desired and map it immediately (bypassing
   * the routine cadence), still through the one serialized client + rate budget. FluxOS
   * calls this when an app is installed. The port joins the maintained set (so the routine
   * loop keeps it, and it survives later desired-set refreshes), and the optional
   * description (e.g. "Flux_App_<name>") labels it. No-op until the coordinator is built.
   */
  async requestMap(port: number, description?: string): Promise<void> {
    if (!this.fluxosDesiredUpnp.includes(port)) {
      this.fluxosDesiredUpnp = [...this.fluxosDesiredUpnp, port];
    }
    if (this.upnpCoordinator) await this.upnpCoordinator.requestMap(port, description);
  }

  /** Feed the coordinator the union of FluxOS's desired set and our own assigned port. */
  private refreshUpnpDesired(): void {
    if (!this.upnpCoordinator) return;
    const union = new Set(this.fluxosDesiredUpnp);
    const assigned = this.assignedPort;
    if (assigned != null) union.add(assigned);
    this.upnpCoordinator.setDesiredPortSet([...union]);
  }

  /** The UPnP ports this node is maintaining (test seam / observability). */
  get desiredUpnpPorts(): number[] {
    return this.upnpCoordinator?.desired ?? [];
  }
  /** The UPnP coordinator's mode (LEADER_CHECK / SELF_CHECK), or null if disabled. */
  get upnpMode(): string | null {
    return this.upnpCoordinator?.currentMode ?? null;
  }
  /** The current group-wide UPnP rate (the adaptive back-off value), or null if disabled. */
  get upnpRate(): number | null {
    return this.upnpCoordinator?.currentRate ?? null;
  }
  /** This node's use of the router's events: off, idle, testing or trusted. */
  get upnpEvents(): string | null {
    return this.upnpCoordinator?.eventsState ?? null;
  }
  /** True when this node is the upnp ring's enumerating leader (observability). */
  get upnpIsLeader(): boolean {
    return this.upnpCoordinator?.isLeader ?? false;
  }

  /**
   * Enumerate the router's current UPnP mapping table (a real SOAP read through the one
   * serialized client). Route-through for FluxOS's `getmap` and the integration harness's
   * ground-truth check. Throws if no client/gateway — callers handle it.
   */
  async getUpnpMappings(): Promise<UpnpMapping[]> {
    return this.upnpClient.getMappings();
  }
}
