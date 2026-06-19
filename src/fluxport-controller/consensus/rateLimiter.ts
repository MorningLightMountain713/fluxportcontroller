/**
 * Generic distributed token-bucket rate limiter over a group's broadcast — the
 * standard local-bucket model.
 *
 * Goal: pace a group of nodes sharing one resource to a common budget — `rate`
 * tokens/second, bursting up to `capacity` — with collective adaptive back-off
 * (`setRate`). Each node holds a LOCAL bucket, refilled lazily on its OWN clock.
 * `acquire()` debits this node's bucket immediately and broadcasts a CONSUME; peers
 * fold that CONSUME by debiting their own bucket; a node SKIPS its own CONSUME on
 * delivery (it already applied it at acquire). `setRate` broadcasts a SET that every
 * node applies. Over-issue is carried as DEBT (the bucket goes negative, floored at
 * -capacity), so a transient concurrent burst is repaid and the rate self-corrects.
 *
 * This is SOFT pacing, NOT a correctness lock — the consumer's own read-before-write
 * against the real resource is the correctness backstop, so a brief over-issue is
 * acceptable. The guarantee, precisely:
 *   - Under SERIALIZED acquisition (one acquirer at a time, e.g. token/baton-gated)
 *     the group bound is EXACT (granted == capacity + rate*seconds).
 *   - Under genuine CONCURRENCY (M nodes acquiring before each other's CONSUMEs are
 *     delivered) an instantaneous burst can reach ~M*capacity; it is carried as debt
 *     and repaid, so the SUSTAINED rate re-converges. For an exact sustained bound
 *     under uncoordinated concurrency, size `capacity >= cohort - 1` and/or keep the
 *     baton (which holds M at 1).
 *
 * Leak-free and obligation-free BY CONSTRUCTION. A node charges its OWN action at
 * acquire, so a CONSUME that is broadcast but never delivered (dropped at a view
 * change) was already counted by the originator (correct) and merely missed by peers
 * (a one-time generosity that cannot accumulate). There is NO `pending` optimism to
 * strand, hence NO `onViewChange` obligation, NO TTL, and NO timestamp on the wire —
 * unlike a deterministic replicated state machine (PortAllocator), this needs no
 * per-view-change reset: the local bucket simply carries over.
 *
 * Cross-node buckets are APPROXIMATELY consistent (a node's own action lands early
 * vs a peer applying it on delivery; plus per-node clock skew), re-converging after
 * delivery. This is never observed — every consumer reads only its OWN `available`
 * to gate its OWN action; nobody reads a peer's level. Steady-state clock skew
 * self-cancels (lastAt and now() share the offset), so only a clock STEP can perturb
 * a level, and then only by a one-time, non-accumulating, fail-safe (early-deny)
 * amount that read-before-write renders moot.
 *
 * Transport/group-agnostic: hand it a `broadcast` sink and feed every delivered
 * rate-limiter payload to `onDeliver`. The sink MUST echo this node's OWN messages
 * back through `onDeliver` in total order (the package's `Group`/`OrderedBroadcast`
 * does). The two message kinds are folded differently, on purpose: a CONSUME is a
 * commutative debit, applied early at acquire and SKIPPED on its own delivery (so a
 * dropped own consume was already charged — that is what makes the limiter
 * leak-free); a SET is a last-writer-wins value, folded in total order INCLUDING the
 * originator's own in its ordered slot (applying it early would diverge under
 * concurrent SETs). So the originator's own SET takes effect when it is delivered
 * back, not at the `setRate` call. In a SHARED group the limiter co-exists with a
 * feature's own typed payloads — the owner demuxes with `RateLimiter.owns(payload)`
 * and routes ours here. Reusable by any "max N actions / interval" consumer.
 *
 * Precondition: `self` MUST be unique per node (use the stable outpoint nid). Two
 * distinct nodes sharing a `self` would each skip the other's CONSUME as "its own",
 * under-counting the group's spend, so the group would OVER-permit (exceed the
 * budget — the unsafe direction). A node never shares its outpoint, so this cannot
 * occur in practice; it is why the nid, not the rebindable LAN address, is the id.
 */

import { Clock } from "./clock";

const CONSUME = "RATE_CONSUME";
const SET = "RATE_SET";

interface ConsumeMsg {
  type: typeof CONSUME;
  by: string; // originator, so a node skips its own already-applied consume
}
interface SetMsg {
  type: typeof SET;
  rate: number;
  capacity: number;
}

const nonneg = (n: number): number => (n > 0 ? n : 0);
const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));

export interface RateLimiterOptions {
  /** Unique node identity (the outpoint nid) — used to skip own consumes. */
  self: string;
  clock: Clock;
  /** Sink: emit a payload onto the group's ordered broadcast. */
  broadcast: (payload: unknown) => void;
  /** Initial sustained rate, tokens per second (group-wide). Clamped to >= 0. */
  rate: number;
  /** Burst capacity (max tokens). Clamped to >= 0. */
  capacity: number;
  /** Initial level; defaults to `capacity` (full). Pass 0 when joining a live group. */
  tokens?: number;
}

export class RateLimiter {
  private readonly self: string;
  private readonly clock: Clock;
  private readonly broadcast: (payload: unknown) => void;

  private rate: number;
  private capacity: number;
  private tokens: number;
  private lastAt: number;

  constructor(opts: RateLimiterOptions) {
    this.self = opts.self;
    this.clock = opts.clock;
    this.broadcast = opts.broadcast;
    this.rate = nonneg(opts.rate);
    this.capacity = nonneg(opts.capacity);
    this.tokens = opts.tokens ?? this.capacity;
    this.lastAt = opts.clock.now();
  }

  /** Does this payload belong to a RateLimiter? (for an owner's type-demux). */
  static owns(payload: unknown): boolean {
    if (typeof payload !== "object" || payload === null) return false;
    const t = (payload as { type?: unknown }).type;
    return t === CONSUME || t === SET;
  }

  /**
   * Try to take one permit. Refills this node's bucket to now; if a token is
   * available, debits it IMMEDIATELY, broadcasts a CONSUME for peers to fold, and
   * returns true. Returns false without broadcasting when empty.
   */
  acquire(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    this.broadcast({ type: CONSUME, by: this.self } satisfies ConsumeMsg);
    return true;
  }

  /** Adjust the group-wide budget (e.g. a leader backing the segment off). Broadcast,
   *  so every node applies the same rate/capacity. Clamped to >= 0 at the source. */
  setRate(rate: number, capacity?: number): void {
    this.broadcast({
      type: SET,
      rate: nonneg(rate),
      capacity: nonneg(capacity ?? this.capacity)
    } satisfies SetMsg);
  }

  /** Fold one delivered rate-limiter event (routed here by the owner's demux). */
  onDeliver(payload: unknown): void {
    if (!RateLimiter.owns(payload)) return;
    this.refill();
    const msg = payload as ConsumeMsg | SetMsg;
    if (msg.type === CONSUME) {
      // Our own consume was already debited at acquire; only peers debit here.
      // Over-issue is carried as debt (floored at -capacity), not swallowed.
      if (msg.by !== this.self) {
        this.tokens = Math.max(-this.capacity, this.tokens - 1);
      }
    } else {
      this.rate = nonneg(msg.rate);
      this.capacity = nonneg(msg.capacity);
      this.tokens = clamp(this.tokens, -this.capacity, this.capacity);
    }
  }

  /** Local estimate of permits available right now (refilled to now). */
  get available(): number {
    const dt = Math.max(0, this.clock.now() - this.lastAt);
    return Math.min(this.capacity, this.tokens + (this.rate * dt) / 1000);
  }
  get currentRate(): number {
    return this.rate;
  }
  get currentCapacity(): number {
    return this.capacity;
  }

  /** Lazily refill this node's local bucket up to now (mutating). */
  private refill(): void {
    const now = this.clock.now();
    const dt = Math.max(0, now - this.lastAt);
    this.tokens = Math.min(this.capacity, this.tokens + (this.rate * dt) / 1000);
    this.lastAt = now;
  }
}
