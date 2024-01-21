import { FluxGossipServer as impFluxGossipServer } from "./fluxport-controller/fluxGossipServer";
import { FluxEchoServer as impFluxEchoServer } from "./fluxport-controller/fluxEchoServer";
import * as impLogController from "./fluxport-controller/log";

namespace fluxportcontroller {
  export const FluxGossipServer = impFluxGossipServer;
  export const FluxEchoServer = impFluxEchoServer;
  export const LogController = impLogController;
}

export {
  FluxGossipServer,
  ServerMode
} from "./fluxport-controller/fluxGossipServer";
export { FluxEchoServer } from "./fluxport-controller/fluxEchoServer";
export * as logController from "./fluxport-controller/log";

export default fluxportcontroller;
