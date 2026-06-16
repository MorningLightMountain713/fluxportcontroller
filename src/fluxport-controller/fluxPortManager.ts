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
 * `startError`. FluxOS just constructs it and listens — nothing to persist.
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

// Timing invariant: a full rotation takes ~|members| × tokenRotationTarget plus
// network latency. tokenRetransmitTimeout MUST exceed one rotation (else the
// token is retransmitted every lap — harmless after dedup, but wasteful), and
// tokenLossTimeout MUST exceed that again (else a slow rotation is mistaken for a
// dead ring → spurious reconfiguration). Sized here for the max ring of 8.
const DEFAULT_TIMING: Timing = {
  tokenRotationTarget: 40, // ~320ms/rotation for 8 members
  tokenRetransmitTimeout: 1500, // > one rotation
  maxTokenRetransmits: 4,
  tokenLossTimeout: 4000, // > a couple of rotations
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

  private transport: Transport | null = null;
  private allocator: PortAllocator | null = null;

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
    this.upnpClient =
      options.upnpClient ?? new RealUpnpClient({ cacheGateway: true });
    this.createTransport =
      options.createTransport ??
      ((localAddress, group, port) =>
        new MulticastTransport({ localAddress, multicastGroup: group, port }));
    this.resolveNodeInfo =
      options.resolveNodeInfo ?? ((ip, op) => this.fetchNodeInfo(ip, op));
    this.getPublicIp = options.getPublicIp ?? (() => this.fetchPublicIp());
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
      logger.info(
        `Node info: priorPort=${info.priorPort}, priority=${info.priority}`
      );

      const transport = this.createTransport(
        localAddress,
        this.multicastGroup,
        this.port
      );
      this.transport = transport;
      this.allocator = new PortAllocator({
        self: localAddress,
        transport,
        clock: this.clock,
        config: {
          ...this.timing,
          ports: this.ports,
          identity: this.nid,
          priority: info.priority,
          priorPort: info.priorPort
        },
        hooks: {
          onPortConfirmed: (port) => this.emit("portConfirmed", port),
          onWaiting: () => this.emit("noPortAvailable")
        }
      });

      await transport.start();
      this.allocator.start();
      this.allocator.bootstrap();
      return true;
    } catch (err) {
      logger.warn(`Error starting FluxPortManager: ${err}`);
      this.emit("startError");
      return false;
    }
  }

  stop(): void {
    this.allocator?.stop();
    this.transport?.stop();
    try {
      this.upnpClient.close?.();
    } catch {
      // already closed
    }
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
