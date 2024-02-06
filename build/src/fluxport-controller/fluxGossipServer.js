"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FluxGossipServer = exports.Msg = void 0;
const node_dgram_1 = __importDefault(require("node:dgram"));
const node_http_1 = require("node:http");
const promises_1 = require("node:dns/promises");
const axios_1 = __importDefault(require("axios"));
const fluxServer_1 = require("./fluxServer");
const fluxEchoServer_1 = require("./fluxEchoServer");
const nat_upnp_1 = require("@megachips/nat-upnp");
const log_1 = require("./log");
const util_1 = require("util");
const fs_1 = require("fs");
// this isn't the best, but should handle our data structures
function replacer(key, value) {
    if (value instanceof Map) {
        return {
            dataType: "Map",
            value: Array.from(value.entries())
        };
    }
    else {
        return value;
    }
}
function reviver(key, value) {
    if (typeof value === "object" && value !== null) {
        if (value.dataType === "Map") {
            return new Map(value.value);
        }
    }
    return value;
}
if (+process.versions.node.split(".")[0] < 17) {
    global.structuredClone = (val) => JSON.parse(JSON.stringify(val, replacer), reviver);
}
const logger = log_1.logController.getLogger();
const AXIOS_TIMEOUT = 3000; // ms
const ADDRESS_APIS = [
    "https://ifconfig.me",
    "https://checkip.amazonaws.com",
    "https://api.ipify.org"
];
var Msg;
(function (Msg) {
    // port messages
    Msg[Msg["PORT_DISCOVER"] = 0] = "PORT_DISCOVER";
    Msg[Msg["PORT_DISCOVER_REPLY"] = 1] = "PORT_DISCOVER_REPLY";
    Msg[Msg["PORT_SELECT"] = 2] = "PORT_SELECT";
    Msg[Msg["PORT_SELECT_ACK"] = 3] = "PORT_SELECT_ACK";
    Msg[Msg["PORT_SELECT_NAK"] = 4] = "PORT_SELECT_NAK";
    // peering messages
    Msg[Msg["PEERING_REQUEST"] = 5] = "PEERING_REQUEST";
    Msg[Msg["PEERING_REQUEST_ACK"] = 6] = "PEERING_REQUEST_ACK";
    Msg[Msg["PEERING_UPDATE"] = 7] = "PEERING_UPDATE";
    // chain discovery messages (remove)
    Msg[Msg["CHAIN_DISCOVER"] = 8] = "CHAIN_DISCOVER";
    Msg[Msg["CHAIN_DISCOVER_REPLY"] = 9] = "CHAIN_DISCOVER_REPLY";
    // development
    Msg[Msg["ADMIN_START"] = 10] = "ADMIN_START";
    Msg[Msg["ADMIN_RESET"] = 11] = "ADMIN_RESET";
    Msg[Msg["ADMIN_DISCOVER"] = 12] = "ADMIN_DISCOVER";
    Msg[Msg["ADMIN_DISCOVER_REPLY"] = 13] = "ADMIN_DISCOVER_REPLY";
})(Msg = exports.Msg || (exports.Msg = {}));
const ADMIN_MESSAGES = [
    Msg.PORT_SELECT_ACK,
    Msg.ADMIN_DISCOVER_REPLY
];
// nodeStates - move this to enum
const STARTING = "STARTING";
const DISCOVERING = "DISCOVERING";
const SELECTING = "SELECTING";
const READY = "READY";
const UNKNOWN = "UNKNOWN";
const TIMED_OUT = "TIMED_OUT";
const DISCONNECTING = "DISCONNECTING";
const DOWN = "DOWN";
const STARTING_STATE = {
    port: null,
    nodeState: STARTING
};
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
    peeringRequestTimeout = null;
    adminTimeout = null;
    pendingDiscoverId = null;
    pendingSelectId = null;
    pendingPeeringRequestId = null;
    upnpServiceUrl = null;
    localAddresses = [];
    myIp = null;
    addressApis;
    portToNodeMap = new Map();
    peeringRequestCounter = new Map();
    state = structuredClone(STARTING_STATE);
    networkState = {};
    nodeTimeouts = {};
    nodeConnectionCooldowns = new Map();
    multicastGroup;
    port;
    startDelay;
    firstResponderDelay;
    responseTimeoutMultiplier;
    responseTimeout;
    nodeStartupTimeout = 90;
    nodeDisconnectingTimeout = 30;
    nodeDownTimeout = 600;
    echoServer = null;
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
        this.port = options.port || 16137;
        this.multicastGroup = options.multicastGroup || "239.112.233.123";
        // weak equivalence includes null and undefined, we want to allow 0 here.
        this.startDelay = options.startDelay != null ? options.startDelay : 10;
        this.firstResponderDelay = options.firstResponderDelay || 1;
        this.responseTimeoutMultiplier = options.responseTimeoutMultiplier || 3;
        this.responseTimeout =
            this.firstResponderDelay * this.responseTimeoutMultiplier;
        this.upnpServiceUrl = options.upnpServiceUrl || null;
        this.addressApis = options.addressApis || ADDRESS_APIS;
        // use the upnpclient address for our interface
        // example Client({ url: "http://172.18.0.5:36211/rootDesc.xml" });
        // this is ugly. It's opening sockets out the gate
        this.upnpClient = new nat_upnp_1.Client({ cacheGateway: true });
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
    get ["networkConverged"]() {
        return Object.values(this.networkState).every((host) => host.nodeState === READY ||
            host.nodeState === DOWN ||
            host.nodeState === DISCONNECTING);
    }
    get ["nodeCount"]() {
        return Object.keys(this.networkState).length;
    }
    async getMyPublicIp() {
        let addressApi;
        let data = "";
        // for testing, we are able to pass in "testtx" for the txhash, in
        // this case - we know it's for testing / debug so we return a fake IP
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
    // nodesConnectedTo(target: string): Partial<NetworkState> {
    //   return this.filter(this.networkState, ([_, peer]) =>
    //     peer.outboundPeers.includes(target)
    //   );
    // }
    async start() {
        // Can't use UPnP public IP as that isn't guaranteed to be actual public IP.
        // we need the IP to be able to filter the deterministic node list for our
        // prior port and our siblings
        this.closed = false;
        const now = Date.now();
        if (!this.myIp || this.startedAt + 900 < now) {
            this.myIp = await this.getMyPublicIp();
            this.startedAt = now;
        }
        logger.info(`My ip is: ${this.myIp}`);
        // this now means the gossipserver is reliant on UPnP working as we're using the
        // interface provided by UPnP for multicast
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
        const gatewayIp = await (0, promises_1.lookup)(gatewayFqdn);
        this.emit("routerIpConfirmed", gatewayIp.address);
        // we only run on the interface that we are able to communicate with the
        // upnp gateway
        const upnpInterface = this.interfaces.find((int) => int.address === localAddress);
        // disabled, needs more dev / testing
        // if (this.mode !== "OBSERVE") this.createAndStartEchoServer(localAddress);
        // interface is guaranteed here
        this.sockets.push(this.runSocketServer(upnpInterface));
        return true;
    }
    createAndStartEchoServer(localAddress) {
        this.echoServer = new fluxEchoServer_1.FluxEchoServer({
            bindAddress: localAddress
        });
        this.echoServer.on("peerRemoved", async (peer, direction) => {
            if (direction == fluxEchoServer_1.Dir.INBOUND) {
                this.requestPeerConnections(localAddress);
                return;
            }
            // outbound peer
            if (this.networkState[peer].nodeState == "DISCONNECTING") {
                // sibling peer sent us an update that they have disconnected,
                // we will be running checks in tha peerstate handler
                return;
            }
            this.networkState[peer].nodeState = "DISCONNECTING";
            this.sendPeeringUpdate(localAddress, peer, "DISCONNECTING");
            this.nodeTimeouts[peer].set("nodeDisconnecting", setTimeout(() => this.checkDisconnectingPeer(peer, localAddress), this.nodeDisconnectingTimeout * 1000));
        });
        this.echoServer.on("peerTimeout", async (peer, seconds) => {
            logger.warn(`Peer: ${peer}, has been uncontactable for ${seconds} seconds`);
        });
        this.echoServer.on("peerConnected", (peer, direction) => {
            logger.info(`Peer: ${peer} connected. Direction: ${fluxEchoServer_1.Dir[direction]}`);
            if (direction === fluxEchoServer_1.Dir.OUTBOUND) {
                this.sendPeeringUpdate(localAddress, peer, "CONNECTED");
            }
        });
        this.echoServer.on("peerRejected", (peer) => {
            // don't connect for 5 minutes
            this.nodeConnectionCooldowns.set(peer, Date.now() + 300 * 1000);
            this.connectToPeers(localAddress);
        });
        this.echoServer.start();
    }
    stop() {
        // this is idempotent now
        this.upnpClient.close();
        super.stop();
    }
    /**
     * This is for the observer to send results to someone running tests. Only
     * run when mode is set to OBSERVER
     * @param port
     * The port to listen on
     */
    runAdminWebserver(port) {
        const requestListener = (req, res) => {
            res.writeHead(200, {
                "content-type": "application/json; charset=utf-8"
            });
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
        // for an observer, we bind on all addresses so we can receive multicast,
        // and also the unicast responses to ADMIN_DISCOVER
        const bindAddress = this.mode === "OBSERVE" ? undefined : this.multicastGroup;
        socket.on("message", (data, remote) => this.messageHandler(socket, iface.address, data, remote));
        socket.on("listening", async () => await this.initiate(socket, iface.address, sendDisover));
        socket.once("error", (err) => this.removeSocketServer(socket, err));
        logger.info(`Binding to ${this.port} on ${iface.address}`);
        // this will receive on multicast address only, not iface.address
        // (if you dont specify address, it will listen on both
        socket.bind(this.port, bindAddress);
        return socket;
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
        // this is for more DEVELOPMENT / PRODUCTION if in dev, don't send
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
                this.sendAdminDiscover(interfaceAddress);
            }, 60 * 1000);
            this.sendAdminStart(interfaceAddress);
        }
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
        const sortedNodes = this.sortHosts("DISCOVERING");
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
                // previously, we were going to usurp the port if the node didn't respond. However, if a
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
            this.restartTimeout = setTimeout(async () => {
                this.resetState();
                await this.initiate(socket, localAddress, true);
            }, 300 * 1000);
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
        // this.requestPeerConnections(localAddress, { converged: true });
    }
    resetState(resetMsgLog = true) {
        if (this.mode !== "OBSERVE") {
            this.discoverTimeout = null;
            this.pendingDiscoverId = null;
            this.portSelectTimeout = null;
            this.pendingSelectId = null;
            this.state = structuredClone(STARTING_STATE);
            this.networkState = {};
            // we call reset state if we get a PORT_SELECT_NAK. The nak handler resets
            // the state and reinitiates. However, if we are in DEVELOPMENT mode, we don't
            // want to wipe the state as, we want all the msgLogs for the observer
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
    // HELPERS //
    updateState(host, state) {
        if (!(host in this.networkState)) {
            this.networkState[host] = structuredClone(STARTING_STATE);
        }
        if (!(host in this.nodeTimeouts)) {
            this.nodeTimeouts[host] = new Map();
        }
        this.networkState[host] = { ...this.networkState[host], ...state };
    }
    /**
     * Helper function to sort ip addresses. Nodes use this as a tiebreaker
     * when more than one node is discovering
     * @returns string[]
     * Array of all hosts sorted from lowest to highest IP
     */
    sortHosts(stateFilter = null) {
        let filtered;
        if (stateFilter) {
            filtered = this.filter(this.networkState, ([_, host]) => host.nodeState === stateFilter);
        }
        else {
            filtered = this.networkState;
        }
        const sortedHosts = Object.keys(filtered).sort((a, b) => {
            const numA = this.ipv4ToNumber(a);
            const numB = this.ipv4ToNumber(b);
            return numA - numB;
        });
        return sortedHosts;
    }
    // type this
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
                    res = await upnpCall.call(this.upnpClient);
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
    // ADMIN (OBSERVER) FUNCTIONS //
    // type this better, this function is just for the observer
    createMessageFlows() {
        const aggregatedMsgTypes = {};
        for (const [node, msgHistory] of Object.entries(this.observerMsgHistory)) {
            const inboundMsgTypes = msgHistory.reduce((acc, next) => {
                if (next.direction === "INBOUND") {
                    if (!acc.length) {
                        acc.push(Msg[next.type]);
                        return acc;
                    }
                    // i.e PORT_SELECT_ACK x3
                    const last = acc[acc.length - 1].split(" ");
                    if (last[0] === Msg[next.type]) {
                        const counter = last[1] || "x1";
                        const newCount = +counter[1] + 1;
                        acc.pop();
                        acc.push(`${Msg[next.type]} x${newCount}`);
                    }
                    else {
                        acc.push(Msg[next.type]);
                    }
                }
                return acc;
            }, []);
            const outboundMsgTypes = msgHistory.reduce((acc, next) => {
                if (next.direction === "OUTBOUND")
                    acc.push(Msg[next.type]);
                return acc;
            }, []);
            aggregatedMsgTypes[node] = { INBOUND: inboundMsgTypes };
            aggregatedMsgTypes[node]["OUTBOUND"] = outboundMsgTypes;
        }
        return aggregatedMsgTypes;
    }
    deepEqual(x, y) {
        const ok = Object.keys, tx = typeof x, ty = typeof y;
        return x && y && tx === "object" && tx === ty
            ? ok(x).length === ok(y).length &&
                ok(x).every((key) => this.deepEqual(x[key], y[key]))
            : x === y;
    }
    // this function is just for the observer
    writeAdminResults(testId) {
        // aggregate data. Then write it. Then reset
        const resultKey = `Test ${testId}`;
        let msg;
        // check all network states are the same
        const anchorHost = Object.keys(this.observerNetworkStates)[0];
        const anchorState = this.observerNetworkStates[anchorHost];
        const states = Object.entries(this.observerNetworkStates).filter(([host, _]) => host !== anchorHost);
        const nodesConcur = states.every(([_, state]) => this.deepEqual(anchorState, state));
        // check that all ports are different (can use anchor state here,
        // as we confirm all states are the same)
        const ports = new Set(Object.values(anchorState).map((state) => state.port));
        const diversePorts = ports.size === 8 ? true : false;
        if (this.observerLastTestFailed) {
            // write full report
            msg = {
                [resultKey]: {
                    resultType: "Fail: Timeout before ACKs",
                    result: {
                        msgHistory: this.observerMsgHistory,
                        allNetworkStates: this.observerNetworkStates
                    }
                }
            };
        }
        else if (!nodesConcur) {
            msg = {
                [resultKey]: {
                    resultType: "Fail: Node states differ",
                    allNetworkStates: this.observerNetworkStates
                }
            };
        }
        else if (!diversePorts) {
            const msgFlows = this.createMessageFlows();
            msg = {
                [resultKey]: {
                    resulType: "Fail: Two or more nodes have the same port",
                    state: anchorState,
                    msgFlows: msgFlows
                }
            };
        }
        else {
            // check for any NAKs. If so provide list of each nodes message types.
            const nakFound = Object.values(this.observerMsgHistory).find((msgArr) => msgArr.find((x) => x.type === Msg.PORT_SELECT_NAK));
            if (nakFound) {
                const msgFlows = this.createMessageFlows();
                msg = {
                    [resultKey]: {
                        resultType: "Pass: PORT_SELECT_NAK found",
                        msgFlows: msgFlows
                    }
                };
            }
            else {
                msg = {
                    [resultKey]: {
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
    // OUTBOUND MESSAGES //
    sendDiscover(ifaceAddress) {
        // need to save pending discover???
        const msgId = this.generateId();
        const msg = { type: Msg.PORT_DISCOVER, id: msgId, host: ifaceAddress };
        this.sendMessageToSockets(msg);
        return msgId;
    }
    sendDiscoverReply(host, msgId) {
        // remove local timeouts from network state before transmission
        // const networkState: Record<string, Partial<State>> = {};
        // for (const [key, value] of Object.entries(this.networkState)) {
        //   const { timeouts: _, ...nodeState } = value;
        //   networkState[key] = nodeState;
        // }
        const msg = {
            type: Msg.PORT_DISCOVER_REPLY,
            id: msgId,
            host: host,
            networkState: this.networkState
        };
        this.sendMessageToSockets(msg);
    }
    sendPortSelect(ifaceAddress, port) {
        const msgId = this.generateId();
        const msg = {
            type: Msg.PORT_SELECT,
            id: msgId,
            host: ifaceAddress,
            port
        };
        this.sendMessageToSockets(msg);
        return msgId;
    }
    sendPortSelectAck(msgId, host, port) {
        const msg = {
            type: Msg.PORT_SELECT_ACK,
            id: msgId,
            host,
            port
        };
        this.sendMessageToSockets(msg);
    }
    sendPortSelectNak(msgId, host, port) {
        const msg = {
            type: Msg.PORT_SELECT_NAK,
            id: msgId,
            host,
            port
        };
        this.sendMessageToSockets(msg);
    }
    sendPeeringUpdate(host, peer, peerState) {
        const msg = {
            type: Msg.PEERING_UPDATE,
            id: this.generateId(),
            host,
            peer,
            peerState
        };
        this.sendMessageToSockets(msg);
    }
    sendPeeringRequest(msgId, host, peersRequired, outboundPeers) {
        const msg = {
            type: Msg.PEERING_REQUEST,
            id: msgId,
            host,
            peersRequired,
            outboundPeers
        };
        this.sendMessageToSockets(msg);
    }
    sendPeeringRequestAck(host, id, peer, connectTo = null) {
        const msg = {
            type: Msg.PEERING_REQUEST_ACK,
            id,
            host,
            peer,
            connectTo
        };
        this.sendMessageToSockets(msg);
    }
    sendAdminDiscover(host) {
        const msg = { type: Msg.ADMIN_DISCOVER, id: this.generateId(), host };
        this.sendMessageToSockets(msg);
    }
    sendAdminDiscoverReply(srcHost, dstHost) {
        /**
         * This is a special case. Sends unicast response back to Observer.
         */
        const msg = {
            type: Msg.ADMIN_DISCOVER_REPLY,
            id: this.generateId(),
            host: srcHost,
            networkState: this.networkState,
            msgLog: this.msgLog
        };
        this.sendMessageToSockets(msg, { address: dstHost });
    }
    sendAdminStart(localAddress) {
        const msg = {
            type: Msg.ADMIN_START,
            id: this.generateId(),
            host: localAddress
        };
        this.sendMessageToSockets(msg);
    }
    sendAdminReset(localAddress) {
        const msg = {
            type: Msg.ADMIN_RESET,
            id: this.generateId(),
            host: localAddress
        };
        this.sendMessageToSockets(msg);
    }
    sendMessageToSockets(msg, options = {}) {
        const targetAddress = options.address || this.multicastGroup;
        // avoid circular
        if (this.mode === "DEVELOPMENT" && msg.type !== Msg.ADMIN_DISCOVER_REPLY) {
            this.msgLog.push({
                ...structuredClone(msg),
                ...{ direction: "OUTBOUND" }
            });
        }
        const payload = this.preparePayload(msg, options.addSeparators);
        this.sockets.forEach((socket) => {
            logger.info(`Sending type: ${Msg[msg.type]} to: ${targetAddress}:${this.port}`);
            socket.send(payload, 0, payload.length, this.port, targetAddress);
        });
    }
    // INBOUND MESSAGE HANDLERS //
    async discoverHandler(msg) {
        this.networkState[msg.host] = {
            port: null,
            nodeState: DISCOVERING
        };
        const timeouts = new Map();
        this.nodeTimeouts[msg.host] = timeouts;
        timeouts.set("startUp", setTimeout(() => {
            for (const timeout of timeouts.values()) {
                clearTimeout(timeout);
            }
            delete this.networkState[msg.host];
        }, this.nodeStartupTimeout * 1000));
        await this.sleep(Math.random() * this.firstResponderDelay * 1000);
        if (this.unhandledMessages.has(msg.id)) {
            this.sendDiscoverReply(msg.host, msg.id);
            this.unhandledMessages.delete(msg.id);
        }
    }
    async discoverReplyHandler(
    /**
     * This only updates the state if the reply is for this node. Means that
     * we could be missing out on newer info. It's hard to tell if it's actually
     * newer without a timestamp. I've tried to avoid timestamps as there is no
     * guarantee the clocks are accurate - and for multicast on lan we need ms
     * resolution. Thought about NTP, but that gets ugly real quick.
     *
     * Quite easy to check is state is newer using enum. Since state only transitions
     * one way - can just use >. I.e. starting -> disocvering -> selecting -> ready
     */
    socket, localAddress, msg) {
        this.unhandledMessages.delete(msg.id);
        if (this.discoverTimeout && this.pendingDiscoverId === msg.id) {
            clearTimeout(this.discoverTimeout);
            this.discoverTimeout = null;
            this.pendingDiscoverId = null;
            // don't like this, move into update state function // or init state?
            // might be better just to spread this with existing state <shrug>
            // this includes ourselves
            // changed this to merge our state over the top. What I was happening
            // prior, is that we were getting newer state inbetween us receiveing the reply,
            // then we were overwriting it with the reply state. This way we keep the newest
            // state from both
            this.networkState = { ...msg.networkState, ...this.networkState };
            // so networkState references our local state
            this.networkState[localAddress] = this.state;
            Object.keys(this.networkState).forEach((node) => {
                if (!this.nodeTimeouts[node]) {
                    this.nodeTimeouts[node] = new Map();
                }
            });
            this.portSelect(socket, localAddress);
        }
    }
    async portSelectHandler(msg, localAddress) {
        let validPortSelect = false;
        if (this.portsAvailable.includes(msg.port)) {
            validPortSelect = true;
            this.updateState(msg.host, { port: msg.port, nodeState: SELECTING });
        }
        // between 0-1 seconds by default
        await this.sleep(Math.random() * this.firstResponderDelay * 1000);
        if (this.unhandledMessages.has(msg.id)) {
            this.unhandledMessages.delete(msg.id);
            if (validPortSelect) {
                this.updateState(msg.host, { port: msg.port, nodeState: READY });
                // we normally do this is portSelectAckHandler but we don't get there
                // if we are the one sending the ack, if we don't do this, node gets removed
                // out of networkState
                const nodeTimeout = this.nodeTimeouts[msg.host].get("startUp");
                if (nodeTimeout) {
                    clearTimeout(nodeTimeout);
                    this.nodeTimeouts[msg.host].delete(msg.host);
                }
                this.sendPortSelectAck(msg.id, msg.host, msg.port);
                // if (this.nodeCount <= 3) {
                //   this.connectToPeers(localAddress);
                // }
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
            return;
        }
        if (this.portSelectTimeout && this.pendingSelectId === msg.id) {
            clearTimeout(this.portSelectTimeout);
            // this should already be set in portSelect
            this.state.port = msg.port;
            this.portConfirm(localAddress);
        }
        else {
            this.updateState(msg.host, { port: msg.port, nodeState: READY });
            const nodeTimeout = this.nodeTimeouts[msg.host].get("startUp");
            if (nodeTimeout) {
                clearTimeout(nodeTimeout);
                this.nodeTimeouts[msg.host].delete(msg.host);
            }
        }
        // this.connectToPeers(localAddress);
        // this.requestPeerConnections(localAddress, { converged: true });
        // let the outbound connections happen first
        // setTimeout(() => this.requestPeerConnections(localAddress), 5 * 1000);
    }
    async connectToPeers(localAddress, options = {}) {
        logger.info("CONNECT TO PEERS");
        if (!this.echoServer || this.echoServer.outboundPeerCount >= 2)
            return;
        // this may not include ourselves, it probably should though
        // shouldn't start pinging until we are ready?!?
        const prospects = this.sortHosts("READY");
        const now = Date.now();
        for (const [node, cooldown] of this.nodeConnectionCooldowns) {
            if (cooldown <= now) {
                this.nodeConnectionCooldowns.delete(node);
            }
            else {
                prospects.splice(prospects.indexOf(node), 1);
            }
        }
        // we are the only node :(
        if (prospects.length === 1 && prospects[0] === localAddress) {
            return;
        }
        const peers = this.echoServer.outboundPeerAddresses;
        // should only be 0 or 1 peers
        peers.forEach((peer) => prospects.splice(prospects.indexOf(peer), 1));
        let myIndex = prospects.indexOf(localAddress);
        // rotate list so that we are allways at the start
        // the Array is at max 8
        while (myIndex > 0) {
            const first = prospects.shift();
            prospects.push(first);
            myIndex = prospects.indexOf(localAddress);
        }
        // remove ourselves, if we are in the list
        if (myIndex === 0) {
            prospects.splice(0, 1);
        }
        while (prospects.length && this.echoServer.outboundPeerCount < 2) {
            const prospect = prospects.shift();
            this.echoServer.addPeer(prospect, fluxEchoServer_1.Dir.OUTBOUND);
        }
        // selectPeers()
        // echoServer.addPeer()
        // setup listeners
        // do we care about timeouts or just disconnected
        // on connect / disconnect - send PEERING_UPDATE - just do disconnected for now
        // connected node should? get caught when they restart? are there cases where this
        // won't happen?
        // do we need the connects so we know who our sibling peer is?
        // {type: PEERING_UPDATE, peer: x.x.x.x, peerState: disconnected}
        // PEERING_UPDATE_ACK - whoever acks (the other node that has this peer) tries to connect, if that fails,
        // they try flux/uptime, if multicast fails but uptime good - it's multicast issue,
        // otherwise, node down.
    }
    async requestPeerConnections(localAddress, options = {}) {
        if (this.pendingPeeringRequestId)
            return;
        if (options.converged) {
            while (!this.networkConverged) {
                //
                await this.sleep(Math.random() * 3 * 1000);
            }
        }
        const inboundPeerCount = this.echoServer.inboundPeerCount;
        // if we already have enough connections, or there aren't enough peers to support
        // a new connection - bail
        if (inboundPeerCount >= 2 || this.nodeCount <= inboundPeerCount + 1)
            return;
        // if network convergence requested and all nodes aren't ready - bail
        // if (options.converged && !this.networkConverged) return;
        const msgId = this.generateId();
        // console.log("SENDING PEERING REQUEST FOR:", 2 - inboundPeerCount, "peers");
        this.sendPeeringRequest(msgId, localAddress, 2 - inboundPeerCount, this.echoServer.outboundPeerAddresses);
        // this needs a setTimeout to remove in case we don't get the inbound
        // peers
        this.pendingPeeringRequestId = msgId;
    }
    async portSelectNakHandler(socket, localAddress, msg) {
        this.unhandledMessages.delete(msg.id);
        if (this.portSelectTimeout && this.pendingSelectId === msg.id) {
            logger.warn("Our port request got NAKd... restarting in 10 seconds");
            clearTimeout(this.portSelectTimeout);
            this.portSelectTimeout = null;
            this.pendingSelectId = null;
            // wait 5 seconds (plus random 0-startDelay seconds in initiate call)
            this.restartTimeout = setTimeout(async () => {
                this.resetState(false);
                await this.initiate(socket, localAddress, true);
            }, 5 * 1000);
        }
        else {
            this.networkState[msg.host] = structuredClone(STARTING_STATE);
        }
    }
    clearNodeTimeouts(node) {
        const timeouts = this.nodeTimeouts[node];
        if (!timeouts)
            return;
        for (const timeout of timeouts.values()) {
            clearTimeout(timeout);
            timeouts.clear();
        }
    }
    createNodeDownCallback(peer) {
        this.clearNodeTimeouts(peer);
        this.nodeTimeouts[peer].set("nodeDown", setTimeout(() => {
            this.clearNodeTimeouts(peer);
            delete this.networkState[peer];
        }, this.nodeDownTimeout * 1000));
    }
    async peeringUpdateHandler(socket, localAddress, msg) {
        this.unhandledMessages.delete(msg.id);
        switch (msg.peerState) {
            case "DOWN":
                this.networkState[msg.peer].nodeState = "DOWN";
                // console.log(`Received node down message for node: ${msg.peer}`);
                this.createNodeDownCallback(msg.peer);
                break;
            case "CONNECTED":
                // console.log(`Node: ${msg.host} connected to Peer: ${msg.peer}`);
                // if it's not our node, this has no effect
                this.clearNodeTimeouts(msg.peer);
                break;
            case "DISCONNECTING":
                this.networkState[msg.peer].nodeState = "DISCONNECTING";
                this.checkDisconnectingPeer(msg.peer, localAddress);
                break;
            default:
                logger.warn(`Unknown peerState ${msg.peerState} received... ignoring`);
        }
        // console.log(
        //   "IN PEERING UPDATE POST HANDLERS",
        //   inspect(this.echoServer!.peerAddresses, INSPECT_OPTIONS)
        // );
        // if (!this.echoServer!.peerAddresses.includes(msg.peer)) return;
    }
    async checkDisconnectingPeer(peer, localAddress) {
        // console.log(`Running checks for disconnecting peer: ${peer}`);
        if (!this.echoServer.peerAvailable(peer)) {
            const inUse = await this.fluxportInUse(peer, this.networkState[peer].port);
            if (inUse) {
                logger.warn("Something fishy going on... Peer disconnected on multicast but available via /flux/uptime");
            }
            else {
                this.networkState[peer].nodeState = "DOWN";
                this.sendPeeringUpdate(localAddress, peer, "DOWN");
                this.createNodeDownCallback(peer);
            }
        }
    }
    async peeringRequestHandler(socket, localAddress, msg) {
        this.peeringRequestCounter.set(msg.id, msg.peersRequired);
        await this.sleep(Math.random() * this.firstResponderDelay * 1000);
        if (this.unhandledMessages.has(msg.id)) {
            // we are going to peer with this node, if we have 2 outbound already
            // we add connect to in the ack field. This tells the node that we are going
            // to connect to to connect to the node, it also tells that node to send us a ping nak,
            // so we remove the node as outbound.
            this.unhandledMessages.delete(msg.id);
            const outboundPeerCount = this.echoServer.outboundPeerCount;
            if (outboundPeerCount < 3 &&
                !this.echoServer.outboundPeerAddresses.includes(msg.host)) {
                let connectTo = null;
                if (outboundPeerCount === 2) {
                    // we will temporarily have 3 outbound peers, until the remote
                    // end sends us a PING_NAK
                    // we need to drop a peer, so we set connect to. We only drop a peer
                    // that the requesting node DOESN'T HAVE AS AN OUTBOUND PEER
                    let outbound = this.echoServer.outboundPeerAddresses;
                    if (this.peeringRequestCounter.get(msg.id) < msg.peersRequired) {
                        // outbound peer addresses are pre sorted lowest to highest
                        // another node has responded, we reverse our outbound peer addresses,
                        // otherwise we end up giving the same node to connect to
                        outbound.reverse();
                    }
                    connectTo = outbound.find((addr) => !msg.outboundPeers.includes(addr) || null);
                }
                // let other nodes know we will peer with the node
                this.sendPeeringRequestAck(localAddress, msg.id, msg.host, connectTo);
                if (msg.peersRequired === 1) {
                    this.peeringRequestCounter.delete(msg.id);
                }
                this.echoServer.addPeer(msg.host, fluxEchoServer_1.Dir.OUTBOUND);
            }
        }
        // this.peeringRequestCounter.delete(msg.id);
    }
    async peeringRequestAckHandler(msg, localAddress) {
        if (this.pendingPeeringRequestId === msg.id) {
            if (msg.connectTo) {
                this.echoServer.addPeer(msg.connectTo, fluxEchoServer_1.Dir.OUTBOUND);
            }
            if (this.echoServer.inboundPeerCount >= 2) {
                this.pendingPeeringRequestId = null;
                this.unhandledMessages.delete(msg.id);
            }
        }
        // if a node has just started and this is the first message they have received
        if (!this.peeringRequestCounter.has(msg.id))
            return;
        // the sender of this message wants us to drop him so the originator of the peering
        // request can connect to us
        if (msg.connectTo === localAddress) {
            this.echoServer.addTransition(msg.host, msg.peer);
        }
        // should always be 2 or 1
        const requestsRemaining = this.peeringRequestCounter.get(msg.id) - 1;
        if (!requestsRemaining) {
            this.unhandledMessages.delete(msg.id);
            this.peeringRequestCounter.delete(msg.id);
        }
        else {
            this.peeringRequestCounter.set(msg.id, requestsRemaining);
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
            logger.info("Writing results and resetting nodes...");
            this.writeAdminResults(this.observerTestId);
            this.sendAdminReset(localAddress);
            this.resetState();
            this.observerTestId++;
            // no await, I think it makes sense here
            this.initiate(socket, localAddress, false);
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
            logger.info(`Received type: ${Msg[msg.type]} from: ${remote.address}:${remote.port}`);
            switch (this.mode) {
                case "PRODUCTION":
                    break;
                case "DEVELOPMENT":
                    // need to clone the object here otherwise, all msgLogs all reference
                    // the same networkState. Think this is only available in > node 18
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
                case Msg.PORT_DISCOVER:
                    await this.discoverHandler(msg);
                    break;
                case Msg.PORT_DISCOVER_REPLY:
                    await this.discoverReplyHandler(socket, localAddress, msg);
                    break;
                case Msg.PORT_SELECT:
                    await this.portSelectHandler(msg, localAddress);
                    break;
                case Msg.PORT_SELECT_ACK:
                    await this.portSelectAckHandler(localAddress, msg);
                    break;
                case Msg.PORT_SELECT_NAK:
                    await this.portSelectNakHandler(socket, localAddress, msg);
                    break;
                case Msg.PEERING_UPDATE:
                    // console.log("RECEIVING", inspect(msg, INSPECT_OPTIONS));
                    await this.peeringUpdateHandler(socket, localAddress, msg);
                    break;
                case Msg.PEERING_REQUEST:
                    await this.peeringRequestHandler(socket, localAddress, msg);
                    break;
                case Msg.PEERING_REQUEST_ACK:
                    await this.peeringRequestAckHandler(msg, localAddress);
                    break;
                case Msg.ADMIN_START:
                    await this.adminStartHandler(socket, localAddress);
                    break;
                case Msg.ADMIN_RESET:
                    this.adminResetHandler();
                    break;
                case Msg.ADMIN_DISCOVER:
                    await this.adminDiscoverHandler(localAddress, remote);
                    break;
                case Msg.ADMIN_DISCOVER_REPLY:
                    await this.adminDiscoverReplyhandler(socket, localAddress, msg);
                    break;
                default:
                    logger.warn(`Received an unknown message of type: ${msg.type}, ignoring`);
            }
        }
    }
}
exports.FluxGossipServer = FluxGossipServer;
exports.default = FluxGossipServer;
// timeouts
// startUp
// nodeDisconnected
// nodeDown
// reconnection
