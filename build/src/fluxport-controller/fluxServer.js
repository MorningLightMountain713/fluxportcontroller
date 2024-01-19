"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FluxServer = exports.ServerError = void 0;
const events_1 = require("events");
const os_1 = __importDefault(require("os"));
const util_1 = require("util");
const log_1 = __importDefault(require("./log"));
class ServerError extends Error {
    constructor(msg) {
        super(msg);
        Object.setPrototypeOf(this, ServerError.prototype);
    }
}
exports.ServerError = ServerError;
class FluxServer extends events_1.EventEmitter {
    MESSAGE_SEPARATOR = "!FluxServer!";
    buff = new Map();
    unhandledMessages = new Set();
    sockets = [];
    interfaces = [];
    closed = false;
    constructor(options = {}) {
        super();
        const availableInterfaces = os_1.default.networkInterfaces();
        if (options.bindInterface) {
            const intf = availableInterfaces[options.bindInterface];
            if (intf) {
                this.interfaces.push(...intf);
            }
            else {
                throw new ServerError("Bind interface not found");
            }
        }
        else {
            this.interfaces.push(...Object.keys(availableInterfaces).reduce((arr, key) => arr.concat(availableInterfaces[key]?.filter((item) => !item.internal && item.family == "IPv4") ?? []), []));
        }
        log_1.default.debug(this.interfaces);
    }
    start() {
        // for (const intf of this.interfaces) {
        //   this.sockets.push(this.runSocketServer(intf));
        // }
        this.sockets.push(this.runSocketServer(this.interfaces[0]));
    }
    runSocketServer(iface) {
        throw new Error("Not Implemented");
    }
    removeSocketServer(socket, err) {
        if (err) {
            log_1.default.error("Socket error:", err);
        }
        socket.close();
        this.sockets.splice(this.sockets.indexOf(socket), 1);
    }
    stop() {
        this.closed = true;
        this.sockets.forEach((socket) => socket.close());
        this.sockets.length = 0;
    }
    preparePayload(msg, addSeparator = true) {
        const sep = addSeparator ? this.MESSAGE_SEPARATOR : "";
        return Buffer.from(sep + JSON.stringify(msg) + sep);
    }
    decodeMessages(id, data) {
        // could set decoding
        // this probably needs a bit of work, some edgecases it
        // will fail
        // maybe strip newlines from message endings
        let stringData = data.toString();
        // if the id hasn't been created, create it
        !this.buff.has(id) && this.buff.set(id, "");
        // Shouldn't ever get a message start with a message seperator
        // when there is a buffer, if so - we lost it, so discard.
        // What about edge case where message starts with 2 separators?
        if (this.buff.get(id) && stringData.startsWith(this.MESSAGE_SEPARATOR)) {
            this.buff.set(id, "");
        }
        if (this.buff.get(id) === "" &&
            !stringData.startsWith(this.MESSAGE_SEPARATOR)) {
            log_1.default.warn("Received a non standard message... discarding");
            log_1.default.warn((0, util_1.inspect)(stringData, { depth: null }));
            return [];
        }
        if (!stringData.endsWith(this.MESSAGE_SEPARATOR)) {
            this.buff.set(id, this.buff.get(id) + stringData);
            return [];
        }
        // we should have a full message by now
        if (this.buff.get(id)) {
            stringData = this.buff.get(id) + stringData;
            this.buff.set(id, "");
        }
        let rawMessages = stringData.split(this.MESSAGE_SEPARATOR);
        rawMessages = rawMessages.filter((m) => m); // strip empty strings
        const parsedMessages = [];
        for (const message of rawMessages) {
            try {
                parsedMessages.push(JSON.parse(message));
            }
            catch {
                log_1.default.warn("Message parsing error:", message);
            }
        }
        return parsedMessages;
    }
    messageHandler(socket, localAddress, socketData, remote) {
        throw new Error("Not implemented");
    }
    generateId() {
        return Math.random().toString(36).substring(2, 9);
    }
}
exports.FluxServer = FluxServer;
