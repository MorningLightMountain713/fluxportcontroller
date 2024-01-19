import dgram, { Socket } from "dgram";
import { AddressInfo } from "net";
import os from "os";
import { FluxServer, ServerOptions, Message } from "./fluxServer";

import logger from "./log";

import { inspect } from "util";

const PING = "PING";
const PONG = "PONG";

export class FluxEchoServer extends FluxServer {
  MESSAGE_SEPARATOR = "^#!@!#^";
  private readonly peers: Record<string, Peer> = {};
  private readonly port: number;
  private readonly pingInterval: number; // seconds
  private readonly maxMissed: number;

  constructor(options: EchoServerOptions = {}) {
    super();

    if (options.peers) {
      for (const peer of options.peers) {
        this.peers[peer] = {
          pingTimer: null,
          messageTimeouts: new Map(),
          missedPingCount: 0
        };
      }
    }

    this.port = options.port || 16137;
    this.pingInterval = options.interval || 5;
    this.maxMissed = options.maxMissed || 3;

    logger.info(this.interfaces);
  }

  addPeer(peerAddress: string) {
    this.peers[peerAddress] = {
      pingTimer: null,
      messageTimeouts: new Map(),
      missedPingCount: 0
    };

    // this only works with one socket, probably change this up a little, make multisocket
    for (const socket of this.sockets) {
      this.sendPing(socket, peerAddress);
      this.peers[peerAddress].pingTimer = setInterval(
        () => this.sendPing(socket, peerAddress),
        this.pingInterval * 1000
      );
    }
  }

  removePeer(peer: string) {
    if (this.peers[peer].pingTimer) {
      clearInterval(this.peers[peer].pingTimer!);
    }
    for (const timeout of this.peers[peer].messageTimeouts.values()) {
      clearTimeout(timeout);
    }
    delete this.peers[peer];
  }

  initiate(
    socket: Socket,
    multicastGroup: string,
    interfaceAddress: string
  ): void {
    socket.setMulticastTTL(1);
    logger.info(`Joining multicast group: ${multicastGroup}`);
    socket.addMembership(multicastGroup, interfaceAddress);

    for (const [peerName, peerData] of Object.entries(this.peers)) {
      this.sendPing(socket, peerName);
      peerData.pingTimer = setInterval(
        () => this.sendPing(socket, peerName),
        this.pingInterval * 1000
      );
    }
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

    logger.info("Message received from:", remote);
    const messages = this.decodeMessages(remote.address, socketData);
    logger.info(
      inspect(messages, { showHidden: false, depth: null, colors: true })
    );
    for (const msg of messages) {
      this.unhandledMessages.add(msg.id);
      switch (msg.type) {
        case PING:
          this.pingHandler(socket, msg, remote.address);
          break;
        case PONG:
          this.pongHandler(msg, remote.address);
          break;
        default:
          logger.info(
            `Received an unknown message of type: ${msg.type}, ignoring`
          );
      }
    }
  }

  pingHandler(socket: Socket, msg: Message, remoteAddress: string) {
    const [_, hostPart] = remoteAddress.split(/\.(.*)/);
    const peerMulticastGroup = `239.${hostPart}`;

    if (!(remoteAddress in this.peers)) {
      this.addPeer(remoteAddress);
    }

    this.sendPong(socket, msg.id, peerMulticastGroup);
  }

  pongHandler(msg: Message, peer: string): void {
    if (this.peers[peer].messageTimeouts.has(msg.id)) {
      const timeoutId = this.peers[peer].messageTimeouts.get(msg.id);
      clearTimeout(timeoutId);
      this.peers[peer].messageTimeouts.delete(msg.id);
    }
  }

  sendPing(socket: Socket, peer: string): void {
    const [_, hostPart] = peer.split(/\.(.*)/);
    const peerMulticastGroup = `239.${hostPart}`;

    if (this.peers[peer].missedPingCount >= this.maxMissed) {
      this.emit(
        "timeout",
        peer,
        this.peers[peer].missedPingCount * this.pingInterval
      );
      this.peers[peer].missedPingCount = 0;
      for (const timeoutId of this.peers[peer].messageTimeouts.values()) {
        clearTimeout(timeoutId);
      }
      this.peers[peer].messageTimeouts.clear();
    }

    const msgId = this.generateId();
    const msg = { type: PING, id: msgId };
    const payload = this.preparePayload(msg);

    const timeoutId = setTimeout(
      () => this.peers[peer].missedPingCount++,
      3 * 1000
    );
    this.peers[peer].messageTimeouts.set(msgId, timeoutId);

    this.sendPayloadToSocket(payload, socket, peerMulticastGroup);
  }

  sendPong(socket: Socket, msgId: string, multicastGroup: string): void {
    const reply = { type: PONG, id: msgId };
    const payload = this.preparePayload(reply);

    this.sendPayloadToSocket(payload, socket, multicastGroup);
  }

  sendMessageToSocket(
    payload: Buffer,
    socket: Socket,
    multicastGroup: string
  ): void {
    logger.info(`Sending message to ${multicastGroup}:${this.port}`);
    socket.send(payload, 0, payload.length, this.port, multicastGroup);
  }
}

export interface EchoServerOptions extends ServerOptions {
  peers?: string[];
  interval?: number;
  maxMissed?: number;
}

interface Peer {
  pingTimer: NodeJS.Timeout | null;
  messageTimeouts: Map<string, NodeJS.Timeout>;
  missedPingCount: number;
}

interface FluxEchoServerEvents {
  timeout: (peer: string, seconds: number) => void;
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
