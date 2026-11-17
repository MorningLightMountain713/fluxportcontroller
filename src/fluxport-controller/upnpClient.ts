/**
 * UPnP client seam — the node-level interface onto the LAN gateway.
 *
 * Exposes gateway discovery plus the read/write port surface, all funnelled
 * through a SerialQueue so the node only ever has ONE SOAP call in flight at the
 * router (a consumer-grade miniupnpd is single-threaded and corrupts state under
 * concurrency). The injectable shape lets the whole flow run over the in-memory
 * virtual network with no real UPnP.
 */

import { Client as RealUpnpClient } from "@runonflux/nat-upnp";
import { SerialQueue } from "./serialQueue";

export interface UpnpInfoLike {
  gateway: { description: string };
  getLocalAddress(): Promise<string>;
}

/** A port mapping as we consume it — a faithful subset of nat-upnp's Mapping (no `local`). */
export interface UpnpMapping {
  public: { host: string; port: number };
  private: { host: string; port: number };
  protocol: string;
  enabled: boolean;
  description: string;
  ttl: number;
}

/** Create args — assignable to nat-upnp's NewPortMappingOpts. */
export interface NewMapping {
  public: number;
  private: { host: string; port: number };
  protocol?: string;
  description?: string;
  ttl?: number;
}

/** Read/remove selector — assignable to nat-upnp's GetSpecificMappingOpts / DeletePortMappingOpts. */
export interface MappingQuery {
  public: number;
  protocol?: string;
}

export interface UpnpClientLike {
  getGateway(): Promise<UpnpInfoLike>;
  getMappings(): Promise<UpnpMapping[]>;
  getMapping(q: MappingQuery): Promise<UpnpMapping | null>;
  createMapping(m: NewMapping): Promise<void>;
  removeMapping(q: MappingQuery): Promise<void>;
  close?(): void;
}

/**
 * Wraps an inner client so EVERY SOAP method delegates through a shared
 * SerialQueue — one call in flight at a time. getLocalAddress (a zero-packet
 * kernel route query on the returned gateway) and close are NOT SOAP, so they
 * are not queued.
 */
export class SerializedUpnpClient implements UpnpClientLike {
  private readonly queue = new SerialQueue();

  constructor(private readonly inner: UpnpClientLike) {}

  getGateway(): Promise<UpnpInfoLike> {
    return this.queue.run(() => this.inner.getGateway());
  }
  getMappings(): Promise<UpnpMapping[]> {
    return this.queue.run(() => this.inner.getMappings());
  }
  getMapping(q: MappingQuery): Promise<UpnpMapping | null> {
    return this.queue.run(() => this.inner.getMapping(q));
  }
  createMapping(m: NewMapping): Promise<void> {
    return this.queue.run(() => this.inner.createMapping(m));
  }
  removeMapping(q: MappingQuery): Promise<void> {
    return this.queue.run(() => this.inner.removeMapping(q));
  }
  close(): void {
    this.inner.close?.();
  }
}

/**
 * Default real UPnP client, serialized. cacheGateway:false so a heal's re-resolve
 * gets a FRESH gateway (and thus a fresh, non-memoized getLocalAddress) rather
 * than the stale pre-change one.
 *
 * The real client's createMapping/removeMapping resolve with a RawResponse and its
 * Mapping carries an extra `local` field; both are accepted where our narrower
 * interface expects void / a Mapping subset, so a single boundary cast suffices.
 */
export function createDefaultUpnpClient(): UpnpClientLike {
  return new SerializedUpnpClient(
    new RealUpnpClient({ cacheGateway: false }) as unknown as UpnpClientLike
  );
}
