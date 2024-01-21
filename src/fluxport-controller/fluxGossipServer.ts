import dgram, { Socket } from "node:dgram";
import { AddressInfo } from "node:net";
import os from "node:os";
import nodeTimersPromises from "node:timers/promises";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { lookup } from "node:dns/promises";

import axios, { AxiosResponse } from "axios";
import { FluxServer, ServerOptions, Message, ServerError } from "./fluxServer";
// import { Client } from "@runonflux/nat-upnp";
import { Client as UpnpClient } from "@megachips/nat-upnp";
import logController from "./log";

import { inspect } from "util";
import { readFileSync, writeFileSync } from "fs";

// logController.addLoggerTransport("console");
const logger = logController.getLogger();

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

const ADMIN_MESSAGES: AdminMessages[] = [PORT_SELECT_ACK, ADMIN_DISCOVER_REPLY];

// nodeStates
const STARTING = "STARTING";
const DISCOVERING = "DISCOVERING";
const SELECTING = "SELECTING";
const READY = "READY";
const UNKNOWN = "UNKNOWN";

const INSPECT_OPTIONS = { showHidden: false, depth: null, colors: true };

export class FluxGossipServer extends FluxServer {
  MESSAGE_SEPARATOR = "?#!%%!#?";
  private readonly allFluxports: fluxPorts[] = [
    16197, 16187, 16177, 16167, 16157, 16147, 16137, 16127
  ];

  restartTimeout: NodeJS.Timeout | null = null;
  discoverTimeout: NodeJS.Timeout | null = null;
  portSelectTimeout: NodeJS.Timeout | null = null;
  adminTimeout: NodeJS.Timeout | null = null;

  pendingDiscoverId: string | null = null;
  pendingSelectId: string | null = null;

  private upnpServiceUrl: string | null = null;
  private localAddresses: string[] = [];

  myIp: string | null = null;
  private addressApis: string[];

  portToNodeMap: Map<number, string> = new Map();
  state: State = { port: null, nodeState: STARTING };
  networkState: NetworkState = {};

  private multicastGroup: string;
  private port: number;

  private startDelay: number;
  private firstResponderDelay: number;
  private responseTimeoutMultiplier: number;
  private responseTimeout: number;

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
    this.upnpClient = new UpnpClient({ cacheGateway: true });
    // use the upnpclient address for our interface

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

  async getMyPublicIp(): Promise<string> {
    let addressApi: string | undefined;
    let data: string = "";

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

  async start(): Promise<boolean> {
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

    // interface is guaranteed here
    this.sockets.push(this.runSocketServer(upnpInterface!));
    return true;
  }

  stop(): void {
    // this is idempotent now
    this.upnpClient.close();
    super.stop();
  }

  runAdminWebserver(port: number) {
    const requestListener = (req: IncomingMessage, res: ServerResponse) => {
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
    // (if you specify dont specify address, it will listen on both
    socket.bind(this.port, bindAddress);

    return socket;
  }

  resetState(resetMsgLog: boolean = true) {
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
    } else {
      this.observerMsgHistory = {};
      this.observerNetworkStates = {};
      this.observerAckedPorts = new Set();
      this.observerLastTestFailed = false;
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
  }

  createMessageFlows(): Record<string, Record<string, string[]>> {
    const aggregatedMsgTypes: Record<string, Record<string, string[]>> = {};
    for (const [node, msgHistory] of Object.entries(this.observerMsgHistory!)) {
      // DRY
      const inboundMsgTypes = msgHistory.reduce<string[]>((acc, next) => {
        if (next.direction === "INBOUND") acc.push(next.type);
        return acc;
      }, []);
      const outboundMsgTypes = msgHistory.reduce<string[]>((acc, next) => {
        if (next.direction === "OUTBOUND") acc.push(next.type);
        return acc;
      }, []);

      aggregatedMsgTypes[node] = { INBOUND: inboundMsgTypes };
      aggregatedMsgTypes[node]["OUTBOUND"] = outboundMsgTypes;
    }
    return aggregatedMsgTypes;
  }

  writeAdminResults(testId: number) {
    // aggregate data. Then write it. Then reset
    // observerMsgHistory
    // observerNetworkStates
    // observerNodeCount
    // observerAckedPorts
    let msg: any;

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
    } else {
      // check for any NAKs. If so provide list of each nodes message types.
      const nakFound = Object.values(this.observerMsgHistory!).find((msgArr) =>
        msgArr.find((x) => x.type === "PORT_SELECT_NAK")
      );
      if (nakFound) {
        const msgFlows = this.createMessageFlows();
        msg = {
          [testId]: {
            resultType: "Pass: PORT_SELECT_NAK found",
            result: msgFlows
          }
        };
      } else {
        msg = {
          [testId]: {
            resultType: "Pass: Success"
          }
        };
      }
    }
    this.writeDataToJsonFile(msg);
  }

  writeDataToJsonFile(data: any) {
    let previousResults = JSON.parse(readFileSync("results.json").toString());
    if (!previousResults) {
      previousResults = {};
    }
    const merged = { ...previousResults, ...data };

    writeFileSync("results.json", JSON.stringify(merged));
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

  sortDiscoveringHosts(): string[] {
    const filter = (obj: Object, predicate: (v: State) => {}) =>
      Object.fromEntries(
        Object.entries(obj).filter(([key, value]) => predicate(value))
      );

    const filtered = filter(
      this.networkState,
      (host) => host.nodeState === ("DISCOVERING" as NodeState)
    );

    const sortedHosts = Object.keys(filtered).sort((a, b) => {
      const numA = this.ipv4ToNumber(a);
      const numB = this.ipv4ToNumber(b);
      return numA - numB;
    });
    return sortedHosts;
  }

  ipv4ToNumber(ipv4: string): number {
    return ipv4.split(".").reduce<number>((a, b) => (a << 8) | +b, 0) >>> 0;
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
    const sortedNodes = this.sortDiscoveringHosts();
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
      this.portSelectTimeout = setTimeout(
        () => this.portConfirm(localAddress, true),
        this.responseTimeout * 1000
      );
    } else {
      logger.error("No free ports... will try again in 5 minutes");
      this.resetState();
      this.restartTimeout = setTimeout(async () => {
        await this.initiate(socket, localAddress, true);
      }, 300 * 1000);
    }
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

    // this is for more DEVELOPMENT / PRODUCTION IF IN DEV, don't send
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

  sleep(ms: number): Promise<void> {
    return nodeTimersPromises.setTimeout(ms);
  }

  updateState(localAddress: string, networkState: NetworkState): void {
    this.networkState = networkState;
    this.networkState[localAddress] = this.state;
  }

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
          res = await upnpCall();
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

  // OUTBOUND MESSAGES //

  sendDiscover(ifaceAddress: string): string {
    // need to save pending discover???
    const msgId = this.generateId();
    const msg = { type: DISCOVER, id: msgId, host: ifaceAddress };
    this.sendMessageToSockets(msg);
    return msgId;
  }

  sendDiscoverReply(host: string, msgId: string): void {
    const msg = {
      type: DISCOVER_REPLY,
      id: msgId,
      host: host,
      networkState: this.networkState
    };
    this.sendMessageToSockets(msg);
  }

  sendPortSelect(ifaceAddress: string, port: number): string {
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

  sendPortSelectAck(msgId: string, host: string, port: number): void {
    const msg = { type: PORT_SELECT_ACK, id: msgId, host: host, port: port };
    this.sendMessageToSockets(msg);
  }

  sendPortSelectNak(msgId: string, host: string, port: number): void {
    const msg = { type: PORT_SELECT_NAK, id: msgId, host: host, port: port };
    this.sendMessageToSockets(msg);
  }

  sendAdminDiscover(host: string) {
    const msg = { type: ADMIN_DISCOVER, id: this.generateId(), host: host };
    this.sendMessageToSockets(msg);
  }

  sendAdminDiscoverReply(srcHost: string, dstHost: string) {
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

  sendAdminStart(localAddress: string) {
    const msg = {
      type: ADMIN_START,
      id: this.generateId(),
      host: localAddress
    };
    this.sendMessageToSockets(msg);
  }

  sendAdminReset(localAddress: string) {
    const msg = {
      type: ADMIN_RESET,
      id: this.generateId(),
      host: localAddress
    };
    this.sendMessageToSockets(msg);
  }

  sendMessageToSockets(msg: Message, options: sendMessageOptions = {}): void {
    const targetAddress = options.address || this.multicastGroup;
    // avoid circular
    if (this.mode === "DEVELOPMENT" && msg.type !== "ADMIN_DISCOVER_REPLY") {
      this.msgLog!.push({
        ...structuredClone(msg),
        ...{ direction: "OUTBOUND" }
      });
    }

    const payload = this.preparePayload(msg, options.addSeparators);
    this.sockets.forEach((socket) => {
      logger.info(
        `Sending type: ${msg.type} to: ${targetAddress}:${this.port}`
      );
      socket.send(payload, 0, payload.length, this.port, targetAddress);
    });
  }

  // INBOUND MESSAGE HANDLERS //

  async discoverHandler(msg: Message): Promise<void> {
    this.networkState[msg.host] = { port: null, nodeState: DISCOVERING };

    await this.sleep(Math.random() * this.firstResponderDelay * 1000);

    if (this.unhandledMessages.has(msg.id)) {
      this.sendDiscoverReply(msg.host, msg.id);
      this.unhandledMessages.delete(msg.id);
    }
  }

  async discoverReplyHandler(
    socket: Socket,
    localAddress: string,
    msg: DiscoverReplyMessage
  ): Promise<void> {
    this.unhandledMessages.delete(msg.id);

    if (this.discoverTimeout && this.pendingDiscoverId === msg.id) {
      clearTimeout(this.discoverTimeout);
      this.discoverTimeout = null;
      this.pendingDiscoverId = null;
      this.updateState(localAddress, msg.networkState);
      this.portSelect(socket, localAddress);
    } else {
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

  async portSelectHandler(msg: PortSelectMessage): Promise<void> {
    let validPortSelect = false;

    if (this.portsAvailable.includes(msg.port as fluxPorts)) {
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
    } else {
      if (this.portSelectTimeout && this.pendingSelectId === msg.id) {
        clearTimeout(this.portSelectTimeout);
        // this should already be set in portSelect
        this.state.port = msg.port;
        this.portConfirm(localAddress);
      } else {
        this.networkState[msg.host] = { port: msg.port, nodeState: READY };
      }
    }
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
      this.resetState(false);

      // wait 5 seconds (plus random 0-startDelay seconds in initiate call)
      this.restartTimeout = setTimeout(async () => {
        await this.initiate(socket, localAddress, true);
      }, 5 * 1000);
    } else {
      this.networkState[msg.host] = { port: null, nodeState: STARTING };
    }
  }

  async adminStartHandler(socket: Socket, localAddress: string) {
    logger.info("admin Start received... starting");
    await this.initiate(socket, localAddress, true);
  }

  adminResetHandler() {
    this.resetTimers();
    this.resetState();
    logger.info("admin Reset complete");
  }

  async adminDiscoverHandler(localAddress: string, remote: AddressInfo) {
    // send our state and nakCount unicast to msg.host
    // also, if in DEVELOPMENT mode, should collect stats,
    // of message count received from each node.
    // also nak counter should only be set in dev mode.
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
      // if (!(msg.type === "ADMIN_DISCOVER_REPLY")) {
      //   logger.info(inspect(msg, INSPECT_OPTIONS));
      // }
      logger.info(
        `Received type: ${msg.type} from: ${remote.address}:${remote.port}`
      );
      switch (this.mode) {
        case "PRODUCTION":
          break;
        case "DEVELOPMENT":
          // need to clone the object here otherwise, all msgLogs all reference
          // the same networkState
          this.msgLog!.push({
            ...structuredClone(msg),
            ...{ direction: "INBOUND" }
          });
          break;
        case "OBSERVE":
          if (!ADMIN_MESSAGES.includes(msg.type as AdminMessages)) {
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
          await this.discoverReplyHandler(
            socket,
            localAddress,
            msg as DiscoverReplyMessage
          );
          break;
        case PORT_SELECT:
          await this.portSelectHandler(msg as PortSelectMessage);
          break;
        case PORT_SELECT_ACK:
          await this.portSelectAckHandler(
            localAddress,
            msg as PortSelectMessage
          );
          break;
        case PORT_SELECT_NAK:
          await this.portSelectNakHandler(
            socket,
            localAddress,
            msg as PortSelectMessage
          );
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
          await this.adminDiscoverReplyhandler(
            socket,
            localAddress,
            msg as AdminDiscoverReplyMessage
          );
          break;
        // case ADMIN_RESULTS:
        //   await this.adminResultsHandler(localAddress, remote);
        //   break;
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

export type NodeState =
  | "UNKNOWN"
  | "STARTING"
  | "DISCOVERING"
  | "SELECTING"
  | "READY";

type fluxPorts = 16197 | 16187 | 16177 | 16167 | 16157 | 16147 | 16137 | 16127;

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

type AdminMessages = "PORT_SELECT_ACK" | "ADMIN_DISCOVER_REPLY";

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

interface ImportError {
  code: string;
  message: string;
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
  portSelectHandler(msg: PortSelectMessage): Promise<void>;
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
