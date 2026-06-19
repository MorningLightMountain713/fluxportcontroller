# Consensus architecture — how to build on the substrate

This package is a **reusable LAN multicast atomic-broadcast foundation** for
Fluxnode-to-Fluxnode coordination. It was built for one job — auto-assigning each
node a unique UPnP port — but the consensus core is payload-agnostic, so new
coordination features are added as thin *consumers*, not new protocol.

This document is the map for adding one: the layers, the two coordination
"flavors", and the recipe. Read it before adding a feature so it lands in the
right place.

---

## The three layers

```
  Layer 3  FEATURES                FluxPortManager(+PortAllocator)   UpnpCoordinator   ...
           (thin: a payload type + a fold + their own logic; compose Layer 2)
                          │                         │
  Layer 2  GENERIC CONSUMERS       RateLimiter (pacing)     [ReplicatedMap] (shared state, deferred)
           (a small, bounded set — one reusable building block per flavor)
                          │
  Layer 1  SUBSTRATE PRIMITIVES    Consensus · Group · OrderedBroadcast · Membership · TokenRing
           (fixed, few; the protocol. Do NOT add to this per feature.)
```

- **Layer 1 — substrate primitives (done).** One multicast socket (`Consensus`)
  hosts named **groups**; each `Group` is an independent ring with its own
  ordering, membership, timing and failure domain. `OrderedBroadcast` gives
  total-order, failure-atomic (virtual-synchrony) delivery of opaque payloads;
  `Membership` handles GATHER/COMMIT recovery; `TokenRing` is the rotating baton +
  failure detector. The node-level transport **self-heal** lives in `Consensus`
  (one shared socket, all groups rejoin on a rebind). You do not modify Layer 1 to
  add a feature.

- **Layer 2 — generic consumers (a small set, one per flavor).** Reusable building
  blocks over Layer 1. Today: `RateLimiter` (the *pacing* flavor). A shared-state
  building block (`ReplicatedMap`/`ReplicatedRegister`) is **deferred** — see below.

- **Layer 3 — features.** Each is thin: a payload `type`, a fold of the ordered
  log into its state, and its own logic, composing Layer 2. `PortAllocator` is the
  template (~100 lines, reusing every hard part of Layer 1).

---

## The two coordination flavors — pick the right one

The deciding question for any new feature: **does a node read its OWN state to
pace its OWN action, or do nodes read a SHARED agreed value to make a decision?**

### Flavor A — soft pacing ("may *I* act now?")

A node consults its **own** local view to rate-limit or take turns at an action
whose *truth lives elsewhere* (an external resource, reconciled by the consumer's
own read-before-write). Nobody reads a peer's level.

- Building block: **`RateLimiter`** (`consensus/rateLimiter.ts`) — the standard
  distributed token bucket. Each node debits its own bucket at `acquire()` and
  broadcasts; peers fold the consume; over-issue is carried as debt and repaid.
  Leak-free and obligation-free **by construction** (no `pending`, no
  `onViewChange`, no wire timestamps). Exact under serialized (baton-gated)
  acquisition; soft under concurrency. Reuse it for any "max N actions / interval".
- Example feature: **UPnP router pacing** — the truth is the router's mapping
  table (read-before-write); the limiter only paces how fast the segment hits it.

### Flavor B — deterministic shared state ("what's the AGREED value?")

Every node folds the ordered log into a **byte-identical** replicated state that
nodes *read to make a decision* — the agreed state **is** the truth. This needs
strict determinism (every node computes the same value from the same ordered log).

- Pattern: a deterministic fold over `Group.onDeliver`, re-asserted on
  `onViewChange` (the log restarts on a reconfiguration). **`PortAllocator` is the
  live template.**
- Example features (roadmap): score/benchmark sync (eject the agreed outlier),
  shared config / feature flags, health-verdict gossip, an auditable per-segment
  quota with no external truth.

> The litmus test: if a node ever needs to **read a peer's value** (or the count
> is an **auditable contract**), it is Flavor B and must be a deterministic fold.
> If it only ever asks **its own** limiter "may I act?", it is Flavor A. Do **not**
> bolt determinism onto a pacer, and do **not** make shared state a pacer — keep
> the flavors distinct; that is what keeps the foundation small.

---

## The consumer recipe

1. **Join a group:** `const g = consensus.join("yourfeature", { config, hooks })`.
   Default to **one group per feature** (own ring, timing, failure domain). Give it
   its own cadence — e.g. a slow router-pacing token vs the fast port ring.
2. **Define a typed payload.** Discriminate with a `type` field (e.g.
   `PortAllocator` uses `CLAIM`/`RELEASE`; `RateLimiter` uses `RATE_CONSUME`/
   `RATE_SET`). The substrate carries it opaquely.
3. **Fold it.** Wire `hooks.onDeliver(payload, seq)` to your state machine, and
   `hooks.onViewChange(view)` to re-assert/reset on a reconfiguration (Flavor B
   folds re-assert; the `RateLimiter` needs nothing here).
4. **Use the baton / leader if you need turns or a leader:** `Group.onTokenGranted`
   (it's your turn — runs off the critical path, must not block or throw) and
   `Group.representative` (the lowest-nid implicit leader). `Group.multicastReceivedCount`
   is the ring-health evidence (peer multicast heard).

### Co-tenancy — sharing one group between consumers

Two consumers may share a single group (e.g. a coordinator's own messages **and**
a `RateLimiter`'s `RATE_*` on one ring). The owner demuxes by type: each reusable
consumer exposes an **`owns(payload)`** predicate, and the owner routes:

```ts
onDeliver(payload) {
  if (RateLimiter.owns(payload)) { this.rateLimiter.onDeliver(payload); return; }
  // ... handle this feature's own typed payloads
}
```

A short if-chain is the convention; a `Map<type, handler>` router is only worth it
with 3+ co-tenants (YAGNI until then).

---

## Identity

The ring is keyed by `self` = the node's **LAN IP** (the transport address the
token is unicast to). Claim/feature ownership is keyed by `identity` = the node's
stable **outpoint nid** (globally unique on-chain). This split is load-bearing:
a changed IP is a rejoin-as-same-nid (the self-heal path), and a feature's state
survives a rebind because it is keyed on the nid, not the address. **Use the nid
as a consumer's identity** wherever uniqueness matters (e.g. the `RateLimiter`'s
`self`, so two nodes can never collide).

---

## Deferred (build when grounded, not before)

- **A generic shared-state building block (`ReplicatedMap`/`ReplicatedRegister`).**
  The Flavor-B reusable component. Its load-bearing decision is the *conflict/merge
  model*, and that is underdetermined today: `PortAllocator` wants lowest-priority-
  wins over a contested fixed set (and isn't even a plain map — it's an allocation
  protocol); a config register wants last-writer-wins; a score map wants max/
  per-node. Designing the generalization from one example would be guessing in a
  vacuum. **Factor it when the second deterministic consumer lands** and the merge
  variation is real. Until then each Flavor-B feature is a thin `PortAllocator`-style
  fold.
- **Subset / trusted-membership groups.** Today a group's membership = whoever is
  reachable on the segment. A feature needing a *subset* (e.g. a trusted-config
  ring) would need a per-group admission policy the substrate does not have — the
  one extension that would touch Layer 1. Design it against its first concrete
  consumer.
