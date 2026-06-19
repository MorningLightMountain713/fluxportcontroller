import { FluxNodeAgent as impFluxNodeAgent } from "./fluxport-controller/fluxNodeAgent";
import { FluxPortManager as impFluxPortManager } from "./fluxport-controller/fluxPortManager";
import { Consensus as impConsensus } from "./fluxport-controller/consensus/consensus";
import { logController as impLogController } from "./fluxport-controller/log";

namespace fluxportcontroller {
  export const FluxNodeAgent = impFluxNodeAgent;
  export const FluxPortManager = impFluxPortManager;
  export const Consensus = impConsensus;
  export const logController = impLogController;
}

// The node-level composition root + public entry point.
export {
  FluxNodeAgent,
  ALL_FLUXPORTS
} from "./fluxport-controller/fluxNodeAgent";
export type { FluxNodeAgentOptions } from "./fluxport-controller/fluxNodeAgent";
// The port-allocation feature peer.
export { FluxPortManager } from "./fluxport-controller/fluxPortManager";
export type { OutPoint, NodeInfo } from "./fluxport-controller/nodeList";
// The reusable consensus surface: host named groups over one shared transport.
export { Consensus, Group } from "./fluxport-controller/consensus/consensus";
export type { GroupHooks, GroupOptions } from "./fluxport-controller/consensus/consensus";
export { logController } from "./fluxport-controller/log";

export default fluxportcontroller;
