#!/usr/bin/env -S npx tsx

import os from "node:os";
import { createServer } from "node:http";
import axios from "axios";
import { FluxNodeAgent, FluxNodeAgentOptions, logController } from "./src";
import {
  createDefaultUpnpClient,
  UpnpClientLike
} from "./src/fluxport-controller/upnpClient";

// Test-side instrumentation (harness only): count router WRITES so the integration
// test can assert steady-state zero writes. A thin pass-through around the real
// serialized client — no production code involved.
let upnpWrites = 0;
let upnpDeletes = 0;
function countingClient(inner: UpnpClientLike): UpnpClientLike {
  return {
    getGateway: () => inner.getGateway(),
    getMappings: () => inner.getMappings(),
    getMapping: (q) => inner.getMapping(q),
    createMapping: (m) => {
      upnpWrites += 1;
      return inner.createMapping(m);
    },
    removeMapping: (q) => {
      upnpDeletes += 1;
      return inner.removeMapping(q);
    },
    close: () => inner.close?.()
  };
}

logController.addLoggerTransport("console");

// Long-running runner: never die on a stray async error (e.g. nat-upnp's SSDP
// search timing out when no router answers). start() handles real failures via
// the startError event + retry.
process.on("unhandledRejection", (reason) =>
  console.log(`unhandledRejection (continuing): ${reason}`)
);

// In the docker harness we exercise the REAL UPnP discovery + multicast consensus
// (miniupnpd is the router), but stub the external flux-API bits so the test does
// not depend on the internet, and give each container a unique identity.
const harness = process.env.HARNESS === "1";

const [argTxHash, argOutIdx] = process.argv.slice(2);
const txhash = argTxHash || process.env.TX_HASH || (harness ? os.hostname() : "testtx");
const outidx = argOutIdx || process.env.OUT_IDX || "0";
const nid = `${txhash}:${outidx}`;

const statusPort = process.env.STATUS_PORT ? +process.env.STATUS_PORT : 33334;
const reportUrl = process.env.REPORT_URL || null;

const options: FluxNodeAgentOptions = {
  multicastGroup: process.env.MULTICAST_GROUP || "239.16.32.15",
  port: process.env.PORT ? +process.env.PORT : 33333
};
if (harness) {
  // real UPnP + real multicast; only the flux-list / public-IP lookups are stubbed
  options.getPublicIp = async () => "10.10.10.10";
  options.resolveNodeInfo = async () => ({
    priorPort: null,
    priority: Number.MAX_SAFE_INTEGER
  });
  // Real serialized client, wrapped to count writes for the steady-state assertion.
  options.upnpClient = countingClient(createDefaultUpnpClient());
}
// A harness node `node-N` tests lease renewal on 40000 + N: distinct per node, as
// FluxOS's api port + 3 is.
const nodeNumber = /^node-(\d+)$/.exec(txhash);
const leaseTestPort = harness && nodeNumber ? 40000 + Number(nodeNumber[1]) : undefined;
if (process.env.UPNP_FAST === "1") {
  // Fast-but-PROPORTIONED upnp timing for the integration harness: same shape as the
  // production slow timing, scaled to seconds so real mappings happen within a test
  // window. announceInterval (50) ≪ the per-node baton interval (~|members| × 100) so
  // the 5c health gate sees multicast advance; tokenStallMs (5000) > that interval so a
  // normal rotation never trips a spurious SELF_CHECK.
  options.upnpTiming = {
    tokenRotationTarget: 100,
    tokenRetransmitTimeout: 1000,
    maxTokenRetransmits: 10,
    tokenLossTimeout: 5000,
    maxMessagesPerToken: 16,
    announceInterval: 50,
    joinInterval: 100,
    joinTimeout: 1000,
    commitTimeout: 5000
  };
  options.upnpTuning = {
    rate: 1000,
    capacity: 1000,
    enterLaps: 3,
    leaveLaps: 5,
    tokenStallMs: 5000,
    selfCheckCycleMs: 2000,
    selfCheckWindows: 4,
    leaseTestPort
  };
} else if (leaseTestPort != null) {
  options.upnpTuning = { leaseTestPort };
}

const manager = new FluxNodeAgent({ txhash, outidx }, options);

let confirmedPort: number | null = null;

manager.on("routerIpConfirmed", (ip) => console.log(`ROUTER IP: ${ip}`));
manager.on("noPortAvailable", () => console.log("NO PORT AVAILABLE (capacity)"));
manager.on("startError", () => {
  console.log("Error starting, retrying in 5s...");
  setTimeout(() => manager.start(), 5000);
});
manager.on("portConfirmed", (port: number) => {
  confirmedPort = port;
  console.log(`PORT CONFIRMED: ${port}`);
  if (reportUrl) {
    axios
      .post(reportUrl, { nid, port })
      .catch((err) => console.log(`report failed: ${err.message}`));
  }
});

// status endpoint for the verifier. The plain GET (/) is the cheap convergence poll
// (sync getters only). GET /?upnp=1 additionally does a REAL getMappings SOAP enumerate
// against the router — kept OFF the frequent poll so it never spams miniupnpd; the §7.5
// integration test calls it on demand for ground-truth verification.
createServer((req, res) => {
  // Sync UPnP fields (no SOAP) ride the plain poll, so they stay readable even when a
  // test has blocked the node's router access. Only the table read (?upnp=1) does a SOAP
  // enumerate, kept off the frequent convergence poll.
  const respond = (extra: Record<string, unknown>): void => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        nid,
        port: confirmedPort,
        view: manager.viewId,
        members: manager.members,
        upnpMode: manager.upnpMode,
        upnpRate: manager.upnpRate,
        upnpIsLeader: manager.upnpIsLeader,
        desiredUpnpPorts: manager.desiredUpnpPorts,
        upnpWrites,
        upnpDeletes,
        ...extra
      })
    );
  };
  if (!req.url || !req.url.includes("upnp=1")) return respond({});
  manager
    .getUpnpMappings()
    .then((upnpMappings) => respond({ upnpMappings }))
    .catch((err) =>
      respond({ upnpMappings: [], upnpError: String((err && (err as Error).message) || err) })
    );
}).listen(statusPort, () => console.log(`status endpoint on :${statusPort}`));

process.on("SIGINT", () => {
  manager.stop();
  process.exit();
});

console.log(`Starting fluxport-controller node ${nid}`);
manager.start();
