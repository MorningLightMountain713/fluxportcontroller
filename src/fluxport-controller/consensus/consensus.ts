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
 * Transport self-heal (node-level, generic): the shared socket pins reception and
 * egress to one LAN IP and cannot recover on its own if that IP changes under it,
 * or if the kernel silently drops the multicast membership while the address is
 * unchanged (the bound IP removed and restored to the same value, or the interface
 * recreated). The heal is a node-wide concern — one shared socket under many
 * groups — so it lives HERE rather than in any one consumer. Two consumer-provided
 * seams keep Consensus free of UPnP/HTTP coupling: `resolveLocalAddress` (a fresh
 * re-resolve of this node's LAN IP) and `createTransport(localAddress)` (build a
 * fresh socket on a given address).
 *
 * A rebuild swaps the socket once and ALL groups rejoin under their own identities
 * (same nid, possibly new address ⇒ the proven rejoin-as-same-node path). Consensus
 * triggers a heal when (a) the shared socket raises an error, (b) the re-resolved
 * local address has changed, or (c) the node has gone DEAF — every joined group has
 * collapsed to a singleton, having previously had at least one multi-member group.
 * A single group shrinking to a singleton while another stays multi is NOT deafness
 * and must not rebuild. For the single `ports` group this reduces exactly to the
 * old "ports collapsed to a singleton," so single-group behavior is unchanged.
 * Consensus emits `rebound { from, to }` after a heal so the consumer can re-emit.
 */

import { EventEmitter } from "node:events";
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
import { logController } from "../log";

const logger = logController.getLogger();

export interface GroupHooks {
  onDeliver: (payload: unknown, seq: number) => void;
  onViewChange: (view: View) => void;
  /** Fired (off the critical path) when this node holds this group's token — the
   *  generic turn-taking baton. Must not block or throw; the token rotates
   *  regardless (it shares the dispatch path with delivery). */
  onTokenGranted?: () => void;
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
    this.safely("onDeliver", () => this.hooks.onDeliver(payload, seq));
  }
  /** internal: the Membership forwards view changes here. */
  changeView(view: View): void {
    this.safely("onViewChange", () => this.hooks.onViewChange(view));
  }
  /** internal: the Membership forwards token grants here so hooks stay rebindable. */
  grantToken(): void {
    this.safely("onTokenGranted", () => this.hooks.onTokenGranted?.());
  }

  /**
   * Run a consumer hook in isolation: a feature's throw is logged and contained
   * here at the Group boundary, never propagated back into the consensus dispatch
   * path (where it would escape the socket 'message' / rotation-timer callbacks and
   * crash the node). One feature's bug must not take down the shared ring.
   */
  private safely(hook: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      logger.warn(`Group "${this.groupId}" ${hook} hook threw (ignored): ${err}`);
    }
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
  /** Ring-health evidence: peer multicasts heard on this group (self excluded),
   *  monotonic. Correlate across `onTokenGranted` laps to detect a deaf-but-latent
   *  node — grants keep arriving (unicast token) while this count stalls. */
  get multicastReceivedCount(): number {
    return this.membership.multicastReceivedCount;
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
  /** Members in this group's latest view (the deaf detector reads this). */
  memberCount: number;
  /** True once this group has ever been observed multi-member (deaf precondition). */
  everMulti: boolean;
}

export interface ConsensusOptions {
  /** Re-resolve this node's LAN address afresh (consumer seam; no UPnP coupling). */
  resolveLocalAddress: () => Promise<string>;
  /** Build a fresh transport on a given LAN address (consumer seam). */
  createTransport: (localAddress: string) => Transport;
  /** The LAN address the initial transport is bound to. */
  localAddress: string;
}

export class Consensus extends EventEmitter implements SharedTransportHost {
  private transport: Transport;
  private readonly clock: Clock;
  private readonly demux = new Map<string, MessageHandler>();
  private readonly groups = new Map<string, JoinedGroup>();
  private errorHandler: ErrorHandler = () => {};

  // self-heal seams + state (node-level, generic)
  private localAddress: string;
  private readonly resolveLocalAddress: () => Promise<string>;
  private readonly createTransport: (localAddress: string) => Transport;
  private healing = false;
  private stopped = false;

  constructor(transport: Transport, clock: Clock, options: ConsensusOptions) {
    super();
    this.transport = transport;
    this.clock = clock;
    this.resolveLocalAddress = options.resolveLocalAddress;
    this.createTransport = options.createTransport;
    this.localAddress = options.localAddress;
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
    const joined: JoinedGroup = {
      group: handle,
      options,
      memberCount: 0,
      everMulti: false
    };
    this.groups.set(groupId, joined);
    handle.attach(this.buildMembership(groupId, options.config, joined));
    return handle;
  }

  /**
   * Build a fresh Membership over a GroupTransport on the current socket, keyed by
   * the transport's current address. It forwards delivery/view-change through the
   * `handle`'s (rebindable) hooks, so a rebuild can swap in a new Membership while
   * the consumer keeps its same Group reference.
   *
   * Consensus's OWN onViewChange updates this group's deaf-detector tracking (the
   * current member count, whether it has ever been multi) and runs the deaf check,
   * then forwards the view to the handle so the consumer still receives it — the
   * detector observes without stealing the hook.
   */
  private buildMembership(
    groupId: string,
    baseConfig: MembershipConfig,
    joined: JoinedGroup
  ): Membership {
    const groupTransport = new GroupTransport(groupId, this);
    return new Membership({
      self: groupTransport.localAddress,
      transport: groupTransport,
      clock: this.clock,
      config: { ...baseConfig, groupId },
      hooks: {
        onDeliver: (payload, seq) => joined.group.deliver(payload, seq),
        onViewChange: (view) => {
          this.observeView(joined, view);
          joined.group.changeView(view);
        },
        onTokenGranted: () => joined.group.grantToken()
      }
    });
  }

  // ---- self-heal detectors + heal ----

  /**
   * Detector tracking: record this group's member count, whether it has ever been
   * multi, and fire the node-deaf detector on the edge where a group collapses to a
   * singleton that makes EVERY joined group a singleton AND at least one of them had
   * previously been multi (so a node that was always alone never self-triggers).
   * For the single `ports` group this reduces exactly to the old "ports collapsed
   * to a singleton" reconfiguration signal.
   */
  private observeView(joined: JoinedGroup, view: View): void {
    const n = view.members.length;
    const wasMulti = joined.memberCount > 1;
    joined.memberCount = n;
    if (n > 1) joined.everMulti = true;
    // A group collapsing to a singleton is the only edge that can make the node
    // deaf. Check it only on that edge so a steady singleton doesn't re-trigger.
    const everAnyMulti = [...this.groups.values()].some((g) => g.everMulti);
    if (n === 1 && wasMulti && everAnyMulti && this.nodeDeaf()) {
      this.triggerHeal("deaf");
    }
  }

  /** Node-wide deafness: every joined group is currently a singleton (no group is
   *  hearing anyone). The reliable "we've gone deaf" signal — a deaf node still
   *  reforms a one-member ring in each group. */
  private nodeDeaf(): boolean {
    const joined = [...this.groups.values()];
    if (joined.length === 0) return false;
    return joined.every((g) => g.memberCount <= 1);
  }

  private triggerHeal(reason: string): void {
    if (this.stopped || this.healing) return;
    this.healing = true;
    void this.heal(reason).finally(() => {
      this.healing = false;
    });
  }

  /**
   * Re-resolve our LAN address and rebuild the shared transport (same nid per
   * group, so each rejoins) when either the address CHANGED, or it is unchanged
   * but the node has gone deaf — every group collapsed to a singleton, so a
   * same-IP membership loss (the bound IP removed and restored, or the interface
   * recreated) is the cause and rebinding in place re-establishes the dropped
   * group memberships. A no-op for a transient blip on a still-healthy ring and
   * for a legitimately-lone node, so detectors can fire liberally without harm.
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

    const addressChanged = newAddress !== this.localAddress;
    const nodeDeaf = this.nodeDeaf();
    if (!addressChanged && !nodeDeaf) return;

    const from = this.localAddress;
    logger.info(
      addressChanged
        ? `Heal (${reason}): local address ${from} -> ${newAddress}; rebinding`
        : `Heal (${reason}): rebinding in place on ${newAddress} after a membership loss`
    );

    this.localAddress = newAddress;
    // The imminent re-bootstrap installs singleton views; reset per-group tracking
    // so those post-rebuild singletons aren't read as a fresh multi -> singleton
    // collapse (which would re-trigger a heal).
    for (const g of this.groups.values()) {
      g.memberCount = 1;
      g.everMulti = false;
    }
    await this.rebuild(() => this.createTransport(newAddress));
    this.emit("rebound", { from, to: newAddress });
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
    this.stopped = true;
    for (const { group } of this.groups.values()) group.stop();
    this.transport.stop();
    this.demux.clear();
  }

  /**
   * Mechanical rebuild of the shared transport (the heal decides; this swaps the
   * socket). Stop the old socket FIRST, then build the replacement (so it may
   * rebind the same address/port), adopt it, re-register the demux, and re-build +
   * re-start + re-bootstrap every joined group on it — so all groups rejoin under
   * their own identities (same nid, new address ⇒ the proven rejoin-as-same-node
   * path). The factory defers construction until after the old socket is closed,
   * matching the prior buildAndStart(newAddress) ordering exactly.
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
        this.buildMembership(groupId, joined.options.config, joined)
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
    // Fast detector: a post-start socket error (e.g. our bound IP vanished) drives
    // the heal directly. Also forward to any registered errorHandler seam.
    this.transport.onError((err) => {
      logger.warn(
        `Shared transport error (${err.code ?? err.message}); re-validating address`
      );
      this.errorHandler(err);
      this.triggerHeal(`transport:${err.code ?? "error"}`);
    });
  }
}
