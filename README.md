# fluxport-controller

Auto-assigns each Fluxnode a **unique UPnP port** with no router lock and no
FluxOS coupling. Nodes on the same LAN discover each other over multicast and
agree on a conflict-free port assignment via a Totem-style token-ring
atomic-broadcast consensus.

## How it works

`FluxPortManager` wires the real world onto a consensus stack:

- **UPnP discovery** (nat-upnp 2.x) finds the LAN interface to bind multicast on,
  and the router IP (emitted for observability).
- The **Flux deterministic node list** supplies this node's previously-confirmed
  port (sticky reuse) and its `confirmed_height`, used as the conflict priority —
  globally known and stable across restarts, so no local state is persisted.
- A **multicast transport** (link-local, TTL 1) carries the consensus, feeding a
  deterministic port allocator.

**Identity split:** the consensus ring is addressed by the node's **LAN IP**,
while port ownership is keyed by the node's **outpoint** (`txhash:outidx`). A node
therefore keeps its port across a LAN-IP change.

**Self-heal:** the multicast socket binds to the discovered LAN IP. If that IP
changes, or the group membership is lost at an unchanged IP (an interface
recreated under the node), the transport rebuilds and the node rejoins under the
same outpoint and reclaims its port — emitting `rebound`. Detection is
event-driven (a transport error, or the consensus collapsing to a lone ring); no
polling.

## Installation

```bash
npm i @megachips/fluxport-controller
```

## Usage

```javascript
import { FluxPortManager, logController } from "@megachips/fluxport-controller";

// optional: the logger is silent by default
logController.addLoggerTransport("console");

const manager = new FluxPortManager(
  // this node's collateral/confirmation outpoint
  { txhash: "334896be9aacb757de3e01633eba12b30198612513289223ca355d52137ba221", outidx: "0" },
  // options are optional; these are the defaults
  { multicastGroup: "239.112.233.123", port: 16137 }
);

manager.on("routerIpConfirmed", (ip) => console.log(`router: ${ip}`));
manager.on("portConfirmed", (port) => console.log(`assigned UPnP port: ${port}`));
manager.on("rebound", ({ from, to }) => console.log(`rebound ${from} -> ${to}`));
manager.on("noPortAvailable", () => console.warn("no free port (capacity)"));
manager.on("startError", () => setTimeout(() => manager.start(), 5000));

await manager.start();
```

CommonJS:

```javascript
const { FluxPortManager } = require("@megachips/fluxport-controller");
```

### Constructor

```typescript
new FluxPortManager(outPoint: OutPoint, options?: FluxPortManagerOptions)
```

`OutPoint` is `{ txhash: string; outidx: string }` — the Fluxnode's collateral
confirmation outpoint, used as the stable port-ownership identity.

### Options

| Option | Default | Meaning |
|---|---|---|
| `multicastGroup` | `"239.112.233.123"` | Multicast group the consensus runs on |
| `port` | `16137` | UDP port the consensus protocol communicates on (not the assigned port) |
| `ports` | `ALL_FLUXPORTS` | The set of assignable Fluxports (`[16197, 16187, …, 16127]`, exported) |
| `addressApis` | `ifconfig.me`, `checkip.amazonaws.com`, `api.ipify.org` | Public-IP lookup endpoints |

By default the manager reaches the internet to resolve this node's public IP and
its entry in the Flux deterministic list. Every external dependency
(`upnpClient`, `getPublicIp`, `resolveNodeInfo`, `resolveLocalAddress`,
`createTransport`, `clock`) plus the consensus timing is injectable via
`options` — used by the test suite to run the whole flow over an in-memory
network with no sockets, UPnP, or HTTP.

### Events

| Event | Payload | When |
|---|---|---|
| `portConfirmed` | `(port: number)` | This node has won/holds a port |
| `routerIpConfirmed` | `(routerIp: string)` | The router IP was resolved (observability) |
| `noPortAvailable` | — | More nodes than ports on this segment (capacity) |
| `startError` | — | Startup failed (e.g. UPnP discovery); safe to retry `start()` |
| `rebound` | `({ from, to }: { from: string \| null; to: string })` | The transport self-healed; the port is re-confirmed |

### Methods & properties

- `start(): Promise<boolean>` — resolves `true` once started, `false` on a start
  error (also emits `startError`).
- `stop(): void` — tear down the transport and consensus.
- `nid: string` — the ownership identity (`txhash:outidx`).
- `assignedPort: number | null` — the currently owned port.
- `members: string[]` — the current consensus view.
- `viewId: string | null` — the current ring id.

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
npm run unittest       # unit + property tests (node:test/tsx)
npm run inttest        # integration tests (requires Docker)
npm run inttest:chaos  # chaos scenarios only (requires Docker)
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
