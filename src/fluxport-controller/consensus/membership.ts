/**
 * Group membership & recovery (Phase 4) — virtual synchrony over the token ring.
 *
 * When the token is lost (a member crashed) or a foreign ring/JOIN is heard (a
 * member joined, or two partitions merged), the group reconfigures:
 *
 *   GATHER   every node multicasts JOIN; the alive set converges to whoever is
 *            actually reachable (a crashed node sends no JOIN, so it drops out).
 *   COMMIT   the representative (lowest nid) circulates a commit token:
 *              · collect circuit — each member appends its old ring + aru;
 *              · install circuit — each member flushes, delivers the view change,
 *                and installs the new ring; the representative then seeds the
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
 * Deferred hardening (documented): commit-token loss beyond a single re-gather,
 * and concurrent-representative races when candidate sets disagree transiently.
 * The commit timeout falls back to re-GATHER.
 */

import { Transport } from "./transport";
import { Clock, TimerId } from "./clock";
import {
  Nid,
  RingId,
  JoinMessage,
  CommitTokenMessage,
  MemberState
} from "./messages";
import { sortMembers, successorOf, representativeOf } from "./ring";
import { OrderedBroadcast, OrderedBroadcastConfig } from "./orderedBroadcast";

export type MembershipState = "OPERATIONAL" | "GATHER" | "COMMIT";

export interface MembershipConfig extends OrderedBroadcastConfig {
  announceInterval: number; // OPERATIONAL discovery-announce cadence
  joinInterval: number; // JOIN resend cadence during GATHER
  joinTimeout: number; // candidate set stable this long ⇒ proceed to COMMIT
  commitTimeout: number; // no commit progress ⇒ re-GATHER
}

export interface View {
  ringId: RingId;
  members: Nid[];
}

export interface MembershipHooks {
  onDeliver: (payload: unknown, seq: number) => void;
  onViewChange: (view: View) => void;
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

  constructor(opts: MembershipOptions) {
    this.self = opts.self;
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
        onJoin: (msg) => this.onJoin(msg),
        onCommitToken: (msg) => this.onCommitToken(msg)
      }
    });
  }

  start(): void {
    this.ob.start();
  }

  stop(): void {
    this.clearTimers();
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
      ringId: this.currentRing,
      senderNid: this.self,
      gathering,
      procSet,
      failSet: []
    };
    this.transport.sendMulticast(msg);
  }

  private onJoin(msg: JoinMessage): void {
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

  // ---- COMMIT ----

  private startCommit(members: Nid[]): void {
    const newRing: RingId = { rep: this.self, seq: this.maxSeenSeq + 1 };
    const token: CommitTokenMessage = {
      kind: "COMMIT_TOKEN",
      ringId: newRing,
      phase: "collect",
      originator: this.self,
      members,
      memberStates: [this.myState()],
      visited: [this.self]
    };
    this.forward(token);
  }

  private myState(): MemberState {
    return { nid: this.self, oldRing: this.currentRing, aru: this.ob.aru };
  }

  private onCommitToken(token: CommitTokenMessage): void {
    if (this.state === "OPERATIONAL") this.ob.tokenRing.suspend();
    this.state = "COMMIT";
    this.clearGatherTimers();
    this.armCommitTimeout();

    if (token.phase === "collect") {
      this.onCollect(token);
    } else {
      this.onInstall(token);
    }
  }

  private onCollect(token: CommitTokenMessage): void {
    if (token.originator === this.self) {
      if (this.allVisited(token, token.members)) {
        // collect circuit complete: flip to install and circulate again
        token.phase = "install";
        token.visited = [];
      }
      this.forward(token);
      return;
    }
    if (!token.visited.includes(this.self)) {
      token.memberStates.push(this.myState());
      token.visited.push(this.self);
    }
    this.forward(token);
  }

  private onInstall(token: CommitTokenMessage): void {
    if (token.originator === this.self) {
      const others = token.members.filter((m) => m !== this.self);
      if (others.every((m) => token.visited.includes(m))) {
        // every other member installed: install ourselves and seed the token
        this.recoverAndInstall(token);
        this.ob.tokenRing.seedToken();
      } else {
        this.forward(token);
      }
      return;
    }
    if (!token.visited.includes(this.self)) {
      this.recoverAndInstall(token);
      token.visited.push(this.self);
    }
    this.forward(token);
  }

  /** Flush our old ring up to its agreed cut, deliver the view change, install. */
  private recoverAndInstall(token: CommitTokenMessage): void {
    const myOld = ringKey(this.currentRing);
    const arus = token.memberStates
      .filter((s) => ringKey(s.oldRing) === myOld)
      .map((s) => s.aru);
    const target = arus.length ? Math.min(...arus) : 0;

    this.ob.flushTo(target); // deliver the agreed old-view prefix
    this.ob.resetForNewRing();
    this.ob.tokenRing.installRing(token.ringId, token.members, false);

    this.state = "OPERATIONAL";
    this.clearCommitTimeout();
    this.scheduleAnnounce();

    // Notify the app only after the new ring is live, so anything it broadcasts
    // in response (the allocator's re-claim) queues into the fresh ring rather
    // than being discarded by resetForNewRing.
    this.onViewChange({ ringId: token.ringId, members: token.members });
  }

  private forward(token: CommitTokenMessage): void {
    // Do NOT (re)arm the commit timeout here: a non-representative forwards the
    // install token AFTER it has already installed and gone OPERATIONAL (which
    // cleared the timer), so arming here left a stray timeout that fired later
    // and re-triggered GATHER — a self-sustaining re-gather storm. The timeout is
    // re-armed on every commit-token *receipt* (onCommitToken), which is the
    // correct freshness signal.
    this.transport.sendUnicast(token, successorOf(this.self, token.members));
  }

  private allVisited(token: CommitTokenMessage, members: Nid[]): boolean {
    return members.every((m) => token.visited.includes(m));
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
