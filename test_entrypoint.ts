#!/usr/bin/env -S npx tsx

import os from "node:os";
import { createServer } from "node:http";
import axios from "axios";
import { FluxPortManager, FluxPortManagerOptions, logController } from "./src";

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

const options: FluxPortManagerOptions = {
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
}

const manager = new FluxPortManager({ txhash, outidx }, options);

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

// status endpoint for the verifier
createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      nid,
      port: confirmedPort,
      view: manager.viewId,
      members: manager.members
    })
  );
}).listen(statusPort, () => console.log(`status endpoint on :${statusPort}`));

process.on("SIGINT", () => {
  manager.stop();
  process.exit();
});

console.log(`Starting fluxport-controller node ${nid}`);
manager.start();
