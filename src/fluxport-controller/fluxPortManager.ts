/**
 * Public entry point (Phase 6): assigns this Fluxnode a unique UPnP port via the
 * token-ring atomic-broadcast consensus, with no router lock and no FluxOS
 * coupling.
 *
 * It wires the real world onto the consensus stack:
 *  - UPnP gateway discovery (nat-upnp 2.x) → the LAN interface to bind multicast
 *    on, and the router IP (emitted for observability);
 *  - the Flux deterministic node list (a public API the package already uses) →
 *    this node's prior port (sticky reuse) and `confirmed_height` (the conflict
 *    priority — globally known, stable across restarts, no local state);
 *  - a multicast transport on that interface feeding a PortAllocator keyed by the
 *    outpoint identity.
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
 * Two event-driven signals trigger a heal — a transport socket error (the fast
 * path, e.g. a send raising EADDRNOTAVAIL) and the consensus collapsing to a lone
 * ring (the reliable path: a deaf node still reforms a one-member ring). A heal
 * re-resolves the local address and rebuilds the transport + allocator — same nid,
 * so the node rejoins and reclaims its port (the proven address-change / same-nid
 * path) — when the address CHANGED, or, on an unchanged address, when we have
 * actually gone deaf (the ring collapsed to just us), which rebinds in place to
 * re-establish the dropped group membership. It is a no-op for a transient blip on
 * a still-healthy multi-member ring and for a genuinely-lone node, so both
 * detectors can fire liberally without harm.
 *
 * Every external dependency is injectable so the whole flow is testable over the
 * in-memory virtual network with no sockets, UPnP, or HTTP.
 */

import { EventEmitter } from "node:events";
import { lookup } from "node:dns/promises";
import axios from "axios";
import { Client as RealUpnpClient } from "@megachips/nat-upnp";

import { Clock, SystemClock } from "./consensus/clock";
import { Transport, MulticastTransport } from "./consensus/transport";
import { PortAllocator } from "./consensus/portAllocator";
import { View } from "./consensus/membership";
import { logController } from "./log";

const logger = logController.getLogger();

export const ALL_FLUXPORTS = [
  16197, 16187, 16177, 16167, 16157, 16147, 16137, 16127
];

const AXIOS_TIMEOUT = 3000;
const DEFAULT_ADDRESS_APIS = [
  "https://ifconfig.me",
  "https://checkip.amazonaws.com",
  "https://api.ipify.org"
];

export interface OutPoint {
  txhash: string;
  outidx: string;
}

/** What we need from the deterministic node list for this node. */
export interface NodeInfo {
  /** Previously-confirmed port for this node, if any (sticky reuse). */
  priorPort: number | null;
  /** Conflict priority — lower wins. Use confirmed_height; absent ⇒ +Infinity. */
  priority: number;
}

interface UpnpInfoLike {
  gateway: { description: string };
  getLocalAddress(): Promise<string>;
}
interface UpnpClientLike {
  getGateway(): Promise<UpnpInfoLike>;
  close?(): void;
}

interface Timing {
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
const DEFAULT_TIMING: Timing = {
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

export interface FluxPortManagerOptions extends Partial<Timing> {
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

export class FluxPortManager extends EventEmitter {
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

  private transport: Transport | null = null;
  private allocator: PortAllocator | null = null;

  // self-heal state
  private localAddress: string | null = null; // the LAN IP currently bound
  private cachedPriority = Number.MAX_SAFE_INTEGER;
  private lastConfirmedPort: number | null = null; // for reclaim across a rebind
  private lastMemberCount = 0; // to detect a multi -> singleton collapse
  private healing = false;
  private stopped = false;

  constructor(outPoint: OutPoint, options: FluxPortManagerOptions = {}) {
    super();
    this.outPoint = outPoint;
    this.multicastGroup = options.multicastGroup ?? "239.112.233.123";
    this.port = options.port ?? 16137;
    this.ports = options.ports ?? ALL_FLUXPORTS;
    this.addressApis = options.addressApis ?? DEFAULT_ADDRESS_APIS;
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
    // cacheGateway:false so a heal's re-resolve gets a FRESH gateway (and thus a
    // fresh, non-memoized getLocalAddress) rather than the stale pre-change one.
    this.upnpClient =
      options.upnpClient ?? new RealUpnpClient({ cacheGateway: false });
    this.createTransport =
      options.createTransport ??
      ((localAddress, group, port) =>
        new MulticastTransport({ localAddress, multicastGroup: group, port }));
    this.resolveNodeInfo =
      options.resolveNodeInfo ?? ((ip, op) => this.fetchNodeInfo(ip, op));
    this.getPublicIp = options.getPublicIp ?? (() => this.fetchPublicIp());
    this.resolveLocalAddress =
      options.resolveLocalAddress ??
      (async () => (await this.upnpClient.getGateway()).getLocalAddress());
  }

  get nid(): string {
    return `${this.outPoint.txhash}:${this.outPoint.outidx}`;
  }
  get assignedPort(): number | null {
    return this.allocator?.port ?? null;
  }
  get members(): string[] {
    return this.allocator?.currentMembers ?? [];
  }
  get viewId(): string | null {
    return this.allocator?.viewId ?? null;
  }

  async start(): Promise<boolean> {
    try {
      this.stopped = false;
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
      logger.warn(`Error starting FluxPortManager: ${err}`);
      this.emit("startError");
      return false;
    }
  }

  stop(): void {
    this.stopped = true;
    this.allocator?.stop();
    this.transport?.stop();
    try {
      this.upnpClient.close?.();
    } catch {
      // already closed
    }
  }

  // ---- transport + allocator construction (shared by start and heal) ----

  private async buildAndStart(
    localAddress: string,
    priorPort: number | null
  ): Promise<void> {
    this.localAddress = localAddress;
    // The imminent bootstrap installs a singleton view; reset so it isn't read as
    // a multi -> singleton collapse (which would re-trigger a heal).
    this.lastMemberCount = 1;

    const transport = this.createTransport(
      localAddress,
      this.multicastGroup,
      this.port
    );
    transport.onError((err) => this.onTransportError(err));
    this.transport = transport;
    this.allocator = new PortAllocator({
      self: localAddress,
      transport,
      clock: this.clock,
      config: {
        ...this.timing,
        ports: this.ports,
        identity: this.nid,
        priority: this.cachedPriority,
        priorPort
      },
      hooks: {
        onPortConfirmed: (port) => {
          this.lastConfirmedPort = port;
          this.emit("portConfirmed", port);
        },
        onWaiting: () => this.emit("noPortAvailable"),
        onViewChange: (view) => this.onViewChange(view)
      }
    });

    await transport.start();
    this.allocator.start();
    this.allocator.bootstrap();
  }

  // ---- self-heal on a live IP change ----

  /** Reliable detector: a collapse to a one-member view means we've gone deaf. */
  private onViewChange(view: View): void {
    const wasMulti = this.lastMemberCount > 1;
    this.lastMemberCount = view.members.length;
    if (view.members.length === 1 && wasMulti) {
      this.triggerHeal("isolated");
    }
  }

  /** Fast detector: a post-start socket error (e.g. our bound IP vanished). */
  private onTransportError(err: NodeJS.ErrnoException): void {
    logger.warn(`Transport error (${err.code ?? err.message}); re-validating address`);
    this.triggerHeal(`transport:${err.code ?? "error"}`);
  }

  private triggerHeal(reason: string): void {
    if (this.stopped || this.healing) return;
    this.healing = true;
    void this.heal(reason).finally(() => {
      this.healing = false;
    });
  }

  /**
   * Re-resolve our LAN address and rebuild the transport + allocator (same nid, so
   * we rejoin and reclaim our port) when either the address CHANGED, or it is
   * unchanged but we have gone deaf — the ring collapsed to a lone member, so a
   * same-IP membership loss (the bound IP removed and restored, or the interface
   * recreated) is the cause and rebinding in place re-establishes the dropped
   * group membership. A no-op for a transient blip on a still-healthy
   * (multi-member) ring and for a genuinely-lone node, so both detectors can fire
   * liberally without harm.
   */
  private async heal(reason: string): Promise<void> {
    let newAddress: string;
    try {
      newAddress = await this.resolveLocalAddress();
    } catch (err) {
      logger.warn(`Heal (${reason}) address re-resolve failed: ${err}`);
      return;
    }
    if (this.stopped || !newAddress) return;

    // A changed address must rebuild (the ring is keyed by address). An unchanged
    // address only rebuilds if we have actually gone deaf — consensus collapsed to
    // a lone ring — which cures a same-IP membership loss the kernel does not
    // transparently recover; otherwise it is a harmless no-op (a transient blip on
    // a healthy ring, or a genuinely-lone node).
    const addressChanged = newAddress !== this.localAddress;
    const wentDeaf = this.members.length <= 1;
    if (!addressChanged && !wentDeaf) return;

    const from = this.localAddress;
    // Reclaim the same port on the (possibly unchanged) address. assignedPort is
    // transiently null if the heal fired mid view-change (the isolation path), so
    // fall back to the last confirmed port.
    const heldPort = this.assignedPort ?? this.lastConfirmedPort;
    logger.info(
      addressChanged
        ? `Heal (${reason}): local address ${from} -> ${newAddress}; rebinding (port ${heldPort})`
        : `Heal (${reason}): rebinding in place on ${newAddress} after a membership loss (port ${heldPort})`
    );
    this.allocator?.stop();
    this.transport?.stop();
    await this.buildAndStart(newAddress, heldPort);
    this.emit("rebound", { from, to: newAddress });
  }

  // ---- default real-world resolvers (injectable above) ----

  private async fetchPublicIp(): Promise<string> {
    if (this.outPoint.txhash === "testtx") return "10.10.10.10";

    const apis = [...this.addressApis];
    for (;;) {
      const api = apis.shift()!;
      apis.push(api);
      try {
        const { data } = await axios.get(api, { timeout: AXIOS_TIMEOUT });
        const ip = String(data).trim();
        if (ip) return ip;
      } catch {
        logger.warn(`Error getting public IP from ${api}, switching...`);
      }
    }
  }

  private async fetchNodeInfo(
    publicIp: string,
    outPoint: OutPoint
  ): Promise<NodeInfo> {
    if (outPoint.txhash === "testtx") {
      return { priorPort: null, priority: Number.MAX_SAFE_INTEGER };
    }

    const url = `https://api.runonflux.io/daemon/viewdeterministiczelnodelist?filter=${publicIp}`;
    let list: any[] | null = null;
    while (!list) {
      try {
        const { data } = await axios.get(url, { timeout: AXIOS_TIMEOUT });
        if (data?.status === "success") list = data.data;
      } catch {
        logger.warn(`Error fetching deterministic list for ${publicIp}, retrying`);
      }
      if (!list) await this.sleep(1000);
    }

    const node = list.find(
      (n) => n.txhash === outPoint.txhash && n.outidx === outPoint.outidx
    );
    if (!node) {
      // not yet confirmed: lowest possible priority so established nodes win
      return { priorPort: null, priority: Number.MAX_SAFE_INTEGER };
    }

    const [, portStr] = String(node.ip).split(":");
    const priorPort = +portStr || 16127;
    const priority = Number(node.confirmed_height) || Number.MAX_SAFE_INTEGER;
    return { priorPort, priority };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
