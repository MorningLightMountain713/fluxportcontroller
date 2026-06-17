import { FluxPortManager as impFluxPortManager } from "./fluxport-controller/fluxPortManager";
import { Consensus as impConsensus } from "./fluxport-controller/consensus/consensus";
import { logController as impLogController } from "./fluxport-controller/log";

namespace fluxportcontroller {
  export const FluxPortManager = impFluxPortManager;
  export const Consensus = impConsensus;
  export const logController = impLogController;
}

export {
  FluxPortManager,
  ALL_FLUXPORTS
} from "./fluxport-controller/fluxPortManager";
export type {
  OutPoint,
  NodeInfo,
  FluxPortManagerOptions
} from "./fluxport-controller/fluxPortManager";
// The reusable consensus surface: host named groups over one shared transport.
export { Consensus, Group } from "./fluxport-controller/consensus/consensus";
export type { GroupHooks, GroupOptions } from "./fluxport-controller/consensus/consensus";
export { logController } from "./fluxport-controller/log";

export default fluxportcontroller;
