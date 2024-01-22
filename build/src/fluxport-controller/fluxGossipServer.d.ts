/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
import { Socket } from "node:dgram";
import { AddressInfo } from "node:net";
import os from "node:os";
import { FluxServer, ServerOptions, Message } from "./fluxServer";
import { Client as UpnpClient } from "@megachips/nat-upnp";
export declare class FluxGossipServer extends FluxServer {
    private outPoint;
    MESSAGE_SEPARATOR: string;
    private readonly allFluxports;
    restartTimeout: NodeJS.Timeout | null;
    discoverTimeout: NodeJS.Timeout | null;
    portSelectTimeout: NodeJS.Timeout | null;
    adminTimeout: NodeJS.Timeout | null;
    pendingDiscoverId: string | null;
    pendingSelectId: string | null;
    private upnpServiceUrl;
    private localAddresses;
    myIp: string | null;
    private addressApis;
    portToNodeMap: Map<number, string>;
    state: State;
    networkState: NetworkState;
    private multicastGroup;
    private port;
    private startDelay;
    private firstResponderDelay;
    private responseTimeoutMultiplier;
    private responseTimeout;
    mode: ServerMode;
    msgLog: Message[] | null;
    observerMsgHistory: Record<string, AdminMessage[]> | null;
    observerNetworkStates: Record<string, NetworkState> | null;
    observerNodeCount: number | null;
    observerAckedPorts: Set<fluxPorts> | null;
    observerTestId: number;
    observerTestCount: number | null;
    observerLastTestFailed: boolean;
    upnpClient: UpnpClient;
    startedAt: number;
    constructor(outPoint: OutPoint, options?: GossipServerOptions);
    get ["portsAvailable"](): fluxPorts[];
    getMyPublicIp(): Promise<string>;
    start(): Promise<boolean>;
    stop(): void;
    /**
     * This is for the observer to send results to someone running tests. Only
     * run when mode is set to OBSERVER
     * @param port
     * The port to listen on
     */
    runAdminWebserver(port: number): void;
    runSocketServer(iface: os.NetworkInterfaceInfo): Socket;
    initiate(socket: FluxSocket, interfaceAddress: string, sendDiscover: boolean): Promise<void>;
    portConfirm(localAddress: string, sendPortSelectAck?: boolean): void;
    resetState(resetMsgLog?: boolean): void;
    fluxnodePriorPort(): Promise<number | null>;
    fluxportInUse(ip: string, port: number): Promise<boolean>;
    resetTimers(): void;
    sleep(ms: number): Promise<void>;
    updateState(localAddress: string, networkState: NetworkState): void;
    /**
     * Helper function to sort ip addresses. Nodes use this as a tiebreaker
     * when more than one node is discovering
     * @returns string[]
     * Array of all hosts sorted from lowest to highest IP
     */
    sortDiscoveringHosts(): string[];
    ipv4ToNumber(ipv4: string): number;
    getPortFromNode(nodeIp: string): fluxPorts | null;
    updatePortToNodeMap(): Promise<void>;
    createMessageFlows(): Record<string, Record<string, string[]>>;
    writeAdminResults(testId: number): void;
    writeDataToJsonFile(data: any): void;
    sendAdminDiscover(host: string): void;
    sendAdminDiscoverReply(srcHost: string, dstHost: string): void;
    sendAdminStart(localAddress: string): void;
    sendAdminReset(localAddress: string): void;
    sendMessageToSockets(msg: Message, options?: sendMessageOptions): void;
    adminStartHandler(socket: Socket, localAddress: string): Promise<void>;
    adminResetHandler(): void;
    adminDiscoverHandler(localAddress: string, remote: AddressInfo): Promise<void>;
    adminDiscoverReplyhandler(socket: Socket, localAddress: string, msg: AdminDiscoverReplyMessage): Promise<void>;
    messageHandler(socket: Socket, localAddress: string, socketData: Buffer, remote: AddressInfo): Promise<void>;
}
export default FluxGossipServer;
type fluxPorts = 16197 | 16187 | 16177 | 16167 | 16157 | 16147 | 16137 | 16127;
export type NodeState = "UNKNOWN" | "STARTING" | "DISCOVERING" | "SELECTING" | "READY";
export type ServerMode = "DEVELOPMENT" | "PRODUCTION" | "OBSERVE";
interface State {
    port: number | null;
    nodeState: NodeState;
}
export interface OutPoint {
    txhash: string;
    outidx: string;
}
type NetworkState = Record<string, State>;
interface FluxSocket extends Socket {
    /**
     * A switch so the server can determine if a call
     * to join the multicast group has already been completed
     */
    fluxGroupJoined?: boolean;
}
interface GossipServerOptions extends ServerOptions {
    upnpServiceUrl?: string;
    localAddress?: string;
    /**
     * Max random delay in seconds before starting server.
     * The delay will be between 0-startDelay seconds. If
     * delay is set to 0, node will start immediately.
     * (For testing purposes only) Default is 10s
     */
    startDelay?: number;
    /**
     * Max random delay in seconds before responding. Once,
     * the delay has been reached, if no other node has
     * responded, this node will respond. Default is 1s.
     */
    firstResponderDelay?: number;
    /**
     * Multiplier of firstResponderDelay. This is the amount
     * of time that nodes have to respond. Default is 3 times
     * the firstResponder delay, 3s.
     */
    responseTimeoutMultiplier?: number;
    /**
     * Array of urls for that return the calees ip address.
     * Must only return the ip address only in the response.
     */
    addressApis?: string[];
    /**
     * The multicast address used for flux communication. The
     * default is 239.112.233.123
     */
    multicastGroup?: string;
    /**
     * Server mode operation. Default is PRODUCTION. If DEVELOPMENT
     * is selected, nodes wait for commands from a master. This is
     * for testing message syncronization. OBSERVER mode is used to
     * monitor / command DEVELOPMENT nodes.
     */
    mode?: ServerMode;
    /**
     * The count of nodes under test. This only has meaning if mode is
     * set to OBSERVER. This is used to determine when tests are complete.
     */
    observerNodeCount?: number;
    /**
     * The amount of thimes to run the test
     */
    observerTestCount?: number;
}
interface AdminMessage extends Message {
    direction: string;
}
interface DiscoverReplyMessage extends Message {
    networkState: NetworkState;
}
interface PortSelectMessage extends Message {
    port: number;
}
interface sendMessageOptions {
    address?: string;
    addSeparators?: boolean;
}
interface AdminDiscoverReplyMessage extends Message {
    networkState: NetworkState;
    msgLog: AdminMessage[];
}
interface FluxGossipServerEvents {
    portConfirmed: (port: number) => void;
    upnpError: (message: string) => void;
    startError: () => void;
    routerIpConfirmed: (ip: string) => void;
}
export declare interface FluxGossipServer {
    on<U extends keyof FluxGossipServerEvents>(event: U, listener: FluxGossipServerEvents[U]): this;
    emit<U extends keyof FluxGossipServerEvents>(event: U, ...args: Parameters<FluxGossipServerEvents[U]>): boolean;
    sendDiscover(localAddress: string): string;
    sendDiscoverReply(localAdress: string, msgId: string): void;
    sendPortSelect(ifaceAddress: string, port: number): string;
    sendPortSelectAck(msgId: string, host: string, port: number): void;
    sendPortSelectNak(msgId: string, host: string, port: number): void;
    sendPayloadToSockets(payload: Buffer): void;
    /**
     * Handles a discover messsage. Upon receiving this message,
     * a node will wait a random period of time, as determined by the
     * firstResponderDelay parameter. If no one else
     * has handled the message at this time, then this node handles
     * it, by sending a DISCOVER REPLY
     * @param msg
     * The DISCOVER message received
     */
    discoverHandler(msg: Message): Promise<void>;
    /**
     * Handles a discover reply message. This only has meaning for a node
     * that is awaiting a discover reply. All other nodes ignore. Potentially
     * this should update the state too in case a discover message was missing.
     * Host field is the host of the origin message.
     *
     * @param socket
     * The socket this message was received on
     * @param localAddress
     * The address of the local socket
     * @param msg
     * The DISCOVER_REPLY message received
     *
     */
    discoverReplyHandler(socket: Socket, localAddress: string, msg: DiscoverReplyMessage): Promise<void>;
    /**
     * Handles a PORT_SELECT message. Upon reciept, a node will check what
     * ports are available, as determined by networkState. The node will then
     * wait a random period of time (firstResponderDelay) and if not handled by
     * another node, this node will either send a PORT_SELECT_ACK or PORT_SELECT_NAK
     * @param msg
     * The PORT_SELECT message received
     */
    portSelectHandler(msg: PortSelectMessage): Promise<void>;
    /**
     * Handles a PORT_SELECT_ACK message. Upon reciept, this node will
     * update state for the host in the message to READY. (this may be itself)
     * @param msg
     * The PORT_SELECT_ACK message received
     */
    portSelectAckHandler(localAddress: string, msg: PortSelectMessage): Promise<void>;
    /**
     * Handles a PORT_SELECT_NAK message. Upon receipt, the node will
     * check if this message was for itself, if so it restarts discovery
     * after 10 seconds. Otherwise, it will reset the nodeState
     * for the host in the message to DISCOVERING
     * @param socket
     * The socket the message was received on
     * @param localAddress
     * The local address of the socket
     * @param msg
     * The PORT_SELECT_NAK message received
     */
    portSelectNakHandler(socket: Socket, localAddress: string, msg: PortSelectMessage): Promise<void>;
    /**
     * Runs a upnp method and handles Errors. Will emit upnp error
     * upon error
     * @param upnpCall
     * A method from UpnpClient
     */
    runUpnpRequest(upnpCall: () => Promise<any>): Promise<any>;
    /**
     * This function does the heavy lifting. Based on the following assumptions:
     *  * Once a portmapping is set - another node cannot remove it, only the node that,
     *    set it can, or it expires.
     *  * If this node's txhash is found in the zelnode list, it must have rebooted / restarted
     *    etc, so we favor this port first.
     *  * If txhash is not found, we then look for a port mapping for this host for a fluxport
     *    on the router. If found, we then favor this port.
     *  * Finally, if none of the above happens, we then resort to the gossip server algo to
     *    figure out what port we want.
     *
     * Gossip server algo:
     *  * After getting a DISCOVER_REPLY, the network state is updated, and any ports that are
     *    in use are filtered, and the portsAvailable property generated. Any DISCOVERING nodes
     *    are sorted from lowest ip to highest, whatever this nodes index is in that list, is the
     *    index used to determine the selected port in the portsAvailable property.
     * @param socket
     * The socket used for this request
     * @param localAddress
     * The local address of the socket (same adress as what is used for UPnP)
     */
    portSelect(socket: Socket, localAddress: string): Promise<void>;
}
