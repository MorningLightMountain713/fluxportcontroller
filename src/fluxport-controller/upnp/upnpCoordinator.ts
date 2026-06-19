/**
 * UPnP coordinator (slices 5a + 5b + 5c) — correctness floor, leader-check reads,
 * and the LEADER_CHECK/SELF_CHECK mode machine.
 *
 * Many Fluxnodes can sit behind ONE home router, each maintaining its own UPnP
 * port mapping. A consumer-grade miniupnpd is single-threaded and chokes if they
 * all hammer it, so the nodes take turns: each node keeps ONLY its own port mapped,
 * acting only on its paced turn (the consensus `onTokenGranted` baton) and only
 * when the group's shared RateLimiter budget permits.
 *
 * READ-BEFORE-WRITE is the correctness backstop. On its turn a node reads the
 * router's current mapping for its desired port and writes ONLY if the mapping is
 * missing, points at the wrong host (someone else's / a stale entry), or its lease
 * is running low. In steady state the mapping is already correct, so the common
 * path is a single read and ZERO router writes — that is what keeps a shared router
 * from being hammered. The RateLimiter is soft pacing on top; the read-before-write
 * is the real guard (a brief rate over-issue is harmless because the write is still
 * idempotent against the router's actual state).
 *
 * Self-map-only: by construction the coordinator only ever creates a mapping for
 * its OWN `desiredPort` -> `localAddress`. There is no code path that maps or
 * deletes anything on another node's behalf.
 *
 * LEADER-CHECK (5b) — the ~N-times read reduction. When the group is healthy, the
 * ring representative (lowest nid) enumerates the WHOLE router table once on its
 * baton and broadcasts it as UPNP_OBSERVED. A non-leader that sees its OWN port
 * already healthy in a FRESH broadcast skips its targeted read entirely, so in
 * steady state ONE enumerate covers the whole cohort instead of N targeted reads.
 * It is only an optimisation: with no fresh broadcast (no leader yet, a stale one,
 * or the broadcast showing the port missing/wrong/low) a non-leader falls straight
 * back to the 5a read-before-write floor, which remains the correctness guarantee.
 *
 * MODE MACHINE (5c) — a node is in exactly ONE mode and the choice is LOCAL (you
 * cannot coordinate a switch away from a broken ring over the broken channel):
 *   - LEADER_CHECK trusts the ring: the 5a/5b baton behaviour above runs.
 *   - SELF_CHECK trusts nobody: the baton does NO repair and OBSERVED is not trusted
 *     for skipping; instead an autonomous wall-clock slot timer owns the repair.
 *
 * Health = the token circulating AND peer multicast heard recently. The unicast
 * token still reaches a DEAF-but-latent node (grants keep arriving) so the token
 * alone is NOT proof of health; `group.multicastReceivedCount` ADVANCING between
 * laps is the gate that catches a deaf node — it hears its own batons but no peer
 * multicast. We default to SELF_CHECK at startup because we must never begin
 * trusting a leader/token we have not yet seen circulate, and asymmetric hysteresis
 * (enter after K clean laps, leave after M bad laps where M exceeds a routine
 * reconfiguration) keeps a normal view change from flapping the mode.
 *
 * The self-check slot needs ZERO external info: it is `fnv1a(self) % windows` of a
 * repeating wall-clock cycle, identical-by-construction spread of the cohort, so a
 * brand-new or partitioned node has an autonomous repair cadence with no peer/list.
 *
 * This slice does NOT do lease probing or orphan cleanup — later.
 */

import { Group } from "../consensus/consensus";
import { Clock, TimerId } from "../consensus/clock";
import { RateLimiter } from "../consensus/rateLimiter";
import { UpnpClientLike, UpnpMapping } from "../upnpClient";

export type CoordinatorMode = "LEADER_CHECK" | "SELF_CHECK";

const OBSERVED = "UPNP_OBSERVED";

interface ObservedMsg {
  type: typeof OBSERVED;
  by: string; // the enumerating leader, so a node ignores its own broadcast
  mappings: UpnpMapping[];
}

/** Laps (this node's own baton turns) an OBSERVED stays usable before it is stale. */
const DEFAULT_FRESH_LAPS = 3;

/** Consecutive clean laps (peer multicast heard) before trusting the ring. */
const DEFAULT_ENTER_LAPS = 3;
/** Consecutive deaf laps before abandoning the ring — set above a routine
 *  reconfiguration so a normal view change does not flip the mode. */
const DEFAULT_LEAVE_LAPS = 5;
/** No-baton window that means the token has stopped circulating (a few rotations). */
const DEFAULT_TOKEN_STALL_MS = 30_000;
/** The repeating wall-clock cycle the self-check slot is carved out of. */
const DEFAULT_SELF_CHECK_CYCLE_MS = 60_000;
/** Slots the cycle divides into; this node owns `fnv1a(self) % windows`. */
const DEFAULT_SELF_CHECK_WINDOWS = 8;

/** Multiplicative DECREASE on a leader's enumerate failure (AIMD-flavoured: a sharp
 *  cut so a struggling router is relieved fast). */
const DEFAULT_BACKOFF_FACTOR = 0.5;
/** Multiplicative INCREASE on a leader's clean scan (gentler than the cut so the
 *  rate eases back toward baseline without flapping the segment). */
const DEFAULT_RECOVER_FACTOR = 1.5;
/** Fraction of the baseline the back-off may floor to (never pace to a standstill). */
const DEFAULT_FLOOR_DIVISOR = 8;

/**
 * Same hashing pattern the port allocator uses (deterministic, identical on every
 * node) so each node maps its identity to a stable slot WITHOUT any peer/list — the
 * cohort spreads itself across the cycle with zero coordination.
 */
function fnv1a(id: string, n: number): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % n;
}

export interface UpnpCoordinatorDeps {
  /** This node's unique outpoint nid — the RateLimiter identity (must be unique). */
  self: string;
  /** An already-joined "upnp" Group (the caller does consensus.join). */
  group: Group;
  /** The serialized UPnP client (read/write against the LAN gateway). */
  client: UpnpClientLike;
  clock: Clock;
  /** This node's LAN IP — the private host for its own mapping. */
  localAddress: string;
  /** RateLimiter sustained rate (router writes/sec) — slow. This is the BASELINE the
   *  leader's adaptive back-off paces around: healthy -> baseline, stress -> lower. */
  rate: number;
  /** RateLimiter burst capacity (held constant; back-off only moves the rate). */
  capacity: number;
  /** Lowest rate the leader's back-off may pace the group down to (never 0 — that
   *  would stall the segment). Default `baselineRate / 8`. */
  floorRate?: number;
  /** Multiplicative-decrease factor applied on a leader enumerate FAILURE (< 1). */
  backoffFactor?: number;
  /** Multiplicative-increase factor applied on a leader clean scan (> 1). */
  recoverFactor?: number;
  protocol?: string;
  description?: string;
  /** Requested lease seconds for createMapping. */
  ttl?: number;
  /** Re-map when an existing mapping's remaining ttl drops below this. */
  lowTtlThreshold?: number;
  /** Baton turns a leader's OBSERVED stays trusted before a node re-checks itself. */
  freshLaps?: number;
  /** Consecutive clean laps to enter LEADER_CHECK (K). */
  enterLaps?: number;
  /** Consecutive deaf laps to leave for SELF_CHECK (M, > a routine reconfiguration). */
  leaveLaps?: number;
  /** No-baton window before the token is presumed stalled and we drop to SELF_CHECK. */
  tokenStallMs?: number;
  /** The repeating wall-clock cycle the self-check slot divides. */
  selfCheckCycleMs?: number;
  /** Slots per cycle; this node fires once per cycle at `fnv1a(self) % windows`. */
  selfCheckWindows?: number;
  hooks?: { onMappingFailed?: (port: number, reason: string) => void };
}

export class UpnpCoordinator {
  private readonly self: string;
  private readonly group: Group;
  private readonly client: UpnpClientLike;
  private readonly clock: Clock;
  private readonly localAddress: string;
  private readonly protocol: string;
  private readonly description: string;
  private readonly ttl: number;
  private readonly lowTtlThreshold: number;
  private readonly freshLaps: number;
  private readonly enterLaps: number;
  private readonly leaveLaps: number;
  private readonly tokenStallMs: number;
  private readonly selfCheckCycleMs: number;
  private readonly selfCheckWindows: number;
  private readonly onMappingFailed?: (port: number, reason: string) => void;
  private readonly rl: RateLimiter;
  // Adaptive back-off control: the constructor `rate` is the baseline the leader paces
  // around; floor bounds the multiplicative decrease; the two factors are the AIMD law.
  private readonly baselineRate: number;
  private readonly floorRate: number;
  private readonly backoffFactor: number;
  private readonly recoverFactor: number;

  private desiredPort: number | null = null;
  // Once this router has rejected a finite lease (SOAP 725) it never accepts one, so
  // we latch permanent and request ttl 0 for the rest of this node's life on it.
  private permanentLease = false;
  // A repair runs async off the baton; guard so only one is in flight at a time.
  private repairing = false;
  // The leader's enumerate+broadcast runs async off the baton; same one-at-a-time guard.
  private scanning = false;
  // The last router table a leader broadcast, and how many of THIS node's baton
  // turns have passed since — a non-leader trusts it while fresh to skip its read.
  private lastObserved: UpnpMapping[] | null = null;
  private lapsSinceObserved = 0;

  // ---- 5c mode machine ----
  // Default SELF_CHECK: never start trusting a leader/token we have not seen circulate.
  private mode: CoordinatorMode = "SELF_CHECK";
  private started = false;
  // Multicast-evidence laps: the deaf-node gate (the unicast token alone is not proof).
  private lastMulticastCount = 0;
  private cleanLaps = 0;
  private missedLaps = 0;
  // Re-armed on every baton; firing means the token stopped circulating.
  private tokenStallTimer: TimerId | null = null;
  // Repeating wall-clock slot timer; owns repairs while in SELF_CHECK.
  private slotTimer: TimerId | null = null;
  private readonly slot: number;

  constructor(deps: UpnpCoordinatorDeps) {
    this.self = deps.self;
    this.group = deps.group;
    this.client = deps.client;
    this.clock = deps.clock;
    this.localAddress = deps.localAddress;
    this.protocol = deps.protocol ?? "tcp";
    this.description = deps.description ?? "Flux";
    this.ttl = deps.ttl ?? 14400;
    this.lowTtlThreshold = deps.lowTtlThreshold ?? this.ttl / 4;
    this.freshLaps = deps.freshLaps ?? DEFAULT_FRESH_LAPS;
    this.enterLaps = deps.enterLaps ?? DEFAULT_ENTER_LAPS;
    this.leaveLaps = deps.leaveLaps ?? DEFAULT_LEAVE_LAPS;
    this.tokenStallMs = deps.tokenStallMs ?? DEFAULT_TOKEN_STALL_MS;
    this.selfCheckCycleMs = deps.selfCheckCycleMs ?? DEFAULT_SELF_CHECK_CYCLE_MS;
    this.selfCheckWindows = deps.selfCheckWindows ?? DEFAULT_SELF_CHECK_WINDOWS;
    this.slot = fnv1a(this.self, this.selfCheckWindows);
    this.onMappingFailed = deps.hooks?.onMappingFailed;

    // Closed-loop back-off bounds. Baseline is the requested rate; the floor defaults
    // to baseline/8 (a tiny but non-zero pace, never a standstill) and is clamped so an
    // explicit floor can never exceed the baseline it must sit below.
    this.baselineRate = deps.rate;
    this.backoffFactor = deps.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
    this.recoverFactor = deps.recoverFactor ?? DEFAULT_RECOVER_FACTOR;
    this.floorRate = Math.min(
      deps.floorRate ?? this.baselineRate / DEFAULT_FLOOR_DIVISOR,
      this.baselineRate
    );

    this.rl = new RateLimiter({
      self: deps.self,
      clock: deps.clock,
      broadcast: (p) => this.group.broadcast(p),
      rate: deps.rate,
      capacity: deps.capacity
    });

    this.group.bindHooks({
      onDeliver: (payload) => {
        // Two typed payloads share this group: the RateLimiter's pacing traffic and
        // the leader's UPNP_OBSERVED table. Demux by owner; ignore anything else.
        if (RateLimiter.owns(payload)) this.rl.onDeliver(payload);
        else if (UpnpCoordinator.ownsObserved(payload)) this.onObserved(payload);
      },
      onViewChange: () => {
        // The RateLimiter carries its bucket across views (no reset needed) and
        // there is no coordinator state to reset in this slice.
      },
      onTokenGranted: () => this.onBaton()
    });
  }

  /**
   * Arm the two mode-machine timers (idempotent). Called AFTER `consensus.start()`
   * so the baton can begin driving health laps. The token-stall timer is armed now
   * so a node that never receives a baton still resolves to (stays in) SELF_CHECK.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.armTokenStall();
    this.armSlotTimer();
  }

  /** Clear both timers (idempotent). */
  stop(): void {
    this.started = false;
    if (this.tokenStallTimer != null) {
      this.clock.clearTimer(this.tokenStallTimer);
      this.tokenStallTimer = null;
    }
    if (this.slotTimer != null) {
      this.clock.clearTimer(this.slotTimer);
      this.slotTimer = null;
    }
  }

  /** The port this node should keep mapped (its assigned Fluxport). Null clears it. */
  setDesiredPort(port: number | null): void {
    this.desiredPort = port;
  }

  get desired(): number | null {
    return this.desiredPort;
  }
  /** Which mode this node is in (test seam / observability). */
  get currentMode(): CoordinatorMode {
    return this.mode;
  }
  /** This node's self-check slot index (test seam). */
  get selfCheckSlot(): number {
    return this.slot;
  }
  /** True once the router rejected a finite lease and we latched permanent (test seam). */
  get leasePermanent(): boolean {
    return this.permanentLease;
  }
  /** The group's representative; delegates to the group. */
  get representative(): string | null {
    return this.group.representative;
  }
  /** True when this node is the ring representative — the enumerating leader. */
  get isLeader(): boolean {
    return this.group.representative === this.self;
  }
  /** Whether a leader broadcast has been received and is still fresh (test seam). */
  get observedFresh(): boolean {
    return this.lastObserved != null && this.lapsSinceObserved <= this.freshLaps;
  }
  /** The current group-wide rate the limiter is pacing at (test seam / observability). */
  get currentRate(): number {
    return this.rl.currentRate;
  }

  /** Does this payload belong to the leader-check? (for the owner's type-demux). */
  static ownsObserved(payload: unknown): boolean {
    return (
      typeof payload === "object" &&
      payload !== null &&
      (payload as { type?: unknown }).type === OBSERVED
    );
  }

  /**
   * Fold a leader's broadcast router table: trust it (resetting the freshness
   * counter) so a non-leader can skip its own targeted read while it stays fresh.
   * A leader ignores its OWN broadcast — it just enumerated, it doesn't consult it.
   */
  private onObserved(payload: unknown): void {
    const msg = payload as ObservedMsg;
    if (msg.by === this.self) return;
    this.lastObserved = msg.mappings;
    this.lapsSinceObserved = 0;
  }

  /**
   * This node holds the upnp baton — its paced turn, and one health "lap". We ALWAYS
   * sample ring health and run the mode transitions first (a baton arriving re-arms
   * the token-stall timer; the multicast-evidence delta decides clean vs deaf), then
   * gate the 5a/5b repair work on the mode. In SELF_CHECK the baton does NO repair
   * and OBSERVED is not trusted for skipping — the slot timer owns repairs there (a
   * leader in SELF_CHECK does not even broadcast, it does not trust the ring either).
   * Fire-and-forget the async work: the token rotates regardless and onTokenGranted
   * MUST NOT block or throw, so we never await here and the async paths contain their
   * own errors.
   */
  private onBaton(): void {
    this.sampleLap();
    if (this.mode !== "LEADER_CHECK") return;

    if (this.isLeader) {
      if (this.scanning) return; // a prior turn's enumerate+repair is still running
      void this.scanAndBroadcast();
      return;
    }

    if (this.desiredPort == null) return;
    // Count this node's turns since the last broadcast so it ages out of trust.
    this.lapsSinceObserved += 1;
    // The read-reduction win: a fresh leader enumerate already covered this node,
    // so if it shows our port healthy we do ZERO router I/O this turn.
    if (this.observedShowsHealthy(this.desiredPort)) return;
    if (this.repairing) return; // a prior turn's repair is still running
    void this.checkAndRepair();
  }

  /**
   * One health lap, run on every baton. The baton is the unicast token, which still
   * reaches a DEAF-but-latent node, so the token alone is NOT evidence of health.
   * The gate is `multicastReceivedCount` ADVANCING since the last lap (peer multicast
   * actually heard): a clean lap counts toward entering LEADER_CHECK after K, a deaf
   * lap (count unchanged) counts toward leaving for SELF_CHECK after M. Re-arm the
   * token-stall timer because a baton DID arrive.
   */
  private sampleLap(): void {
    this.armTokenStall();

    const count = this.group.multicastReceivedCount;
    const advanced = count > this.lastMulticastCount;
    this.lastMulticastCount = count;

    if (advanced) {
      this.cleanLaps += 1;
      this.missedLaps = 0;
      if (this.mode !== "LEADER_CHECK" && this.cleanLaps >= this.enterLaps) {
        this.mode = "LEADER_CHECK";
      }
    } else {
      this.missedLaps += 1;
      this.cleanLaps = 0;
      // M consecutive deaf laps: the token reaches us but no peer multicast does, so
      // we are deaf-but-latent — leave the ring even though batons keep arriving.
      if (this.missedLaps >= this.leaveLaps) this.toSelfCheck();
    }
  }

  /** Drop to SELF_CHECK and reset the enter hysteresis (must re-earn K clean laps). */
  private toSelfCheck(): void {
    this.mode = "SELF_CHECK";
    this.cleanLaps = 0;
  }

  /**
   * Re-arm the no-baton watchdog. Firing means no baton arrived within `tokenStallMs`
   * — the token is not circulating — so we cannot be in LEADER_CHECK; drop to
   * SELF_CHECK where the slot timer keeps the mapping alive autonomously.
   */
  private armTokenStall(): void {
    if (this.tokenStallTimer != null) this.clock.clearTimer(this.tokenStallTimer);
    this.tokenStallTimer = this.clock.setTimer(this.tokenStallMs, () => {
      this.tokenStallTimer = null;
      this.toSelfCheck();
    });
  }

  /**
   * Arm the repeating wall-clock slot timer. The cohort spreads itself across the
   * cycle by `fnv1a(self) % windows` with ZERO coordination, so even a brand-new or
   * partitioned node has an autonomous repair cadence. We align to the wall clock
   * (`clock.now()`) so the slot is the same absolute window on every node, then re-arm
   * for the same slot in the next cycle. The handler only repairs in SELF_CHECK; in
   * LEADER_CHECK it is a no-op (the baton owns repairs there).
   */
  private armSlotTimer(): void {
    if (this.slotTimer != null) this.clock.clearTimer(this.slotTimer);
    const cycle = this.selfCheckCycleMs;
    const width = cycle / this.selfCheckWindows;
    const offset = this.slot * width;
    const now = this.clock.now();
    // Next absolute time this node's slot opens (this cycle if still ahead, else next).
    const intoCycle = now % cycle;
    let wait = offset - intoCycle;
    if (wait <= 0) wait += cycle;
    this.slotTimer = this.clock.setTimer(wait, () => {
      this.slotTimer = null;
      this.onSlot();
      this.armSlotTimer();
    });
  }

  /** Slot fired: in SELF_CHECK only, run the SAME 5a read-before-write on our port. */
  private onSlot(): void {
    if (this.mode !== "SELF_CHECK" || this.desiredPort == null) return;
    if (this.repairing) return;
    void this.checkAndRepair();
  }

  /**
   * Is the last leader broadcast still fresh AND does it show THIS node's port
   * already healthy — present, pointing at us, with a non-expiring lease? Only then
   * is skipping the targeted read safe; otherwise the 5a floor re-checks.
   */
  private observedShowsHealthy(port: number): boolean {
    if (this.lastObserved == null || this.lapsSinceObserved > this.freshLaps) {
      return false;
    }
    return this.lastObserved.some(
      (m) =>
        m.public.port === port &&
        m.private.host === this.localAddress &&
        (m.ttl === 0 || m.ttl >= this.lowTtlThreshold)
    );
  }

  /**
   * Leader path: enumerate the WHOLE router table once and broadcast it so peers
   * can skip their reads, then keep this node's OWN mapping like any other (the
   * leader is a node too). Wholly self-contained — never throws into the token
   * path. On an enumerate failure we surface it and skip the broadcast but STILL
   * attempt the own-port repair, so a flaky scan never strands the leader's mapping.
   *
   * Closed-loop back-off: the enumerate is the LEADER's per-cycle router interaction,
   * so its outcome is the group's router-health proxy. A clean scan recovers the
   * shared rate toward baseline; a failed scan backs the WHOLE segment off (a SET the
   * limiter folds on every node, so the leader paces the entire ring). Only the leader
   * reaches this path, so only the leader ever adjusts — non-leaders just obey the
   * folded SET. It is AIMD-flavoured (sharp multiplicative cut, gentle multiplicative
   * rise) so it cannot flap, and self-contained: setRate only broadcasts, never throws.
   */
  private async scanAndBroadcast(): Promise<void> {
    this.scanning = true;
    try {
      try {
        const mappings = await this.client.getMappings();
        this.group.broadcast({
          type: OBSERVED,
          by: this.self,
          mappings
        } satisfies ObservedMsg);
        this.recoverRate(); // clean scan: ease the whole segment back toward baseline
      } catch (err) {
        this.onMappingFailed?.(this.desiredPort ?? -1, String(err));
        this.backoffRate(); // the struggling router also stalls reads: back the group off
      }
      // The leader still rate-gates its own writes via the shared 5a path.
      await this.checkAndRepair();
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Multiplicative decrease (leader-only): a failed enumerate is router stress, so cut
   * the shared rate by `backoffFactor`, floored at `floorRate` (never to a standstill).
   * Broadcast via setRate so every node folds the same SET in total order — the leader
   * paces the entire segment, not just itself.
   */
  private backoffRate(): void {
    const next = Math.max(this.floorRate, this.rl.currentRate * this.backoffFactor);
    this.rl.setRate(next, this.rl.currentCapacity);
  }

  /**
   * Multiplicative increase (leader-only): a clean scan is router health, so nudge the
   * shared rate UP by `recoverFactor`, capped at the baseline (never above it). Skip the
   * broadcast entirely when already at baseline so a healthy steady state emits no SETs.
   */
  private recoverRate(): void {
    if (this.rl.currentRate >= this.baselineRate) return;
    const next = Math.min(this.baselineRate, this.rl.currentRate * this.recoverFactor);
    this.rl.setRate(next, this.rl.currentCapacity);
  }

  /**
   * Read-before-write the node's OWN mapping, writing only when needed and only
   * when the rate budget permits. Wholly self-contained: never throws (so it can
   * never escape into the token-dispatch path) and never touches another node's
   * mapping.
   */
  private async checkAndRepair(): Promise<void> {
    const port = this.desiredPort;
    if (port == null) return;
    this.repairing = true;
    try {
      const existing = await this.client.getMapping({
        public: port,
        protocol: this.protocol
      });

      // The steady-state path: a present mapping that points at us with a healthy
      // lease needs no write, so the common case costs one read and zero writes.
      const missing = existing == null;
      const wrongHost = existing != null && existing.private.host !== this.localAddress;
      const lowTtl =
        existing != null && existing.ttl > 0 && existing.ttl < this.lowTtlThreshold;
      if (!missing && !wrongHost && !lowTtl) return;

      // A write is needed: spend a token, or skip this turn and let a later baton
      // retry (the rate limiter, not us, decides the cadence of router writes).
      if (!this.rl.acquire()) return;

      try {
        await this.client.createMapping({
          public: port,
          private: { host: this.localAddress, port },
          protocol: this.protocol,
          description: this.description,
          ttl: this.permanentLease ? 0 : this.ttl
        });
      } catch (err) {
        // Some IGDs (e.g. MikroTik) reject a finite lease with SOAP fault 725
        // OnlyPermanentLeasesSupported. Latch permanent and retry this SAME write
        // with ttl 0 — NOT a second rate token, the acquire above already covered
        // this logical write; the retry is the same write with a different lease.
        if (this.permanentLease || !this.isPermanentLeaseError(err)) throw err;
        this.permanentLease = true;
        await this.client.createMapping({
          public: port,
          private: { host: this.localAddress, port },
          protocol: this.protocol,
          description: this.description,
          ttl: 0
        });
      }
    } catch (err) {
      this.onMappingFailed?.(port, String(err));
    } finally {
      this.repairing = false;
    }
  }

  /**
   * Does this error signal the router only accepts permanent leases? Match the SOAP
   * fault on `String(err)` case-insensitively, covering BOTH the numeric code (725)
   * and the text (OnlyPermanentLeases...), since the nat-upnp error surface may carry
   * either.
   */
  private isPermanentLeaseError(err: unknown): boolean {
    return /725|OnlyPermanentLeases/i.test(String(err));
  }
}
