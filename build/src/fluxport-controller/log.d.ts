import winston from "winston";
declare class GossipServerLogger {
    logger: winston.Logger;
    defaultConsole: winston.transports.ConsoleTransportInstance;
    constructor();
    getLogger(): winston.Logger;
    addLoggerTransport(type: LoggerType, options?: LoggerOptions): void;
}
declare const _default: GossipServerLogger;
export default _default;
type LoggerType = "file" | "console";
export interface LoggerOptions {
    filePath?: string;
    logLevel?: string;
}
