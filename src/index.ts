import { FluxPortManager as impFluxPortManager } from "./fluxport-controller/fluxPortManager";
import { logController as impLogController } from "./fluxport-controller/log";

namespace fluxportcontroller {
  export const FluxPortManager = impFluxPortManager;
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
export { logController } from "./fluxport-controller/log";

export default fluxportcontroller;
