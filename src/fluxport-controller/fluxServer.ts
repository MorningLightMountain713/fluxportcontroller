import { Socket } from "dgram";
import { EventEmitter } from "events";
import { AddressInfo } from "net";
import os from "os";

import { inspect } from "util";
import { logController } from "./log";

const logger = logController.getLogger();

export class ServerError extends Error {
  constructor(msg: string) {
    super(msg);

    Object.setPrototypeOf(this, ServerError.prototype);
  }
}

export class FluxServer extends EventEmitter {
  // overridden in child classes
  MESSAGE_SEPARATOR = "!FluxServer!";
  private readonly buff: Map<string, string> = new Map();

  readonly unhandledMessages: Set<string> = new Set();
  readonly sockets: Socket[] = [];
  readonly interfaces: os.NetworkInterfaceInfo[] = [];
  closed = false;

  constructor(options: ServerOptions = {}) {
    super();

    const availableInterfaces = os.networkInterfaces();
    if (options.bindInterface) {
      const intf = availableInterfaces[options.bindInterface];
      if (intf) {
        this.interfaces.push(...intf);
      } else {
        throw new ServerError("Bind interface not found");
      }
    } else {
      this.interfaces.push(
        ...Object.keys(availableInterfaces).reduce<os.NetworkInterfaceInfo[]>(
          (arr, key) =>
            arr.concat(
              availableInterfaces[key]?.filter(
                (item) => !item.internal && item.family == "IPv4"
              ) ?? []
            ),
          []
        )
      );
    }
    logger.debug(
      inspect(this.interfaces, { showHidden: false, depth: null, colors: true })
    );
  }

  start(): void {
    this.closed = false;
    this.sockets.push(this.runSocketServer(this.interfaces[0]));
  }

  runSocketServer(iface: os.NetworkInterfaceInfo): Socket {
    throw new Error("Not Implemented");
  }

  removeSocketServer(socket: Socket, err?: Error): void {
    if (err) {
      logger.error("Socket error:", err);
    }

    socket.close();
    this.sockets.splice(this.sockets.indexOf(socket), 1);
  }

  stop(): void {
    // idempotent
    if (!this.closed) {
      try {
        this.sockets.forEach((socket) => socket.close());
      } catch {
        // pass
      }
      this.sockets.length = 0;
      this.closed = true;
    }
  }

  preparePayload(msg: any, addSeparator: boolean = true): Buffer {
    const sep = addSeparator ? this.MESSAGE_SEPARATOR : "";
    return Buffer.from(sep + JSON.stringify(msg) + sep);
  }

  decodeMessages(id: string, data: Buffer): Message[] {
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

    if (
      this.buff.get(id) === "" &&
      !stringData.startsWith(this.MESSAGE_SEPARATOR)
    ) {
      logger.warn("Received a non standard message... discarding");
      logger.warn(inspect(stringData, { depth: null }));
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

    const parsedMessages: Message[] = [];
    for (const message of rawMessages) {
      try {
        parsedMessages.push(JSON.parse(message));
      } catch {
        logger.warn("Message parsing error:", message);
      }
    }

    return parsedMessages;
  }

  messageHandler(
    socket: Socket,
    localAddress: string,
    socketData: Buffer,
    remote: AddressInfo
  ): void {
    throw new Error("Not implemented");
  }

  generateId(): string {
    return Math.random().toString(36).substring(2, 9);
  }
}

export interface ServerOptions {
  port?: number;
  bindInterface?: string;
}

export interface Message {
  type: string;
  host: string;
  id: string;
}

export declare interface FluxServer {
  start(): void;
  stop(): void;
  generateId(): string;
  messageHandler(
    socket: Socket,
    localAddress: string,
    socketData: Buffer,
    remote: AddressInfo
  ): void;
  preparePayload(msg: any): Buffer;
  decodeMessages(id: string, data: Buffer): Message[];
  runSocketServer(iface: os.NetworkInterfaceInfo): Socket;
  removeSocketServer(socket: Socket, err?: Error): void;
}
