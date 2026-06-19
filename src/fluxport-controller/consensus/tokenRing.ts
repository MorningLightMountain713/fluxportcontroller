/**
 * OPERATIONAL token rotation (Phase 2).
 *
 * A single token circulates the ring (unicast to the successor). Holding the
 * token is the privilege to broadcast (Phase 3 fills that in via `processToken`).
 * This module owns the failure detector:
 *
 *  - the token-loss timer is reset on every token receipt; if it fires, the ring
 *    is broken (a member crashed or the token was lost) → `onTokenLost`, which
 *    Phase 4 will turn into a membership reconfiguration;
 *  - after forwarding, a shorter retransmit timer re-sends the token to ride out
 *    a single drop, until either the token returns or the loss timer gives up.
 *
 * A message from a foreign ring (or an unknown sender) signals that membership
 * must change → `onForeignMessage` (the Phase 4 GATHER trigger).
 *
 * Timeout hierarchy (config must satisfy): rotationTarget ≪ retransmitTimeout
 * (≈ one rotation) ≪ tokenLossTimeout.
 */

import { Transport } from "./transport";
import { Clock, TimerId } from "./clock";
import {
  Nid,
  RingId,
  ProtocolMessage,
  TokenMessage,
  McastMessage,
  JoinMessage,
  CommitProposeMessage,
  CommitReplyMessage,
  DEFAULT_GROUP_ID
} from "./messages";
import { sortMembers, successorOf, representativeOf } from "./ring";

export interface TokenRingConfig {
  /** Named consensus group; defaults to DEFAULT_GROUP_ID. Inherited down the
   *  stack so one config scopes the whole ring/ordering/membership chain. */
  groupId?: string;
  /** Minimum time the token is held before forwarding (idle pacing). */
  tokenRotationTarget: number;
  /** If the token hasn't returned within this, retransmit to the successor. */
  tokenRetransmitTimeout: number;
  /**
   * Max retransmits before giving up. Bounded so a node retransmitting toward a
   * dead successor stops re-feeding the *next* node's loss timer — otherwise a
   * downstream failure would be masked and never detected past the first node.
   */
  maxTokenRetransmits: number;
  /** No token within this ⇒ the ring is broken. */
  tokenLossTimeout: number;
}

export interface TokenRingHooks {
  onTokenLost?: () => void;
  onForeignMessage?: (msg: ProtocolMessage, from: string) => void;
  onReceiveToken?: (token: TokenMessage) => void;
  onForward?: (token: TokenMessage, to: Nid) => void;
  /** Fired (off the critical path) when this node receives/holds the token — the
   *  generic turn-taking baton a consumer can pace work on. The handler MUST NOT
   *  block or throw (it shares the dispatch path with delivery): the token forwards
   *  on its own rotation timer regardless of what the consumer does with its turn. */
  onTokenGranted?: () => void;
  /** Phase 3 hook: mutate the token (assign seqs, service rtr, update aru) while held. */
  processToken?: (token: TokenMessage) => void;
  /** Phase 3 hook: an in-ring application multicast was received. */
  onMcast?: (msg: McastMessage) => void;
  /** Phase 4 hooks: membership-plane messages (delivered regardless of ring). */
  onJoin?: (msg: JoinMessage, from: string) => void;
  onCommitPropose?: (msg: CommitProposeMessage, from: string) => void;
  onCommitReply?: (msg: CommitReplyMessage, from: string) => void;
}

export interface TokenRingOptions {
  self: Nid;
  transport: Transport;
  clock: Clock;
  config: TokenRingConfig;
  hooks?: TokenRingHooks;
}

export class TokenRing {
  readonly self: Nid;
  readonly groupId: string;
  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly config: TokenRingConfig;
  private readonly hooks: TokenRingHooks;

  private ringId: RingId | null = null;
  private members: Nid[] = [];
  private running = false;
  private holdsToken = false;
  private lastToken: TokenMessage | null = null;
  private multicastReceived = 0;

  private lossTimer: TimerId | null = null;
  private retransmitTimer: TimerId | null = null;
  private forwardTimer: TimerId | null = null;
  private retransmitCount = 0;
  private lastTokenSeq = -1; // highest token round seen; drops stale/duplicate tokens

  constructor(opts: TokenRingOptions) {
    this.self = opts.self;
    this.groupId = opts.config.groupId ?? DEFAULT_GROUP_ID;
    this.transport = opts.transport;
    this.clock = opts.clock;
    this.config = opts.config;
    this.hooks = opts.hooks ?? {};
    this.transport.onMessage((msg, from) => this.handleMessage(msg, from));
  }

  get ring(): RingId | null {
    return this.ringId;
  }
  get currentMembers(): Nid[] {
    return [...this.members];
  }
  get holding(): boolean {
    return this.holdsToken;
  }
  /** Count of multicast messages received from peers (own looped-back sends
   *  excluded) — the "I can still hear the segment" evidence for ring-health.
   *  Monotonic; consumers correlate it across `onTokenGranted` laps (a deaf-but-
   *  latent node keeps getting the unicast token but this count stalls). */
  get multicastReceivedCount(): number {
    return this.multicastReceived;
  }
  get successor(): Nid {
    return successorOf(this.self, this.members);
  }
  get representative(): Nid | null {
    return representativeOf(this.members);
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
    this.holdsToken = false;
    this.clearTimers();
  }

  /** Stop driving the token (during a membership change) but keep receiving. */
  suspend(): void {
    this.holdsToken = false;
    this.clearTimers();
  }

  /** Bootstrap a one-node ring and originate the token (the production start path). */
  bootstrap(): void {
    this.installRing({ rep: this.self, seq: 1 }, [this.self], true);
  }

  /**
   * Install a (new) ring configuration. If `originate` and this node is the
   * representative, seed a fresh token — used at bootstrap and after recovery.
   */
  installRing(ringId: RingId, members: Nid[], originate = false): void {
    this.ringId = ringId;
    this.members = sortMembers(members);
    this.holdsToken = false;
    this.lastToken = null;
    this.lastTokenSeq = -1; // new ring = new token lineage (originate starts at 0)
    this.clearTimers();
    this.armLossTimer();
    if (originate) this.originateToken();
  }

  /** Originate a fresh token on the current ring (representative only). Used by the
   *  membership layer once a new view's install circuit completes. */
  seedToken(): void {
    this.originateToken();
  }

  private originateToken(): void {
    if (!this.running || !this.ringId) return;
    if (representativeOf(this.members) !== this.self) return;
    this.receiveToken({
      kind: "TOKEN",
      groupId: this.groupId,
      ringId: this.ringId,
      tokenSeq: 0,
      seq: 0,
      safe: 0,
      aru: 0,
      aruId: this.self,
      rtr: [],
      fcc: 0
    });
  }

  private handleMessage(msg: ProtocolMessage, from: string): void {
    if (!this.running) return;

    // Another group sharing this socket: silently ignore. A different groupId is
    // NOT a foreign ring (no reconfiguration) — it is simply not our traffic.
    if ((msg.groupId ?? DEFAULT_GROUP_ID) !== this.groupId) return;

    // Ring-health evidence: any multicast from a PEER (every kind but the unicast
    // TOKEN) proves this node can still hear the multicast plane. Own looped-back
    // sends are excluded, so a deaf-but-latent node — unicast token still arriving,
    // multicast gone — shows a stalled count.
    if (msg.kind !== "TOKEN" && from !== this.self) this.multicastReceived += 1;

    // Membership-plane messages are delivered regardless of ring — they are how
    // a new view is formed when rings differ.
    if (msg.kind === "JOIN") {
      this.hooks.onJoin?.(msg, from);
      return;
    }
    if (msg.kind === "COMMIT_PROPOSE") {
      this.hooks.onCommitPropose?.(msg, from);
      return;
    }
    if (msg.kind === "COMMIT_REPLY") {
      this.hooks.onCommitReply?.(msg, from);
      return;
    }

    // Data-plane (TOKEN / MCAST).
    if (!this.ringId || msg.ringId.rep !== this.ringId.rep) {
      // A different representative means a genuinely different ring lineage
      // (a merge / new membership) — signal a reconfiguration.
      this.hooks.onForeignMessage?.(msg, from);
      return;
    }
    if (msg.ringId.seq !== this.ringId.seq) {
      // Same lineage, different incarnation: a delayed message from a prior ring
      // (or a premature one from the next). Drop it — re-gathering here would
      // cascade. The token dedup + membership protocol resync us.
      return;
    }
    if (msg.kind === "TOKEN") {
      this.receiveToken(msg);
    } else if (msg.kind === "MCAST") {
      this.hooks.onMcast?.(msg);
    }
  }

  private receiveToken(token: TokenMessage): void {
    // Drop stale/duplicate tokens (e.g. a retransmit racing the delayed original
    // under reorder). Two live tokens would each assign sequence numbers,
    // corrupting the total order and dropping claims. Only advance to a strictly
    // newer token round.
    if (token.tokenSeq <= this.lastTokenSeq) return;
    this.lastTokenSeq = token.tokenSeq;

    this.holdsToken = true;
    this.lastToken = token;
    this.retransmitCount = 0;
    this.cancelRetransmit(); // the token came back (or we just originated it)
    this.armLossTimer(); // a healthy rotation just happened
    this.hooks.onReceiveToken?.(token);
    this.hooks.processToken?.(token);

    if (this.forwardTimer !== null) this.clock.clearTimer(this.forwardTimer);
    this.forwardTimer = this.clock.setTimer(this.config.tokenRotationTarget, () =>
      this.forwardToken()
    );

    // Grant the baton AFTER the forward timer is armed, so a (non-blocking)
    // consumer's turn can never delay rotation: the token forwards regardless.
    this.hooks.onTokenGranted?.();
  }

  private forwardToken(): void {
    this.forwardTimer = null;
    if (!this.holdsToken || !this.lastToken) return;
    this.holdsToken = false;
    const token = this.lastToken;
    token.tokenSeq += 1;

    // Arm the retransmit before sending: self-delivery (singleton ring) is
    // synchronous and will cancel it in receiveToken right away.
    this.retransmitCount = 0;
    this.armRetransmit(token);
    this.hooks.onForward?.(token, this.successor);
    this.transport.sendUnicast(token, this.successor);
  }

  private armLossTimer(): void {
    if (this.lossTimer !== null) this.clock.clearTimer(this.lossTimer);
    this.lossTimer = this.clock.setTimer(this.config.tokenLossTimeout, () => {
      this.lossTimer = null;
      this.cancelRetransmit();
      this.hooks.onTokenLost?.();
    });
  }

  private armRetransmit(token: TokenMessage): void {
    this.cancelRetransmit();
    this.retransmitTimer = this.clock.setTimer(this.config.tokenRetransmitTimeout, () => {
      this.retransmitTimer = null;
      // Give up after the cap so a downstream failure is not masked; the loss
      // timer (reset only on receipt) then fires and triggers reconfiguration.
      if (this.retransmitCount >= this.config.maxTokenRetransmits) return;
      this.retransmitCount += 1;
      // Single-drop resilience: resend until the token returns (cancels this)
      // or we hit the cap.
      this.transport.sendUnicast(token, this.successor);
      this.armRetransmit(token);
    });
  }

  private cancelRetransmit(): void {
    if (this.retransmitTimer !== null) {
      this.clock.clearTimer(this.retransmitTimer);
      this.retransmitTimer = null;
    }
  }

  private clearTimers(): void {
    for (const t of [this.lossTimer, this.retransmitTimer, this.forwardTimer]) {
      if (t !== null) this.clock.clearTimer(t);
    }
    this.lossTimer = null;
    this.retransmitTimer = null;
    this.forwardTimer = null;
  }
}
