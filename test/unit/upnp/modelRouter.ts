/**
 * A router the coordinator's tests can share between nodes: one mapping table, leases
 * that expire on the test clock, strict-mode ownership, and these real routers'
 * behaviours as switches:
 *
 *   missingLookup        what GetSpecificPortMappingEntry answers for a port it does not
 *                        hold: 714 (the standard), a fault (606 Sagemcom Livebox, 501),
 *                        or an empty success (eero)
 *   lookupAnswersFirst   every lookup, of a held port or not, answers the table's first
 *                        entry (Netgear RAX30)
 *   hidesLeasedEntries   a lookup of an entry that carries a lease answers 714 although
 *                        the entry is held and listed (FRITZ!OS 8.x)
 *   renewsOnReadd        false: adding a held mapping again is accepted and changes
 *                        nothing, so its lease runs out (FRITZ!OS 8.x, miniupnpd 1.6-1.9)
 *   timedLeaseFault      a fault code every leased AddPortMapping is refused with
 *                        (725 MikroTik, 501, 718)
 *   minimumLease         seconds every lease is raised to (libupnp 1.6.22: 900, 86400)
 *
 * `clientFor(address)` is the UpnpClientLike a node at that LAN address uses.
 */

import { ManualClock } from "@/fluxport-controller/consensus/clock";
import {
  MappingQuery,
  NewMapping,
  UpnpClientLike,
  UpnpInfoLike,
  UpnpMapping
} from "@/fluxport-controller/upnpClient";

/** A SOAP fault as nat-upnp raises it: an Error with the UPnP error code. */
export class RouterFault extends Error {
  constructor(readonly code: number) {
    super(`UPnP error ${code}`);
  }
}

export interface RouterBehaviour {
  missingLookup?: "714" | "606" | "501" | "empty-success";
  lookupAnswersFirst?: boolean;
  hidesLeasedEntries?: boolean;
  renewsOnReadd?: boolean;
  timedLeaseFault?: number | null;
  minimumLease?: number;
}

interface Held {
  external: number;
  protocol: string;
  host: string;
  internal: number;
  description: string;
  lease: number; // seconds asked for; 0 = permanent
  expiresAt: number | null; // clock ms
}

export interface ClientCounts {
  lookups: number;
  walks: number;
  adds: number;
  removes: number;
  /** External port of every AddPortMapping and DeletePortMapping, in order. */
  added: number[];
  removed: number[];
}

export class ModelRouter {
  private readonly table: Held[] = [];
  /** Mutable: a test can change how the router behaves mid-run. */
  readonly behaviour: Required<RouterBehaviour>;

  constructor(
    private readonly clock: ManualClock,
    behaviour: RouterBehaviour = {}
  ) {
    this.behaviour = {
      missingLookup: behaviour.missingLookup ?? "714",
      lookupAnswersFirst: behaviour.lookupAnswersFirst ?? false,
      hidesLeasedEntries: behaviour.hidesLeasedEntries ?? false,
      renewsOnReadd: behaviour.renewsOnReadd ?? true,
      timedLeaseFault: behaviour.timedLeaseFault ?? null,
      minimumLease: behaviour.minimumLease ?? 0
    };
  }

  /** The mappings held right now, as a walk would list them. */
  entries(): UpnpMapping[] {
    this.expire();
    return this.table.map((h) => this.toMapping(h));
  }

  /** The held mapping for one external port, or null. */
  held(port: number, protocol = "tcp"): UpnpMapping | null {
    this.expire();
    const h = this.find(port, protocol);
    return h ? this.toMapping(h) : null;
  }

  /** Put a mapping on the table directly (another machine's, or a leftover). */
  seed(m: { port: number; host: string; internal?: number; description?: string; lease?: number }): void {
    this.table.push({
      external: m.port,
      protocol: "tcp",
      host: m.host,
      internal: m.internal ?? m.port,
      description: m.description ?? "Flux",
      lease: m.lease ?? 0,
      expiresAt: m.lease ? this.clock.now() + m.lease * 1000 : null
    });
  }

  /** Drop every mapping, as a router reboot does. */
  reboot(): void {
    this.table.length = 0;
  }

  clientFor(address: string): UpnpClientLike & { counts: ClientCounts } {
    const router = this;
    const counts: ClientCounts = { lookups: 0, walks: 0, adds: 0, removes: 0, added: [], removed: [] };
    return {
      counts,
      async getGateway(): Promise<UpnpInfoLike> {
        return {
          gateway: { description: "http://192.0.2.1:5000/rootDesc.xml" },
          getLocalAddress: async () => address
        };
      },
      async getMappings(): Promise<UpnpMapping[]> {
        counts.walks += 1;
        return router.entries();
      },
      async getMapping(q: MappingQuery): Promise<UpnpMapping | null> {
        counts.lookups += 1;
        return router.lookUp(q.public, q.protocol ?? "tcp");
      },
      async createMapping(m: NewMapping): Promise<void> {
        counts.adds += 1;
        counts.added.push(m.public);
        router.add(address, m);
      },
      async removeMapping(q: MappingQuery): Promise<void> {
        counts.removes += 1;
        counts.removed.push(q.public);
        router.remove(address, q.public, q.protocol ?? "tcp");
      }
    };
  }

  private lookUp(port: number, protocol: string): UpnpMapping | null {
    this.expire();
    if (this.behaviour.lookupAnswersFirst) {
      const first = this.table[0];
      // The answer names no external port; nat-upnp fills in the one asked for.
      return first ? { ...this.toMapping(first), public: { host: "", port } } : null;
    }
    const h = this.find(port, protocol);
    if (h && !(this.behaviour.hidesLeasedEntries && h.lease > 0)) return this.toMapping(h);
    switch (this.behaviour.missingLookup) {
      case "714":
        return null;
      case "606":
        throw new RouterFault(606);
      case "501":
        throw new RouterFault(501);
      case "empty-success":
        return {
          public: { host: "", port },
          private: { host: "", port: 0 },
          protocol: protocol.toLowerCase(),
          enabled: false,
          description: "",
          ttl: 0
        };
    }
  }

  private add(address: string, m: NewMapping): void {
    this.expire();
    const asked = m.ttl ?? 0;
    const lease = asked > 0 ? Math.max(asked, this.behaviour.minimumLease) : 0;
    if (lease > 0 && this.behaviour.timedLeaseFault != null) {
      throw new RouterFault(this.behaviour.timedLeaseFault);
    }
    const protocol = (m.protocol ?? "tcp").toLowerCase();
    const h = this.find(m.public, protocol);
    if (h && h.host !== address) throw new RouterFault(718);
    if (h && !this.behaviour.renewsOnReadd) return;
    const next: Held = {
      external: m.public,
      protocol,
      host: m.private.host,
      internal: m.private.port,
      description: m.description ?? "",
      lease,
      expiresAt: lease > 0 ? this.clock.now() + lease * 1000 : null
    };
    if (h) Object.assign(h, next);
    else this.table.push(next);
  }

  private remove(address: string, port: number, protocol: string): void {
    this.expire();
    const h = this.find(port, protocol);
    if (!h) throw new RouterFault(714);
    if (h.host !== address) throw new RouterFault(606);
    this.table.splice(this.table.indexOf(h), 1);
  }

  private find(port: number, protocol: string): Held | undefined {
    return this.table.find((h) => h.external === port && h.protocol === protocol.toLowerCase());
  }

  private expire(): void {
    const now = this.clock.now();
    for (let i = this.table.length - 1; i >= 0; i--) {
      const at = this.table[i].expiresAt;
      if (at != null && at <= now) this.table.splice(i, 1);
    }
  }

  private toMapping(h: Held): UpnpMapping {
    const left = h.expiresAt == null ? 0 : Math.max(1, Math.ceil((h.expiresAt - this.clock.now()) / 1000));
    return {
      public: { host: "", port: h.external },
      private: { host: h.host, port: h.internal },
      protocol: h.protocol,
      enabled: true,
      description: h.description,
      ttl: left
    };
  }
}
