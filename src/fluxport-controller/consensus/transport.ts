/**
 * Transport seam for the atomic-broadcast layer.
 *
 * The protocol logic depends only on the `Transport` interface, so it can run on
 * a real multicast UDP socket in production or a deterministic in-memory
 * `VirtualNetwork` in tests.
 *
 * Contract:
 *  - `sendMulticast` delivers to every OTHER endpoint in the group; the sender
 *    never receives its own multicast (multicast loopback is disabled), so the
 *    protocol layer is responsible for local self-delivery.
 *  - `sendUnicast` delivers to exactly the addressed endpoint, including the
 *    sender itself (UDP unicast loops back) — this is how a singleton ring passes
 *    the token to its own successor.
 */

import dgram from "node:dgram";
import { ProtocolMessage, decodeDatagram, encode } from "./messages";
import { Clock } from "./clock";

export type MessageHandler = (msg: ProtocolMessage, from: string) => void;

export interface Transport {
  readonly localAddress: string;
  start(): Promise<void>;
  stop(): void;
  sendMulticast(msg: ProtocolMessage): void;
  sendUnicast(msg: ProtocolMessage, to: string): void;
  onMessage(handler: MessageHandler): void;
}

export interface MulticastTransportOptions {
  localAddress: string;
  multicastGroup: string;
  port: number;
}

/** Production transport: one multicast UDP socket on the UPnP-confirmed interface. */
export class MulticastTransport implements Transport {
  readonly localAddress: string;
  private readonly group: string;
  private readonly port: number;
  private socket: dgram.Socket | null = null;
  private handler: MessageHandler = () => {};

  constructor(opts: MulticastTransportOptions) {
    this.localAddress = opts.localAddress;
    this.group = opts.multicastGroup;
    this.port = opts.port;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      this.socket = socket;
      socket.once("error", reject);
      socket.on("message", (data, remote) => {
        for (const msg of decodeDatagram(data)) {
          this.handler(msg, remote.address);
        }
      });
      socket.bind(this.port, () => {
        try {
          socket.addMembership(this.group, this.localAddress);
          socket.setMulticastInterface(this.localAddress);
          socket.setMulticastTTL(1);
          // we self-deliver in the protocol layer; don't also receive our own multicast
          socket.setMulticastLoopback(false);
          socket.removeListener("error", reject);
          resolve();
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  stop(): void {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // already closed
      }
      this.socket = null;
    }
  }

  sendMulticast(msg: ProtocolMessage): void {
    this.send(msg, this.group);
  }

  sendUnicast(msg: ProtocolMessage, to: string): void {
    this.send(msg, to);
  }

  private send(msg: ProtocolMessage, address: string): void {
    if (!this.socket) return;
    const buf = encode(msg);
    this.socket.send(buf, 0, buf.length, this.port, address);
  }
}

export type DropPredicate = (
  from: string,
  to: string,
  msg: ProtocolMessage
) => boolean;

export interface VirtualNetworkOptions {
  /** When set (with maxLatency > 0), deliveries are scheduled on this clock. */
  clock?: Clock;
  /** Seeded randomness for per-message latency (default Math.random). */
  rng?: () => number;
  minLatency?: number;
  maxLatency?: number;
}

/**
 * Deterministic in-memory network for tests. Supports partitioning and an
 * arbitrary drop predicate (loss / targeted drops). Each delivery is an
 * independent encode→decode round-trip, mirroring the real wire.
 *
 * By default it delivers synchronously and in order. Given a clock + a latency
 * range, each message is instead scheduled at an independent random delay, which
 * models the real wire's variable latency and packet REORDER (a later-sent
 * message can arrive first) — still fully deterministic via the ManualClock and
 * a seeded rng.
 */
export class VirtualNetwork {
  private readonly endpoints = new Map<string, VirtualTransport>();
  private partitions: Set<string>[] | null = null;
  private dropPredicate: DropPredicate | null = null;
  private readonly clock?: Clock;
  private readonly rng: () => number;
  private readonly minLatency: number;
  private readonly maxLatency: number;

  constructor(options: VirtualNetworkOptions = {}) {
    this.clock = options.clock;
    this.rng = options.rng ?? Math.random;
    this.minLatency = options.minLatency ?? 0;
    this.maxLatency = options.maxLatency ?? 0;
  }

  register(address: string): VirtualTransport {
    if (this.endpoints.has(address)) {
      throw new Error(`address already registered: ${address}`);
    }
    const transport = new VirtualTransport(address, this);
    this.endpoints.set(address, transport);
    return transport;
  }

  /** Define partition groups; an endpoint only reaches others in the same group. */
  partition(groups: string[][]): void {
    this.partitions = groups.map((g) => new Set(g));
  }

  /** Remove all partitions. */
  heal(): void {
    this.partitions = null;
  }

  /** Install a predicate that drops a message when it returns true (null clears). */
  setDropPredicate(fn: DropPredicate | null): void {
    this.dropPredicate = fn;
  }

  private sameGroup(from: string, to: string): boolean {
    if (!this.partitions) return true;
    const group = this.partitions.find((s) => s.has(from));
    return group ? group.has(to) : false;
  }

  /** internal: route a message; `to === null` means multicast to the group. */
  route(from: string, to: string | null, msg: ProtocolMessage): void {
    const buf = encode(msg);
    const send = (addr: string): void => {
      if (this.dropPredicate && this.dropPredicate(from, addr, msg)) return;
      if (!this.endpoints.has(addr)) return;
      const deliver = (): void => {
        const endpoint = this.endpoints.get(addr);
        const copy = decodeDatagram(buf)[0];
        if (endpoint && copy) endpoint.receive(copy, from);
      };
      if (this.clock && this.maxLatency > 0) {
        const span = this.maxLatency - this.minLatency;
        const delay = this.minLatency + (span > 0 ? Math.floor(this.rng() * (span + 1)) : 0);
        this.clock.setTimer(delay, deliver); // async + reorder
      } else {
        deliver(); // synchronous, in order
      }
    };

    if (to === null) {
      for (const addr of this.endpoints.keys()) {
        if (addr === from) continue; // no multicast loopback
        if (!this.sameGroup(from, addr)) continue;
        send(addr);
      }
    } else {
      if (!this.sameGroup(from, to)) return;
      send(to); // unicast to self is allowed
    }
  }
}

export class VirtualTransport implements Transport {
  private handler: MessageHandler = () => {};
  private running = false;

  constructor(
    readonly localAddress: string,
    private readonly net: VirtualNetwork
  ) {}

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  start(): Promise<void> {
    this.running = true;
    return Promise.resolve();
  }

  stop(): void {
    this.running = false;
  }

  sendMulticast(msg: ProtocolMessage): void {
    this.net.route(this.localAddress, null, msg);
  }

  sendUnicast(msg: ProtocolMessage, to: string): void {
    this.net.route(this.localAddress, to, msg);
  }

  /** internal: invoked by the VirtualNetwork to deliver an inbound message. */
  receive(msg: ProtocolMessage, from: string): void {
    if (this.running) this.handler(msg, from);
  }
}
