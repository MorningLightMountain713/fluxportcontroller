"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FluxGossipServer = void 0;
const node_dgram_1 = __importDefault(require("node:dgram"));
const promises_1 = __importDefault(require("node:timers/promises"));
const node_http_1 = require("node:http");
const promises_2 = require("node:dns/promises");
const axios_1 = __importDefault(require("axios"));
const fluxServer_1 = require("./fluxServer");
// import { Client } from "@runonflux/nat-upnp";
const nat_upnp_1 = require("@megachips/nat-upnp");
const log_1 = require("./log");
const util_1 = require("util");
const fs_1 = require("fs");
// logController.addLoggerTransport("console");
const logger = log_1.logController.getLogger();
const AXIOS_TIMEOUT = 3000; // ms
const ADDRESS_APIS = [
    "https://ifconfig.me",
    "https://checkip.amazonaws.com",
    "https://api.ipify.org"
];
//message types
const DISCOVER = "DISCOVER";
const DISCOVER_REPLY = "DISCOVER_REPLY";
const PORT_SELECT = "PORT_SELECT";
const PORT_SELECT_ACK = "PORT_SELECT_ACK";
const PORT_SELECT_NAK = "PORT_SELECT_NAK";
// development
const ADMIN_START = "ADMIN_START";
const ADMIN_RESET = "ADMIN_RESET";
const ADMIN_DISCOVER = "ADMIN_DISCOVER";
// this is unicast response
const ADMIN_DISCOVER_REPLY = "ADMIN_DISCOVER_REPLY";
const ADMIN_MESSAGES = [PORT_SELECT_ACK, ADMIN_DISCOVER_REPLY];
// nodeStates
const STARTING = "STARTING";
const DISCOVERING = "DISCOVERING";
const SELECTING = "SELECTING";
const READY = "READY";
const UNKNOWN = "UNKNOWN";
const INSPECT_OPTIONS = { showHidden: false, depth: null, colors: true };
class FluxGossipServer extends fluxServer_1.FluxServer {
    outPoint;
    MESSAGE_SEPARATOR = "?#!%%!#?";
    allFluxports = [
        16197, 16187, 16177, 16167, 16157, 16147, 16137, 16127
    ];
    restartTimeout = null;
    discoverTimeout = null;
    portSelectTimeout = null;
    adminTimeout = null;
    pendingDiscoverId = null;
    pendingSelectId = null;
    upnpServiceUrl = null;
    localAddresses = [];
    myIp = null;
    addressApis;
    portToNodeMap = new Map();
    state = { port: null, nodeState: STARTING };
    networkState = {};
    multicastGroup;
    port;
    startDelay;
    firstResponderDelay;
    responseTimeoutMultiplier;
    responseTimeout;
    mode;
    msgLog = null;
    observerMsgHistory = null;
    observerNetworkStates = null;
    observerNodeCount = null;
    observerAckedPorts = null;
    observerTestId = 0;
    observerTestCount = null;
    observerLastTestFailed = false;
    upnpClient;
    startedAt = 0;
    constructor(outPoint, options = {}) {
        super();
        this.outPoint = outPoint;
        this.outPoint = outPoint;
        this.mode = options.mode || "PRODUCTION";
        this.port = options.port || 16127;
        this.multicastGroup = options.multicastGroup || "239.112.233.123";
        // weak equivalence includes null and undefined, we want to allow 0 here.
        this.startDelay = options.startDelay != null ? options.startDelay : 10;
        this.firstResponderDelay = options.firstResponderDelay || 1;
        this.responseTimeoutMultiplier = options.responseTimeoutMultiplier || 3;
        this.responseTimeout =
            this.firstResponderDelay * this.responseTimeoutMultiplier;
        this.upnpServiceUrl = options.upnpServiceUrl || null;
        this.addressApis = options.addressApis || ADDRESS_APIS;
        // example Client({ url: "http://172.18.0.5:36211/rootDesc.xml" });
        // this is ugly. It's opening sockets out the gate
        this.upnpClient = new nat_upnp_1.Client({ cacheGateway: true });
        // use the upnpclient address for our interface
        switch (this.mode) {
            case "PRODUCTION":
                break;
            case "DEVELOPMENT":
                this.msgLog = [];
                break;
            case "OBSERVE":
                if (!options.observerNodeCount) {
                    throw new fluxServer_1.ServerError("observerNodeCount must be provided if using OBSERVE mode");
                }
                this.observerNodeCount = options.observerNodeCount;
                this.observerMsgHistory = {};
                this.observerNetworkStates = {};
                this.observerAckedPorts = new Set();
                this.observerTestCount = options.observerTestCount || 5;
                // clear out results file (create if not exist)
                (0, fs_1.writeFileSync)("results.json", "{}");
                this.runAdminWebserver(this.port);
                break;
            default:
                throw new fluxServer_1.ServerError(`Unknown server mode: ${this.mode}`);
        }
        logger.debug(`Start delay: ${this.startDelay}`);
        logger.debug(`firstResponderDelay: ${this.firstResponderDelay}`);
        logger.debug(`responseTimeoutMultiplier: ${this.responseTimeoutMultiplier}`);
        logger.debug(`responseTimeout: ${this.responseTimeout}`);
    }
    get ["portsAvailable"]() {
        const usedPorts = Object.values(this.networkState)
            .filter((host) => (host.nodeState === SELECTING ||
            host.nodeState === READY ||
            host.nodeState === UNKNOWN) &&
            typeof host.port === "number")
            .map((host) => host.port);
        return this.allFluxports.filter((port) => !usedPorts.includes(port));
    }
    async getMyPublicIp() {
        let addressApi;
        let data = "";
        if (this.outPoint.txhash == "testtx") {
            return "10.10.10.10";
        }
        while (!data) {
            addressApi = this.addressApis.shift();
            this.addressApis.push(addressApi);
            try {
                ({ data } = await axios_1.default.get(addressApi, { timeout: AXIOS_TIMEOUT }));
            }
            catch (err) {
                logger.warn(`Error getting IP address from ${addressApi}, switching...`);
                await this.sleep(1000);
            }
        }
        return data.trim();
    }
    async start() {
        // Can't use UPnP public IP as that isn't guaranteed to be actual public IP.
        // we need the IP to be able to filter the deterministic node list for our
        // prior port and our siblings
        const now = Date.now();
        if (!this.myIp || this.startedAt + 900 < now) {
            this.myIp = await this.getMyPublicIp();
            this.startedAt = now;
        }
        logger.info(`My ip is: ${this.myIp}`);
        // this now means the gossipserver is reliant on UPnP working as we're using the
        // interface provided by UPnP for multicast
        // use generics for this and type properly
        const gatewayResponse = await this.runUpnpRequest(this.upnpClient.getGateway);
        if (!gatewayResponse) {
            this.emit("startError");
            return false;
        }
        // this returns empty array or mappings (both truthy) or undefined on error
        const mappings = await this.runUpnpRequest(this.upnpClient.getMappings);
        if (!mappings) {
            this.emit("startError");
            return false;
        }
        const { gateway, localAddress } = gatewayResponse;
        // from testing, this is an IP. However, resolve just in case
        const gatewayFqdn = new URL(gateway.description).hostname;
        const gatewayIp = await (0, promises_2.lookup)(gatewayFqdn);
        this.emit("routerIpConfirmed", gatewayIp.address);
        // we only run on the interface that we are able to communicate with the
        // upnp gateway
        const upnpInterface = this.interfaces.find((int) => int.address === localAddress);
        // interface is guaranteed here
        this.sockets.push(this.runSocketServer(upnpInterface));
        return true;
    }
    stop() {
        // this is idempotent now
        this.upnpClient.close();
        super.stop();
    }
    runAdminWebserver(port) {
        const requestListener = (req, res) => {
            // if (
            //   !this.observerMsgHistory ||
            //   Object.keys(this.observerMsgHistory).length === 0
            // ) {
            //   res.writeHead(503);
            //   res.end();
            //   return;
            // }
            res.writeHead(200, {
                "content-type": "application/json; charset=utf-8"
            });
            // const msg = {
            //   msgHistory: this.observerMsgHistory,
            //   networkStates: this.observerNetworkStates
            // };
            const results = JSON.parse((0, fs_1.readFileSync)("results.json").toString());
            res.end(JSON.stringify(results));
        };
        const server = (0, node_http_1.createServer)(requestListener);
        // all interfaces
        server.listen(port, () => {
            logger.info(`Admin server is running on http://0.0.0.0:${port}`);
        });
    }
    runSocketServer(iface) {
        this.localAddresses.push(iface.address);
        this.networkState[iface.address] = this.state;
        const socket = node_dgram_1.default.createSocket("udp4");
        const sendDisover = this.mode === "PRODUCTION";
        const bindAddress = this.mode === "OBSERVE" ? undefined : this.multicastGroup;
        socket.on("message", (data, remote) => this.messageHandler(socket, iface.address, data, remote));
        socket.on("listening", async () => await this.initiate(socket, iface.address, sendDisover));
        socket.once("error", (err) => this.removeSocketServer(socket, err));
        logger.info(`Binding to ${this.port} on ${iface.address}`);
        // this will receive on multicast address only, not iface.address
        // (if you specify dont specify address, it will listen on both
        socket.bind(this.port, bindAddress);
        return socket;
    }
    resetState(resetMsgLog = true) {
        if (this.mode !== "OBSERVE") {
            this.discoverTimeout = null;
            this.pendingDiscoverId = null;
            this.portSelectTimeout = null;
            this.pendingSelectId = null;
            this.state = { port: null, nodeState: STARTING };
            this.networkState = {};
            // we call reset state if we get a PORT_SELECT_NAK. The nak handler resets
            // the state and reinitiates. However, in this case, we don't want to wipe
            // the state as is we are in DEVELOPMENT mode, we want all the msgLogs for
            // the observer
            if (resetMsgLog) {
                this.msgLog = [];
            }
        }
        else {
            this.observerMsgHistory = {};
            this.observerNetworkStates = {};
            this.observerAckedPorts = new Set();
            this.observerLastTestFailed = false;
        }
    }
    portConfirm(localAddress, sendPortSelectAck = false) {
        this.portSelectTimeout = null;
        this.pendingSelectId = null;
        this.state.nodeState = READY;
        logger.info(`Port confirmed: ${this.state.port}`);
        // this happens when the node hits the portSelectTimeout (i.e. there are
        // no other nodes) This is a courtesy message for an observer, or starting node.
        if (sendPortSelectAck) {
            this.sendPortSelectAck(this.generateId(), localAddress, this.state.port);
        }
        this.emit("portConfirmed", this.state.port);
        logger.info((0, util_1.inspect)(this.networkState, INSPECT_OPTIONS));
    }
    createMessageFlows() {
        const aggregatedMsgTypes = {};
        for (const [node, msgHistory] of Object.entries(this.observerMsgHistory)) {
            // DRY
            const inboundMsgTypes = msgHistory.reduce((acc, next) => {
                if (next.direction === "INBOUND")
                    acc.push(next.type);
                return acc;
            }, []);
            const outboundMsgTypes = msgHistory.reduce((acc, next) => {
                if (next.direction === "OUTBOUND")
                    acc.push(next.type);
                return acc;
            }, []);
            aggregatedMsgTypes[node] = { INBOUND: inboundMsgTypes };
            aggregatedMsgTypes[node]["OUTBOUND"] = outboundMsgTypes;
        }
        return aggregatedMsgTypes;
    }
    writeAdminResults(testId) {
        // aggregate data. Then write it. Then reset
        // observerMsgHistory
        // observerNetworkStates
        // observerNodeCount
        // observerAckedPorts
        let msg;
        if (this.observerLastTestFailed) {
            // write full report
            msg = {
                [testId]: {
                    resultType: "Fail: Timeout before ACKs",
                    result: {
                        msgHistory: this.observerMsgHistory,
                        networkStates: this.observerNetworkStates
                    }
                }
            };
        }
        else {
            // check for any NAKs. If so provide list of each nodes message types.
            const nakFound = Object.values(this.observerMsgHistory).find((msgArr) => msgArr.find((x) => x.type === "PORT_SELECT_NAK"));
            if (nakFound) {
                const msgFlows = this.createMessageFlows();
                msg = {
                    [testId]: {
                        resultType: "Pass: PORT_SELECT_NAK found",
                        result: msgFlows
                    }
                };
            }
            else {
                msg = {
                    [testId]: {
                        resultType: "Pass: Success"
                    }
                };
            }
        }
        this.writeDataToJsonFile(msg);
    }
    writeDataToJsonFile(data) {
        let previousResults = JSON.parse((0, fs_1.readFileSync)("results.json").toString());
        if (!previousResults) {
            previousResults = {};
        }
        const merged = { ...previousResults, ...data };
        (0, fs_1.writeFileSync)("results.json", JSON.stringify(merged));
    }
    async fluxportInUse(ip, port) {
        // call that ip on that port for flux/uptime endpoint
        const url = `http://${ip}:${port}/flux/uptime`;
        let attempts = 0;
        let res = null;
        while (attempts < 3) {
            attempts++;
            try {
                res = await axios_1.default.get(url, { timeout: 1000 });
            }
            catch (err) {
                logger.warn(`No response on ${url}, ${3 - attempts} attempts remaining`);
                continue;
            }
        }
        if (res && res.status === 200) {
            // some other node is live on this port
            return true;
        }
        return false;
    }
    async fluxnodePriorPort() {
        // this happens on development mode. Don't spam api.
        if (this.outPoint.txhash == "testtx") {
            return null;
        }
        logger.info("Checking for prior confirmed port via flux api");
        const url = `https://api.runonflux.io/daemon/viewdeterministiczelnodelist?filter=${this.myIp}`;
        let data = null;
        while (!data) {
            try {
                ({ data } = await axios_1.default.get(url, { timeout: AXIOS_TIMEOUT }));
            }
            catch (err) {
                logger.warn(`Error getting fluxnode deterministic list for my ip: ${this.myIp}, retrying`);
                await this.sleep(1 * 1000);
            }
            if (data?.status === "success") {
                data = data.data;
            }
            else {
                data = null;
            }
        }
        const thisNode = data.find((node) => node.txhash == this.outPoint.txhash &&
            node.outidx == this.outPoint.outidx);
        if (thisNode) {
            let [_, port] = thisNode.ip.split(":");
            return +port || 16127;
        }
        return null;
    }
    sortDiscoveringHosts() {
        const filter = (obj, predicate) => Object.fromEntries(Object.entries(obj).filter(([key, value]) => predicate(value)));
        const filtered = filter(this.networkState, (host) => host.nodeState === "DISCOVERING");
        const sortedHosts = Object.keys(filtered).sort((a, b) => {
            const numA = this.ipv4ToNumber(a);
            const numB = this.ipv4ToNumber(b);
            return numA - numB;
        });
        return sortedHosts;
    }
    ipv4ToNumber(ipv4) {
        return ipv4.split(".").reduce((a, b) => (a << 8) | +b, 0) >>> 0;
    }
    async portSelect(socket, localAddress) {
        let selectedPort = null;
        // contacts the upnp router for portmaps
        await this.updatePortToNodeMap();
        // looks up the flux api to see if our ip / txhash is in the determzelnode list
        const priorPort = await this.fluxnodePriorPort();
        logger.info(`Prior port found: ${priorPort}`);
        const portsAvailable = this.portsAvailable;
        // sort DISCOVERING nodes from lowest IP to higest. We select
        // the same index in the list. I.e. lowest IP gets index 0 (16197)
        // this is the tiebreak for discovering nodes
        const sortedNodes = this.sortDiscoveringHosts();
        let thisNodesIndex = sortedNodes.indexOf(localAddress);
        // in case index isn't found for some reason
        thisNodesIndex = thisNodesIndex === -1 ? 0 : thisNodesIndex;
        while (!selectedPort && portsAvailable.length) {
            if (priorPort && portsAvailable.includes(priorPort)) {
                const priorIndex = this.portsAvailable.indexOf(priorPort);
                selectedPort = portsAvailable.splice(priorIndex, 1)[0];
                logger.info(`Prior port ${selectedPort} found and available, selecting`);
            }
            else {
                // check router port mappings
                selectedPort = this.getPortFromNode(localAddress);
                if (selectedPort) {
                    logger.info(`Port ${selectedPort} found in router mapping table for our IP, selecting`);
                }
                else {
                    // this is based on the FluxGossip network state (all multicast participants)
                    selectedPort = portsAvailable.splice(thisNodesIndex, 1)[0];
                    logger.info(`Selecting next available port: ${selectedPort}`);
                }
                // we only try the tiebreak thing once, then just rawdog ports after that
                thisNodesIndex = 0;
            }
            // checks what ip's are mapped to what ports via upnp (call above)
            const collisionIp = this.portToNodeMap.get(selectedPort);
            // the port we want has a upnp mapping, check if it's actually on a live node
            if (collisionIp && collisionIp !== localAddress) {
                logger.warn(`Our selected port already has a mapping for ${collisionIp}, checking if node live`);
                if (await this.fluxportInUse(collisionIp, selectedPort)) {
                    logger.warn(`Fluxnode responded at http://${collisionIp}:${selectedPort}/flux/uptime, marking port as used`);
                    // This can happen when running a blend of old fluxnodes and new autoUPnP nodes
                    // adding this as a precautionary measure
                    if (!(collisionIp in this.networkState)) {
                        this.networkState[collisionIp] = {
                            port: selectedPort,
                            nodeState: UNKNOWN
                        };
                    }
                }
                // previously, we were going to usurp the port. If the node didn't respond. However, if a
                // mapping exists, we are unable to remove it from another node, which, for
                // what are now obvious reasons, makes sense.
                selectedPort = null;
            }
        }
        if (selectedPort) {
            this.state.nodeState = SELECTING;
            this.state.port = selectedPort;
            this.pendingSelectId = this.sendPortSelect(localAddress, selectedPort);
            this.portSelectTimeout = setTimeout(() => this.portConfirm(localAddress, true), this.responseTimeout * 1000);
        }
        else {
            logger.error("No free ports... will try again in 5 minutes");
            this.resetState();
            this.restartTimeout = setTimeout(async () => {
                await this.initiate(socket, localAddress, true);
            }, 300 * 1000);
        }
    }
    resetTimers() {
        if (this.restartTimeout) {
            clearTimeout(this.restartTimeout);
            this.restartTimeout = null;
        }
        if (this.discoverTimeout) {
            clearTimeout(this.discoverTimeout);
            this.discoverTimeout = null;
        }
        if (this.portSelectTimeout) {
            clearTimeout(this.portSelectTimeout);
            this.portSelectTimeout = null;
        }
    }
    async initiate(socket, interfaceAddress, sendDiscover) {
        if (this.restartTimeout) {
            // should already be triggered
            clearTimeout(this.restartTimeout);
            this.restartTimeout = null;
        }
        if (!socket.fluxGroupJoined) {
            socket.setMulticastTTL(1);
            logger.info(`Joining multicast group: ${this.multicastGroup}`);
            socket.addMembership(this.multicastGroup, interfaceAddress);
            socket.fluxGroupJoined = true;
        }
        // stop the stampede effect from nodes starting together
        if (this.startDelay !== 0) {
            await this.sleep(Math.random() * this.startDelay * 1000);
        }
        // this is for more DEVELOPMENT / PRODUCTION IF IN DEV, don't send
        // discover on first initiate, so it can be run from observer.
        if (sendDiscover) {
            this.state.nodeState = DISCOVERING;
            this.pendingDiscoverId = this.sendDiscover(interfaceAddress);
            this.discoverTimeout = setTimeout(async () => await this.portSelect(socket, interfaceAddress), this.responseTimeout * 1000);
        }
        if (this.mode === "OBSERVE") {
            if (this.observerTestId >= this.observerTestCount) {
                logger.info("Test limit reached, END");
                logger.info("Results available at: http://localhost:33333");
                return;
            }
            logger.info("Starting in 5 seconds...");
            await this.sleep(5 * 1000);
            // allow 60 seconds for network to converge... then reset
            // nodes, store results and rerun. This would only fire on failure
            this.adminTimeout = setTimeout(async () => {
                this.adminTimeout = null;
                this.observerLastTestFailed = true;
                // this.writeAdminResults(this.observerTestId, true);
                // this.sendAdminReset(interfaceAddress);
                // this.observerTestId++;
                // await this.initiate(socket, interfaceAddress, sendDiscover);
                this.sendAdminDiscover(interfaceAddress);
            }, 60 * 1000);
            this.sendAdminStart(interfaceAddress);
        }
    }
    // HELPERS //
    sleep(ms) {
        return promises_1.default.setTimeout(ms);
    }
    updateState(localAddress, networkState) {
        this.networkState = networkState;
        this.networkState[localAddress] = this.state;
    }
    async runUpnpRequest(upnpCall) {
        let res;
        try {
            res = await upnpCall.call(this.upnpClient);
        }
        catch (err1) {
            logger.warn(`Unable to run upnp request: ${err1}. Will try again without SSDP if possible`);
            let errMsg = "";
            if (this.upnpServiceUrl &&
                err1 instanceof Error &&
                /Connection timed out/.test(err1.message)) {
                // skip SSDP (multicast) and use cached router url
                this.upnpClient.url = this.upnpServiceUrl;
                try {
                    res = await upnpCall();
                }
                catch (err2) {
                    // we tried, we failed, reset
                    this.upnpClient.url = null;
                    logger.warn(`Unable to run upnp request: ${err2}.`);
                    errMsg = err2 instanceof Error ? err2.message : err2;
                }
            }
            if (!errMsg) {
                errMsg = err1 instanceof Error ? err1.message : err1;
            }
            this.emit("upnpError", errMsg);
        }
        return res;
    }
    getPortFromNode(nodeIp) {
        for (let [key, value] of this.portToNodeMap.entries()) {
            if (value === nodeIp)
                return key;
        }
        return null;
    }
    async updatePortToNodeMap() {
        const allMappings = await this.runUpnpRequest(this.upnpClient.getMappings);
        if (!allMappings)
            return;
        for (const mapping of allMappings) {
            // we only care about Flux tcp maps
            if (mapping.protocol !== "tcp")
                continue;
            if (this.allFluxports.includes(mapping.public.port)) {
                this.portToNodeMap.set(mapping.public.port, mapping.private.host);
            }
        }
    }
    // OUTBOUND MESSAGES //
    sendDiscover(ifaceAddress) {
        // need to save pending discover???
        const msgId = this.generateId();
        const msg = { type: DISCOVER, id: msgId, host: ifaceAddress };
        this.sendMessageToSockets(msg);
        return msgId;
    }
    sendDiscoverReply(host, msgId) {
        const msg = {
            type: DISCOVER_REPLY,
            id: msgId,
            host: host,
            networkState: this.networkState
        };
        this.sendMessageToSockets(msg);
    }
    sendPortSelect(ifaceAddress, port) {
        const msgId = this.generateId();
        const msg = {
            type: PORT_SELECT,
            id: msgId,
            host: ifaceAddress,
            port: port
        };
        this.sendMessageToSockets(msg);
        return msgId;
    }
    sendPortSelectAck(msgId, host, port) {
        const msg = { type: PORT_SELECT_ACK, id: msgId, host: host, port: port };
        this.sendMessageToSockets(msg);
    }
    sendPortSelectNak(msgId, host, port) {
        const msg = { type: PORT_SELECT_NAK, id: msgId, host: host, port: port };
        this.sendMessageToSockets(msg);
    }
    sendAdminDiscover(host) {
        const msg = { type: ADMIN_DISCOVER, id: this.generateId(), host: host };
        this.sendMessageToSockets(msg);
    }
    sendAdminDiscoverReply(srcHost, dstHost) {
        /**
         * This is a special case. Sends unicast response back to Observer.
         */
        const msg = {
            type: ADMIN_DISCOVER_REPLY,
            id: this.generateId(),
            host: srcHost,
            networkState: this.networkState,
            msgLog: this.msgLog
        };
        this.sendMessageToSockets(msg, { address: dstHost });
    }
    sendAdminStart(localAddress) {
        const msg = {
            type: ADMIN_START,
            id: this.generateId(),
            host: localAddress
        };
        this.sendMessageToSockets(msg);
    }
    sendAdminReset(localAddress) {
        const msg = {
            type: ADMIN_RESET,
            id: this.generateId(),
            host: localAddress
        };
        this.sendMessageToSockets(msg);
    }
    sendMessageToSockets(msg, options = {}) {
        const targetAddress = options.address || this.multicastGroup;
        // avoid circular
        if (this.mode === "DEVELOPMENT" && msg.type !== "ADMIN_DISCOVER_REPLY") {
            this.msgLog.push({
                ...structuredClone(msg),
                ...{ direction: "OUTBOUND" }
            });
        }
        const payload = this.preparePayload(msg, options.addSeparators);
        this.sockets.forEach((socket) => {
            logger.info(`Sending type: ${msg.type} to: ${targetAddress}:${this.port}`);
            socket.send(payload, 0, payload.length, this.port, targetAddress);
        });
    }
    // INBOUND MESSAGE HANDLERS //
    async discoverHandler(msg) {
        this.networkState[msg.host] = { port: null, nodeState: DISCOVERING };
        await this.sleep(Math.random() * this.firstResponderDelay * 1000);
        if (this.unhandledMessages.has(msg.id)) {
            this.sendDiscoverReply(msg.host, msg.id);
            this.unhandledMessages.delete(msg.id);
        }
    }
    async discoverReplyHandler(socket, localAddress, msg) {
        this.unhandledMessages.delete(msg.id);
        if (this.discoverTimeout && this.pendingDiscoverId === msg.id) {
            clearTimeout(this.discoverTimeout);
            this.discoverTimeout = null;
            this.pendingDiscoverId = null;
            this.updateState(localAddress, msg.networkState);
            this.portSelect(socket, localAddress);
        }
        else {
            // if the reply was for someone else, and there is NEW state that
            // we don't have, update. (Don't modify any existing state)
            // if we could timestamp the messages, then could use that, but how
            // to sync the timestamps accurately? (don't think it's possible)
            // for (const state in msg.networkState) {
            //   if (!(state in this.networkState)) {
            //     this.networkState[state] = msg.networkState[state];
            //   }
            // }
        }
    }
    async portSelectHandler(msg) {
        let validPortSelect = false;
        if (this.portsAvailable.includes(msg.port)) {
            validPortSelect = true;
            this.networkState[msg.host] = { port: msg.port, nodeState: SELECTING };
        }
        // between 0-1 seconds by default
        await this.sleep(Math.random() * this.firstResponderDelay * 1000);
        if (this.unhandledMessages.has(msg.id)) {
            this.unhandledMessages.delete(msg.id);
            if (validPortSelect) {
                this.networkState[msg.host] = { port: msg.port, nodeState: READY };
                this.sendPortSelectAck(msg.id, msg.host, msg.port);
            }
            else {
                this.sendPortSelectNak(msg.id, msg.host, msg.port);
            }
        }
    }
    async portSelectAckHandler(localAddress, msg) {
        this.unhandledMessages.delete(msg.id);
        if (this.mode === "OBSERVE") {
            this.observerAckedPorts.add(msg.port);
            if (this.observerAckedPorts.size === this.observerNodeCount) {
                logger.info("Acked ports matches node count... sending admin discover in 5s...");
                await this.sleep(5 * 1000);
                logger.info("Sending admin discover message");
                this.sendAdminDiscover(localAddress);
            }
        }
        else {
            if (this.portSelectTimeout && this.pendingSelectId === msg.id) {
                clearTimeout(this.portSelectTimeout);
                // this should already be set in portSelect
                this.state.port = msg.port;
                this.portConfirm(localAddress);
            }
            else {
                this.networkState[msg.host] = { port: msg.port, nodeState: READY };
            }
        }
    }
    async portSelectNakHandler(socket, localAddress, msg) {
        this.unhandledMessages.delete(msg.id);
        if (this.portSelectTimeout && this.pendingSelectId === msg.id) {
            logger.warn("Our port request got NAKd... restarting in 10 seconds");
            clearTimeout(this.portSelectTimeout);
            this.portSelectTimeout = null;
            this.pendingSelectId = null;
            this.resetState(false);
            // wait 5 seconds (plus random 0-startDelay seconds in initiate call)
            this.restartTimeout = setTimeout(async () => {
                await this.initiate(socket, localAddress, true);
            }, 5 * 1000);
        }
        else {
            this.networkState[msg.host] = { port: null, nodeState: STARTING };
        }
    }
    async adminStartHandler(socket, localAddress) {
        logger.info("admin Start received... starting");
        await this.initiate(socket, localAddress, true);
    }
    adminResetHandler() {
        this.resetTimers();
        this.resetState();
        logger.info("admin Reset complete");
    }
    async adminDiscoverHandler(localAddress, remote) {
        // send our state and nakCount unicast to msg.host
        // also, if in DEVELOPMENT mode, should collect stats,
        // of message count received from each node.
        // also nak counter should only be set in dev mode.
        await this.sleep(Math.random() * this.firstResponderDelay * 1000);
        this.sendAdminDiscoverReply(localAddress, remote.address);
    }
    async adminDiscoverReplyhandler(socket, localAddress, msg) {
        if (this.mode !== "OBSERVE") {
            return;
        }
        this.observerMsgHistory[msg.host] = msg.msgLog;
        this.observerNetworkStates[msg.host] = msg.networkState;
        if (Object.keys(this.observerNetworkStates).length ===
            this.observerNodeCount) {
            if (this.adminTimeout) {
                clearTimeout(this.adminTimeout);
                this.adminTimeout = null;
            }
            // while testcount < 1000 or something...
            // check results see if they're good... if so log that they're good
            // maybe something simple like ip to port then send ADMIN_RESTART.
            // if there were port NAKs... log the full schebang to file with run
            // number or something. (then restart) mount volume file in for logging
            // into observer container
            logger.info("Writing results and resetting nodes...");
            this.writeAdminResults(this.observerTestId);
            this.sendAdminReset(localAddress);
            this.resetState();
            this.observerTestId++;
            // no await?
            this.initiate(socket, localAddress, false);
            // logger.info("Message history:");
            // logger.info(inspect(this.observerMsgHistory, INSPECT_OPTIONS));
            // logger.info("All network states:");
            // logger.info(inspect(this.observerNetworkStates, INSPECT_OPTIONS));
        }
    }
    async messageHandler(socket, localAddress, socketData, remote) {
        if (this.closed)
            return;
        // since this is multicast, we get our own messages, drop
        if (this.localAddresses.includes(remote.address)) {
            return;
        }
        const messages = this.decodeMessages(remote.address, socketData);
        for (const msg of messages) {
            // if (!(msg.type === "ADMIN_DISCOVER_REPLY")) {
            //   logger.info(inspect(msg, INSPECT_OPTIONS));
            // }
            logger.info(`Received type: ${msg.type} from: ${remote.address}:${remote.port}`);
            switch (this.mode) {
                case "PRODUCTION":
                    break;
                case "DEVELOPMENT":
                    // need to clone the object here otherwise, all msgLogs all reference
                    // the same networkState
                    this.msgLog.push({
                        ...structuredClone(msg),
                        ...{ direction: "INBOUND" }
                    });
                    break;
                case "OBSERVE":
                    if (!ADMIN_MESSAGES.includes(msg.type)) {
                        return;
                    }
                    break;
                // don't need a default as we have already thrown in constructor.
            }
            // don't need to check for node message types as the only admin handler is the
            // ADMIN_DISCOVER_REPLY which has explicit checking in the handler
            this.unhandledMessages.add(msg.id);
            switch (msg.type) {
                case DISCOVER:
                    await this.discoverHandler(msg);
                    break;
                case DISCOVER_REPLY:
                    await this.discoverReplyHandler(socket, localAddress, msg);
                    break;
                case PORT_SELECT:
                    await this.portSelectHandler(msg);
                    break;
                case PORT_SELECT_ACK:
                    await this.portSelectAckHandler(localAddress, msg);
                    break;
                case PORT_SELECT_NAK:
                    await this.portSelectNakHandler(socket, localAddress, msg);
                    break;
                case ADMIN_START:
                    await this.adminStartHandler(socket, localAddress);
                    break;
                case ADMIN_RESET:
                    this.adminResetHandler();
                    break;
                case ADMIN_DISCOVER:
                    await this.adminDiscoverHandler(localAddress, remote);
                    break;
                case ADMIN_DISCOVER_REPLY:
                    await this.adminDiscoverReplyhandler(socket, localAddress, msg);
                    break;
                // case ADMIN_RESULTS:
                //   await this.adminResultsHandler(localAddress, remote);
                //   break;
                default:
                    logger.warn(`Received an unknown message of type: ${msg.type}, ignoring`);
            }
        }
    }
}
exports.FluxGossipServer = FluxGossipServer;
exports.default = FluxGossipServer;
