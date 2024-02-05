import dgram, { Socket } from "node:dgram";
import { AddressInfo } from "node:net";
import os from "node:os";
import nodeTimersPromises from "node:timers/promises";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { lookup } from "node:dns/promises";

import axios, { AxiosResponse } from "axios";
import { FluxServer, ServerOptions, Message, ServerError } from "./fluxServer";
import { FluxEchoServer, Dir } from "./fluxEchoServer";
import { Client as UpnpClient } from "@megachips/nat-upnp";
import { logController } from "./log";

import { inspect } from "util";
import { readFileSync, writeFileSync } from "fs";

// this isn't the best, but should handle our data structures

function replacer(key: any, value: any) {
  if (value instanceof Map) {
    return {
      dataType: "Map",
      value: Array.from(value.entries())
    };
  } else {
    return value;
  }
}

function reviver(key: any, value: any) {
  if (typeof value === "object" && value !== null) {
    if (value.dataType === "Map") {
      return new Map(value.value);
    }
  }
  return value;
}

if (+process.versions.node.split(".")[0] < 17) {
  global.structuredClone = (val: any) =>
    JSON.parse(JSON.stringify(val, replacer), reviver);
}

const logger = logController.getLogger();

const AXIOS_TIMEOUT = 3000; // ms
const ADDRESS_APIS = [
  "https://ifconfig.me",
  "https://checkip.amazonaws.com",
  "https://api.ipify.org"
];

export enum Msg {
  // port messages
  PORT_DISCOVER,
  PORT_DISCOVER_REPLY,
  PORT_SELECT,
  PORT_SELECT_ACK,
  PORT_SELECT_NAK,
  // peering messages
  PEERING_REQUEST,
  PEERING_REQUEST_ACK,
  PEERING_UPDATE,
  // chain discovery messages (remove)
  CHAIN_DISCOVER,
  CHAIN_DISCOVER_REPLY,
  // development
  ADMIN_START,
  ADMIN_RESET,
  ADMIN_DISCOVER,
  ADMIN_DISCOVER_REPLY
}

const ADMIN_MESSAGES: AdminMessages[] = [
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

const STARTING_STATE: State = {
  port: null,
  nodeState: STARTING
};

const INSPECT_OPTIONS = { showHidden: false, depth: null, colors: true };

export class FluxGossipServer extends FluxServer {
  MESSAGE_SEPARATOR = "?#!%%!#?";
  private readonly allFluxports: fluxPorts[] = [
    16197, 16187, 16177, 16167, 16157, 16147, 16137, 16127
  ];

  restartTimeout: NodeJS.Timeout | null = null;
  discoverTimeout: NodeJS.Timeout | null = null;
  portSelectTimeout: NodeJS.Timeout | null = null;
  peeringRequestTimeout: NodeJS.Timeout | null = null;
  adminTimeout: NodeJS.Timeout | null = null;

  pendingDiscoverId: string | null = null;
  pendingSelectId: string | null = null;
  pendingPeeringRequestId: string | null = null;

  private upnpServiceUrl: string | null = null;
  private localAddresses: string[] = [];

  myIp: string | null = null;
  private addressApis: string[];

  portToNodeMap: Map<number, string> = new Map();
  peeringRequestCounter: Map<string, number> = new Map();

  state: State = structuredClone(STARTING_STATE);
  networkState: NetworkState = {};
  nodeTimeouts: Record<string, Map<string, NodeJS.Timeout>> = {};
  nodeConnectionCooldowns: Map<string, number> = new Map();

  private multicastGroup: string;
  private port: number;

  private startDelay: number;
  private firstResponderDelay: number;
  private responseTimeoutMultiplier: number;
  private responseTimeout: number;

  private nodeStartupTimeout: number = 90;
  private nodeDisconnectingTimeout: number = 30;
  private nodeDownTimeout: number = 600;

  private echoServer: FluxEchoServer | null = null;

  mode: ServerMode;
  msgLog: Message[] | null = null;
  observerMsgHistory: Record<string, AdminMessage[]> | null = null;
  observerNetworkStates: Record<string, NetworkState> | null = null;
  observerNodeCount: number | null = null;
  observerAckedPorts: Set<fluxPorts> | null = null;
  observerTestId: number = 0;
  observerTestCount: number | null = null;
  observerLastTestFailed: boolean = false;

  upnpClient: UpnpClient;

  startedAt: number = 0;

  constructor(private outPoint: OutPoint, options: GossipServerOptions = {}) {
    super();

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
    this.upnpClient = new UpnpClient({ cacheGateway: true });

    switch (this.mode) {
      case "PRODUCTION":
        break;
      case "DEVELOPMENT":
        this.msgLog = [];
        break;
      case "OBSERVE":
        if (!options.observerNodeCount) {
          throw new ServerError(
            "observerNodeCount must be provided if using OBSERVE mode"
          );
        }
        this.observerNodeCount = options.observerNodeCount;
        this.observerMsgHistory = {};
        this.observerNetworkStates = {};
        this.observerAckedPorts = new Set();
        this.observerTestCount = options.observerTestCount || 5;
        // clear out results file (create if not exist)
        writeFileSync("results.json", "{}");
        this.runAdminWebserver(this.port);
        break;
      default:
        throw new ServerError(`Unknown server mode: ${this.mode}`);
    }

    logger.debug(`Start delay: ${this.startDelay}`);
    logger.debug(`firstResponderDelay: ${this.firstResponderDelay}`);
    logger.debug(
      `responseTimeoutMultiplier: ${this.responseTimeoutMultiplier}`
    );
    logger.debug(`responseTimeout: ${this.responseTimeout}`);
  }

  get ["portsAvailable"](): fluxPorts[] {
    const usedPorts = Object.values(this.networkState)
      .filter(
        (host) =>
          (host.nodeState === SELECTING ||
            host.nodeState === READY ||
            host.nodeState === UNKNOWN) &&
          typeof host.port === "number"
      )
      .map((host) => host.port);
    return this.allFluxports.filter((port) => !usedPorts.includes(port));
  }

  get ["networkConverged"](): boolean {
    return Object.values(this.networkState).every(
      (host) =>
        host.nodeState === READY ||
        host.nodeState === DOWN ||
        host.nodeState === DISCONNECTING
    );
  }

  get ["nodeCount"](): number {
    return Object.keys(this.networkState).length;
  }

  async getMyPublicIp(): Promise<string> {
    let addressApi: string | undefined;
    let data: string = "";

    // for testing, we are able to pass in "testtx" for the txhash, in
    // this case - we know it's for testing / debug so we return a fake IP
    if (this.outPoint.txhash == "testtx") {
      return "10.10.10.10";
    }

    while (!data) {
      addressApi = this.addressApis.shift();
      this.addressApis.push(addressApi!);
      try {
        ({ data } = await axios.get(addressApi!, { timeout: AXIOS_TIMEOUT }));
      } catch (err) {
        logger.warn(
          `Error getting IP address from ${addressApi}, switching...`
        );
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

  async start(): Promise<boolean> {
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

    const gatewayResponse = await this.runUpnpRequest(
      this.upnpClient.getGateway
    );

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
    const gatewayIp = await lookup(gatewayFqdn);

    this.emit("routerIpConfirmed", gatewayIp.address);

    // we only run on the interface that we are able to communicate with the
    // upnp gateway
    const upnpInterface = this.interfaces.find(
      (int) => int.address === localAddress
    );

    // disabled, needs more dev / testing
    // if (this.mode !== "OBSERVE") this.createAndStartEchoServer(localAddress);

    // interface is guaranteed here
    this.sockets.push(this.runSocketServer(upnpInterface!));
    return true;
  }

  createAndStartEchoServer(localAddress: string) {
    this.echoServer = new FluxEchoServer({
      bindAddress: localAddress
    });

    this.echoServer.on("peerRemoved", async (peer, direction) => {
      if (direction == Dir.INBOUND) {
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

      this.nodeTimeouts[peer].set(
        "nodeDisconnecting",
        setTimeout(
          () => this.checkDisconnectingPeer(peer, localAddress),
          this.nodeDisconnectingTimeout * 1000
        )
      );
    });

    this.echoServer.on("peerTimeout", async (peer, seconds) => {
      logger.warn(
        `Peer: ${peer}, has been uncontactable for ${seconds} seconds`
      );
    });

    this.echoServer.on("peerConnected", (peer, direction) => {
      logger.info(`Peer: ${peer} connected. Direction: ${Dir[direction]}`);
      if (direction === Dir.OUTBOUND) {
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

  stop(): void {
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
  runAdminWebserver(port: number): void {
    const requestListener = (req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8"
      });

      const results = JSON.parse(readFileSync("results.json").toString());

      res.end(JSON.stringify(results));
    };

    const server = createServer(requestListener);
    // all interfaces
    server.listen(port, () => {
      logger.info(`Admin server is running on http://0.0.0.0:${port}`);
    });
  }

  runSocketServer(iface: os.NetworkInterfaceInfo): Socket {
    this.localAddresses.push(iface.address);
    this.networkState[iface.address] = this.state;

    const socket: FluxSocket = dgram.createSocket("udp4");

    const sendDisover = this.mode === "PRODUCTION";
    // for an observer, we bind on all addresses so we can receive multicast,
    // and also the unicast responses to ADMIN_DISCOVER
    const bindAddress =
      this.mode === "OBSERVE" ? undefined : this.multicastGroup;

    socket.on("message", (data, remote) =>
      this.messageHandler(socket, iface.address, data, remote)
    );
    socket.on(
      "listening",
      async () => await this.initiate(socket, iface.address, sendDisover)
    );
    socket.once("error", (err) => this.removeSocketServer(socket, err));

    logger.info(`Binding to ${this.port} on ${iface.address}`);
    // this will receive on multicast address only, not iface.address
    // (if you dont specify address, it will listen on both
    socket.bind(this.port, bindAddress);

    return socket;
  }

  async initiate(
    socket: FluxSocket,
    interfaceAddress: string,
    sendDiscover: boolean
  ): Promise<void> {
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
      this.discoverTimeout = setTimeout(
        async () => await this.portSelect(socket, interfaceAddress),
        this.responseTimeout * 1000
      );
    }

    if (this.mode === "OBSERVE") {
      if (this.observerTestId >= this.observerTestCount!) {
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

  async portSelect(socket: Socket, localAddress: string): Promise<void> {
    let selectedPort: fluxPorts | null = null;
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
      if (priorPort && portsAvailable.includes(priorPort as fluxPorts)) {
        const priorIndex = this.portsAvailable.indexOf(priorPort as fluxPorts);
        selectedPort = portsAvailable.splice(priorIndex, 1)[0];
        logger.info(
          `Prior port ${selectedPort} found and available, selecting`
        );
      } else {
        // check router port mappings
        selectedPort = this.getPortFromNode(localAddress);

        if (selectedPort) {
          logger.info(
            `Port ${selectedPort} found in router mapping table for our IP, selecting`
          );
        } else {
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
        logger.warn(
          `Our selected port already has a mapping for ${collisionIp}, checking if node live`
        );
        if (await this.fluxportInUse(collisionIp, selectedPort)) {
          logger.warn(
            `Fluxnode responded at http://${collisionIp}:${selectedPort}/flux/uptime, marking port as used`
          );
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
      this.portSelectTimeout = setTimeout(
        () => this.portConfirm(localAddress, true),
        this.responseTimeout * 1000
      );
    } else {
      logger.error("No free ports... will try again in 5 minutes");
      this.restartTimeout = setTimeout(async () => {
        this.resetState();
        await this.initiate(socket, localAddress, true);
      }, 300 * 1000);
    }
  }

  portConfirm(localAddress: string, sendPortSelectAck: boolean = false): void {
    this.portSelectTimeout = null;
    this.pendingSelectId = null;
    this.state.nodeState = READY;

    logger.info(`Port confirmed: ${this.state.port}`);

    // this happens when the node hits the portSelectTimeout (i.e. there are
    // no other nodes) This is a courtesy message for an observer, or starting node.
    if (sendPortSelectAck) {
      this.sendPortSelectAck(this.generateId(), localAddress, this.state.port!);
    }

    this.emit("portConfirmed", this.state.port!);

    logger.info(inspect(this.networkState, INSPECT_OPTIONS));

    // this.requestPeerConnections(localAddress, { converged: true });
  }

  resetState(resetMsgLog: boolean = true): void {
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
    } else {
      this.observerMsgHistory = {};
      this.observerNetworkStates = {};
      this.observerAckedPorts = new Set();
      this.observerLastTestFailed = false;
    }
  }

  async fluxnodePriorPort(): Promise<number | null> {
    // this happens on development mode. Don't spam api.
    if (this.outPoint.txhash == "testtx") {
      return null;
    }

    logger.info("Checking for prior confirmed port via flux api");
    const url = `https://api.runonflux.io/daemon/viewdeterministiczelnodelist?filter=${this.myIp}`;
    let data: any = null;
    while (!data) {
      try {
        ({ data } = await axios.get(url, { timeout: AXIOS_TIMEOUT }));
      } catch (err) {
        logger.warn(
          `Error getting fluxnode deterministic list for my ip: ${this.myIp}, retrying`
        );
        await this.sleep(1 * 1000);
      }
      if (data?.status === "success") {
        data = data.data;
      } else {
        data = null;
      }
    }

    const thisNode = data.find(
      (node: any) =>
        node.txhash == this.outPoint.txhash &&
        node.outidx == this.outPoint.outidx
    );

    if (thisNode) {
      let [_, port] = thisNode.ip.split(":");
      return +port || 16127;
    }

    return null;
  }

  async fluxportInUse(ip: string, port: number): Promise<boolean> {
    // call that ip on that port for flux/uptime endpoint
    const url = `http://${ip}:${port}/flux/uptime`;
    let attempts = 0;
    let res: AxiosResponse | null = null;

    while (attempts < 3) {
      attempts++;
      try {
        res = await axios.get(url, { timeout: 1000 });
      } catch (err) {
        logger.warn(
          `No response on ${url}, ${3 - attempts} attempts remaining`
        );
        continue;
      }
    }

    if (res && res.status === 200) {
      // some other node is live on this port
      return true;
    }
    return false;
  }

  resetTimers(): void {
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

  updateState(host: string, state: Partial<State>): void {
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
  sortHosts(stateFilter: NodeState | null = null): string[] {
    let filtered;

    if (stateFilter) {
      filtered = this.filter(
        this.networkState,
        ([_, host]) => host.nodeState === stateFilter
      );
    } else {
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
  async runUpnpRequest(upnpCall: () => Promise<any>): Promise<any> {
    let res;
    try {
      res = await upnpCall.call(this.upnpClient);
    } catch (err1) {
      logger.warn(
        `Unable to run upnp request: ${err1}. Will try again without SSDP if possible`
      );
      let errMsg: string = "";
      if (
        this.upnpServiceUrl &&
        err1 instanceof Error &&
        /Connection timed out/.test(err1.message)
      ) {
        // skip SSDP (multicast) and use cached router url
        this.upnpClient.url = this.upnpServiceUrl;
        try {
          res = await upnpCall.call(this.upnpClient);
        } catch (err2) {
          // we tried, we failed, reset
          this.upnpClient.url = null;
          logger.warn(`Unable to run upnp request: ${err2}.`);
          errMsg = err2 instanceof Error ? err2.message : (err2 as string);
        }
      }
      if (!errMsg) {
        errMsg = err1 instanceof Error ? err1.message : (err1 as string);
      }
      this.emit("upnpError", errMsg);
    }
    return res;
  }

  getPortFromNode(nodeIp: string): fluxPorts | null {
    for (let [key, value] of this.portToNodeMap.entries()) {
      if (value === nodeIp) return key as fluxPorts;
    }
    return null;
  }

  async updatePortToNodeMap(): Promise<void> {
    const allMappings = await this.runUpnpRequest(this.upnpClient.getMappings);

    if (!allMappings) return;

    for (const mapping of allMappings) {
      // we only care about Flux tcp maps
      if (mapping.protocol !== "tcp") continue;

      if (this.allFluxports.includes(mapping.public.port as fluxPorts)) {
        this.portToNodeMap.set(mapping.public.port, mapping.private.host);
      }
    }
  }

  // ADMIN (OBSERVER) FUNCTIONS //

  // type this better, this function is just for the observer
  createMessageFlows(): Record<string, Record<string, string[]>> {
    const aggregatedMsgTypes: Record<string, Record<string, string[]>> = {};
    for (const [node, msgHistory] of Object.entries(this.observerMsgHistory!)) {
      const inboundMsgTypes = msgHistory.reduce<string[]>((acc, next) => {
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
          } else {
            acc.push(Msg[next.type]);
          }
        }
        return acc;
      }, []);
      const outboundMsgTypes = msgHistory.reduce<string[]>((acc, next) => {
        if (next.direction === "OUTBOUND") acc.push(Msg[next.type]);
        return acc;
      }, []);

      aggregatedMsgTypes[node] = { INBOUND: inboundMsgTypes };
      aggregatedMsgTypes[node]["OUTBOUND"] = outboundMsgTypes;
    }
    return aggregatedMsgTypes;
  }

  deepEqual(x: any, y: any): boolean {
    const ok = Object.keys,
      tx = typeof x,
      ty = typeof y;
    return x && y && tx === "object" && tx === ty
      ? ok(x).length === ok(y).length &&
          ok(x).every((key) => this.deepEqual(x[key], y[key]))
      : x === y;
  }

  // this function is just for the observer
  writeAdminResults(testId: number): void {
    // aggregate data. Then write it. Then reset
    const resultKey = `Test ${testId}`;
    let msg: any;

    // check all network states are the same
    const anchorHost = Object.keys(this.observerNetworkStates!)[0];
    const anchorState = this.observerNetworkStates![anchorHost];

    const states = Object.entries(this.observerNetworkStates!).filter(
      ([host, _]) => host !== anchorHost
    );

    const nodesConcur = states.every(([_, state]) =>
      this.deepEqual(anchorState, state)
    );

    // check that all ports are different (can use anchor state here,
    // as we confirm all states are the same)
    const ports = new Set(
      Object.values(anchorState).map((state) => state.port)
    );

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
    } else if (!nodesConcur) {
      msg = {
        [resultKey]: {
          resultType: "Fail: Node states differ",
          allNetworkStates: this.observerNetworkStates
        }
      };
    } else if (!diversePorts) {
      const msgFlows = this.createMessageFlows();
      msg = {
        [resultKey]: {
          resulType: "Fail: Two or more nodes have the same port",
          state: anchorState,
          msgFlows: msgFlows
        }
      };
    } else {
      // check for any NAKs. If so provide list of each nodes message types.
      const nakFound = Object.values(this.observerMsgHistory!).find((msgArr) =>
        msgArr.find((x) => x.type === Msg.PORT_SELECT_NAK)
      );
      if (nakFound) {
        const msgFlows = this.createMessageFlows();
        msg = {
          [resultKey]: {
            resultType: "Pass: PORT_SELECT_NAK found",
            msgFlows: msgFlows
          }
        };
      } else {
        msg = {
          [resultKey]: {
            resultType: "Pass: Success"
          }
        };
      }
    }
    this.writeDataToJsonFile(msg);
  }

  writeDataToJsonFile(data: any): void {
    let previousResults = JSON.parse(readFileSync("results.json").toString());
    if (!previousResults) {
      previousResults = {};
    }
    const merged = { ...previousResults, ...data };

    writeFileSync("results.json", JSON.stringify(merged));
  }

  // OUTBOUND MESSAGES //

  sendDiscover(ifaceAddress: string): string {
    // need to save pending discover???
    const msgId = this.generateId();
    const msg = { type: Msg.PORT_DISCOVER, id: msgId, host: ifaceAddress };
    this.sendMessageToSockets(msg);
    return msgId;
  }

  sendDiscoverReply(host: string, msgId: string): void {
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

  sendPortSelect(ifaceAddress: string, port: number): string {
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

  sendPortSelectAck(msgId: string, host: string, port: number): void {
    const msg = {
      type: Msg.PORT_SELECT_ACK,
      id: msgId,
      host,
      port
    };
    this.sendMessageToSockets(msg);
  }

  sendPortSelectNak(msgId: string, host: string, port: number): void {
    const msg = {
      type: Msg.PORT_SELECT_NAK,
      id: msgId,
      host,
      port
    };
    this.sendMessageToSockets(msg);
  }

  sendPeeringUpdate(
    host: string,
    peer: string,
    peerState: "CONNECTED" | "TIMED_OUT" | "DISCONNECTING" | "DOWN"
  ) {
    const msg = {
      type: Msg.PEERING_UPDATE,
      id: this.generateId(),
      host,
      peer,
      peerState
    };
    this.sendMessageToSockets(msg);
  }

  sendPeeringRequest(
    msgId: string,
    host: string,
    peersRequired: number,
    outboundPeers: string[]
  ) {
    const msg = {
      type: Msg.PEERING_REQUEST,
      id: msgId,
      host,
      peersRequired,
      outboundPeers
    };
    this.sendMessageToSockets(msg);
  }

  sendPeeringRequestAck(
    host: string,
    id: string,
    peer: string,
    connectTo: string | null = null
  ) {
    const msg = {
      type: Msg.PEERING_REQUEST_ACK,
      id,
      host,
      peer,
      connectTo
    };
    this.sendMessageToSockets(msg);
  }

  sendAdminDiscover(host: string) {
    const msg = { type: Msg.ADMIN_DISCOVER, id: this.generateId(), host };
    this.sendMessageToSockets(msg);
  }

  sendAdminDiscoverReply(srcHost: string, dstHost: string) {
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

  sendAdminStart(localAddress: string) {
    const msg = {
      type: Msg.ADMIN_START,
      id: this.generateId(),
      host: localAddress
    };
    this.sendMessageToSockets(msg);
  }

  sendAdminReset(localAddress: string) {
    const msg = {
      type: Msg.ADMIN_RESET,
      id: this.generateId(),
      host: localAddress
    };
    this.sendMessageToSockets(msg);
  }

  sendMessageToSockets(msg: Message, options: sendMessageOptions = {}): void {
    const targetAddress = options.address || this.multicastGroup;
    // avoid circular
    if (this.mode === "DEVELOPMENT" && msg.type !== Msg.ADMIN_DISCOVER_REPLY) {
      this.msgLog!.push({
        ...structuredClone(msg),
        ...{ direction: "OUTBOUND" }
      });
    }

    const payload = this.preparePayload(msg, options.addSeparators);
    this.sockets.forEach((socket) => {
      logger.info(
        `Sending type: ${Msg[msg.type]} to: ${targetAddress}:${this.port}`
      );
      socket.send(payload, 0, payload.length, this.port, targetAddress);
    });
  }

  // INBOUND MESSAGE HANDLERS //

  async discoverHandler(msg: Message): Promise<void> {
    this.networkState[msg.host] = {
      port: null,
      nodeState: DISCOVERING
    };

    const timeouts = new Map();
    this.nodeTimeouts[msg.host] = timeouts;

    timeouts.set(
      "startUp",
      setTimeout(() => {
        for (const timeout of timeouts.values()) {
          clearTimeout(timeout);
        }
        delete this.networkState[msg.host];
      }, this.nodeStartupTimeout * 1000)
    );

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
    socket: Socket,
    localAddress: string,
    msg: DiscoverReplyMessage
  ): Promise<void> {
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

  async portSelectHandler(
    msg: PortSelectMessage,
    localAddress: string
  ): Promise<void> {
    let validPortSelect = false;

    if (this.portsAvailable.includes(msg.port as fluxPorts)) {
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
      } else {
        this.sendPortSelectNak(msg.id, msg.host, msg.port);
      }
    }
  }

  async portSelectAckHandler(
    localAddress: string,
    msg: PortSelectMessage
  ): Promise<void> {
    this.unhandledMessages.delete(msg.id);

    if (this.mode === "OBSERVE") {
      this.observerAckedPorts!.add(msg.port as fluxPorts);
      if (this.observerAckedPorts!.size === this.observerNodeCount) {
        logger.info(
          "Acked ports matches node count... sending admin discover in 5s..."
        );
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
    } else {
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

  async connectToPeers(
    localAddress: string,
    options: { exclude?: string } = {}
  ): Promise<void> {
    logger.info("CONNECT TO PEERS");

    if (!this.echoServer || this.echoServer.outboundPeerCount >= 2) return;

    // this may not include ourselves, it probably should though
    // shouldn't start pinging until we are ready?!?
    const prospects = this.sortHosts("READY");

    const now = Date.now();
    for (const [node, cooldown] of this.nodeConnectionCooldowns) {
      if (cooldown <= now) {
        this.nodeConnectionCooldowns.delete(node);
      } else {
        prospects.splice(prospects.indexOf(node), 1);
      }
    }

    // we are the only node :(
    if (prospects.length === 1 && prospects[0] === localAddress) {
      return;
    }

    const peers = this.echoServer!.outboundPeerAddresses;

    // should only be 0 or 1 peers
    peers.forEach((peer) => prospects.splice(prospects.indexOf(peer), 1));

    let myIndex = prospects.indexOf(localAddress);

    // rotate list so that we are allways at the start
    // the Array is at max 8
    while (myIndex > 0) {
      const first = prospects.shift()!;
      prospects.push(first);
      myIndex = prospects.indexOf(localAddress);
    }

    // remove ourselves, if we are in the list
    if (myIndex === 0) {
      prospects.splice(0, 1);
    }

    while (prospects.length && this.echoServer!.outboundPeerCount < 2) {
      const prospect = prospects.shift()!;
      this.echoServer!.addPeer(prospect, Dir.OUTBOUND);
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

  async requestPeerConnections(
    localAddress: string,
    options: { converged?: boolean } = {}
  ) {
    if (this.pendingPeeringRequestId) return;

    if (options.converged) {
      while (!this.networkConverged) {
        //
        await this.sleep(Math.random() * 3 * 1000);
      }
    }

    const inboundPeerCount = this.echoServer!.inboundPeerCount;

    // if we already have enough connections, or there aren't enough peers to support
    // a new connection - bail
    if (inboundPeerCount >= 2 || this.nodeCount <= inboundPeerCount + 1) return;

    // if network convergence requested and all nodes aren't ready - bail
    // if (options.converged && !this.networkConverged) return;

    const msgId = this.generateId();
    // console.log("SENDING PEERING REQUEST FOR:", 2 - inboundPeerCount, "peers");
    this.sendPeeringRequest(
      msgId,
      localAddress,
      2 - inboundPeerCount,
      this.echoServer!.outboundPeerAddresses
    );
    // this needs a setTimeout to remove in case we don't get the inbound
    // peers
    this.pendingPeeringRequestId = msgId;
  }

  async portSelectNakHandler(
    socket: Socket,
    localAddress: string,
    msg: PortSelectMessage
  ): Promise<void> {
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
    } else {
      this.networkState[msg.host] = structuredClone(STARTING_STATE);
    }
  }

  clearNodeTimeouts(node: string) {
    const timeouts = this.nodeTimeouts[node];

    if (!timeouts) return;

    for (const timeout of timeouts.values()) {
      clearTimeout(timeout);
      timeouts.clear();
    }
  }

  createNodeDownCallback(peer: string): void {
    this.clearNodeTimeouts(peer);
    this.nodeTimeouts[peer].set(
      "nodeDown",
      setTimeout(() => {
        this.clearNodeTimeouts(peer);
        delete this.networkState[peer];
      }, this.nodeDownTimeout * 1000)
    );
  }

  async peeringUpdateHandler(
    socket: Socket,
    localAddress: string,
    msg: PeeringUpdateMessage
  ) {
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

  async checkDisconnectingPeer(peer: string, localAddress: string) {
    // console.log(`Running checks for disconnecting peer: ${peer}`);
    if (!this.echoServer!.peerAvailable(peer)) {
      const inUse = await this.fluxportInUse(
        peer,
        this.networkState[peer].port!
      );

      if (inUse) {
        logger.warn(
          "Something fishy going on... Peer disconnected on multicast but available via /flux/uptime"
        );
      } else {
        this.networkState[peer].nodeState = "DOWN";
        this.sendPeeringUpdate(localAddress, peer, "DOWN");
        this.createNodeDownCallback(peer);
      }
    }
  }

  async peeringRequestHandler(
    socket: Socket,
    localAddress: string,
    msg: PeeringRequestMessage
  ) {
    this.peeringRequestCounter.set(msg.id, msg.peersRequired);
    await this.sleep(Math.random() * this.firstResponderDelay * 1000);

    if (this.unhandledMessages.has(msg.id)) {
      // we are going to peer with this node, if we have 2 outbound already
      // we add connect to in the ack field. This tells the node that we are going
      // to connect to to connect to the node, it also tells that node to send us a ping nak,
      // so we remove the node as outbound.
      this.unhandledMessages.delete(msg.id);
      const outboundPeerCount = this.echoServer!.outboundPeerCount;
      if (
        outboundPeerCount < 3 &&
        !this.echoServer!.outboundPeerAddresses.includes(msg.host)
      ) {
        let connectTo = null;
        if (outboundPeerCount === 2) {
          // we will temporarily have 3 outbound peers, until the remote
          // end sends us a PING_NAK
          // we need to drop a peer, so we set connect to. We only drop a peer
          // that the requesting node DOESN'T HAVE AS AN OUTBOUND PEER

          let outbound = this.echoServer!.outboundPeerAddresses;
          if (this.peeringRequestCounter.get(msg.id)! < msg.peersRequired) {
            // outbound peer addresses are pre sorted lowest to highest
            // another node has responded, we reverse our outbound peer addresses,
            // otherwise we end up giving the same node to connect to
            outbound.reverse();
          }
          connectTo = outbound.find(
            (addr) => !msg.outboundPeers.includes(addr) || null
          );
        }
        // let other nodes know we will peer with the node
        this.sendPeeringRequestAck(localAddress, msg.id, msg.host, connectTo);
        if (msg.peersRequired === 1) {
          this.peeringRequestCounter.delete(msg.id);
        }
        this.echoServer!.addPeer(msg.host, Dir.OUTBOUND);
      }
    }
    // this.peeringRequestCounter.delete(msg.id);
  }

  async peeringRequestAckHandler(
    msg: PeeringRequestMessage,
    localAddress: string
  ) {
    if (this.pendingPeeringRequestId === msg.id) {
      if (msg.connectTo) {
        this.echoServer!.addPeer(msg.connectTo, Dir.OUTBOUND);
      }
      if (this.echoServer!.inboundPeerCount >= 2) {
        this.pendingPeeringRequestId = null;
        this.unhandledMessages.delete(msg.id);
      }
    }

    // if a node has just started and this is the first message they have received
    if (!this.peeringRequestCounter.has(msg.id)) return;

    // the sender of this message wants us to drop him so the originator of the peering
    // request can connect to us
    if (msg.connectTo === localAddress) {
      this.echoServer!.addTransition(msg.host, msg.peer);
    }

    // should always be 2 or 1
    const requestsRemaining = this.peeringRequestCounter.get(msg.id)! - 1;

    if (!requestsRemaining) {
      this.unhandledMessages.delete(msg.id);
      this.peeringRequestCounter.delete(msg.id);
    } else {
      this.peeringRequestCounter.set(msg.id, requestsRemaining);
    }
  }

  async adminStartHandler(socket: Socket, localAddress: string): Promise<void> {
    logger.info("admin Start received... starting");
    await this.initiate(socket, localAddress, true);
  }

  adminResetHandler(): void {
    this.resetTimers();
    this.resetState();
    logger.info("admin Reset complete");
  }

  async adminDiscoverHandler(
    localAddress: string,
    remote: AddressInfo
  ): Promise<void> {
    await this.sleep(Math.random() * this.firstResponderDelay * 1000);

    this.sendAdminDiscoverReply(localAddress, remote.address);
  }

  async adminDiscoverReplyhandler(
    socket: Socket,
    localAddress: string,
    msg: AdminDiscoverReplyMessage
  ) {
    if (this.mode !== "OBSERVE") {
      return;
    }

    this.observerMsgHistory![msg.host] = msg.msgLog;
    this.observerNetworkStates![msg.host] = msg.networkState;

    if (
      Object.keys(this.observerNetworkStates!).length ===
      this.observerNodeCount!
    ) {
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

  async messageHandler(
    socket: Socket,
    localAddress: string,
    socketData: Buffer,
    remote: AddressInfo
  ): Promise<void> {
    if (this.closed) return;

    // since this is multicast, we get our own messages, drop
    if (this.localAddresses.includes(remote.address)) {
      return;
    }

    const messages = this.decodeMessages(remote.address, socketData);
    for (const msg of messages) {
      logger.info(
        `Received type: ${Msg[msg.type]} from: ${remote.address}:${remote.port}`
      );
      switch (this.mode) {
        case "PRODUCTION":
          break;
        case "DEVELOPMENT":
          // need to clone the object here otherwise, all msgLogs all reference
          // the same networkState. Think this is only available in > node 18
          this.msgLog!.push({
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
          await this.discoverReplyHandler(
            socket,
            localAddress,
            msg as DiscoverReplyMessage
          );
          break;
        case Msg.PORT_SELECT:
          await this.portSelectHandler(msg as PortSelectMessage, localAddress);
          break;
        case Msg.PORT_SELECT_ACK:
          await this.portSelectAckHandler(
            localAddress,
            msg as PortSelectMessage
          );
          break;
        case Msg.PORT_SELECT_NAK:
          await this.portSelectNakHandler(
            socket,
            localAddress,
            msg as PortSelectMessage
          );
          break;
        case Msg.PEERING_UPDATE:
          // console.log("RECEIVING", inspect(msg, INSPECT_OPTIONS));
          await this.peeringUpdateHandler(
            socket,
            localAddress,
            msg as PeeringUpdateMessage
          );
          break;
        case Msg.PEERING_REQUEST:
          await this.peeringRequestHandler(
            socket,
            localAddress,
            msg as PeeringRequestMessage
          );
          break;
        case Msg.PEERING_REQUEST_ACK:
          await this.peeringRequestAckHandler(
            msg as PeeringRequestMessage,
            localAddress
          );
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
          await this.adminDiscoverReplyhandler(
            socket,
            localAddress,
            msg as AdminDiscoverReplyMessage
          );
          break;
        default:
          logger.warn(
            `Received an unknown message of type: ${msg.type}, ignoring`
          );
      }
    }
  }
}

export default FluxGossipServer;

/*
 * ===================
 * ====== Types ======
 * ===================
 */

type fluxPorts = 16197 | 16187 | 16177 | 16167 | 16157 | 16147 | 16137 | 16127;

export type NodeState =
  | "UNKNOWN"
  | "STARTING"
  | "DISCOVERING"
  | "SELECTING"
  | "READY"
  | "TIMED_OUT"
  | "DISCONNECTING"
  | "DOWN";

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

type AdminMessages = Msg.PORT_SELECT_ACK | Msg.ADMIN_DISCOVER_REPLY;

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

// fix this
interface PeeringUpdateMessage extends Message {
  peer: string;
  peerState: "CONNECTED" | "TIMED_OUT" | "DISCONNECTING" | "DOWN";
}

interface PeeringRequestMessage extends Message {
  peersRequired: number;
  outboundPeers: string[];
  peer: string;
  connectTo: string;
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
  on<U extends keyof FluxGossipServerEvents>(
    event: U,
    listener: FluxGossipServerEvents[U]
  ): this;

  emit<U extends keyof FluxGossipServerEvents>(
    event: U,
    ...args: Parameters<FluxGossipServerEvents[U]>
  ): boolean;

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
  discoverReplyHandler(
    socket: Socket,
    localAddress: string,
    msg: DiscoverReplyMessage
  ): Promise<void>;
  /**
   * Handles a PORT_SELECT message. Upon reciept, a node will check what
   * ports are available, as determined by networkState. The node will then
   * wait a random period of time (firstResponderDelay) and if not handled by
   * another node, this node will either send a PORT_SELECT_ACK or PORT_SELECT_NAK
   * @param msg
   * The PORT_SELECT message received
   */
  portSelectHandler(
    msg: PortSelectMessage,
    localAddress: string
  ): Promise<void>;
  /**
   * Handles a PORT_SELECT_ACK message. Upon reciept, this node will
   * update state for the host in the message to READY. (this may be itself)
   * @param msg
   * The PORT_SELECT_ACK message received
   */
  portSelectAckHandler(
    localAddress: string,
    msg: PortSelectMessage
  ): Promise<void>;
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
  portSelectNakHandler(
    socket: Socket,
    localAddress: string,
    msg: PortSelectMessage
  ): Promise<void>;
  /**
   * Runs a upnp method and handles Errors. Will emit upnp error
   * upon error
   * @param upnpCall
   * A method from UpnpClient
   */
  runUpnpRequest<T extends keyof UpnpClient>(
    upnpCall: UpnpClient[T]
  ): Promise<any>;
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

// timeouts

// startUp
// nodeDisconnected
// nodeDown
// reconnection
