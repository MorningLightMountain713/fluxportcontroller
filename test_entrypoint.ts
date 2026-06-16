#!/usr/bin/env -S npx tsx

import { FluxPortManager, logController } from "./src";

logController.addLoggerTransport("console");

const [argTxHash, argOutIdx] = process.argv.slice(2);
const txhash = argTxHash || process.env.TX_HASH || "testtx";
const outidx = argOutIdx || process.env.OUT_IDX || "0";

const manager = new FluxPortManager(
  { txhash, outidx },
  {
    multicastGroup: process.env.MULTICAST_GROUP || "239.16.32.15",
    port: process.env.PORT ? +process.env.PORT : 33333
  }
);

manager.on("routerIpConfirmed", (ip) => console.log(`ROUTER IP: ${ip}`));
manager.on("portConfirmed", (port) => console.log(`PORT CONFIRMED: ${port}`));
manager.on("noPortAvailable", () => console.log("NO PORT AVAILABLE (capacity)"));
manager.on("startError", () => {
  console.log("Error starting, retrying in 5s...");
  setTimeout(() => manager.start(), 5000);
});

process.on("SIGINT", () => {
  manager.stop();
  process.exit();
});

manager.start();
