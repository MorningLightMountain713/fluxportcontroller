import { FluxGossipServer as impFluxGossipServer } from "./fluxport-controller/fluxGossipServer";
import { FluxEchoServer as impFluxEchoServer } from "./fluxport-controller/fluxEchoServer";

namespace fluxportcontroller {
  export const FluxGossipServer = impFluxGossipServer;
  export const FluxEchoServer = impFluxEchoServer;
}

export {
  FluxGossipServer,
  ServerMode
} from "./fluxport-controller/fluxGossipServer";
export { FluxEchoServer } from "./fluxport-controller/fluxEchoServer";

export default fluxportcontroller;
