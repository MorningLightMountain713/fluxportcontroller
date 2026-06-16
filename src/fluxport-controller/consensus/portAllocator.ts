/**
 * Port allocator (Phase 5) — the application on top of the atomic-broadcast group.
 *
 * Each node wants exactly one distinct port from a fixed set. The allocation is a
 * deterministic state machine over the totally-ordered CLAIM/RELEASE log: because
 * every member delivers the same messages in the same order, every member
 * computes the same `allocation` — no votes, no negotiation.
 *
 * Per port the winner is the highest-priority claimant: older incarnation first,
 * then lower nid. Applying claims by that rule is order-independent, so the
 * outcome is identical on every node regardless of delivery interleaving.
 *
 * On a view change the ordered log restarts (new ring), so each node re-asserts
 * its held port (sticky preference ⇒ owners keep their port and don't churn);
 * a crashed member's port is simply not re-claimed and becomes free; conflicts
 * from a merge are resolved by the same priority rule. With more members than
 * ports, the unlucky ones go WAITING and claim the instant a port frees.
 */

import { Transport } from "./transport";
import { Clock } from "./clock";
import { Nid } from "./messages";
import { Membership, MembershipConfig, View } from "./membership";

export type AllocatorPhase = "JOINING" | "CLAIMING" | "OWNED" | "WAITING";

interface ClaimPayload {
  type: "CLAIM";
  nid: Nid;
  port: number;
  inc: number;
}
interface ReleasePayload {
  type: "RELEASE";
  nid: Nid;
  port: number;
}
type AllocPayload = ClaimPayload | ReleasePayload;

interface Owner {
  nid: Nid;
  inc: number;
}

export interface PortAllocatorConfig extends MembershipConfig {
  ports: number[];
  incarnation: number;
  priorPort?: number | null;
  /** Deterministic preference hash; identical on every node. */
  hash?: (nid: Nid, port: number) => number;
}

export interface PortAllocatorHooks {
  onPortConfirmed?: (port: number) => void;
  onWaiting?: () => void;
  onViewChange?: (view: View) => void;
}

export interface PortAllocatorOptions {
  self: Nid;
  transport: Transport;
  clock: Clock;
  config: PortAllocatorConfig;
  hooks?: PortAllocatorHooks;
}

function fnv1a(nid: Nid, port: number): number {
  let h = 2166136261;
  const s = `${nid}:${port}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class PortAllocator {
  readonly self: Nid;
  private readonly membership: Membership;
  private readonly ports: number[];
  private readonly inc: number;
  private readonly hash: (nid: Nid, port: number) => number;
  private readonly hooks: PortAllocatorHooks;

  private allocation = new Map<number, Owner>();
  private phase: AllocatorPhase = "JOINING";
  private myPort: number | null = null;
  private pendingPort: number | null = null;
  private desiredPort: number | null;
  private lastConfirmed: number | null = null;
  private waitingEmitted = false;

  constructor(opts: PortAllocatorOptions) {
    this.self = opts.self;
    this.ports = [...opts.config.ports];
    this.inc = opts.config.incarnation;
    this.hash = opts.config.hash ?? fnv1a;
    this.hooks = opts.hooks ?? {};
    this.desiredPort = opts.config.priorPort ?? null;
    this.membership = new Membership({
      self: opts.self,
      transport: opts.transport,
      clock: opts.clock,
      config: opts.config,
      hooks: {
        onDeliver: (payload) => this.onDeliver(payload as AllocPayload),
        onViewChange: (view) => this.onViewChange(view)
      }
    });
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

  get port(): number | null {
    return this.myPort;
  }
  get allocatorPhase(): AllocatorPhase {
    return this.phase;
  }
  get currentMembers(): Nid[] {
    return this.membership.currentMembers;
  }

  // ---- view changes: the ordered log restarts, so re-assert ----

  private onViewChange(view: View): void {
    this.allocation.clear();
    if (this.myPort != null) this.desiredPort = this.myPort; // sticky: keep our port
    this.myPort = null;
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
      this.myPort != null &&
      this.allocation.get(this.myPort)?.nid !== this.self
    ) {
      this.myPort = null;
      this.chooseAndClaim();
      return;
    }

    // our own claim has been ordered+delivered: did we win it?
    if (
      this.phase === "CLAIMING" &&
      p.type === "CLAIM" &&
      p.nid === this.self &&
      p.port === this.pendingPort
    ) {
      if (this.allocation.get(this.pendingPort)?.nid === this.self) {
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
      this.allocation.set(p.port, { nid: p.nid, inc: p.inc });
    }
  }

  private applyRelease(p: ReleasePayload): void {
    const cur = this.allocation.get(p.port);
    if (cur && cur.nid === p.nid) this.allocation.delete(p.port);
  }

  /** Older incarnation wins; ties broken by lower nid. Order-independent. */
  private higherPriority(a: Owner, b: Owner): boolean {
    if (a.inc !== b.inc) return a.inc < b.inc;
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
      pick = [...free].sort((a, b) => this.hash(this.self, a) - this.hash(this.self, b))[0];
    }

    this.pendingPort = pick;
    this.phase = "CLAIMING";
    this.waitingEmitted = false;
    const claim: ClaimPayload = {
      type: "CLAIM",
      nid: this.self,
      port: pick,
      inc: this.inc
    };
    this.membership.broadcast(claim);
  }

  private confirm(port: number): void {
    this.myPort = port;
    this.desiredPort = port;
    this.pendingPort = null;
    this.phase = "OWNED";
    if (this.lastConfirmed !== port) {
      this.lastConfirmed = port;
      this.hooks.onPortConfirmed?.(port);
    }
  }
}
