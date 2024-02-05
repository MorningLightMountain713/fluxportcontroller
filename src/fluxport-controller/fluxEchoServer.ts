import dgram, { Socket } from "dgram";
import { AddressInfo } from "net";
import os from "os";
import { FluxServer, ServerOptions, Message } from "./fluxServer";

import { logController } from "./log";

import { inspect } from "util";

const logger = logController.getLogger();
const INSPECT_OPTIONS = { showHidden: false, depth: null, colors: true };

export enum Msg {
  PING,
  PING_NAK,
  PONG
}

class TwoWayMap extends Map {
  revMap: Map<any, any>;

  // skip being able to init by constructor
  constructor() {
    super();
    this.revMap = new Map();
  }

  set(key: any, value: any): this {
    this.revMap.set(value, key);
    return super.set(key, value);
  }

  getByValue(value: any): any {
    return this.revMap.get(value);
  }

  delete(key: any): boolean {
    const value = this.get(key);
    this.revMap.delete(value);
    return super.delete(key);
  }

  deleteByValue(value: any): boolean {
    const key = this.revMap.get(value);
    if (key) {
      this.revMap.delete(value);
      return this.delete(key);
    }
    return false;
  }
}

export class FluxEchoServer extends FluxServer {
  MESSAGE_SEPARATOR = "^#!@!#^";
  inbound: Record<string, Partial<Peer>> = {};
  outbound: Record<string, Peer> = {};
  transitions: TwoWayMap = new TwoWayMap();
  private readonly port: number;
  private readonly pingInterval: number; // seconds
  private readonly maxMissedPings: number;
  private readonly maxTimeoutCount: number;
  private readonly bindAddress: string | null;
  private lastPingAction: number = 0;

  constructor(options: EchoServerOptions = {}) {
    super();

    if (options.peers) {
      options.peers.forEach((peer) =>
        this.addPeer(peer, Dir.OUTBOUND, { connect: false })
      );
    }

    this.port = options.port || 16137;
    this.pingInterval = options.interval || 8;
    this.maxMissedPings = options.maxMissedPings || 3;
    this.maxTimeoutCount = options.maxTimeoutCount || 3;
    this.bindAddress = options.bindAddress || null;

    logger.info(inspect(this.interfaces, INSPECT_OPTIONS));
  }

  addTransition(from: string, to: string) {
    this.transitions.set(to, from);
  }

  addPeer(
    peerAddress: string,
    direction: Dir,
    options: { connect?: boolean; activeSince?: number } = {}
  ) {
    const activeSince = options.activeSince || 0;
    const connect = options.connect === false ? false : true;

    if (direction === Dir.OUTBOUND) {
      this.outbound[peerAddress] = {
        pingTimer: null,
        messageTimeouts: new Map(),
        missedPingCount: 0,
        timeoutCount: 0,
        activeSince: activeSince
      };
    } else {
      this.inbound[peerAddress] = {
        activeSince: activeSince
      };
    }

    console.log("Added peer", peerAddress, "DIRECTION", Dir[direction]);

    if (!connect || direction === Dir.INBOUND) return;

    // this only works with one socket, probably change this up a little, make multisocket
    for (const socket of this.sockets) {
      this.sendPing(socket, peerAddress);
      this.outbound[peerAddress].pingTimer = setInterval(
        () => this.sendPing(socket, peerAddress),
        this.pingInterval * 1000
      );
    }
  }

  get ["peerAddresses"](): string[] {
    return Array.from(
      new Set([...this.outboundPeerAddresses, ...this.inboundPeerAddresses])
    );
  }

  get ["inboundPeerAddresses"](): string[] {
    return this.sortHosts(Object.keys(this.inbound));
  }

  get ["outboundPeerAddresses"](): string[] {
    return this.sortHosts(Object.keys(this.outbound));
  }

  // get ["inboundPeerAddresses"](): string[] {
  //   return Object.keys(
  //     this.filter(this.outbound, ([_, peer]) => peer.direction === Dir.INBOUND)
  //   );
  // }

  // get ["outboundPeerAddresses"](): string[] {
  //   return Object.keys(
  //     this.filter(this.outbound, ([_, connections]) =>
  //       connections.some((con) => con.direction === Dir.OUTBOUND)
  //     )
  //   );
  // }

  // get ["outboundPeerAddresses"](): string[] {
  //   return Object.keys(
  //     this.filter(this.outbound, ([_, peer]) => peer.direction === Dir.OUTBOUND)
  //   );
  // }

  get ["peerCount"](): number {
    return this.inboundPeerCount + this.outboundPeerCount;
  }

  get ["inboundPeerCount"](): number {
    return this.inboundPeerAddresses.length;
  }

  get ["outboundPeerCount"](): number {
    return this.outboundPeerAddresses.length;
  }

  sortHosts(toSort: string[]): string[] {
    toSort.sort((a, b) => {
      const numA = this.ipv4ToNumber(a);
      const numB = this.ipv4ToNumber(b);
      return numA - numB;
    });
    return toSort;
  }

  /**
   * If the node is a peer of this node and hasn't missed any pings
   * @param peer
   * @returns boolean
   */
  peerAvailable(peer: string): boolean {
    return this.outbound[peer] && this.outbound[peer].missedPingCount === 0;
  }

  removePeer(
    peer: string,
    options: { active?: boolean; inbound?: boolean } = {}
  ) {
    console.log("REMOVING PEER:", peer);

    // if we're removing the outbound... we remove the inbound too
    if (this.inbound[peer]) {
      delete this.inbound[peer];
      this.emit("peerRemoved", peer, Dir.INBOUND);
    }

    if (options.inbound) {
      return;
    }

    const active = options.active === false ? false : true;

    if (this.outbound[peer].pingTimer) {
      clearInterval(this.outbound[peer].pingTimer!);
    }
    for (const timeout of this.outbound[peer].messageTimeouts.values()) {
      clearTimeout(timeout);
    }
    delete this.outbound[peer];
    if (active) {
      this.emit("peerRemoved", peer, Dir.OUTBOUND);
    }
  }

  initiate(
    socket: Socket,
    multicastGroup: string,
    interfaceAddress: string
  ): void {
    socket.setMulticastTTL(1);
    logger.info(`Joining multicast group: ${multicastGroup}`);
    socket.addMembership(multicastGroup, interfaceAddress);

    for (const [peerName, peerData] of Object.entries(this.outbound)) {
      this.sendPing(socket, peerName);
      peerData.pingTimer = setInterval(
        () => this.sendPing(socket, peerName),
        this.pingInterval * 1000
      );
    }
    this.logPeers();
    setInterval(() => {
      this.logPeers();
    }, 10 * 1000);
  }

  logPeers() {
    logger.info(`Inbound peers: ${this.inboundPeerCount}`);
    logger.info(`Outbound peers: ${this.outboundPeerCount}`);
    logger.info(`All peers: ${this.peerCount}`);
  }

  start(): void {
    this.closed = false;
    let bindInterface;

    if (this.bindAddress) {
      bindInterface = this.interfaces.find(
        (int) => int.address === this.bindAddress
      );
    } else {
      bindInterface = this.interfaces[0];
    }

    this.sockets.push(this.runSocketServer(bindInterface!));
  }

  runSocketServer(iface: os.NetworkInterfaceInfo): Socket {
    const socket: Socket = dgram.createSocket("udp4");
    // split the ip on the first dot. I.e 172.16.33.10 hostPart = 16.33.10
    const [_, hostPart] = iface.address.split(/\.(.*)/);
    const echoMulticastGroup = `239.${hostPart}`;

    socket.on("message", (data, remote) =>
      this.messageHandler(socket, iface.address, data, remote)
    );
    socket.on("listening", () =>
      this.initiate(socket, echoMulticastGroup, iface.address)
    );
    socket.once("error", (err) => this.removeSocketServer(socket, err));

    logger.info(`Echo Server binding to ${this.port} on ${iface.address}`);
    // this will receive on multicast address only, not iface.address
    // (if you specify iface.address on bind it will listen on both)
    socket.bind(this.port, echoMulticastGroup);

    return socket;
  }

  messageHandler(
    socket: Socket,
    localAddress: string,
    socketData: Buffer,
    remote: AddressInfo
  ): void {
    if (this.closed) return;

    const messages = this.decodeMessages(remote.address, socketData);
    for (const msg of messages) {
      this.unhandledMessages.add(msg.id);
      logger.info(`Message: ${Msg[msg.type]} received from: ${remote.address}`);
      switch (msg.type) {
        case Msg.PING:
          this.pingHandler(socket, localAddress, msg, remote.address);
          break;
        case Msg.PONG:
          this.pongHandler(msg, remote.address);
          break;
        case Msg.PING_NAK:
          this.pingNakHandler(msg, remote.address);
          break;
        default:
          logger.info(
            `Received an unknown message of type: ${msg.type}, ignoring`
          );
      }
    }
  }

  async pingHandler(
    socket: Socket,
    localAddress: string,
    msg: Message,
    remoteAddress: string
  ) {
    // TRANSITION
    const [_, hostPart] = remoteAddress.split(/\.(.*)/);
    const peerMulticastGroup = `239.${hostPart}`;

    if (this.transitions.size) {
      const to = this.transitions.getByValue(remoteAddress);

      if (to && this.inboundPeerAddresses.includes(to)) {
        console.log("transition complete");
        this.sendPingNak(socket, localAddress, msg.id, peerMulticastGroup);
        this.removePeer(remoteAddress, { inbound: true });
        this.transitions.delete(to);
        return;
      }
    }

    if (!this.inboundPeerAddresses.includes(remoteAddress)) {
      console.log("NEW PING RECEIVED FROM:", remoteAddress);
      const transitionRequired = this.transitions.get(remoteAddress);
      console.log("transitions", this.transitions);
      if (this.inboundPeerCount >= 2 && !transitionRequired) {
        logger.info(
          `Max inbound peer count reached. Rejecting: ${remoteAddress}`
        );
        this.sendPingNak(socket, localAddress, msg.id, peerMulticastGroup);
        return;
      }
      this.addPeer(remoteAddress, Dir.INBOUND, { activeSince: Date.now() });
      this.emit("peerConnected", remoteAddress, Dir.INBOUND);
    }

    this.sendPong(socket, localAddress, msg.id, peerMulticastGroup);
  }

  pongHandler(msg: Message, peer: string): void {
    if (this.outbound[peer].missedPingCount > 0) {
      for (const timeout of this.outbound[peer].messageTimeouts.values()) {
        clearTimeout(timeout);
      }
      this.outbound[peer].timeoutCount = 0;
      this.outbound[peer].missedPingCount = 0;
      this.outbound[peer].messageTimeouts.clear();
      this.emit("peerReconnected", peer);
    } else if (this.outbound[peer].messageTimeouts.has(msg.id)) {
      const timeoutId = this.outbound[peer].messageTimeouts.get(msg.id);
      clearTimeout(timeoutId);
      this.outbound[peer].messageTimeouts.delete(msg.id);
    }
    if (!this.outbound[peer].activeSince) {
      this.outbound[peer].activeSince = Date.now();
      this.emit("peerConnected", peer, Dir.OUTBOUND);
    }
  }

  pingNakHandler(msg: Message, peer: string): void {
    // don't emit peer removed if it wasn't active
    console.log("PING NAK RECEIVED:", peer);
    this.removePeer(peer, { active: false });
    this.emit("peerRejected", peer);
  }

  async sendPing(socket: Socket, peer: string): Promise<void> {
    const [_, hostPart] = peer.split(/\.(.*)/);
    const peerMulticastGroup = `239.${hostPart}`;

    // just use modulo here
    if (this.outbound[peer].missedPingCount >= this.maxMissedPings) {
      this.outbound[peer].timeoutCount++;

      const culmulative =
        this.outbound[peer].timeoutCount *
        this.pingInterval *
        this.maxMissedPings;
      this.emit("peerTimeout", peer, culmulative);
      this.outbound[peer].missedPingCount = 0;

      if (this.outbound[peer].timeoutCount >= this.maxTimeoutCount) {
        this.removePeer(peer);
        return;
      }

      for (const timeoutId of this.outbound[peer].messageTimeouts.values()) {
        clearTimeout(timeoutId);
      }
      this.outbound[peer].messageTimeouts.clear();

      // emit interupts the flow here - which could trigger a peerRemoval,
      // If so - we give up
      if (!this.outbound[peer]) return;
    }

    const localAddress = socket.address().address;
    const msgId = this.generateId();
    // localAddress is the multicast group 239.x.x.x
    const msg = { type: Msg.PING, host: localAddress, id: msgId };

    const timeoutId = setTimeout(() => {
      logger.warn(`Peer ${peer} MISSED PING`);
      this.outbound[peer].missedPingCount++;
    }, this.pingInterval * 1000);
    this.outbound[peer].messageTimeouts.set(msgId, timeoutId);

    const now = Date.now();
    const elapsed = now - this.lastPingAction;
    // within 2000ms default
    if (elapsed + (this.pingInterval / 4) * 1000 > now) {
      // only sleep 100ms so the change is gradual.
      await this.sleep(100);
      this.lastPingAction = Date.now();
    } else {
      this.lastPingAction = now;
    }

    this.sendMessageToSocket(msg, socket, peerMulticastGroup);
  }

  sendPong(
    socket: Socket,
    localAddress: string,
    msgId: string,
    multicastGroup: string
  ): void {
    const msg = { type: Msg.PONG, host: localAddress, id: msgId };

    this.sendMessageToSocket(msg, socket, multicastGroup);
  }

  sendPingNak(
    socket: Socket,
    localAddress: string,
    msgId: string,
    multicastGroup: string
  ): void {
    const msg = { type: Msg.PING_NAK, host: localAddress, id: msgId };

    this.sendMessageToSocket(msg, socket, multicastGroup);
  }

  sendMessageToSocket(
    msg: Message,
    socket: Socket,
    multicastGroup: string
  ): void {
    logger.info(`Sending: ${Msg[msg.type]} To: ${multicastGroup}:${this.port}`);
    const payload = this.preparePayload(msg);
    socket.send(payload, 0, payload.length, this.port, multicastGroup);
  }
}

export interface EchoServerOptions extends ServerOptions {
  peers?: string[];
  interval?: number;
  maxMissedPings?: number;
  maxTimeoutCount?: number;
  bindAddress?: string;
}

export enum Dir {
  INBOUND,
  OUTBOUND
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
  on<U extends keyof FluxEchoServerEvents>(
    event: U,
    listener: FluxEchoServerEvents[U]
  ): this;

  emit<U extends keyof FluxEchoServerEvents>(
    event: U,
    ...args: Parameters<FluxEchoServerEvents[U]>
  ): boolean;

  initiate(
    socket: Socket,
    multicastGroup: string,
    interfaceAddress: string
  ): void;
  echoHandler(msg: Message): void;
  sendEcho(socket: Socket, multicastGroup: string): void;
  sendPayloadToSocket(
    payload: Buffer,
    socket: Socket,
    multicastGroup: string
  ): void;
}
