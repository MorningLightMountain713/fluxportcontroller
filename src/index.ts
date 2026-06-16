import { FluxGossipServer as impFluxGossipServer } from "./fluxport-controller/fluxGossipServer";
import { FluxEchoServer as impFluxEchoServer } from "./fluxport-controller/fluxEchoServer";
import { FluxPortManager as impFluxPortManager } from "./fluxport-controller/fluxPortManager";
import { logController as impLogController } from "./fluxport-controller/log";

namespace fluxportcontroller {
  export const FluxGossipServer = impFluxGossipServer;
  export const FluxEchoServer = impFluxEchoServer;
  // Token-ring consensus port manager (the supported entry point; the legacy
  // FluxGossipServer is retained until the harness is reworked).
  export const FluxPortManager = impFluxPortManager;
  export const logController = impLogController;
}

export {
  FluxGossipServer,
  ServerMode
} from "./fluxport-controller/fluxGossipServer";

export { FluxEchoServer } from "./fluxport-controller/fluxEchoServer";
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
