import winston from "winston";

const { combine, timestamp, label, printf } = winston.format;

const formatter = printf(({ level, message, label, timestamp }) => {
  return `${timestamp} [${label}] ${level}: ${message}`;
});

class GossipServerLogger {
  logger: winston.Logger;
  defaultConsole: winston.transports.ConsoleTransportInstance;

  constructor() {
    this.logger = winston.createLogger({
      silent: true,
      format: combine(label({ label: "fpc" }), timestamp(), formatter)
    });
    this.defaultConsole = new winston.transports.Console({
      level: "info"
      // format: winston.format.simple()
    });

    this.logger.add(this.defaultConsole);
  }

  getLogger(): winston.Logger {
    return this.logger;
  }

  addLoggerTransport(type: LoggerType, options: LoggerOptions = {}) {
    const level = options.logLevel || "info";

    this.logger.silent = false;

    if (type === "file") {
      // add error handling
      this.logger.add(
        new winston.transports.File({
          level: level,
          filename: options.filePath
        })
      );
    } else if (type === "console") {
      this.defaultConsole.level = level || this.defaultConsole.level;
    }
  }
}

export const logController = new GossipServerLogger();

type LoggerType = "file" | "console";

export interface LoggerOptions {
  filePath?: string;
  logLevel?: string;
}
