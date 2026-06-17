/**
 * Port allocator (Phase 5) — the application on top of the atomic-broadcast group.
 *
 * Each node wants exactly one distinct port from a fixed set. The allocation is a
 * deterministic state machine over the totally-ordered CLAIM/RELEASE log: because
 * every member delivers the same messages in the same order, every member
 * computes the same `allocation` — no votes, no negotiation.
 *
 * Identity vs address: the consensus ring is keyed by transport address (the LAN
 * IP the token is unicast to), but claim ownership is keyed by a stable `identity`
 * (the Fluxnode outpoint), so a node keeps its port across an IP change. `priority`
 * is the node's deterministic-list `confirmed_height` (globally known, stable
 * across restarts) — lower (older/more-established) wins a contested port, ties by
 * identity. Applying claims by that rule is order-independent, so the outcome is
 * identical on every node regardless of delivery interleaving.
 *
 * On a view change the ordered log restarts (new ring), so each node re-asserts
 * its held port (sticky preference ⇒ owners keep their port, no churn); a crashed
 * member's port is simply not re-claimed and becomes free; merge conflicts resolve
 * by the priority rule; more members than ports ⇒ WAITING, claiming the instant a
 * port frees.
 */

import { Transport } from "./transport";
import { Clock } from "./clock";
import { Nid } from "./messages";
import { Membership, MembershipConfig, View } from "./membership";

/**
 * The slice of a consensus group the allocator drives. Satisfied by a `Group`
 * (the Consensus facade) and, via a thin adapter, by a `Membership` built
 * directly from a transport — so the allocator works either as a Consensus
 * consumer or standalone (the latter is what its own unit tests construct).
 */
export interface AllocatorGroup {
  bindHooks(hooks: {
    onDeliver: (payload: unknown, seq: number) => void;
    onViewChange: (view: View) => void;
  }): void;
  broadcast(payload: unknown): void;
  readonly members: Nid[];
  readonly viewId: string;
  start(): void;
  bootstrap(): void;
  stop(): void;
}

/** Adapt a directly-built Membership to the AllocatorGroup the allocator drives. */
class MembershipGroup implements AllocatorGroup {
  constructor(private readonly membership: Membership) {}
  bindHooks(): void {
    // no-op: a MembershipGroup's hooks are fixed at Membership construction.
  }
  broadcast(payload: unknown): void {
    this.membership.broadcast(payload);
  }
  get members(): Nid[] {
    return this.membership.currentMembers;
  }
  get viewId(): string {
    const r = this.membership.currentRing;
    return `${r.rep}:${r.seq}`;
  }
  start(): void {
    this.membership.start();
  }
  bootstrap(): void {
    this.membership.bootstrap();
  }
  stop(): void {
    this.membership.stop();
  }
}

export type AllocatorPhase = "JOINING" | "CLAIMING" | "OWNED" | "WAITING";

interface ClaimPayload {
  type: "CLAIM";
  nid: Nid; // owner identity (outpoint), not the transport address
  port: number;
  priority: number;
}
interface ReleasePayload {
  type: "RELEASE";
  nid: Nid;
  port: number;
}
type AllocPayload = ClaimPayload | ReleasePayload;

interface Owner {
  nid: Nid;
  priority: number;
}

export interface PortAllocatorConfig extends MembershipConfig {
  ports: number[];
  /** Owner identity for claims (outpoint). Defaults to `self` when omitted. */
  identity?: Nid;
  /** Conflict priority — lower wins (use deterministic-list confirmed_height). */
  priority: number;
  priorPort?: number | null;
  /** Deterministic preference hash; identical on every node. */
  hash?: (id: Nid, port: number) => number;
}

export interface PortAllocatorHooks {
  onPortConfirmed?: (port: number) => void;
  onWaiting?: () => void;
  onViewChange?: (view: View) => void;
}

export interface PortAllocatorOptions {
  self: Nid; // transport address (ring identity); the identity default
  config: PortAllocatorConfig;
  hooks?: PortAllocatorHooks;
  /**
   * Consensus consumer path: an already-joined group to drive. When omitted, the
   * allocator builds its own Membership from `transport`/`clock` (standalone).
   */
  group?: AllocatorGroup;
  /** Standalone path: required when `group` is absent. */
  transport?: Transport;
  clock?: Clock;
}

function fnv1a(id: Nid, port: number): number {
  let h = 2166136261;
  const s = `${id}:${port}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class PortAllocator {
  readonly self: Nid;
  readonly identity: Nid;
  private readonly group: AllocatorGroup;
  private readonly ports: number[];
  private readonly priority: number;
  private readonly hash: (id: Nid, port: number) => number;
  private readonly hooks: PortAllocatorHooks;

  private allocation = new Map<number, Owner>();
  private phase: AllocatorPhase = "JOINING";
  private ownedPort: number | null = null;
  private pendingPort: number | null = null;
  private desiredPort: number | null;
  private lastConfirmed: number | null = null;
  private waitingEmitted = false;

  constructor(opts: PortAllocatorOptions) {
    this.self = opts.self;
    this.identity = opts.config.identity ?? opts.self;
    this.ports = [...opts.config.ports];
    this.priority = opts.config.priority;
    this.hash = opts.config.hash ?? fnv1a;
    this.hooks = opts.hooks ?? {};
    this.desiredPort = opts.config.priorPort ?? null;
    this.group =
      opts.group ??
      new MembershipGroup(
        new Membership({
          self: opts.self,
          transport: opts.transport!,
          clock: opts.clock!,
          config: opts.config,
          hooks: {
            onDeliver: (payload) => this.onDeliver(payload as AllocPayload),
            onViewChange: (view) => this.onViewChange(view)
          }
        })
      );
    // Consumer path: the injected group forwards delivery/view-change to us.
    this.group.bindHooks({
      onDeliver: (payload) => this.onDeliver(payload as AllocPayload),
      onViewChange: (view) => this.onViewChange(view)
    });
  }

  start(): void {
    this.group.start();
  }
  bootstrap(): void {
    this.group.bootstrap();
  }
  stop(): void {
    this.group.stop();
  }

  get port(): number | null {
    return this.ownedPort;
  }
  get allocatorPhase(): AllocatorPhase {
    return this.phase;
  }
  get currentMembers(): Nid[] {
    return this.group.members;
  }
  /** Current ring identifier (for tests: are all nodes in the same view?). */
  get viewId(): string {
    return this.group.viewId;
  }
  /** Read-only allocation snapshot {port: owner identity} (for tests/observability). */
  snapshot(): Record<number, Nid> {
    const out: Record<number, Nid> = {};
    for (const [port, owner] of this.allocation) out[port] = owner.nid;
    return out;
  }

  // ---- view changes: the ordered log restarts, so re-assert ----

  private onViewChange(view: View): void {
    this.allocation.clear();
    if (this.ownedPort != null) this.desiredPort = this.ownedPort; // sticky: keep our port
    this.ownedPort = null;
    this.pendingPort = null;
    this.phase = "JOINING";
    this.waitingEmitted = false;
    this.hooks.onViewChange?.(view);
    this.chooseAndClaim();
  }

  // ---- the ordered CLAIM/RELEASE log drives the allocation ----

  private onDeliver(p: AllocPayload): void {
    if (p.type === "CLAIM") this.applyClaim(p);
    else this.applyRelease(p);

    // displaced from our owned port by a higher-priority claimant (merge case)
    if (
      this.phase === "OWNED" &&
      this.ownedPort != null &&
      this.allocation.get(this.ownedPort)?.nid !== this.identity
    ) {
      this.ownedPort = null;
      this.chooseAndClaim();
      return;
    }

    // our own claim has been ordered+delivered: did we win it?
    if (
      this.phase === "CLAIMING" &&
      p.type === "CLAIM" &&
      p.nid === this.identity &&
      p.port === this.pendingPort
    ) {
      if (this.allocation.get(this.pendingPort)?.nid === this.identity) {
        this.confirm(this.pendingPort);
      } else {
        this.chooseAndClaim(); // lost the race; try the next free port
      }
      return;
    }

    // a port may have freed for us
    if (this.phase === "WAITING") this.chooseAndClaim();
  }

  private applyClaim(p: ClaimPayload): void {
    const cur = this.allocation.get(p.port);
    if (!cur || cur.nid === p.nid || this.higherPriority(p, cur)) {
      this.allocation.set(p.port, { nid: p.nid, priority: p.priority });
    }
  }

  private applyRelease(p: ReleasePayload): void {
    const cur = this.allocation.get(p.port);
    if (cur && cur.nid === p.nid) this.allocation.delete(p.port);
  }

  /** Lower priority value wins (older confirmed_height); ties by identity. */
  private higherPriority(a: Owner, b: Owner): boolean {
    if (a.priority !== b.priority) return a.priority < b.priority;
    return a.nid < b.nid;
  }

  private chooseAndClaim(): void {
    const free = this.ports.filter((p) => !this.allocation.has(p));
    if (free.length === 0) {
      this.phase = "WAITING";
      this.pendingPort = null;
      if (!this.waitingEmitted) {
        this.waitingEmitted = true;
        this.hooks.onWaiting?.();
      }
      return;
    }

    let pick: number;
    if (this.desiredPort != null && free.includes(this.desiredPort)) {
      pick = this.desiredPort; // sticky: prior/held port, avoids churn
    } else {
      pick = [...free].sort(
        (a, b) => this.hash(this.identity, a) - this.hash(this.identity, b)
      )[0];
    }

    this.pendingPort = pick;
    this.phase = "CLAIMING";
    this.waitingEmitted = false;
    const claim: ClaimPayload = {
      type: "CLAIM",
      nid: this.identity,
      port: pick,
      priority: this.priority
    };
    this.group.broadcast(claim);
  }

  private confirm(port: number): void {
    this.ownedPort = port;
    this.desiredPort = port;
    this.pendingPort = null;
    this.phase = "OWNED";
    if (this.lastConfirmed !== port) {
      this.lastConfirmed = port;
      this.hooks.onPortConfirmed?.(port);
    }
  }
}
