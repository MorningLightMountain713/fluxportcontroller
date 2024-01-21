import { FluxGossipServer as impFluxGossipServer } from "./fluxport-controller/fluxGossipServer";
import { FluxEchoServer as impFluxEchoServer } from "./fluxport-controller/fluxEchoServer";
declare namespace fluxportcontroller {
    const FluxGossipServer: typeof impFluxGossipServer;
    const FluxEchoServer: typeof impFluxEchoServer;
    const logController: {
        logger: import("winston").Logger;
        defaultConsole: import("winston/lib/winston/transports").ConsoleTransportInstance;
        getLogger(): import("winston").Logger;
        addLoggerTransport(type: "file" | "console", options?: import("./fluxport-controller/log").LoggerOptions): void;
    };
}
export { FluxGossipServer, ServerMode } from "./fluxport-controller/fluxGossipServer";
export { FluxEchoServer } from "./fluxport-controller/fluxEchoServer";
export { logController } from "./fluxport-controller/log";
export default fluxportcontroller;
