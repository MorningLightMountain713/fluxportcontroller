import { FluxGossipServer as impFluxGossipServer } from "./fluxport-controller/fluxGossipServer";
import { FluxEchoServer as impFluxEchoServer } from "./fluxport-controller/fluxEchoServer";
import * as impLogController from "./fluxport-controller/log";
declare namespace fluxportcontroller {
    const FluxGossipServer: typeof impFluxGossipServer;
    const FluxEchoServer: typeof impFluxEchoServer;
    const LogController: typeof impLogController;
}
export { FluxGossipServer, ServerMode } from "./fluxport-controller/fluxGossipServer";
export { FluxEchoServer } from "./fluxport-controller/fluxEchoServer";
export * as logController from "./fluxport-controller/log";
export default fluxportcontroller;
