"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Dir = exports.FluxEchoServer = exports.Msg = void 0;
const dgram_1 = __importDefault(require("dgram"));
const fluxServer_1 = require("./fluxServer");
const log_1 = require("./log");
const util_1 = require("util");
const logger = log_1.logController.getLogger();
const INSPECT_OPTIONS = { showHidden: false, depth: null, colors: true };
var Msg;
(function (Msg) {
    Msg[Msg["PING"] = 0] = "PING";
    Msg[Msg["PING_NAK"] = 1] = "PING_NAK";
    Msg[Msg["PONG"] = 2] = "PONG";
})(Msg = exports.Msg || (exports.Msg = {}));
class TwoWayMap extends Map {
    revMap;
    // skip being able to init by constructor
    constructor() {
        super();
        this.revMap = new Map();
    }
    set(key, value) {
        this.revMap.set(value, key);
        return super.set(key, value);
    }
    getByValue(value) {
        return this.revMap.get(value);
    }
    delete(key) {
        const value = this.get(key);
        this.revMap.delete(value);
        return super.delete(key);
    }
    deleteByValue(value) {
        const key = this.revMap.get(value);
        if (key) {
            this.revMap.delete(value);
            return this.delete(key);
        }
        return false;
    }
}
class FluxEchoServer extends fluxServer_1.FluxServer {
    MESSAGE_SEPARATOR = "^#!@!#^";
    inbound = {};
    outbound = {};
    transitions = new TwoWayMap();
    port;
    pingInterval; // seconds
    maxMissedPings;
    maxTimeoutCount;
    bindAddress;
    lastPingAction = 0;
    constructor(options = {}) {
        super();
        if (options.peers) {
            options.peers.forEach((peer) => this.addPeer(peer, Dir.OUTBOUND, { connect: false }));
        }
        this.port = options.port || 16137;
        this.pingInterval = options.interval || 8;
        this.maxMissedPings = options.maxMissedPings || 3;
        this.maxTimeoutCount = options.maxTimeoutCount || 3;
        this.bindAddress = options.bindAddress || null;
        logger.info((0, util_1.inspect)(this.interfaces, INSPECT_OPTIONS));
    }
    addTransition(from, to) {
        this.transitions.set(to, from);
    }
    addPeer(peerAddress, direction, options = {}) {
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
        }
        else {
            this.inbound[peerAddress] = {
                activeSince: activeSince
            };
        }
        console.log("Added peer", peerAddress, "DIRECTION", Dir[direction]);
        if (!connect || direction === Dir.INBOUND)
            return;
        // this only works with one socket, probably change this up a little, make multisocket
        for (const socket of this.sockets) {
            this.sendPing(socket, peerAddress);
            this.outbound[peerAddress].pingTimer = setInterval(() => this.sendPing(socket, peerAddress), this.pingInterval * 1000);
        }
    }
    get ["peerAddresses"]() {
        return Array.from(new Set([...this.outboundPeerAddresses, ...this.inboundPeerAddresses]));
    }
    get ["inboundPeerAddresses"]() {
        return this.sortHosts(Object.keys(this.inbound));
    }
    get ["outboundPeerAddresses"]() {
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
    get ["peerCount"]() {
        return this.inboundPeerCount + this.outboundPeerCount;
    }
    get ["inboundPeerCount"]() {
        return this.inboundPeerAddresses.length;
    }
    get ["outboundPeerCount"]() {
        return this.outboundPeerAddresses.length;
    }
    sortHosts(toSort) {
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
    peerAvailable(peer) {
        return this.outbound[peer] && this.outbound[peer].missedPingCount === 0;
    }
    removePeer(peer, options = {}) {
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
            clearInterval(this.outbound[peer].pingTimer);
        }
        for (const timeout of this.outbound[peer].messageTimeouts.values()) {
            clearTimeout(timeout);
        }
        delete this.outbound[peer];
        if (active) {
            this.emit("peerRemoved", peer, Dir.OUTBOUND);
        }
    }
    initiate(socket, multicastGroup, interfaceAddress) {
        socket.setMulticastTTL(1);
        logger.info(`Joining multicast group: ${multicastGroup}`);
        socket.addMembership(multicastGroup, interfaceAddress);
        for (const [peerName, peerData] of Object.entries(this.outbound)) {
            this.sendPing(socket, peerName);
            peerData.pingTimer = setInterval(() => this.sendPing(socket, peerName), this.pingInterval * 1000);
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
    start() {
        this.closed = false;
        let bindInterface;
        if (this.bindAddress) {
            bindInterface = this.interfaces.find((int) => int.address === this.bindAddress);
        }
        else {
            bindInterface = this.interfaces[0];
        }
        this.sockets.push(this.runSocketServer(bindInterface));
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
                    logger.info(`Received an unknown message of type: ${msg.type}, ignoring`);
            }
        }
    }
    async pingHandler(socket, localAddress, msg, remoteAddress) {
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
                logger.info(`Max inbound peer count reached. Rejecting: ${remoteAddress}`);
                this.sendPingNak(socket, localAddress, msg.id, peerMulticastGroup);
                return;
            }
            this.addPeer(remoteAddress, Dir.INBOUND, { activeSince: Date.now() });
            this.emit("peerConnected", remoteAddress, Dir.INBOUND);
        }
        this.sendPong(socket, localAddress, msg.id, peerMulticastGroup);
    }
    pongHandler(msg, peer) {
        if (this.outbound[peer].missedPingCount > 0) {
            for (const timeout of this.outbound[peer].messageTimeouts.values()) {
                clearTimeout(timeout);
            }
            this.outbound[peer].timeoutCount = 0;
            this.outbound[peer].missedPingCount = 0;
            this.outbound[peer].messageTimeouts.clear();
            this.emit("peerReconnected", peer);
        }
        else if (this.outbound[peer].messageTimeouts.has(msg.id)) {
            const timeoutId = this.outbound[peer].messageTimeouts.get(msg.id);
            clearTimeout(timeoutId);
            this.outbound[peer].messageTimeouts.delete(msg.id);
        }
        if (!this.outbound[peer].activeSince) {
            this.outbound[peer].activeSince = Date.now();
            this.emit("peerConnected", peer, Dir.OUTBOUND);
        }
    }
    pingNakHandler(msg, peer) {
        // don't emit peer removed if it wasn't active
        console.log("PING NAK RECEIVED:", peer);
        this.removePeer(peer, { active: false });
        this.emit("peerRejected", peer);
    }
    async sendPing(socket, peer) {
        const [_, hostPart] = peer.split(/\.(.*)/);
        const peerMulticastGroup = `239.${hostPart}`;
        // just use modulo here
        if (this.outbound[peer].missedPingCount >= this.maxMissedPings) {
            this.outbound[peer].timeoutCount++;
            const culmulative = this.outbound[peer].timeoutCount *
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
            if (!this.outbound[peer])
                return;
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
        }
        else {
            this.lastPingAction = now;
        }
        this.sendMessageToSocket(msg, socket, peerMulticastGroup);
    }
    sendPong(socket, localAddress, msgId, multicastGroup) {
        const msg = { type: Msg.PONG, host: localAddress, id: msgId };
        this.sendMessageToSocket(msg, socket, multicastGroup);
    }
    sendPingNak(socket, localAddress, msgId, multicastGroup) {
        const msg = { type: Msg.PING_NAK, host: localAddress, id: msgId };
        this.sendMessageToSocket(msg, socket, multicastGroup);
    }
    sendMessageToSocket(msg, socket, multicastGroup) {
        logger.info(`Sending: ${Msg[msg.type]} To: ${multicastGroup}:${this.port}`);
        const payload = this.preparePayload(msg);
        socket.send(payload, 0, payload.length, this.port, multicastGroup);
    }
}
exports.FluxEchoServer = FluxEchoServer;
var Dir;
(function (Dir) {
    Dir[Dir["INBOUND"] = 0] = "INBOUND";
    Dir[Dir["OUTBOUND"] = 1] = "OUTBOUND";
})(Dir = exports.Dir || (exports.Dir = {}));
