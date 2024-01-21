"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logController = void 0;
const winston_1 = __importDefault(require("winston"));
class GossipServerLogger {
    logger;
    defaultConsole;
    constructor() {
        this.logger = winston_1.default.createLogger({ silent: true });
        this.defaultConsole = new winston_1.default.transports.Console({
            level: "info",
            format: winston_1.default.format.simple()
        });
        this.logger.add(this.defaultConsole);
    }
    getLogger() {
        return this.logger;
    }
    addLoggerTransport(type, options = {}) {
        const level = options.logLevel || "info";
        this.logger.silent = false;
        if (type === "file") {
            // add error handling
            this.logger.add(new winston_1.default.transports.File({
                level: level,
                filename: options.filePath
            }));
        }
        else if (type === "console") {
            this.defaultConsole.level = level || this.defaultConsole.level;
        }
    }
}
exports.logController = new GossipServerLogger();
