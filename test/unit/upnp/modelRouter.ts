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
 *   eventing             "works": a NOTIFY on subscribing and on every change to the
 *                        table's size; "no-answer": SUBSCRIBE gets no answer; "no-sid":
 *                        SUBSCRIBE is answered without a SID (Netgear RAX30);
 *                        "initial-only": the NOTIFY on subscribing and none after (TP-Link
 *                        Omada ER605); "callback-blocked": no NOTIFY reaches the node (a
 *                        firewall that drops the router's connections)
 *   replaceSignalled     a re-add that changes a held mapping is also signalled (Freebox,
 *                        Huawei, Keenetic, Livebox); miniupnpd signals size changes only
 *
 * `clientFor(address)` is the UpnpClientLike a node at that LAN address uses, and
 * `eventsFor(address)` its RouterEvents. A NOTIFY reaches the node 5 ms after the change.
 */

import { ManualClock } from "@/fluxport-controller/consensus/clock";
import { RouterEvent, RouterEvents, Subscription } from "@/fluxport-controller/upnp/routerEvents";
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
  eventing?: "works" | "no-answer" | "no-sid" | "initial-only" | "callback-blocked";
  replaceSignalled?: boolean;
  /** The lifetime a subscription is granted (default 1800 s). */
  subscriptionSeconds?: number;
  /** A walk answers this long after it starts, with the table as it was at the start. */
  walkDelayMs?: number;
}

interface Subscriber {
  sid: string;
  address: string;
  seq: number;
  expiresAt: number;
}

export interface EventCounts {
  subscribes: number;
  renews: number;
  unsubscribes: number;
  delivered: number;
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
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly listeners = new Map<string, (event: RouterEvent) => void>();
  private nextSid = 1;
  /** Set to lose the next NOTIFY: its SEQ is used, nothing is delivered. */
  dropNextEvent = false;
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
      minimumLease: behaviour.minimumLease ?? 0,
      eventing: behaviour.eventing ?? "works",
      replaceSignalled: behaviour.replaceSignalled ?? false,
      subscriptionSeconds: behaviour.subscriptionSeconds ?? 1800,
      walkDelayMs: behaviour.walkDelayMs ?? 0
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
    const held: Held = {
      external: m.port,
      protocol: "tcp",
      host: m.host,
      internal: m.internal ?? m.port,
      description: m.description ?? "Flux",
      lease: m.lease ?? 0,
      expiresAt: m.lease ? this.clock.now() + m.lease * 1000 : null
    };
    const h = this.find(m.port, "tcp");
    if (h) {
      Object.assign(h, held);
      if (this.behaviour.replaceSignalled) this.notify();
    } else {
      this.table.push(held);
      this.notify();
    }
    this.scheduleExpiry(held);
  }

  /** Another machine removes a mapping, whoever holds it. */
  drop(port: number, protocol = "tcp"): void {
    const h = this.find(port, protocol);
    if (!h) return;
    this.table.splice(this.table.indexOf(h), 1);
    this.notify();
  }

  /** Drop every mapping and every subscription, as a router reboot does. Nothing is
   *  signalled: a rebooted router has forgotten its subscribers. */
  reboot(): void {
    this.table.length = 0;
    this.subscribers.clear();
  }

  readonly eventCounts: EventCounts = { subscribes: 0, renews: 0, unsubscribes: 0, delivered: 0 };

  eventsFor(address: string): RouterEvents {
    const router = this;
    return {
      async listen(onEvent: (event: RouterEvent) => void): Promise<void> {
        router.listeners.set(address, onEvent);
      },
      async subscribe(): Promise<Subscription> {
        router.eventCounts.subscribes += 1;
        if (router.behaviour.eventing === "no-answer") throw new Error("SUBSCRIBE timed out");
        if (router.behaviour.eventing === "no-sid") throw new Error("SUBSCRIBE answered without a SID");
        const sub: Subscriber = {
          sid: `uuid:sub-${router.nextSid++}`,
          address,
          seq: 0,
          expiresAt: router.clock.now() + router.behaviour.subscriptionSeconds * 1000
        };
        router.subscribers.set(sub.sid, sub);
        if (router.behaviour.eventing !== "callback-blocked") router.deliver(sub, 0);
        return { sid: sub.sid, timeoutSeconds: router.behaviour.subscriptionSeconds };
      },
      async renew(sid: string): Promise<Subscription> {
        router.eventCounts.renews += 1;
        const sub = router.liveSubscriber(sid);
        if (!sub) throw new Error("SUBSCRIBE answered 412");
        sub.expiresAt = router.clock.now() + router.behaviour.subscriptionSeconds * 1000;
        return { sid, timeoutSeconds: router.behaviour.subscriptionSeconds };
      },
      async unsubscribe(sid: string): Promise<void> {
        router.eventCounts.unsubscribes += 1;
        if (!router.subscribers.delete(sid)) throw new Error("UNSUBSCRIBE answered 412");
      },
      close(): void {
        router.listeners.delete(address);
      }
    };
  }

  /** Live subscriptions held for a node's address (test seam). */
  subscriptionsFor(address: string): number {
    return [...this.subscribers.values()].filter((s) => s.address === address && this.liveSubscriber(s.sid))
      .length;
  }

  private liveSubscriber(sid: string): Subscriber | null {
    const sub = this.subscribers.get(sid);
    if (!sub) return null;
    if (sub.expiresAt <= this.clock.now()) {
      this.subscribers.delete(sid);
      return null;
    }
    return sub;
  }

  private notify(): void {
    for (const sub of [...this.subscribers.values()]) {
      if (!this.liveSubscriber(sub.sid)) continue;
      sub.seq += 1;
      if (this.behaviour.eventing !== "works") continue;
      if (this.dropNextEvent) {
        this.dropNextEvent = false;
        continue;
      }
      this.deliver(sub, sub.seq);
    }
  }

  private deliver(sub: Subscriber, seq: number): void {
    const entries = this.table.length;
    this.clock.setTimer(5, () => {
      const listener = this.listeners.get(sub.address);
      if (!listener || !this.subscribers.has(sub.sid)) return;
      this.eventCounts.delivered += 1;
      listener({ sid: sub.sid, seq, entries });
    });
  }

  private scheduleExpiry(h: Held): void {
    if (h.expiresAt != null) this.clock.setTimer(h.expiresAt - this.clock.now(), () => this.expire());
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
        const table = router.entries();
        const delay = router.behaviour.walkDelayMs;
        if (delay > 0) await new Promise<void>((r) => router.clock.setTimer(delay, r));
        return table;
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
    const changes = !h || h.internal !== m.private.port || h.description !== (m.description ?? "");
    const next: Held = {
      external: m.public,
      protocol,
      host: m.private.host,
      internal: m.private.port,
      description: m.description ?? "",
      lease,
      expiresAt: lease > 0 ? this.clock.now() + lease * 1000 : null
    };
    if (h) {
      Object.assign(h, next);
      if (changes && this.behaviour.replaceSignalled) this.notify();
    } else {
      this.table.push(next);
      this.notify();
    }
    this.scheduleExpiry(next);
  }

  private remove(address: string, port: number, protocol: string): void {
    this.expire();
    const h = this.find(port, protocol);
    if (!h) throw new RouterFault(714);
    if (h.host !== address) throw new RouterFault(606);
    this.table.splice(this.table.indexOf(h), 1);
    this.notify();
  }

  private find(port: number, protocol: string): Held | undefined {
    return this.table.find((h) => h.external === port && h.protocol === protocol.toLowerCase());
  }

  private expire(): void {
    const now = this.clock.now();
    let expired = false;
    for (let i = this.table.length - 1; i >= 0; i--) {
      const at = this.table[i].expiresAt;
      if (at != null && at <= now) {
        this.table.splice(i, 1);
        expired = true;
      }
    }
    if (expired) this.notify();
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
