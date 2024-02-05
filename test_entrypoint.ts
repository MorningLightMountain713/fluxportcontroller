#!/usr/bin/env -S npx tsx

import { FluxGossipServer, ServerMode, logController } from "./src";

function closeGracefully() {
  gossipServer.stop();
  process.exit();
}

logController.addLoggerTransport("console");

process.on("SIGINT", closeGracefully);

let txhash: string, outidx: string;
const [argTxHash, argOutIdx] = process.argv.slice(2);
const envArgTxHash = process.env.TX_HASH;
const envOutIdx = process.env.OUT_IDX;

if (argTxHash && argOutIdx != null) {
  txhash = argTxHash;
  outidx = argOutIdx;
} else if (envArgTxHash && envOutIdx != null) {
  txhash = envArgTxHash;
  outidx = envOutIdx;
} else {
  txhash = "testtx";
  outidx = "0";
}

const outPoint = { txhash, outidx };

const mode = process.env.MODE || "DEVELOPMENT";
const nodeCount = process.env.NODE_COUNT;
const testCount = process.env.TEST_COUNT != null ? process.env.TEST_COUNT : 5;

const startDelay =
  process.env.START_DELAY != null ? process.env.START_DELAY : 5;

console.log("MODE:", mode);
console.log("NODE COUNT:", nodeCount);
console.log("OUTPOINT:", outPoint);

if (!mode) {
  console.log("No mode set... EXITING");
  process.exit();
}

if (mode === "OBSERVE" && !nodeCount) {
  console.log("Observe mode with no node count... EXITING");
  process.exit();
}

// The port is udp, and the GossipServer only listens on multicast so
// it doesn't bind on the interface address (The observer binds on all)
const gossipServer = new FluxGossipServer(outPoint, {
  multicastGroup: "239.16.32.15",
  port: 33333,
  startDelay: +startDelay,
  mode: mode as ServerMode,
  observerNodeCount: +nodeCount!,
  observerTestCount: +testCount!
  // firstResponderDelay: 1
  // responseTimeoutMultiplier: 300
});

gossipServer.on("portConfirmed", (port) => {
  console.log(`GOSSIP SERVER GOT PORT: ${port}`);
});

gossipServer.on("startError", () => {
  console.log("Error starting gossipserver, starting again in 5 sec...");
  setTimeout(() => gossipServer.start(), 5000);
});

gossipServer.start();
