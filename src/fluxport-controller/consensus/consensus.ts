/**
 * Consensus facade — hosts named consensus groups over one shared transport.
 *
 * One real multicast socket carries every group's traffic; each datagram is
 * tagged with a `groupId` (stamped by the consensus modules). `Consensus` owns
 * that socket and a `Map<groupId, MessageHandler>` demux: it registers a single
 * `realTransport.onMessage` that routes each inbound message to the matching
 * group's handler (unknown groupId ⇒ dropped). A feature does `join(name, …)` and
 * gets a `Group` handle — a thin wrapper over an independent `Membership` (its own
 * ring, ordering and membership) running on a `GroupTransport`.
 *
 * Transport self-heal: the socket pins to one LAN IP and cannot recover a changed
 * or removed address on its own. The detection + decision live in the consumer
 * (FluxPortManager), which calls `rebuild(newTransport)` for the mechanical part:
 * swap in a fresh socket and re-start + re-bootstrap every joined group on it, so
 * all groups rejoin under their own identities. (A node-wide detector that owns
 * the heal end-to-end is a later slice.)
 */

import {
  Transport,
  GroupTransport,
  SharedTransportHost,
  MessageHandler,
  ErrorHandler
} from "./transport";
import { Clock } from "./clock";
import { DEFAULT_GROUP_ID, Nid, RingId } from "./messages";
import { Membership, MembershipConfig, View } from "./membership";
import { representativeOf } from "./ring";

export interface GroupHooks {
  onDeliver: (payload: unknown, seq: number) => void;
  onViewChange: (view: View) => void;
}

export interface GroupOptions {
  config: MembershipConfig;
  hooks: GroupHooks;
}

/**
 * Handle over one group's `Membership`. The consumer's hooks may be (re)bound
 * after construction, so a consumer that must exist before the group can wire its
 * delivery/view-change logic in once both are built.
 */
export class Group {
  private hooks: GroupHooks;
  private membership!: Membership;

  constructor(
    readonly groupId: string,
    hooks: GroupHooks
  ) {
    this.hooks = hooks;
  }

  /** internal (Consensus): install the live Membership (initial join + rebuild). */
  attach(membership: Membership): void {
    this.membership = membership;
  }

  /** Replace the consumer's delivery/view-change hooks. */
  bindHooks(hooks: GroupHooks): void {
    this.hooks = hooks;
  }

  /** internal: the Membership forwards delivery here so hooks stay rebindable. */
  deliver(payload: unknown, seq: number): void {
    this.hooks.onDeliver(payload, seq);
  }
  /** internal: the Membership forwards view changes here. */
  changeView(view: View): void {
    this.hooks.onViewChange(view);
  }

  broadcast(payload: unknown): void {
    this.membership.broadcast(payload);
  }

  get members(): Nid[] {
    return this.membership.currentMembers;
  }
  get representative(): Nid | null {
    return representativeOf(this.membership.currentMembers);
  }
  get viewId(): string {
    const r: RingId = this.membership.currentRing;
    return `${r.rep}:${r.seq}`;
  }

  // ---- lifecycle (driven by Consensus) ----

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

interface JoinedGroup {
  group: Group;
  options: GroupOptions;
}

export class Consensus implements SharedTransportHost {
  private transport: Transport;
  private readonly clock: Clock;
  private readonly demux = new Map<string, MessageHandler>();
  private readonly groups = new Map<string, JoinedGroup>();
  private errorHandler: ErrorHandler = () => {};

  constructor(transport: Transport, clock: Clock) {
    this.transport = transport;
    this.clock = clock;
    this.attachTransport();
  }

  // ---- SharedTransportHost (used by GroupTransport) ----

  get realTransport(): Transport {
    return this.transport;
  }
  registerGroup(groupId: string, handler: MessageHandler): void {
    this.demux.set(groupId, handler);
  }
  unregisterGroup(groupId: string): void {
    this.demux.delete(groupId);
  }
  onSharedError(handler: ErrorHandler): void {
    this.errorHandler = handler;
  }

  // ---- group management ----

  /**
   * Join a named group: build a `Membership` over a `GroupTransport` scoped to
   * `groupId` and return its handle. The membership is constructed but not started
   * — `start()` drives every joined group's lifecycle (so they share one start /
   * rebuild point).
   */
  join(groupId: string, options: GroupOptions): Group {
    if (this.groups.has(groupId)) {
      throw new Error(`group already joined: ${groupId}`);
    }
    const handle = new Group(groupId, options.hooks);
    handle.attach(this.buildMembership(groupId, options.config, handle));
    this.groups.set(groupId, { group: handle, options });
    return handle;
  }

  /**
   * Build a fresh Membership over a GroupTransport on the current socket, keyed by
   * the transport's current address. It forwards delivery/view-change through the
   * `handle`'s (rebindable) hooks, so a rebuild can swap in a new Membership while
   * the consumer keeps its same Group reference.
   */
  private buildMembership(
    groupId: string,
    baseConfig: MembershipConfig,
    handle: Group
  ): Membership {
    const groupTransport = new GroupTransport(groupId, this);
    return new Membership({
      self: groupTransport.localAddress,
      transport: groupTransport,
      clock: this.clock,
      config: { ...baseConfig, groupId },
      hooks: {
        onDeliver: (payload, seq) => handle.deliver(payload, seq),
        onViewChange: (view) => handle.changeView(view)
      }
    });
  }

  // ---- lifecycle + self-heal mechanism ----

  async start(): Promise<void> {
    await this.transport.start();
    for (const { group } of this.groups.values()) {
      group.start();
      group.bootstrap();
    }
  }

  stop(): void {
    for (const { group } of this.groups.values()) group.stop();
    this.transport.stop();
    this.demux.clear();
  }

  /**
   * Mechanical rebuild of the shared transport (the consumer's self-heal calls
   * this once it has decided to rebind). Stop the old socket FIRST, then build the
   * replacement (so it may rebind the same address/port), adopt it, re-register the
   * demux, and re-build + re-start + re-bootstrap every joined group on it — so all
   * groups rejoin under their own identities (same nid, new address ⇒ the proven
   * rejoin-as-same-node path). The factory defers construction until after the old
   * socket is closed, matching today's buildAndStart(newAddress) ordering exactly.
   */
  async rebuild(makeTransport: () => Transport): Promise<void> {
    for (const { group } of this.groups.values()) group.stop();
    this.transport.stop();

    this.transport = makeTransport();
    this.demux.clear();
    this.attachTransport();

    // Rebuild each group's Membership keyed by the new transport's address, onto
    // the SAME handle (so the consumer keeps its Group reference + bound hooks).
    for (const [groupId, joined] of this.groups) {
      joined.group.attach(
        this.buildMembership(groupId, joined.options.config, joined.group)
      );
    }

    await this.transport.start();
    for (const { group } of this.groups.values()) {
      group.start();
      group.bootstrap();
    }
  }

  private attachTransport(): void {
    this.transport.onMessage((msg, from) => {
      const handler = this.demux.get(msg.groupId ?? DEFAULT_GROUP_ID);
      if (handler) handler(msg, from);
    });
    this.transport.onError((err) => this.errorHandler(err));
  }
}
