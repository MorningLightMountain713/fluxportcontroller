import assert from "assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  FluxGossipServer,
  NodeState
} from "../../src/fluxport-controller/fluxGossipServer";
import axios from "axios";

const ready = (port: number | null): { port: number | null; nodeState: NodeState } => ({
  port,
  nodeState: "READY"
});

describe("FluxGossipServer state getters", () => {
  let server: FluxGossipServer;
  beforeEach(
    () => (server = new FluxGossipServer({ txhash: "testtx", outidx: "0" }))
  );
  afterEach(() => server.stop());

  it("portsAvailable excludes ports held by SELECTING/READY/UNKNOWN nodes only", () => {
    server.networkState = {
      "1.1.1.1": { port: 16197, nodeState: "READY" },
      "2.2.2.2": { port: 16187, nodeState: "SELECTING" },
      "3.3.3.3": { port: 16177, nodeState: "UNKNOWN" },
      // a DISCOVERING node has not claimed its port yet, so 16167 stays free
      "4.4.4.4": { port: 16167, nodeState: "DISCOVERING" },
      // a null port must never be treated as "used"
      "5.5.5.5": { port: null, nodeState: "READY" }
    };

    assert.deepEqual(server.portsAvailable, [
      16167, 16157, 16147, 16137, 16127
    ]);
  });

  it("portsAvailable is the full set when the network is empty", () => {
    assert.deepEqual(server.portsAvailable, [
      16197, 16187, 16177, 16167, 16157, 16147, 16137, 16127
    ]);
  });

  it("networkConverged is true only when every node is READY/DOWN/DISCONNECTING", () => {
    // vacuously true for an empty network
    assert.strictEqual(server.networkConverged, true);

    server.networkState = {
      "1.1.1.1": { port: 16197, nodeState: "READY" },
      "2.2.2.2": { port: null, nodeState: "DOWN" },
      "3.3.3.3": { port: 16187, nodeState: "DISCONNECTING" }
    };
    assert.strictEqual(server.networkConverged, true);

    server.networkState["4.4.4.4"] = { port: null, nodeState: "DISCOVERING" };
    assert.strictEqual(server.networkConverged, false);
  });

  it("nodeCount counts known hosts", () => {
    assert.strictEqual(server.nodeCount, 0);
    server.networkState = {
      "1.1.1.1": ready(16197),
      "2.2.2.2": ready(16187)
    };
    assert.strictEqual(server.nodeCount, 2);
  });

  it("sortHosts orders low->high and filters by state when asked", () => {
    server.networkState = {
      "10.0.0.5": { port: null, nodeState: "DISCOVERING" },
      "10.0.0.2": { port: null, nodeState: "DISCOVERING" },
      "10.0.0.9": { port: 16197, nodeState: "READY" }
    };

    assert.deepEqual(server.sortHosts(), [
      "10.0.0.2",
      "10.0.0.5",
      "10.0.0.9"
    ]);
    assert.deepEqual(server.sortHosts("DISCOVERING"), [
      "10.0.0.2",
      "10.0.0.5"
    ]);
  });

  it("getPortFromNode reverse-looks-up the upnp mapping table", () => {
    server.portToNodeMap = new Map([
      [16187, "2.2.2.2"],
      [16197, "1.1.1.1"]
    ]);
    assert.strictEqual(server.getPortFromNode("1.1.1.1"), 16197);
    assert.strictEqual(server.getPortFromNode("2.2.2.2"), 16187);
    assert.strictEqual(server.getPortFromNode("9.9.9.9"), null);
  });
});

describe("FluxGossipServer.updatePortToNodeMap", () => {
  let server: FluxGossipServer;
  beforeEach(
    () => (server = new FluxGossipServer({ txhash: "testtx", outidx: "0" }))
  );
  afterEach(() => server.stop());

  it("keeps only tcp mappings on known fluxports", async (t) => {
    const mappings = [
      {
        public: { host: "", port: 16197 },
        private: { host: "1.1.1.1", port: 16197 },
        protocol: "tcp"
      },
      // udp on a fluxport: ignored, must not overwrite the tcp entry above
      {
        public: { host: "", port: 16197 },
        private: { host: "9.9.9.9", port: 16197 },
        protocol: "udp"
      },
      // tcp but not a fluxport: ignored
      {
        public: { host: "", port: 80 },
        private: { host: "2.2.2.2", port: 80 },
        protocol: "tcp"
      },
      {
        public: { host: "", port: 16187 },
        private: { host: "3.3.3.3", port: 16187 },
        protocol: "tcp"
      }
    ];
    server.upnpClient.getMappings = t.mock.fn(async () => mappings) as any;

    await server.updatePortToNodeMap();

    assert.deepEqual(
      server.portToNodeMap,
      new Map([
        [16197, "1.1.1.1"],
        [16187, "3.3.3.3"]
      ])
    );
  });

  it("leaves the map untouched when the upnp request fails", async (t) => {
    server.portToNodeMap = new Map([[16197, "1.1.1.1"]]);
    // runUpnpRequest swallows the error and returns undefined
    server.upnpClient.getMappings = t.mock.fn(async () => {
      throw new Error("router unreachable");
    }) as any;

    await server.updatePortToNodeMap();

    assert.deepEqual(server.portToNodeMap, new Map([[16197, "1.1.1.1"]]));
  });
});

describe("FluxGossipServer.getMyPublicIp", () => {
  afterEach(() => {});

  it("short-circuits to a fake ip for the testtx outpoint", async () => {
    const server = new FluxGossipServer({ txhash: "testtx", outidx: "0" });
    assert.strictEqual(await server.getMyPublicIp(), "10.10.10.10");
    server.stop();
  });

  it("rotates through the address apis until one responds, then trims", async (t) => {
    const server = new FluxGossipServer(
      { txhash: "real", outidx: "0" },
      { addressApis: ["http://a.example", "http://b.example"] }
    );
    // don't actually wait the 1s backoff between failed attempts
    server.sleep = t.mock.fn(async () => undefined) as any;

    let calls = 0;
    t.mock.method(axios, "get", async () => {
      calls++;
      if (calls === 1) throw new Error("first api down");
      return { data: "5.6.7.8\n" };
    });

    const ip = await server.getMyPublicIp();
    assert.strictEqual(ip, "5.6.7.8");
    assert.strictEqual(calls, 2);
    server.stop();
  });
});

describe("FluxGossipServer.fluxnodePriorPort", () => {
  it("returns null when this node is not in the deterministic list", async (t) => {
    const server = new FluxGossipServer({ txhash: "absent", outidx: "0" });
    server.myIp = "1.1.1.1";
    t.mock.method(axios, "get", async () => ({
      data: {
        status: "success",
        data: [{ txhash: "someone-else", outidx: "0", ip: "1.1.1.1:16197" }]
      }
    }));

    assert.strictEqual(await server.fluxnodePriorPort(), null);
    server.stop();
  });

  it("defaults to 16127 when the listed ip carries no explicit port", async (t) => {
    const server = new FluxGossipServer({ txhash: "mine", outidx: "0" });
    server.myIp = "1.1.1.1";
    t.mock.method(axios, "get", async () => ({
      data: {
        status: "success",
        data: [{ txhash: "mine", outidx: "0", ip: "1.1.1.1" }]
      }
    }));

    assert.strictEqual(await server.fluxnodePriorPort(), 16127);
    server.stop();
  });
});

describe("FluxGossipServer.fluxportInUse (retry semantics)", () => {
  it("returns true and stops after the first 200 (no wasted retries)", async (t) => {
    const server = new FluxGossipServer({ txhash: "x", outidx: "0" });
    const get = t.mock.method(axios, "get", async () => ({ status: 200 }));

    assert.strictEqual(await server.fluxportInUse("2.2.2.2", 16197), true);
    assert.strictEqual(get.mock.calls.length, 1);
    server.stop();
  });

  it("retries on no-response then returns true on a later 200", async (t) => {
    const server = new FluxGossipServer({ txhash: "x", outidx: "0" });
    let n = 0;
    const get = t.mock.method(axios, "get", async () => {
      n++;
      if (n === 1) throw new Error("ECONNREFUSED");
      return { status: 200 };
    });

    assert.strictEqual(await server.fluxportInUse("2.2.2.2", 16197), true);
    assert.strictEqual(get.mock.calls.length, 2);
    server.stop();
  });

  it("returns false after three failed attempts", async (t) => {
    const server = new FluxGossipServer({ txhash: "x", outidx: "0" });
    const get = t.mock.method(axios, "get", async () => {
      throw new Error("nope");
    });

    assert.strictEqual(await server.fluxportInUse("2.2.2.2", 16197), false);
    assert.strictEqual(get.mock.calls.length, 3);
    server.stop();
  });

  it("treats a non-200 response as not-in-use without retrying", async (t) => {
    const server = new FluxGossipServer({ txhash: "x", outidx: "0" });
    const get = t.mock.method(axios, "get", async () => ({ status: 500 }));

    assert.strictEqual(await server.fluxportInUse("2.2.2.2", 16197), false);
    assert.strictEqual(get.mock.calls.length, 1);
    server.stop();
  });
});
