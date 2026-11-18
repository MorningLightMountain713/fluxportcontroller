/**
 * Builders shared by the UpnpCoordinator specs: a VirtualNetwork + ManualClock world
 * whose nodes run a real Consensus, and a coordinator over a freshly joined "upnp" group.
 */

import { VirtualNetwork } from "@/fluxport-controller/consensus/transport";
import { ManualClock } from "@/fluxport-controller/consensus/clock";
import { Consensus, Group } from "@/fluxport-controller/consensus/consensus";
import { MembershipConfig } from "@/fluxport-controller/consensus/membership";
import { UpnpClientLike } from "@/fluxport-controller/upnpClient";
import { UpnpCoordinator } from "@/fluxport-controller/upnp/upnpCoordinator";
import { RouterEvents } from "@/fluxport-controller/upnp/routerEvents";
import { EventWatchState } from "@/fluxport-controller/upnp/eventWatch";

const FAST_TIMING = {
  tokenRotationTarget: 5,
  tokenRetransmitTimeout: 60,
  maxTokenRetransmits: 5,
  tokenLossTimeout: 150,
  maxMessagesPerToken: 8,
  announceInterval: 20,
  joinInterval: 10,
  joinTimeout: 40,
  commitTimeout: 1000
};
// The "upnp" group config the coordinator drives. Token rotation is NOT faster than
// the announce cadence so a healthy baton lap reliably hears peer multicast — the
// condition the mode machine needs to reach K CONSECUTIVE clean laps. The timeout
// hierarchy (rotation ≪ retransmit < loss) is preserved.
export const cfg: MembershipConfig = {
  ...FAST_TIMING,
  tokenRotationTarget: 30,
  tokenRetransmitTimeout: 120,
  tokenLossTimeout: 300
};

/** `cfg` with every interval 20 times longer: a turn comes round about every second. */
export const slowCfg: MembershipConfig = {
  ...cfg,
  tokenRotationTarget: cfg.tokenRotationTarget * 20,
  tokenRetransmitTimeout: cfg.tokenRetransmitTimeout * 20,
  tokenLossTimeout: cfg.tokenLossTimeout * 20,
  announceInterval: cfg.announceInterval * 20,
  joinInterval: cfg.joinInterval * 20,
  joinTimeout: cfg.joinTimeout * 20,
  commitTimeout: cfg.commitTimeout * 20
};

/** Let the async repair's microtasks run after advancing the clock (deterministic). */
export const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

export function makeWorld() {
  const net = new VirtualNetwork();
  const clock = new ManualClock();
  const makeNode = (address: string): Consensus =>
    new Consensus(net.register(address), clock, {
      localAddress: address,
      resolveLocalAddress: async () => address,
      createTransport: (addr) => net.register(addr)
    });
  return { net, clock, makeNode };
}

/**
 * Build a coordinator over a freshly joined "upnp" group on the given node and
 * `start()` it (so the mode machine runs). Defaults are tuned for determinism under
 * ManualClock: a SHORT self-check cycle with ONE window (slot 0) so a lone /
 * not-yet-LEADER_CHECK node repairs on its slot during the tests' small clock advances,
 * and a LONG token-stall window so the no-baton watchdog never fires mid-test (the
 * demotion tests set it explicitly). `start: false` opts out of the lifecycle for the
 * tests that assert pre-start behaviour.
 */
export function makeCoordinator(
  c: Consensus,
  clock: ManualClock,
  opts: {
    self: string;
    localAddress: string;
    client: UpnpClientLike;
    rate?: number;
    capacity?: number;
    floorRate?: number;
    backoffFactor?: number;
    recoverFactor?: number;
    freshLaps?: number;
    enterLaps?: number;
    leaveLaps?: number;
    tokenStallMs?: number;
    selfCheckCycleMs?: number;
    selfCheckWindows?: number;
    orphanConfirmPasses?: number;
    ttl?: number;
    lowTtlThreshold?: number;
    routerTestPort?: number;
    events?: RouterEvents;
    eventsSafetyNetMs?: number;
    start?: boolean;
    onMappingFailed?: (port: number, reason: string) => void;
    onEventsStateChange?: (state: EventWatchState, reason: string) => void;
    config?: MembershipConfig;
  }
): { coordinator: UpnpCoordinator; group: Group } {
  const group = c.join("upnp", {
    config: opts.config ?? cfg,
    hooks: { onDeliver: () => {}, onViewChange: () => {} }
  });
  const coordinator = new UpnpCoordinator({
    self: opts.self,
    group,
    client: opts.client,
    clock,
    localAddress: opts.localAddress,
    rate: opts.rate ?? 1000, // ample by default; specific tests pin it down
    capacity: opts.capacity ?? 1000,
    floorRate: opts.floorRate,
    backoffFactor: opts.backoffFactor,
    recoverFactor: opts.recoverFactor,
    freshLaps: opts.freshLaps,
    enterLaps: opts.enterLaps,
    leaveLaps: opts.leaveLaps,
    tokenStallMs: opts.tokenStallMs ?? 1_000_000, // effectively off unless overridden
    selfCheckCycleMs: opts.selfCheckCycleMs ?? 10,
    selfCheckWindows: opts.selfCheckWindows ?? 1,
    orphanConfirmPasses: opts.orphanConfirmPasses,
    ttl: opts.ttl,
    lowTtlThreshold: opts.lowTtlThreshold,
    routerTestPort: opts.routerTestPort,
    events: opts.events,
    eventsSafetyNetMs: opts.eventsSafetyNetMs,
    hooks: { onMappingFailed: opts.onMappingFailed, onEventsStateChange: opts.onEventsStateChange }
  });
  if (opts.start !== false) coordinator.start();
  return { coordinator, group };
}
