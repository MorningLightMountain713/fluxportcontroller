"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FluxEchoServer = void 0;
const dgram_1 = __importDefault(require("dgram"));
const fluxServer_1 = require("./fluxServer");
const log_1 = require("./log");
const util_1 = require("util");
const logger = log_1.logController.getLogger();
const PING = "PING";
const PONG = "PONG";
class FluxEchoServer extends fluxServer_1.FluxServer {
    MESSAGE_SEPARATOR = "^#!@!#^";
    peers = {};
    port;
    pingInterval; // seconds
    maxMissed;
    constructor(options = {}) {
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
    addPeer(peerAddress) {
        this.peers[peerAddress] = {
            pingTimer: null,
            messageTimeouts: new Map(),
            missedPingCount: 0
        };
        // this only works with one socket, probably change this up a little, make multisocket
        for (const socket of this.sockets) {
            this.sendPing(socket, peerAddress);
            this.peers[peerAddress].pingTimer = setInterval(() => this.sendPing(socket, peerAddress), this.pingInterval * 1000);
        }
    }
    removePeer(peer) {
        if (this.peers[peer].pingTimer) {
            clearInterval(this.peers[peer].pingTimer);
        }
        for (const timeout of this.peers[peer].messageTimeouts.values()) {
            clearTimeout(timeout);
        }
        delete this.peers[peer];
    }
    initiate(socket, multicastGroup, interfaceAddress) {
        socket.setMulticastTTL(1);
        logger.info(`Joining multicast group: ${multicastGroup}`);
        socket.addMembership(multicastGroup, interfaceAddress);
        for (const [peerName, peerData] of Object.entries(this.peers)) {
            this.sendPing(socket, peerName);
            peerData.pingTimer = setInterval(() => this.sendPing(socket, peerName), this.pingInterval * 1000);
        }
    }
    runSocketServer(iface) {
        const socket = dgram_1.default.createSocket("udp4");
        // split the ip on the first dot. I.e 172.16.33.10 hostPart = 16.33.10
        const [_, hostPart] = iface.address.split(/\.(.*)/);
        const echoMulticastGroup = `239.${hostPart}`;
        socket.on("message", (data, remote) => this.messageHandler(socket, iface.address, data, remote));
        socket.on("listening", () => this.initiate(socket, echoMulticastGroup, iface.address));
        socket.once("error", (err) => this.removeSocketServer(socket, err));
        logger.info(`Echo Server binding to ${this.port} on ${iface.address}`);
        // this will receive on multicast address only, not iface.address
        // (if you specify iface.address on bind it will listen on both)
        socket.bind(this.port, echoMulticastGroup);
        return socket;
    }
    messageHandler(socket, localAddress, socketData, remote) {
        if (this.closed)
            return;
        logger.info("Message received from:", remote);
        const messages = this.decodeMessages(remote.address, socketData);
        logger.info((0, util_1.inspect)(messages, { showHidden: false, depth: null, colors: true }));
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
                    logger.info(`Received an unknown message of type: ${msg.type}, ignoring`);
            }
        }
    }
    pingHandler(socket, msg, remoteAddress) {
        const [_, hostPart] = remoteAddress.split(/\.(.*)/);
        const peerMulticastGroup = `239.${hostPart}`;
        if (!(remoteAddress in this.peers)) {
            this.addPeer(remoteAddress);
        }
        this.sendPong(socket, msg.id, peerMulticastGroup);
    }
    pongHandler(msg, peer) {
        if (this.peers[peer].messageTimeouts.has(msg.id)) {
            const timeoutId = this.peers[peer].messageTimeouts.get(msg.id);
            clearTimeout(timeoutId);
            this.peers[peer].messageTimeouts.delete(msg.id);
        }
    }
    sendPing(socket, peer) {
        const [_, hostPart] = peer.split(/\.(.*)/);
        const peerMulticastGroup = `239.${hostPart}`;
        if (this.peers[peer].missedPingCount >= this.maxMissed) {
            this.emit("timeout", peer, this.peers[peer].missedPingCount * this.pingInterval);
            this.peers[peer].missedPingCount = 0;
            for (const timeoutId of this.peers[peer].messageTimeouts.values()) {
                clearTimeout(timeoutId);
            }
            this.peers[peer].messageTimeouts.clear();
        }
        const msgId = this.generateId();
        const msg = { type: PING, id: msgId };
        const payload = this.preparePayload(msg);
        const timeoutId = setTimeout(() => this.peers[peer].missedPingCount++, 3 * 1000);
        this.peers[peer].messageTimeouts.set(msgId, timeoutId);
        this.sendPayloadToSocket(payload, socket, peerMulticastGroup);
    }
    sendPong(socket, msgId, multicastGroup) {
        const reply = { type: PONG, id: msgId };
        const payload = this.preparePayload(reply);
        this.sendPayloadToSocket(payload, socket, multicastGroup);
    }
    sendMessageToSocket(payload, socket, multicastGroup) {
        logger.info(`Sending message to ${multicastGroup}:${this.port}`);
        socket.send(payload, 0, payload.length, this.port, multicastGroup);
    }
}
exports.FluxEchoServer = FluxEchoServer;
