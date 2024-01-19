import { FluxGossipServer as impFluxGossipServer } from "./fluxport-controller/fluxGossipServer";
import { FluxEchoServer as impFluxEchoServer } from "./fluxport-controller/fluxEchoServer";
declare namespace fluxportcontroller {
    const FluxGossipServer: typeof impFluxGossipServer;
    const FluxEchoServer: typeof impFluxEchoServer;
}
export { FluxGossipServer, ServerMode } from "./fluxport-controller/fluxGossipServer";
export { FluxEchoServer } from "./fluxport-controller/fluxEchoServer";
export default fluxportcontroller;
