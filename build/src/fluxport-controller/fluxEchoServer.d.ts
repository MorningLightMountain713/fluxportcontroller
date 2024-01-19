/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
import { Socket } from "dgram";
import { AddressInfo } from "net";
import os from "os";
import { FluxServer, ServerOptions, Message } from "./fluxServer";
export declare class FluxEchoServer extends FluxServer {
    MESSAGE_SEPARATOR: string;
    private readonly peers;
    private readonly port;
    private readonly pingInterval;
    private readonly maxMissed;
    constructor(options?: EchoServerOptions);
    addPeer(peerAddress: string): void;
    removePeer(peer: string): void;
    runSocketServer(iface: os.NetworkInterfaceInfo): Socket;
    messageHandler(socket: Socket, localAddress: string, socketData: Buffer, remote: AddressInfo): void;
    pingHandler(socket: Socket, msg: Message, remoteAddress: string): void;
    pongHandler(msg: Message, peer: string): void;
    sendPing(socket: Socket, peer: string): void;
    sendPong(socket: Socket, msgId: string, multicastGroup: string): void;
    sendMessageToSocket(payload: Buffer, socket: Socket, multicastGroup: string): void;
}
export interface EchoServerOptions extends ServerOptions {
    peers?: string[];
    interval?: number;
    maxMissed?: number;
}
interface FluxEchoServerEvents {
    timeout: (peer: string, seconds: number) => void;
}
export declare interface FluxEchoServer {
    on<U extends keyof FluxEchoServerEvents>(event: U, listener: FluxEchoServerEvents[U]): this;
    emit<U extends keyof FluxEchoServerEvents>(event: U, ...args: Parameters<FluxEchoServerEvents[U]>): boolean;
    initiate(socket: Socket, multicastGroup: string, interfaceAddress: string): void;
    echoHandler(msg: Message): void;
    sendEcho(socket: Socket, multicastGroup: string): void;
    sendPayloadToSocket(payload: Buffer, socket: Socket, multicastGroup: string): void;
}
export {};
