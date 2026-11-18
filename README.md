# fluxport-controller

Coordinates the Fluxnodes behind one router, with no router lock and no FluxOS
coupling. Nodes on the same LAN discover each other over multicast and run a
Totem-style token-ring consensus (reliable, totally ordered broadcast with
virtual-synchrony membership). Two features run on it:

- **Port assignment** — each node gets a unique Fluxport.
- **UPnP coordination** — each node keeps its own mappings on the shared router,
  paced so the nodes take turns and one node reads the router's table for all.

## How it works

`FluxNodeAgent` is the entry point. It owns one multicast socket and one
`Consensus`, on which two named groups run:

- **`ports`** — a deterministic allocator over the totally ordered CLAIM/RELEASE
  log. This node's previously confirmed port (sticky reuse) and its
  `confirmed_height` (the conflict priority) come from the Flux deterministic node
  list, so nothing is persisted locally.
- **`upnp`** — the UPnP coordinator, on a slow cadence.

**Discovery:** UPnP gateway discovery (`@runonflux/nat-upnp`) finds the LAN
interface the multicast socket binds to, and the router address.

**Identity:** the ring is addressed by the node's **LAN IP**; port ownership is
keyed by its **outpoint** (`txhash:outidx`), so a node keeps its port across a
LAN-IP change.

**Self-heal:** the socket is bound to the discovered LAN IP. If that IP changes,
or multicast membership is lost at the same IP (an interface recreated under the
node), the socket is rebuilt, every group rejoins, and the node reclaims its port —
emitting `rebound`. Detection is event-driven (a transport error, or the ring
collapsing to this node alone); there is no polling.

### UPnP coordination

Each node keeps only its **own** desired ports mapped to its own LAN address; no
node maps or deletes on another's behalf.

- **Read before write.** A node writes a mapping only when the router's entry is
  missing, points elsewhere, has a lease running low, or is permanent while the
  router is known to renew leases. In steady state a node only reads.
- **One reader.** While the ring is healthy, its representative (the leader) walks
  the router's whole table and broadcasts it; the other nodes skip their own read
  for any port that table already shows healthy. When the ring is not healthy, each
  node checks its own ports in a slot of a fixed wall-clock cycle.
- **Paced writes.** Every write spends a token from a rate limiter shared by the
  group. When the leader's table read fails, it lowers the group's rate; clean
  reads raise it back.
- **Orphans.** A node deletes its own Flux mappings for ports it no longer wants,
  after a short grace and within the same rate budget.
- **Lookups.** A lookup is trusted only when it answers "no such entry" or an entry
  for the port asked about. A router whose lookups fault, answer with another entry
  or answer an empty success is read through a walk of its table instead.
- **Leases.** Mappings are permanent unless the router is known to renew a lease
  when a mapping is added again. A node with a `routerTestPort` tests that once: it
  maps the port with a 60 s lease, adds it again at +30 s and looks it up at +70 s.
  The leader shares the answer with the ring. A router that refuses a leased
  mapping gets permanent ones.
- **Events.** With an `eventPort`, the leader subscribes to the router's events
  and, once they are trusted, reads the table only when an event arrives and at a
  slow safety-net interval, instead of on every turn. Routers that advertise
  eventing still fail to deliver it in several ways, so events are trusted only
  after a test on that router and node: a subscription, the event it starts with,
  and an event each for a mapping added and removed on the `routerTestPort`. Trust
  ends, until a retest an hour later, when a lost subscription cannot be replaced,
  when one of the leader's own changes brings no event, or when a safety-net read
  finds the table's size changed with no event. A failed test or lost trust only
  means the leader reads on every turn again.

## Installation

```bash
npm i @megachips/fluxport-controller
```

## Usage

```javascript
import { FluxNodeAgent, logController } from "@megachips/fluxport-controller";

// optional: the logger is silent by default
logController.addLoggerTransport("console");

const agent = new FluxNodeAgent(
  // this node's collateral outpoint
  { txhash: "334896be9aacb757de3e01633eba12b30198612513289223ca355d52137ba221", outidx: "0" },
  { upnpTuning: { routerTestPort: apiPort + 3, eventPort: apiPort + 4 } }
);

agent.on("portConfirmed", (port) => console.log(`assigned port: ${port}`));
agent.on("rebound", ({ from, to }) => console.log(`rebound ${from} -> ${to}`));
agent.on("mappingFailed", (port, reason) => console.warn(`UPnP ${port}: ${reason}`));
agent.on("noPortAvailable", () => console.warn("no free port (capacity)"));
agent.on("startError", () => setTimeout(() => agent.start(), 5000));

await agent.start();

// the UPnP ports this node keeps mapped (its own assigned port is always added)
agent.setDesiredUpnpPorts([16127, 16126, 16128, 16129]);
// an app was just installed: map its port now rather than on the next pass
await agent.requestMap(31000, "Flux_App_example");
```

CommonJS:

```javascript
const { FluxNodeAgent } = require("@megachips/fluxport-controller");
```

### Constructor

```typescript
new FluxNodeAgent(outPoint: OutPoint, options?: FluxNodeAgentOptions)
```

`OutPoint` is `{ txhash: string; outidx: string }` — the node's collateral
outpoint, the stable port-ownership identity.

### Options

| Option | Default | Meaning |
|---|---|---|
| `multicastGroup` | `"239.112.233.123"` | Multicast group the consensus runs on |
| `port` | `16137` | UDP port the consensus uses (not the assigned port) |
| `ports` | `ALL_FLUXPORTS` | The assignable Fluxports (`[16197, 16187, …, 16127]`, exported) |
| `addressApis` | `ifconfig.me`, `checkip.amazonaws.com`, `api.ipify.org` | Public-IP lookup endpoints |
| `enableUpnp` | `true` | Run the `upnp` group |
| `upnpTiming` | `DEFAULT_UPNP_TIMING` | Consensus timing of the `upnp` group |
| `upnpTuning` | see below | The UPnP coordinator's settings |

`upnpTuning`:

| Field | Default | Meaning |
|---|---|---|
| `routerTestPort` | none | A port of this node's own that no app uses, for the lease and event tests. It must differ from every other node's behind the same router (FluxOS: api port + 3). Without it, mappings stay permanent and events are not used. |
| `eventPort` | none | The port this node listens on for the router's events. The node's firewall must let the gateway reach it. Without it, the leader reads the table on every turn. |
| `eventsSafetyNetMs` | `1800000` | The longest the leader goes without reading the table while it trusts events (capped at half the lease's renewal threshold) |
| `rate`, `capacity` | `0.5`/s, `4` | The group's write budget |
| `selfCheckCycleMs` | `300000` | The cycle a node checks its own ports on when the ring is not healthy |
| `tokenStallMs` | `240000` | No turn for this long means the ring is not healthy |

Every external dependency (`upnpClient`, `getPublicIp`, `resolveNodeInfo`,
`resolveLocalAddress`, `createTransport`, `clock`) and the consensus timing are
injectable through `options`; the test suite runs the whole flow over an
in-memory network with no sockets, UPnP or HTTP.

### Events

| Event | Payload | When |
|---|---|---|
| `portConfirmed` | `(port: number)` | This node holds a port |
| `routerIpConfirmed` | `(routerIp: string)` | The router's address was resolved |
| `noPortAvailable` | — | More nodes than ports on this segment |
| `startError` | — | Startup failed (e.g. UPnP discovery); `start()` can be called again |
| `rebound` | `({ from, to }: { from: string \| null; to: string })` | The socket was rebuilt; the port is confirmed again |
| `mappingFailed` | `(port: number, reason: string)` | A mapping write, delete or read failed; `port` is `-1` for a failed read of the whole table |
| `upnpEvents` | `(state: string, reason: string)` | The leader's use of the router's events changed: `testing`, `trusted` or `idle` |

### Methods and properties

- `start(): Promise<boolean>` — `true` once started, `false` on a start error
  (also emits `startError`).
- `stop(): void` — stops both groups and closes the socket.
- `setDesiredUpnpPorts(ports: number[])` — the full set of UPnP ports this node
  keeps mapped; each call replaces the last. Ports dropped from it are deleted.
- `requestMap(port, description?)` — add a port and map it now, still within the
  write budget.
- `getUpnpMappings()` — the router's table, read through the node's client.
- `nid`, `assignedPort`, `members`, `viewId` — the node's identity, its port and the
  `ports` view.
- `desiredUpnpPorts`, `upnpMode` (`LEADER_CHECK` / `SELF_CHECK`), `upnpIsLeader`,
  `upnpRate`, `upnpEvents` (`off` / `idle` / `testing` / `trusted`) — the UPnP
  coordinator's state.

### Consensus as a library

`Consensus` and `Group` are exported for other features that need ordered
agreement between the nodes on a LAN: `consensus.join(name, { config, hooks })`
returns a `Group` whose `broadcast(payload)` is delivered to every member's
`onDeliver` in the same order, with `onViewChange` on membership changes and
`onTokenGranted` on this node's turn.

## Performance

Time for a node to resolve its UPnP port, under the default timing. Measured two
ways — **pure consensus** (the in-memory virtual network: deterministic, no
sockets) and **end-to-end** (the Docker integration harness: real UPnP discovery
+ real multicast). The two agree within ~15%, so the cost is dominated by the
consensus itself, not the transport. Numbers are indicative (default timing,
≤10 ms per-message latency).

**Cold convergence** — all nodes start together; each ends up owning a distinct port:

| Nodes | Pure consensus | End-to-end (incl. UPnP) |
|------:|---------------:|------------------------:|
| 3     | ~1.4 s         | ~1.3 s                  |
| 5     | ~2.4 s         | ~2.1 s                  |
| 8     | ~4.4 s         | ~4.4 s                  |

**Other operations:**

| Operation | Time |
|---|---|
| A node joins an already-converged ring | ~2.1 s (3→4) … ~2.7 s (5→6) |
| Self-heal + port reclaim (LAN-IP change / membership loss) | ~2–4 s (gated by the 2 s token-loss timeout) |

- **Capacity: 8 nodes per LAN segment** — there are 8 Fluxports, so a 9th node
  converges to `noPortAvailable` and claims one the instant it frees.
- **What dominates** is discovery + membership cadence (`announceInterval` and
  `joinTimeout`, ~1 s each), not the token — a full token lap is sub-second
  (≈ N × 40 ms + latency). Lowering those intervals trades steady-state multicast
  chatter and loss margin for faster convergence.
- **Loss tolerance:** 8-node convergence holds ~100% up to 20% per-link packet
  loss, and ~95% at 30%.

## Development

```bash
npm run build          # tsc -> build/ (also runs on `prepare`, i.e. on publish)
npm run unittest       # unit and property tests (node:test/tsx)
npm run inttest        # integration tests: real multicast and a real miniupnpd (requires Docker)
npm run inttest:chaos  # the chaos scenarios only
npm run inttest:upnp   # the UPnP coordination scenarios only
```

The compiled `build/` output is produced on publish and is not committed.

## License

This software is licensed under the MIT License.

Copyright David White, 2023.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.
</content>
