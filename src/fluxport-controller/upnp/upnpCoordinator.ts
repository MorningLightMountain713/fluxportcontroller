/**
 * UPnP coordinator (slices 5a + 5b + 5c) — correctness floor, leader-check reads,
 * and the LEADER_CHECK/SELF_CHECK mode machine.
 *
 * Many Fluxnodes can sit behind ONE home router, each maintaining its own SET of
 * UPnP port mappings (its Fluxports plus its apps' ports). A consumer-grade
 * miniupnpd is single-threaded and chokes if they all hammer it, so the nodes take
 * turns: each node keeps ONLY its own ports mapped, acting only on its paced turn
 * (the consensus `onTokenGranted` baton) and only when the group's shared
 * RateLimiter budget permits.
 *
 * READ-BEFORE-WRITE is the correctness backstop. On its turn a node reads the
 * router's current mapping for EACH of its desired ports and writes ONLY if that
 * mapping is missing, points at the wrong host (someone else's / a stale entry), or
 * its lease is running low. In steady state every mapping is already correct, so the
 * common path is one read per port and ZERO router writes — that is what keeps a
 * shared router from being hammered. The RateLimiter is soft pacing on top (a token
 * is spent per WRITE, so a multi-port repair is itself paced); the read-before-write
 * is the real guard (a brief rate over-issue is harmless because the write is still
 * idempotent against the router's actual state).
 *
 * Self-map-only: by construction the coordinator only ever creates a mapping for
 * one of its OWN desired ports -> `localAddress`. There is no code path that maps
 * or deletes anything on another node's behalf.
 *
 * LEADER-CHECK (5b) — the ~N-times read reduction. When the group is healthy, the
 * ring representative (lowest nid) enumerates the WHOLE router table once on its
 * baton and broadcasts it as UPNP_OBSERVED. A non-leader skips the targeted read for
 * any desired port a FRESH broadcast already shows healthy, so in steady state ONE
 * enumerate covers the whole cohort instead of N targeted reads. It is only an
 * optimisation, decided PER PORT: a port with no fresh broadcast (no leader yet, a
 * stale one, or the broadcast showing that port missing/wrong/low) falls straight
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
 * ORPHAN CLEANUP — a mapping this node once created but no longer wants (an app was
 * uninstalled, a port reassigned) becomes an ORPHAN on the router: dead weight that
 * lingers on a permanent-lease router (finite leases self-expire, so this only earns
 * its keep on ttl:0 routers). Strict-mode delete is self-only, so each node prunes its
 * OWN orphans — it never deletes another node's (it could not anyway). A port is an
 * orphan when a mapping points at THIS node (private.host === localAddress), is in the
 * Flux namespace (by description), and is NOT in the desired set. Orphans are found two
 * ways: a port DROPPED from the desired set (known immediately, works in any mode) and,
 * in leader-check, a LEFTOVER spotted in the leader's OBSERVED whole-table broadcast
 * (catches mappings from before a restart, which the node has no memory of). The delete
 * is just another paced router write — token-gated, read-before-delete, through the one
 * serialized client, on this node's turn — so cleanup never storms the router, and
 * repairs are served first so a tight budget keeps a wanted port up before removing a
 * dead one. A confirm delay plus a "desired set has been fed at least once" latch guard
 * against deleting a live mapping before FluxOS has declared what it wants.
 *
 * READING A PORT — a lookup (GetSpecificPortMappingEntry) is trusted only when it answers
 * "no such entry" or an entry for that same internal port. Some routers fault instead
 * (606, 501), answer with another entry, or answer an empty success; the first such
 * answer marks this router's lookups unreliable, and from then on this node reads its
 * ports from a walk of the table (once per pass; the leader reuses its own scan).
 *
 * LEASES — a mapping is permanent (ttl 0) unless this router is known to renew a lease
 * when the mapping is added again. Many do not: the re-add is accepted and the lease runs
 * out regardless, and some of those also answer 714 to a lookup of a leased entry they
 * hold. The lease test answers it once per router: on `leaseTestPort` it maps with a 60 s
 * lease, adds the same mapping at +30 s, and looks it up at +70 s — renewed means held,
 * pointing at us, with a lease of at most 60 s. Any other outcome means permanent. The
 * leader runs the test and carries the answer in every UPNP_OBSERVED; a node in
 * SELF_CHECK runs it itself. A leased write the router refuses is made permanent and ends
 * leasing on this node.
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
  /** The lease test's answer for this router; null until it has one. */
  leaseRenews: boolean | null;
}

/** The lease the lease test asks for, and when it adds again and reads back. */
const LEASE_TEST_SECONDS = 60;
const LEASE_TEST_READD_MS = 30_000;
const LEASE_TEST_READ_MS = 70_000;
/** Wait before trying again a lease test that could not finish (no rate token, no answer). */
const LEASE_TEST_RETRY_MS = 600_000;

/** One repair or cleanup pass: the router table, once walked, is reused by every port. */
interface Pass {
  table: UpnpMapping[] | null;
}

/** A SOAP fault the router answered with (nat-upnp's UpnpError carries a numeric code),
 *  as opposed to a request that got no answer. */
function isRouterFault(err: unknown): boolean {
  return typeof (err as { code?: unknown } | null)?.code === "number";
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

/** Consecutive cleanup passes a port must stay an orphan before its mapping is deleted.
 *  A small grace so a just-created-but-not-yet-desired mapping (FluxOS still declaring
 *  its desired set) is never pruned out from under itself. */
const DEFAULT_ORPHAN_CONFIRM_PASSES = 2;

/** Consecutive FAILED unmap attempts before a candidate is dropped — a bounded retry,
 *  distinct from repairs (which retry a WANTED port forever). A lingering orphan is
 *  acceptable (design §3); a doomed delete retried every pass is pure waste, so we give
 *  up after the cap and let a later OBSERVED re-surface it if still present, which spaces
 *  the retries far apart instead of one per turn. */
const DEFAULT_ORPHAN_MAX_DELETE_ATTEMPTS = 4;

/** Matches the Flux mapping namespace (`Flux`, `Flux_App_<name>`, `Flux_Test_App`,
 *  `Flux_Prelaunch_App_`). Orphan cleanup only ever deletes within it, so a manual /
 *  third-party port forward on the same router is never touched. */
const FLUX_DESCRIPTION = /^Flux/i;

/** Per-candidate orphan state: confirm passes served so far (the grace before deleting)
 *  and consecutive failed delete attempts (the bound before giving up). */
interface OrphanState {
  confirms: number;
  failures: number;
}

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
  /** Lease seconds for a mapping, once the lease test has shown this router renews
   *  leases; until then, and on routers that do not, mappings are permanent. */
  ttl?: number;
  /** Re-map when an existing mapping's remaining ttl drops below this. */
  lowTtlThreshold?: number;
  /** A port of this node's own that no app uses, free on the router, for the lease test. */
  leaseTestPort?: number;
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
  /** Consecutive cleanup passes a port must stay an orphan before it is unmapped. */
  orphanConfirmPasses?: number;
  /** Consecutive failed unmap attempts before an orphan candidate is dropped (bounded
   *  retry). Default 4. */
  orphanMaxDeleteAttempts?: number;
  /** onMappingFailed surfaces BOTH a failed create AND a failed orphan delete for the
   *  port; the reason is the client's raw error text, so create vs delete is
   *  distinguishable only if the SOAP client's message says so, not by the coordinator. A
   *  delete failure is benign — the mapping just lingers; the unmap is retried, then
   *  bounded (dropped after a few attempts, re-surfaced by a later OBSERVED if present). */
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
  private readonly leaseTestPort: number | null;
  private readonly freshLaps: number;
  private readonly enterLaps: number;
  private readonly leaveLaps: number;
  private readonly tokenStallMs: number;
  private readonly selfCheckCycleMs: number;
  private readonly selfCheckWindows: number;
  private readonly orphanConfirmPasses: number;
  private readonly orphanMaxDeleteAttempts: number;
  private readonly onMappingFailed?: (port: number, reason: string) => void;
  private readonly rl: RateLimiter;
  // Adaptive back-off control: the constructor `rate` is the baseline the leader paces
  // around; floor bounds the multiplicative decrease; the two factors are the AIMD law.
  private readonly baselineRate: number;
  private readonly floorRate: number;
  private readonly backoffFactor: number;
  private readonly recoverFactor: number;

  private desiredPorts: Set<number> = new Set();
  // Orphan cleanup never runs until FluxOS has declared a desired set at least once, so
  // an empty set at startup ("not told yet") is not mistaken for "I want nothing mapped".
  private desiredEverSet = false;
  // Ports whose OWN mapping should be deleted (no longer desired), each with its confirm
  // grace + failed-attempt counters — deleted once it clears the grace, dropped once it
  // exhausts the retry bound. Fed by a desired-set drop and by leftovers spotted in OBSERVED.
  private orphanCandidates = new Map<number, OrphanState>();
  // Rotating start offset for the orphan walk, the same fairness the repair cursor gives
  // writes: a persistently-failing unmap cannot perpetually sink a tight token budget and
  // starve the other orphans behind it.
  private unmapCursor = 0;
  // Per-port mapping descriptions set by requestMap (e.g. "Flux_App_<name>") so a routine
  // re-map of an app port keeps its app name instead of reverting to the default "Flux".
  // Pruned when a port leaves the desired set.
  private portDescriptions = new Map<number, string>();
  // Whether this router renews a lease on a re-add: null until the lease test (this
  // node's, or the leader's via UPNP_OBSERVED) answers. Mappings are leased only when true.
  private leaseRenewal: boolean | null = null;
  private leaseTestRunning = false;
  private leaseTestNotBefore = 0;
  private leaseTestTimer: TimerId | null = null;
  // Set by the first lookup answer that cannot be trusted; ports are then read from a walk.
  private lookupsUnreliable = false;
  // A repair runs async off the baton; guard so only one is in flight at a time.
  private repairing = false;
  // Rotating start offset for the per-pass set walk, so a constrained rate budget is
  // shared FAIRLY across passes — no port is perpetually stuck behind an earlier one
  // that sinks the budget (e.g. an un-mappable port whose write keeps failing).
  private repairCursor = 0;
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
    this.leaseTestPort = deps.leaseTestPort ?? null;
    this.freshLaps = deps.freshLaps ?? DEFAULT_FRESH_LAPS;
    this.enterLaps = deps.enterLaps ?? DEFAULT_ENTER_LAPS;
    this.leaveLaps = deps.leaveLaps ?? DEFAULT_LEAVE_LAPS;
    this.tokenStallMs = deps.tokenStallMs ?? DEFAULT_TOKEN_STALL_MS;
    this.selfCheckCycleMs = deps.selfCheckCycleMs ?? DEFAULT_SELF_CHECK_CYCLE_MS;
    this.selfCheckWindows = deps.selfCheckWindows ?? DEFAULT_SELF_CHECK_WINDOWS;
    this.orphanConfirmPasses = deps.orphanConfirmPasses ?? DEFAULT_ORPHAN_CONFIRM_PASSES;
    this.orphanMaxDeleteAttempts =
      deps.orphanMaxDeleteAttempts ?? DEFAULT_ORPHAN_MAX_DELETE_ATTEMPTS;
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
    if (this.leaseTestTimer != null) {
      // An interrupted lease test leaves its 60 s mapping to lapse; a later start retries.
      this.clock.clearTimer(this.leaseTestTimer);
      this.leaseTestTimer = null;
      this.leaseTestRunning = false;
    }
  }

  /**
   * The full set of ports this node should keep mapped (its Fluxports ∪ its apps'
   * ports). Last-writer-wins: each call REPLACES the desired set. A port DROPPED from
   * the set becomes an orphan candidate — its own mapping is paced-deleted on a later
   * turn — while a port (re-)added is no longer an orphan, so any pending candidacy for
   * it is cancelled at once (a drop-then-re-add never deletes). FluxOS calls this each
   * cycle with the current desired set; the first call latches `desiredEverSet`, the
   * gate that lets cleanup begin (so a not-yet-fed empty set never prunes anything).
   */
  setDesiredPortSet(ports: number[]): void {
    const next = new Set(ports);
    // A port that just left the desired set is now an orphan to prune (count starts at 0
    // so it still serves the confirm grace). Only meaningful once a set was previously
    // declared — the first call has no prior "desired" to diff against.
    if (this.desiredEverSet) {
      for (const port of this.desiredPorts) {
        if (!next.has(port) && !this.orphanCandidates.has(port)) {
          this.orphanCandidates.set(port, { confirms: 0, failures: 0 });
        }
      }
    }
    // A (re-)desired port is by definition not an orphan — cancel any pending candidacy.
    for (const port of next) this.orphanCandidates.delete(port);
    // Drop per-port descriptions for ports no longer desired (kept only while maintained).
    for (const port of [...this.portDescriptions.keys()]) {
      if (!next.has(port)) this.portDescriptions.delete(port);
    }
    this.desiredPorts = next;
    this.desiredEverSet = true;
  }

  /**
   * Urgent install-time map: declare a port desired AND map it NOW, bypassing the baton
   * cadence (FluxOS calls this the instant an app is installed, not on the slow routine
   * loop). It STILL goes through the one serialized client and the rate budget — urgency
   * is about cadence, not flooding the router — so if no token is free this turn the map
   * is left to the routine loop (the port is now in the desired set). The optional
   * description (e.g. "Flux_App_<name>") is remembered so a later routine re-map keeps it.
   * Failures surface via onMappingFailed, like any other map; read-before-write keeps it
   * idempotent against a concurrent baton-driven pass.
   */
  async requestMap(port: number, description?: string): Promise<void> {
    this.desiredEverSet = true;
    this.desiredPorts.add(port);
    this.orphanCandidates.delete(port); // desired now — never an orphan
    if (description != null) this.portDescriptions.set(port, description);
    await this.repairPort(port, { table: null });
  }

  /** The ports this node is maintaining, ascending (test seam / observability). */
  get desired(): number[] {
    return [...this.desiredPorts].sort((a, b) => a - b);
  }
  /** Ports queued for orphan cleanup (own mapping pending delete), ascending (test seam). */
  get pendingUnmaps(): number[] {
    return [...this.orphanCandidates.keys()].sort((a, b) => a - b);
  }
  /** Which mode this node is in (test seam / observability). */
  get currentMode(): CoordinatorMode {
    return this.mode;
  }
  /** This node's self-check slot index (test seam). */
  get selfCheckSlot(): number {
    return this.slot;
  }
  /** Whether this router renews a lease on a re-add; null until known (test seam). */
  get leaseRenews(): boolean | null {
    return this.leaseRenewal;
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
    // The lease answer is the router's, whoever measured it; a refusal this node saw
    // itself (false) is never overridden.
    if (this.leaseRenewal === null && msg.leaseRenews != null) this.leaseRenewal = msg.leaseRenews;
    // The leader's whole-table view also reveals OUR leftovers — a Flux mapping pointing
    // at us on a port we no longer desire (e.g. one from before a restart) — which we
    // queue to prune on our turn. (The leader ignores its own broadcast here, but feeds
    // the same queue from its own enumerate in scanAndBroadcast.)
    this.noteObservedOrphans(msg.mappings);
  }

  /**
   * Scan a whole-table view for THIS node's orphans — a Flux-namespace mapping pointing
   * at us, on our protocol, for a port not in the desired set — and queue each to be
   * unmapped. Gated two ways: only after a desired set has been declared (`desiredEverSet`,
   * so a not-yet-fed node never treats its own live mappings as orphans), and only in
   * LEADER_CHECK — SELF_CHECK trusts nobody, so leftover discovery (which relies on a
   * peer's broadcast) waits for the ring; a self-check node still prunes its explicit
   * desired-set drops, just not broadcast-discovered leftovers. Idempotent: an
   * already-queued port keeps its counters; a re-desired one was already dropped.
   */
  private noteObservedOrphans(table: UpnpMapping[]): void {
    if (!this.desiredEverSet || this.mode !== "LEADER_CHECK") return;
    for (const m of table) {
      if (
        m.private.host === this.localAddress &&
        m.protocol.toLowerCase() === this.protocol.toLowerCase() &&
        FLUX_DESCRIPTION.test(m.description) &&
        !this.desiredPorts.has(m.public.port) &&
        m.public.port !== this.leaseTestPort &&
        !this.orphanCandidates.has(m.public.port)
      ) {
        this.orphanCandidates.set(m.public.port, { confirms: 0, failures: 0 });
      }
    }
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

    if (this.desiredPorts.size === 0 && this.orphanCandidates.size === 0) return;
    // Count this node's turns since the last broadcast so it ages out of trust. One
    // observation covers the whole set, so this ages once per turn, not per port.
    this.lapsSinceObserved += 1;
    // The read-reduction win is decided PER PORT inside checkAndRepair: a port a fresh
    // leader enumerate already shows healthy costs ZERO router I/O this turn; the rest
    // fall back to the read-before-write floor. (checkAndRepair guards re-entrancy.)
    void this.checkAndRepair(true, { table: null });
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

  /** Slot fired: in SELF_CHECK only, run the SAME read-before-write over our whole
   *  desired set (and prune any orphans) — trusting NO broadcast (self-check trusts
   *  nobody). With no leader broadcast here, only desired-set DROPS surface as orphans;
   *  leftover discovery needs the leader's whole-table OBSERVED (leader-check). */
  private onSlot(): void {
    if (this.mode !== "SELF_CHECK") return;
    this.maybeStartLeaseTest();
    if (this.desiredPorts.size === 0 && this.orphanCandidates.size === 0) return;
    void this.checkAndRepair(false, { table: null });
  }

  /**
   * Is the last leader broadcast still fresh AND does it show THIS node's port needing
   * no write? Only then is skipping the targeted read safe; otherwise the 5a floor
   * re-checks. The protocol match is load-bearing: the read this skips is itself
   * protocol-scoped (`getMapping({ protocol })`), so a same-port entry on a DIFFERENT
   * protocol (e.g. a neighbour's UDP mapping on our TCP port number) must NOT count as
   * our port being healthy, or we would skip and never repair the genuinely-missing one.
   */
  private observedShowsHealthy(port: number): boolean {
    if (this.lastObserved == null || this.lapsSinceObserved > this.freshLaps) {
      return false;
    }
    const entry = this.entryIn(this.lastObserved, port);
    return entry != null && !this.needsWrite(entry, port);
  }

  /** This node's protocol's entry for `port` in a whole-table view, or null. */
  private entryIn(table: UpnpMapping[], port: number): UpnpMapping | null {
    return (
      table.find(
        (m) =>
          m.public.port === port && m.protocol.toLowerCase() === this.protocol.toLowerCase()
      ) ?? null
    );
  }

  /**
   * Does the router's entry for one of OUR ports need writing? Missing; pointing at
   * another host or another internal port; a lease running low; or permanent while this
   * router is known to renew leases (the write converts it to a lease).
   */
  private needsWrite(entry: UpnpMapping | null, port: number): boolean {
    if (entry == null) return true;
    if (entry.private.host !== this.localAddress || entry.private.port !== port) return true;
    if (entry.ttl > 0 && entry.ttl < this.lowTtlThreshold) return true;
    return this.leaseRenewal === true && entry.ttl === 0;
  }

  /**
   * The router's entry for one of OUR ports. A lookup is used while this router's lookups
   * are trusted; an answer that cannot be about this port (a fault other than "no such
   * entry", or an entry for another internal port) marks them unreliable, and the port is
   * read from the pass's walk of the table instead — made once per pass and shared.
   */
  private async readOwn(port: number, pass: Pass): Promise<UpnpMapping | null> {
    if (!this.lookupsUnreliable) {
      try {
        const entry = await this.client.getMapping({ public: port, protocol: this.protocol });
        if (entry == null || entry.private.port === port) return entry;
      } catch (err) {
        if (!isRouterFault(err)) throw err;
      }
      this.lookupsUnreliable = true;
    }
    pass.table ??= await this.client.getMappings();
    return this.entryIn(pass.table, port);
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
    const pass: Pass = { table: null };
    try {
      this.maybeStartLeaseTest();
      try {
        const mappings = await this.client.getMappings();
        pass.table = mappings;
        this.group.broadcast({
          type: OBSERVED,
          by: this.self,
          mappings,
          leaseRenews: this.leaseRenewal
        } satisfies ObservedMsg);
        // The leader ignores its OWN broadcast (onObserved), so feed its leftovers from
        // the enumerate it just did — its own orphans get pruned like any other node's.
        this.noteObservedOrphans(mappings);
        this.recoverRate(); // clean scan: ease the whole segment back toward baseline
      } catch (err) {
        // An enumerate failure is a whole-table read fault, not specific to one port,
        // so report it under the sentinel -1 (no single port to attribute it to).
        this.onMappingFailed?.(-1, String(err));
        this.backoffRate(); // the struggling router also stalls reads: back the group off
      }
      // The leader keeps its OWN ports via the shared read-before-write path. It does
      // NOT trust OBSERVED (it ignores its own broadcast), so it reads each own port —
      // from the scan it just made, where this router's lookups are unreliable.
      await this.checkAndRepair(false, pass);
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
   * Read-before-write EACH desired port, writing only when needed and only when the
   * rate budget permits. One pass over the whole set per call, guarded so only one
   * pass runs at a time (a slow router can span several batons/slots). Each port is
   * repaired independently and self-containedly, so one port's failure never blocks
   * the rest and nothing ever throws into the token-dispatch path.
   *
   * `trustObserved` is the 5b read-reduction: a non-leader passes true so a port a
   * fresh leader broadcast already shows healthy is skipped with ZERO router I/O; the
   * leader's own scan and the self-check slot pass false (they trust no broadcast and
   * read every port first-hand). `pass` carries the router table across the ports once
   * one has been read (the leader's scan, or a walk made because lookups are unreliable).
   */
  private async checkAndRepair(trustObserved: boolean, pass: Pass): Promise<void> {
    if (this.repairing) return; // a prior pass is still working through the set
    if (this.desiredPorts.size === 0 && this.orphanCandidates.size === 0) return;
    this.repairing = true;
    try {
      if (this.desiredPorts.size > 0) {
        // Walk the set from a rotating offset so that when the rate budget is tighter
        // than the number of ports needing a write (a router-reboot mass-repair, or one
        // port that keeps failing to map and sinks a token each pass), the budget is
        // shared across passes and every port is eventually reached — not perpetually
        // starved behind an earlier one. Recomputed per call so a changed set is fine.
        const ports = [...this.desiredPorts];
        const start = this.repairCursor % ports.length;
        this.repairCursor = (start + 1) % ports.length;
        for (let i = 0; i < ports.length; i++) {
          const port = ports[(start + i) % ports.length];
          if (trustObserved && this.observedShowsHealthy(port)) continue;
          await this.repairPort(port, pass);
        }
      }
      // Then prune our own orphans, paced by the SAME budget. Repairs run first, so a
      // tight budget always keeps a wanted port up before spending a token to remove a
      // dead one — the asymmetry that matters (a missed orphan just lingers; a wrongly
      // dropped repair breaks a live port).
      await this.cleanupOrphans(pass);
    } finally {
      this.repairing = false;
    }
  }

  /**
   * Delete THIS node's orphan mappings, one paced pass over the candidate queue. A
   * candidate first serves a confirm grace (a few passes) so a mapping created just
   * before FluxOS declares it desired is never pruned; once confirmed and still
   * undesired it is unmapped read-before-delete and token-gated. A rotating start shares
   * a tight budget fairly — the same guard the repair cursor gives writes — so a
   * persistently-failing unmap can never starve the rest of the queue.
   */
  private async cleanupOrphans(pass: Pass): Promise<void> {
    if (this.orphanCandidates.size === 0) return;
    // Snapshot the keys so deletes / re-adds during the awaited pass do not perturb this
    // walk; the live map is the source of truth for each port's current state below.
    const ports = [...this.orphanCandidates.keys()];
    const start = this.unmapCursor % ports.length;
    this.unmapCursor = (start + 1) % ports.length;
    for (let i = 0; i < ports.length; i++) {
      const port = ports[(start + i) % ports.length];
      const st = this.orphanCandidates.get(port);
      if (st == null) continue; // removed mid-pass (re-desired / already pruned)
      if (this.desiredPorts.has(port)) {
        this.orphanCandidates.delete(port); // re-desired since queued — not an orphan
        continue;
      }
      if (st.confirms < this.orphanConfirmPasses) {
        st.confirms += 1; // serve the confirm grace first
        continue;
      }
      await this.unmapPort(port, pass);
    }
  }

  /**
   * Read-before-delete a SINGLE orphan: confirm a mapping for it still exists, still
   * points at us, and is still in the Flux namespace before deleting (strict-mode delete
   * is self-only, so a port a peer has since reclaimed is not ours to remove — drop it
   * from the queue). The delete spends one rate token, else we keep the candidate and
   * retry on a later turn. Wholly self-contained — never throws — so a delete fault never
   * escapes into the token path; the candidate is kept (the cursor rotates so it cannot
   * starve the rest) and the benign failure is surfaced via onMappingFailed.
   */
  private async unmapPort(port: number, pass: Pass): Promise<void> {
    try {
      const existing = await this.readOwn(port, pass);
      // A re-desire can have landed DURING the awaited read — setDesiredPortSet runs on the
      // same loop, concurrent with our SOAP round-trip, and cancels the candidacy. Re-check
      // at the LAST point before the committed delete (no further await before removeMapping)
      // so a port wanted again is never torn down. cleanupOrphans guards synchronously before
      // the await; this closes the in-flight window the synchronous guard cannot see.
      if (this.desiredPorts.has(port)) {
        this.orphanCandidates.delete(port);
        return;
      }
      if (
        existing == null ||
        existing.private.host !== this.localAddress ||
        !FLUX_DESCRIPTION.test(existing.description)
      ) {
        this.orphanCandidates.delete(port); // already gone, or no longer ours to delete
        return;
      }
      if (!this.rl.acquire()) return; // no budget this pass; keep the candidate, retry later
      await this.client.removeMapping({ public: port, protocol: this.protocol });
      this.orphanCandidates.delete(port);
    } catch (err) {
      this.onMappingFailed?.(port, String(err));
      // Bounded retry (unlike repairs, which retry a WANTED port forever): a delete that
      // keeps failing while the entry still reads as ours is pure waste — a lingering orphan
      // is acceptable (design §3). After the cap, drop it; a later OBSERVED re-surfaces it if
      // still present, spacing retries far apart instead of one per turn.
      const st = this.orphanCandidates.get(port);
      if (st != null && ++st.failures >= this.orphanMaxDeleteAttempts) {
        this.orphanCandidates.delete(port);
      }
    }
  }

  /**
   * Read-before-write a SINGLE port: read the router's current entry and write only when
   * `needsWrite` says so; the write spends one rate token (else skip this port this pass
   * and let a later turn retry). Wholly self-contained — never throws — so each port is
   * isolated from the others and from the token path. Self-map-only: the create is always
   * our own port -> localAddress.
   */
  private async repairPort(port: number, pass: Pass): Promise<void> {
    try {
      const existing = await this.readOwn(port, pass);
      // The steady-state path: an entry that needs nothing costs one read, zero writes.
      if (!this.needsWrite(existing, port)) return;

      // A write is needed: spend a token, or skip this port and let a later baton
      // retry (the rate limiter, not us, decides the cadence of router writes).
      if (!this.rl.acquire()) return;

      const lease = this.leaseRenewal === true ? this.ttl : 0;
      const description = this.portDescriptions.get(port) ?? this.description;
      const write = (ttl: number): Promise<void> =>
        this.client.createMapping({
          public: port,
          private: { host: this.localAddress, port },
          protocol: this.protocol,
          description,
          ttl
        });
      try {
        await write(lease);
      } catch (err) {
        // A router that refuses a leased mapping (725, 501, 718 on a port that is free or
        // ours) takes the same write permanently. Another host's entry on the port is a
        // conflict, not a lease refusal. The retry is the same logical write: no token.
        const othersEntry = existing != null && existing.private.host !== this.localAddress;
        if (lease === 0 || othersEntry || !isRouterFault(err)) throw err;
        await write(0);
        this.leaseRenewal = false;
      }
    } catch (err) {
      this.onMappingFailed?.(port, String(err));
    }
  }

  /** Start the lease test when this node is the one to answer it and has no answer yet. */
  private maybeStartLeaseTest(): void {
    if (this.leaseTestPort == null || this.leaseRenewal !== null || this.leaseTestRunning) return;
    if (this.clock.now() < this.leaseTestNotBefore) return;
    void this.runLeaseTest(this.leaseTestPort);
  }

  private async runLeaseTest(port: number): Promise<void> {
    this.leaseTestRunning = true;
    try {
      const renews = await this.leaseTestOutcome(port);
      if (renews === null) {
        this.leaseTestNotBefore = this.clock.now() + LEASE_TEST_RETRY_MS;
      } else if (this.leaseRenewal === null) {
        this.leaseRenewal = renews;
      }
    } catch (err) {
      this.onMappingFailed?.(port, String(err));
      this.leaseTestNotBefore = this.clock.now() + LEASE_TEST_RETRY_MS;
    } finally {
      this.leaseTestRunning = false;
    }
  }

  /**
   * Map the test port with a 60 s lease, add it again at +30 s, look it up at +70 s:
   * true when it is still held, pointing at us, with a lease of at most 60 s; false for any
   * refusal or other answer; null when the test could not finish (no rate token, or a
   * request with no answer). Each write spends a rate token. The test mapping is removed
   * at the end; when it cannot be, its lease ends it.
   */
  private async leaseTestOutcome(port: number): Promise<boolean | null> {
    const add = (): Promise<void> =>
      this.client.createMapping({
        public: port,
        private: { host: this.localAddress, port },
        protocol: this.protocol,
        description: `${this.description}_Lease_Test`,
        ttl: LEASE_TEST_SECONDS
      });
    for (const at of [0, LEASE_TEST_READD_MS]) {
      if (at > 0) await this.wait(at);
      if (!this.rl.acquire()) return null;
      try {
        await add();
      } catch (err) {
        return isRouterFault(err) ? false : null;
      }
    }
    await this.wait(LEASE_TEST_READ_MS - LEASE_TEST_READD_MS);
    let held: UpnpMapping | null;
    try {
      held = await this.client.getMapping({ public: port, protocol: this.protocol });
    } catch (err) {
      if (!isRouterFault(err)) return null;
      held = null;
    }
    const renews =
      held != null &&
      held.private.host === this.localAddress &&
      held.private.port === port &&
      held.enabled &&
      held.ttl > 0 &&
      held.ttl <= LEASE_TEST_SECONDS;
    if (this.rl.acquire()) {
      try {
        await this.client.removeMapping({ public: port, protocol: this.protocol });
      } catch {
        // its lease ends it
      }
    }
    return renews;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.leaseTestTimer = this.clock.setTimer(ms, () => {
        this.leaseTestTimer = null;
        resolve();
      });
    });
  }
}
