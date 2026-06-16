/**
 * Reliable, totally-ordered broadcast (Phase 3) layered on the token ring.
 *
 * Total order: only the token holder may broadcast, and each message is stamped
 * with the next global `seq` taken from the token, so there is one agreed order.
 *
 * Reliability: a receiver that detects a gap requests the missing seqs via the
 * token's `rtr` list; any holder that has them re-multicasts.
 *
 * Safe (failure-atomic) delivery: the token carries a per-rotation running min of
 * every member's "received-up-to". The representative anchors each rotation —
 * it commits the completed rotation's min into `token.safe` and restarts the
 * accumulation from its own level. Because `safe` is a lower bound on what every
 * member has received, delivering only `seq ≤ safe` (in contiguous order)
 * guarantees no node ever acts on a message another node has not yet received.
 */

import { Transport } from "./transport";
import { Clock } from "./clock";
import { Nid, McastMessage, TokenMessage } from "./messages";
import { TokenRing, TokenRingConfig, TokenRingHooks } from "./tokenRing";

export interface OrderedBroadcastConfig extends TokenRingConfig {
  /** Max application messages a holder may broadcast per token visit (flow control). */
  maxMessagesPerToken: number;
}

export interface OrderedBroadcastHooks {
  onDeliver: (payload: unknown, seq: number) => void;
  onTokenLost?: () => void;
  onForeignMessage?: TokenRingHooks["onForeignMessage"];
  onJoin?: TokenRingHooks["onJoin"];
  onCommitPropose?: TokenRingHooks["onCommitPropose"];
  onCommitReply?: TokenRingHooks["onCommitReply"];
}

export interface OrderedBroadcastOptions {
  self: Nid;
  transport: Transport;
  clock: Clock;
  config: OrderedBroadcastConfig;
  hooks: OrderedBroadcastHooks;
}

export class OrderedBroadcast {
  readonly self: Nid;
  readonly tokenRing: TokenRing;
  private readonly transport: Transport;
  private readonly config: OrderedBroadcastConfig;
  private readonly onDeliver: OrderedBroadcastHooks["onDeliver"];

  private readonly sendQueue: unknown[] = [];
  /** Everything we hold (own + received), keyed by seq; serves both delivery and rtr. */
  private readonly have = new Map<number, McastMessage>();
  private highestSeq = 0;
  private lastDelivered = 0;

  constructor(opts: OrderedBroadcastOptions) {
    this.self = opts.self;
    this.transport = opts.transport;
    this.config = opts.config;
    this.onDeliver = opts.hooks.onDeliver;
    this.tokenRing = new TokenRing({
      self: opts.self,
      transport: opts.transport,
      clock: opts.clock,
      config: opts.config,
      hooks: {
        processToken: (token) => this.onToken(token),
        onMcast: (msg) => this.onMcast(msg),
        onTokenLost: opts.hooks.onTokenLost,
        onForeignMessage: opts.hooks.onForeignMessage,
        onJoin: opts.hooks.onJoin,
        onCommitPropose: opts.hooks.onCommitPropose,
        onCommitReply: opts.hooks.onCommitReply
      }
    });
  }

  start(): void {
    this.tokenRing.start();
  }
  stop(): void {
    this.tokenRing.stop();
  }
  bootstrap(): void {
    this.tokenRing.bootstrap();
  }

  /** Queue an application payload; it is assigned a seq when we next hold the token. */
  broadcast(payload: unknown): void {
    this.sendQueue.push(payload);
  }

  /** Our contiguous received-up-to in the current ring (for recovery commit). */
  get aru(): number {
    return this.computeMyAru();
  }

  /** Highest seq we hold in the current ring (for recovery commit). */
  get highSeq(): number {
    return this.highestSeq;
  }

  /**
   * Recovery flush: deliver everything up to `target` in order, bypassing the
   * safe gate. The membership layer sets `target` to the min aru of surviving
   * old members, so every survivor holds and delivers exactly this prefix —
   * preserving virtual synchrony across the view change.
   */
  flushTo(target: number): void {
    this.deliverUpTo(target);
  }

  /** Reset ordering state for a freshly installed ring (seq space restarts at 1). */
  resetForNewRing(): void {
    this.have.clear();
    this.highestSeq = 0;
    this.lastDelivered = 0;
    // Drop unsent payloads: messages not yet ordered in the old view do not cross
    // the view boundary (virtual synchrony). Applications re-issue what they need
    // on the view change (the port allocator re-claims).
    this.sendQueue.length = 0;
  }

  /** Received an in-ring application multicast: retain it for ordering + rtr service. */
  private onMcast(msg: McastMessage): void {
    if (msg.seq > this.lastDelivered && !this.have.has(msg.seq)) {
      this.have.set(msg.seq, msg);
      if (msg.seq > this.highestSeq) this.highestSeq = msg.seq;
    }
  }

  /** Invoked while holding the token: serve rtr, broadcast, update safe, deliver. */
  private onToken(token: TokenMessage): void {
    this.serveRetransmissions(token);
    this.broadcastQueued(token);
    this.updateSafe(token);
    this.requestGaps(token);
    this.deliverUpTo(token.safe);
  }

  private serveRetransmissions(token: TokenMessage): void {
    if (token.rtr.length === 0) return;
    const stillMissing: number[] = [];
    for (const seq of token.rtr) {
      const msg = this.have.get(seq);
      if (msg) this.transport.sendMulticast(msg);
      else stillMissing.push(seq);
    }
    token.rtr = stillMissing;
  }

  private broadcastQueued(token: TokenMessage): void {
    const ringId = this.tokenRing.ring;
    if (!ringId) return;
    let sent = 0;
    while (this.sendQueue.length > 0 && sent < this.config.maxMessagesPerToken) {
      const payload = this.sendQueue.shift();
      const seq = ++token.seq;
      const msg: McastMessage = {
        kind: "MCAST",
        ringId,
        senderNid: this.self,
        seq,
        payload
      };
      this.transport.sendMulticast(msg);
      this.have.set(seq, msg); // we deliver our own messages in order too
      if (seq > this.highestSeq) this.highestSeq = seq;
      sent += 1;
    }
    token.fcc = sent;
  }

  private updateSafe(token: TokenMessage): void {
    const myAru = this.computeMyAru();
    if (this.self === this.tokenRing.representative) {
      // anchor: the completed rotation's min is now safe everywhere; restart
      token.safe = token.aru;
      token.aru = myAru;
      token.aruId = this.self;
    } else {
      token.aru = Math.min(token.aru, myAru);
    }
  }

  private requestGaps(token: TokenMessage): void {
    const myAru = this.computeMyAru();
    for (let seq = myAru + 1; seq <= token.seq; seq++) {
      if (!this.have.has(seq) && !token.rtr.includes(seq)) {
        token.rtr.push(seq);
      }
    }
  }

  /** Highest seq such that every seq up to it has been delivered or is held. */
  private computeMyAru(): number {
    let aru = this.lastDelivered;
    while (this.have.has(aru + 1)) aru += 1;
    return aru;
  }

  private deliverUpTo(safe: number): void {
    let next = this.lastDelivered + 1;
    while (next <= safe && this.have.has(next)) {
      const msg = this.have.get(next)!;
      this.have.delete(next); // safe ⇒ all have it ⇒ no rtr will need it
      this.lastDelivered = next;
      this.onDeliver(msg.payload, next);
      next += 1;
    }
  }
}
