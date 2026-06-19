/**
 * Group membership & recovery (Phase 4) — virtual synchrony over the token ring.
 *
 * When the token is lost (a member crashed) or a foreign ring/JOIN is heard (a
 * member joined, or two partitions merged), the group reconfigures:
 *
 *   GATHER   every node multicasts JOIN; the alive set converges to whoever is
 *            actually reachable (a crashed node sends no JOIN, so it drops out).
 *   COMMIT   the representative (lowest nid) drives a multicast 2-phase commit,
 *            re-proposing until every member replies (so it survives loss):
 *              · collect — each member returns its old ring + aru;
 *              · install — the representative multicasts the gathered states;
 *                each member flushes, delivers the view change, installs the new
 *                ring, and acks; the representative installs last and seeds the
 *                operational token.
 *
 * Discovery: while OPERATIONAL each node periodically multicasts an announce
 * (a JOIN carrying its current view). A node hearing an announce from a ring it
 * is not part of starts GATHER, so idle rings still find each other and merge.
 *
 * Virtual synchrony: each member flushes its OWN old ring's messages up to the
 * min aru of that ring's surviving members (merged rings have independent seq
 * spaces, so cuts are per-old-ring). Because `lastDelivered ≤ safe ≤ min aru`
 * always holds, that cut is one every survivor can reach without retransmission,
 * so all members of the new view deliver the identical prefix from the old view.
 *
 * The 2-phase commit is retransmit-until-acked, so commit-message loss no longer
 * forces a re-gather. An A/B against the older unicast commit-token chain (with
 * the operational token timing held fixed) held ~100% convergence to 20% packet
 * loss, ~96% at 30%, ~76% at 40% — where the chain collapsed to 46% / 10% / 0%.
 * Deferred hardening (documented): concurrent-representative races when candidate
 * sets disagree transiently; the commit timeout falls back to re-GATHER.
 */

import { Transport } from "./transport";
import { Clock, TimerId } from "./clock";
import {
  Nid,
  RingId,
  JoinMessage,
  CommitProposeMessage,
  CommitReplyMessage,
  MemberState,
  DEFAULT_GROUP_ID
} from "./messages";
import { sortMembers, representativeOf } from "./ring";
import { OrderedBroadcast, OrderedBroadcastConfig } from "./orderedBroadcast";

export type MembershipState = "OPERATIONAL" | "GATHER" | "COMMIT";

export interface MembershipConfig extends OrderedBroadcastConfig {
  announceInterval: number; // OPERATIONAL discovery-announce cadence
  joinInterval: number; // JOIN resend cadence during GATHER
  joinTimeout: number; // candidate set stable this long ⇒ proceed to COMMIT
  commitTimeout: number; // no commit progress ⇒ re-GATHER
  proposeInterval?: number; // COMMIT_PROPOSE retransmit cadence (default: joinInterval)
}

export interface View {
  ringId: RingId;
  members: Nid[];
}

export interface MembershipHooks {
  onDeliver: (payload: unknown, seq: number) => void;
  onViewChange: (view: View) => void;
  /** Fired (off the critical path) when this node holds this group's token — the
   *  generic turn-taking baton. Must not block or throw; the token rotates
   *  regardless (it shares the dispatch path with delivery). */
  onTokenGranted?: () => void;
}

export interface MembershipOptions {
  self: Nid;
  transport: Transport;
  clock: Clock;
  config: MembershipConfig;
  hooks: MembershipHooks;
}

const ringKey = (r: RingId): string => `${r.rep}:${r.seq}`;

export class Membership {
  readonly self: Nid;
  readonly groupId: string;
  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly config: MembershipConfig;
  private readonly ob: OrderedBroadcast;
  private readonly onViewChange: (view: View) => void;

  private state: MembershipState = "OPERATIONAL";
  private candidate = new Set<Nid>();
  private maxSeenSeq = 1;

  private announceTimer: TimerId | null = null;
  private joinResendTimer: TimerId | null = null;
  private joinStableTimer: TimerId | null = null;
  private commitTimer: TimerId | null = null;
  private proposeTimer: TimerId | null = null;

  // commit (2-phase) state
  private commitRing: RingId | null = null;
  private commitMembers: Nid[] = [];
  private commitPhase: "collect" | "install" = "collect";
  private collected = new Map<Nid, MemberState>();
  private installed = new Set<Nid>();
  private installedRing: string | null = null; // ringKey we've already installed

  constructor(opts: MembershipOptions) {
    this.self = opts.self;
    this.groupId = opts.config.groupId ?? DEFAULT_GROUP_ID;
    this.transport = opts.transport;
    this.clock = opts.clock;
    this.config = opts.config;
    this.onViewChange = opts.hooks.onViewChange;
    this.ob = new OrderedBroadcast({
      self: opts.self,
      transport: opts.transport,
      clock: opts.clock,
      config: opts.config,
      hooks: {
        onDeliver: opts.hooks.onDeliver,
        onTokenLost: () => this.trigger("tokenLost"),
        onForeignMessage: () => this.trigger("foreign"),
        onTokenGranted: opts.hooks.onTokenGranted,
        onJoin: (msg) => this.onJoin(msg),
        onCommitPropose: (msg) => this.onCommitPropose(msg),
        onCommitReply: (msg) => this.onCommitReply(msg)
      }
    });
  }

  start(): void {
    this.ob.start();
  }

  stop(): void {
    this.clearTimers();
    this.resetCommit();
    this.stopAnnounce();
    this.ob.stop();
  }

  /** Bootstrap a singleton view (the production start path). */
  bootstrap(): void {
    this.ob.bootstrap();
    this.maxSeenSeq = 1;
    this.state = "OPERATIONAL";
    this.onViewChange({ ringId: { rep: this.self, seq: 1 }, members: [this.self] });
    this.scheduleAnnounce();
  }

  broadcast(payload: unknown): void {
    this.ob.broadcast(payload);
  }

  get currentMembers(): Nid[] {
    return this.ob.tokenRing.currentMembers;
  }
  /** Ring-health evidence: peer multicasts heard on this group (self excluded),
   *  monotonic. See `TokenRing.multicastReceivedCount`. */
  get multicastReceivedCount(): number {
    return this.ob.tokenRing.multicastReceivedCount;
  }
  get currentRing(): RingId {
    return this.ob.tokenRing.ring ?? { rep: this.self, seq: 1 };
  }
  get currentState(): MembershipState {
    return this.state;
  }

  // ---- discovery announce (OPERATIONAL) ----

  private scheduleAnnounce(): void {
    if (this.announceTimer !== null) this.clock.clearTimer(this.announceTimer);
    this.announceTimer = this.clock.setTimer(this.config.announceInterval, () => {
      this.announceTimer = null;
      if (this.state !== "OPERATIONAL") return;
      this.sendJoin(this.currentMembers, false); // steady-state discovery announce
      this.scheduleAnnounce();
    });
  }

  private stopAnnounce(): void {
    if (this.announceTimer !== null) {
      this.clock.clearTimer(this.announceTimer);
      this.announceTimer = null;
    }
  }

  // ---- triggers -> GATHER ----

  private trigger(reason: string): void {
    if (this.state === "OPERATIONAL") this.enterGather(reason);
  }

  // `reason` documents what triggered the reconfiguration (tokenLost, foreign,
  // gathering, newMember, commitTimeout) — useful when tracing convergence.
  private enterGather(reason = "?"): void {
    void reason;
    this.state = "GATHER";
    this.stopAnnounce();
    this.resetCommit(); // abandon any in-flight commit
    this.ob.tokenRing.suspend();
    this.candidate = new Set<Nid>([this.self]); // grow from JOINs; crashed nodes drop out
    this.maxSeenSeq = Math.max(this.maxSeenSeq, this.currentRing.seq);
    this.clearTimers();
    this.sendJoin([...this.candidate], true);
    this.scheduleJoinResend();
    this.armJoinStable();
  }

  private sendJoin(procSet: Nid[], gathering: boolean): void {
    const msg: JoinMessage = {
      kind: "JOIN",
      groupId: this.groupId,
      ringId: this.currentRing,
      senderNid: this.self,
      gathering,
      procSet,
      failSet: []
    };
    this.transport.sendMulticast(msg);
  }

  private onJoin(msg: JoinMessage): void {
    // Another group's announce/JOIN is not a merge candidate for ours.
    if ((msg.groupId ?? DEFAULT_GROUP_ID) !== this.groupId) return;
    this.maxSeenSeq = Math.max(this.maxSeenSeq, msg.ringId.seq);

    if (this.state === "OPERATIONAL") {
      if (msg.gathering) {
        this.enterGather("gathering"); // a peer is reconfiguring — join in
      } else {
        // Steady-state announce. Reconfigure ONLY if it reveals a member we don't
        // already know (a genuine merge / new node) — NOT merely because the ring
        // seq skews. Keying on seq equality here caused a re-gather cascade: any
        // transient skew made a current member's announce look foreign, so all
        // nodes re-gathered, bumping the seq, forever.
        const known = new Set(this.currentMembers);
        const revealsNewMember = [msg.senderNid, ...msg.procSet].some(
          (n) => !known.has(n)
        );
        if (!revealsNewMember) return; // same-or-subset group; seq skew heals on its own
        this.enterGather("newMember");
      }
    }
    if (this.state !== "GATHER") return; // mid-commit joins are picked up next round

    // Seed only from the sender (proof it is alive) — never from procSet, so a
    // crashed member that lingers in others' views cannot be resurrected.
    if (!this.candidate.has(msg.senderNid)) {
      this.candidate.add(msg.senderNid);
      this.armJoinStable(); // membership still changing; restart the stability clock
      this.sendJoin([...this.candidate], true);
    }
  }

  private scheduleJoinResend(): void {
    this.joinResendTimer = this.clock.setTimer(this.config.joinInterval, () => {
      this.joinResendTimer = null;
      if (this.state !== "GATHER") return;
      this.sendJoin([...this.candidate], true);
      this.scheduleJoinResend();
    });
  }

  private armJoinStable(): void {
    if (this.joinStableTimer !== null) this.clock.clearTimer(this.joinStableTimer);
    this.joinStableTimer = this.clock.setTimer(this.config.joinTimeout, () =>
      this.onStable()
    );
  }

  private onStable(): void {
    this.joinStableTimer = null;
    if (this.joinResendTimer !== null) {
      this.clock.clearTimer(this.joinResendTimer);
      this.joinResendTimer = null;
    }
    const members = sortMembers([...this.candidate]);
    this.state = "COMMIT";
    this.armCommitTimeout();
    if (representativeOf(members) === this.self) {
      this.startCommit(members);
    }
    // non-representatives wait for the commit token
  }

  // ---- COMMIT (multicast 2-phase, retransmitted until all reply) ----

  private myState(): MemberState {
    return { nid: this.self, oldRing: this.currentRing, aru: this.ob.aru };
  }

  /** Representative: begin committing the new view. */
  private startCommit(members: Nid[]): void {
    this.commitRing = { rep: this.self, seq: this.maxSeenSeq + 1 };
    this.commitMembers = members;
    this.commitPhase = "collect";
    this.collected = new Map([[this.self, this.myState()]]);
    this.installed = new Set();
    this.sendPropose();
    this.scheduleProposeRetransmit();
    this.maybeAdvanceCommit(); // handles the singleton case immediately
  }

  private sendPropose(): void {
    if (!this.commitRing) return;
    const msg: CommitProposeMessage = {
      kind: "COMMIT_PROPOSE",
      groupId: this.groupId,
      ringId: this.commitRing,
      phase: this.commitPhase,
      originator: this.self,
      members: this.commitMembers,
      memberStates:
        this.commitPhase === "install" ? [...this.collected.values()] : undefined
    };
    this.transport.sendMulticast(msg);
  }

  /** Loss recovery: keep re-proposing until every member has replied. */
  private scheduleProposeRetransmit(): void {
    this.proposeTimer = this.clock.setTimer(
      this.config.proposeInterval ?? this.config.joinInterval,
      () => {
        this.proposeTimer = null;
        if (this.state !== "COMMIT" || !this.commitRing) return;
        this.sendPropose();
        this.scheduleProposeRetransmit();
      }
    );
  }

  /** Representative: collect a member's reply; advance when all have replied. */
  private onCommitReply(msg: CommitReplyMessage): void {
    if ((msg.groupId ?? DEFAULT_GROUP_ID) !== this.groupId) return; // not our commit
    if (!this.commitRing || ringKey(msg.ringId) !== ringKey(this.commitRing)) return;
    if (msg.phase !== this.commitPhase) return; // stale-phase reply
    if (msg.phase === "collect") {
      if (msg.state) this.collected.set(msg.senderNid, msg.state);
    } else {
      this.installed.add(msg.senderNid);
    }
    this.maybeAdvanceCommit();
  }

  private maybeAdvanceCommit(): void {
    if (!this.commitRing) return;
    if (this.commitPhase === "collect") {
      if (this.commitMembers.every((m) => this.collected.has(m))) {
        this.commitPhase = "install"; // all states gathered
        this.installed = new Set([this.self]); // we install ourselves last
        this.sendPropose();
        this.maybeAdvanceCommit();
      }
    } else {
      const others = this.commitMembers.filter((m) => m !== this.self);
      if (others.every((m) => this.installed.has(m))) {
        // every other member installed: install ourselves and seed the token
        this.applyInstall(this.commitRing, this.commitMembers, [
          ...this.collected.values()
        ]);
        this.ob.tokenRing.seedToken();
        this.resetCommit();
        this.clearCommitTimeout();
      }
    }
  }

  /** Member (non-representative): handle the representative's proposal. */
  private onCommitPropose(msg: CommitProposeMessage): void {
    if ((msg.groupId ?? DEFAULT_GROUP_ID) !== this.groupId) return; // not our commit
    this.maxSeenSeq = Math.max(this.maxSeenSeq, msg.ringId.seq);
    if (msg.originator === this.self) return; // the representative drives its own commit

    // Already installed this ring? Just re-ack — don't disrupt our OPERATIONAL
    // state on a retransmit meant for a slower peer.
    if (this.installedRing === ringKey(msg.ringId)) {
      this.commitRing = msg.ringId;
      this.sendReply("install");
      return;
    }

    if (this.state === "OPERATIONAL") this.ob.tokenRing.suspend();
    this.state = "COMMIT";
    this.clearGatherTimers();
    this.commitRing = msg.ringId;
    this.commitMembers = msg.members;
    if (this.commitTimer === null) this.armCommitTimeout();

    if (msg.phase === "collect") {
      this.sendReply("collect", this.myState());
    } else {
      this.applyInstall(msg.ringId, msg.members, msg.memberStates ?? []);
      this.installedRing = ringKey(msg.ringId);
      this.sendReply("install");
    }
  }

  private sendReply(phase: "collect" | "install", state?: MemberState): void {
    if (!this.commitRing) return;
    const msg: CommitReplyMessage = {
      kind: "COMMIT_REPLY",
      groupId: this.groupId,
      ringId: this.commitRing,
      phase,
      senderNid: this.self,
      state
    };
    this.transport.sendMulticast(msg);
  }

  /** Flush our old ring up to its agreed cut, install, deliver the view change. */
  private applyInstall(ringId: RingId, members: Nid[], memberStates: MemberState[]): void {
    const myOld = ringKey(this.currentRing);
    const arus = memberStates
      .filter((s) => ringKey(s.oldRing) === myOld)
      .map((s) => s.aru);
    const target = arus.length ? Math.min(...arus) : 0;

    this.ob.flushTo(target); // deliver the agreed old-view prefix
    this.ob.resetForNewRing();
    this.ob.tokenRing.installRing(ringId, members, false);

    this.state = "OPERATIONAL";
    this.clearCommitTimeout();
    this.scheduleAnnounce();

    // Notify the app only after the new ring is live, so its re-claim queues into
    // the fresh ring rather than being discarded by resetForNewRing.
    this.onViewChange({ ringId, members });
  }

  private resetCommit(): void {
    if (this.proposeTimer !== null) {
      this.clock.clearTimer(this.proposeTimer);
      this.proposeTimer = null;
    }
    this.commitRing = null;
    this.collected.clear();
    this.installed.clear();
  }

  // ---- timers ----

  private armCommitTimeout(): void {
    this.clearCommitTimeout();
    this.commitTimer = this.clock.setTimer(this.config.commitTimeout, () => {
      this.commitTimer = null;
      this.state = "OPERATIONAL"; // give up; a fresh GATHER recovers
      this.enterGather("commitTimeout");
    });
  }

  private clearCommitTimeout(): void {
    if (this.commitTimer !== null) {
      this.clock.clearTimer(this.commitTimer);
      this.commitTimer = null;
    }
  }

  private clearGatherTimers(): void {
    if (this.joinResendTimer !== null) {
      this.clock.clearTimer(this.joinResendTimer);
      this.joinResendTimer = null;
    }
    if (this.joinStableTimer !== null) {
      this.clock.clearTimer(this.joinStableTimer);
      this.joinStableTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearGatherTimers();
    this.clearCommitTimeout();
  }
}
