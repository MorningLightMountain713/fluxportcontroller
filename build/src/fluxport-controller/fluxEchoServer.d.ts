/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
import { Socket } from "dgram";
import { AddressInfo } from "net";
import os from "os";
import { FluxServer, ServerOptions, Message } from "./fluxServer";
export declare enum Msg {
    PING = 0,
    PING_NAK = 1,
    PONG = 2
}
declare class TwoWayMap extends Map {
    revMap: Map<any, any>;
    constructor();
    set(key: any, value: any): this;
    getByValue(value: any): any;
    delete(key: any): boolean;
    deleteByValue(value: any): boolean;
}
export declare class FluxEchoServer extends FluxServer {
    MESSAGE_SEPARATOR: string;
    inbound: Record<string, Partial<Peer>>;
    outbound: Record<string, Peer>;
    transitions: TwoWayMap;
    private readonly port;
    private readonly pingInterval;
    private readonly maxMissedPings;
    private readonly maxTimeoutCount;
    private readonly bindAddress;
    private lastPingAction;
    constructor(options?: EchoServerOptions);
    addTransition(from: string, to: string): void;
    addPeer(peerAddress: string, direction: Dir, options?: {
        connect?: boolean;
        activeSince?: number;
    }): void;
    get ["peerAddresses"](): string[];
    get ["inboundPeerAddresses"](): string[];
    get ["outboundPeerAddresses"](): string[];
    get ["peerCount"](): number;
    get ["inboundPeerCount"](): number;
    get ["outboundPeerCount"](): number;
    sortHosts(toSort: string[]): string[];
    /**
     * If the node is a peer of this node and hasn't missed any pings
     * @param peer
     * @returns boolean
     */
    peerAvailable(peer: string): boolean;
    removePeer(peer: string, options?: {
        active?: boolean;
        inbound?: boolean;
    }): void;
    logPeers(): void;
    start(): void;
    runSocketServer(iface: os.NetworkInterfaceInfo): Socket;
    messageHandler(socket: Socket, localAddress: string, socketData: Buffer, remote: AddressInfo): void;
    pingHandler(socket: Socket, localAddress: string, msg: Message, remoteAddress: string): Promise<void>;
    pongHandler(msg: Message, peer: string): void;
    pingNakHandler(msg: Message, peer: string): void;
    sendPing(socket: Socket, peer: string): Promise<void>;
    sendPong(socket: Socket, localAddress: string, msgId: string, multicastGroup: string): void;
    sendPingNak(socket: Socket, localAddress: string, msgId: string, multicastGroup: string): void;
    sendMessageToSocket(msg: Message, socket: Socket, multicastGroup: string): void;
}
export interface EchoServerOptions extends ServerOptions {
    peers?: string[];
    interval?: number;
    maxMissedPings?: number;
    maxTimeoutCount?: number;
    bindAddress?: string;
}
export declare enum Dir {
    INBOUND = 0,
    OUTBOUND = 1
}
interface Peer {
    pingTimer: NodeJS.Timeout | null;
    messageTimeouts: Map<string, NodeJS.Timeout>;
    missedPingCount: number;
    timeoutCount: number;
    activeSince: number;
}
interface FluxEchoServerEvents {
    peerTimeout: (peer: string, seconds: number) => void;
    peerReconnected: (peer: string) => void;
    peerRemoved: (peer: string, direction: Dir) => void;
    peerConnected: (peer: string, direction: Dir) => void;
    peerRejected: (peer: string) => void;
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
