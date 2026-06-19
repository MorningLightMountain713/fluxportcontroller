/**
 * Port-allocation feature peer: drives a `PortAllocator` over an already-joined
 * consensus `Group`. It owns NO node-level concerns — the UPnP client, node-list /
 * public-IP fetch, the shared `Consensus` socket and its self-heal seams all live in
 * `FluxNodeAgent`, the composition root that constructs this peer. Here we just wire
 * the allocator to the injected group and surface its outcome (the held port, the
 * current members/view) plus its `onPortConfirmed` / `onWaiting` callbacks.
 *
 * The persistent allocator's sticky preference reclaims the held port on a rejoin,
 * so a node keeps its port across a self-heal rebuild (driven by the agent).
 */

import { Group } from "./consensus/consensus";
import {
  PortAllocator,
  PortAllocatorConfig
} from "./consensus/portAllocator";

export interface FluxPortManagerHooks {
  onPortConfirmed: (port: number) => void;
  onWaiting: () => void;
}

export interface FluxPortManagerDeps {
  /** Transport address (ring identity); the allocator's `self`. */
  self: string;
  /** The already-joined `ports` group the allocator drives. */
  group: Group;
  config: PortAllocatorConfig;
  hooks: FluxPortManagerHooks;
}

export class FluxPortManager {
  private readonly allocator: PortAllocator;

  constructor(deps: FluxPortManagerDeps) {
    this.allocator = new PortAllocator({
      self: deps.self,
      config: deps.config,
      group: deps.group,
      hooks: {
        onPortConfirmed: deps.hooks.onPortConfirmed,
        onWaiting: deps.hooks.onWaiting
      }
    });
  }

  get assignedPort(): number | null {
    return this.allocator.port;
  }
  get members(): string[] {
    return this.allocator.currentMembers;
  }
  get viewId(): string | null {
    return this.allocator.viewId;
  }
}
