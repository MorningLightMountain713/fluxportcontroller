/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
import { Socket } from "dgram";
import { EventEmitter } from "events";
import { AddressInfo } from "net";
import os from "os";
export declare class ServerError extends Error {
    constructor(msg: string);
}
export declare class FluxServer extends EventEmitter {
    MESSAGE_SEPARATOR: string;
    private readonly buff;
    readonly unhandledMessages: Set<string>;
    readonly sockets: Socket[];
    readonly interfaces: os.NetworkInterfaceInfo[];
    closed: boolean;
    constructor(options?: ServerOptions);
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
    messageHandler(socket: Socket, localAddress: string, socketData: Buffer, remote: AddressInfo): void;
    preparePayload(msg: any): Buffer;
    decodeMessages(id: string, data: Buffer): Message[];
    runSocketServer(iface: os.NetworkInterfaceInfo): Socket;
    removeSocketServer(socket: Socket, err?: Error): void;
}
