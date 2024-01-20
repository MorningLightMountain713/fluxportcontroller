import assert from "assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import {
  FluxGossipServer,
  NodeState
} from "../../src/fluxport-controller/fluxGossipServer";
import { Socket } from "dgram";
import axios from "axios";

describe("handler tests", () => {
  let server: FluxGossipServer;
  beforeEach(
    () => (server = new FluxGossipServer({ txhash: "555", outidx: "0" }))
  );
  afterEach(() => server.stop());

  it("should UPDATE STATE when a D message is received that has ALREADY been handled", async (t) => {
    const testDiscover = { type: "DISCOVER", id: "test", host: "1.1.1.1" };

    assert.deepEqual(server.networkState, {});

    t.mock.timers.enable({ apis: ["setTimeout"] });

    t.mock.method(server, "discoverHandler");
    t.mock.method(server, "sendDiscoverReply");

    assert.strictEqual(
      (server.discoverHandler as any as any).mock.calls.length,
      0
    );
    assert.strictEqual(
      (server.sendDiscoverReply as any as any).mock.calls.length,
      0
    );

    const promise = server.discoverHandler(testDiscover);
    t.mock.timers.tick(1000);
    await promise;

    assert.strictEqual(
      (server.discoverHandler as any as any).mock.calls.length,
      1
    );
    assert.strictEqual(
      (server.sendDiscoverReply as any as any).mock.calls.length,
      0
    );

    assert.deepEqual(server.networkState, {
      "1.1.1.1": { port: null, nodeState: "DISCOVERING" }
    });
  });

  it("should REPLY when a D message is received that HASN'T been handled yet", async (t) => {
    const testDiscover = { type: "DISCOVER", id: "test", host: "1.1.1.1" };

    server.unhandledMessages.add("test");
    assert.deepEqual(server.networkState, {});

    t.mock.timers.enable({ apis: ["setTimeout"] });

    t.mock.method(server, "discoverHandler");
    server.sendDiscoverReply = t.mock.fn();

    assert.strictEqual((server.discoverHandler as any).mock.calls.length, 0);
    assert.strictEqual((server.sendDiscoverReply as any).mock.calls.length, 0);

    const promise = server.discoverHandler(testDiscover);
    t.mock.timers.tick(1000);
    await promise;

    assert.strictEqual((server.discoverHandler as any).mock.calls.length, 1);
    assert.strictEqual((server.sendDiscoverReply as any).mock.calls.length, 1);
    assert.strictEqual(server.unhandledMessages.size, 0);
    assert.deepEqual(server.networkState, {
      "1.1.1.1": { port: null, nodeState: "DISCOVERING" }
    });
  });

  it("should UPDATE STATE when a DR message is received for this node within timeout", async (t) => {
    const localAddress = "1.1.1.1";
    const socket = {} as Socket;
    const testDiscoverReply = {
      type: "DISCOVER_REPLY",
      id: "test",
      host: "2.2.2.2",
      networkState: {
        "1.1.1.1": { port: null, nodeState: "DISCOVERING" as NodeState },
        "2.2.2.2": { port: 16197, nodeState: "READY" as NodeState }
      }
    };

    server.unhandledMessages.add("test");
    server.pendingDiscoverId = "test";
    server.discoverTimeout = setTimeout(() => {}, 3000);

    assert.deepEqual(server.networkState, {});

    t.mock.method(server, "discoverReplyHandler");
    t.mock.method(server, "updateState");

    server.portSelect = t.mock.fn();

    assert.strictEqual(
      (server.discoverReplyHandler as any).mock.calls.length,
      0
    );
    assert.strictEqual((server.portSelect as any).mock.calls.length, 0);

    const promise = server.discoverReplyHandler(
      socket,
      localAddress,
      testDiscoverReply
    );
    await promise;

    assert.strictEqual(
      (server.discoverReplyHandler as any).mock.calls.length,
      1
    );
    assert.strictEqual((server.portSelect as any).mock.calls.length, 1);
    assert.strictEqual((server.updateState as any).mock.calls.length, 1);
    assert.strictEqual(server.unhandledMessages.size, 0);
    assert.deepEqual(server.networkState, testDiscoverReply.networkState);
    assert.strictEqual(server.discoverTimeout, null);
    assert.strictEqual(server.pendingDiscoverId, null);
  });

  it("should DROP a DR message received for this node outside timeout", async (t) => {
    const localAddress = "1.1.1.1";
    const socket = {} as Socket;
    const testDiscoverReply = {
      type: "DISCOVER_REPLY",
      id: "test",
      host: "2.2.2.2",
      networkState: {
        "1.1.1.1": { port: null, nodeState: "DISCOVERING" as NodeState },
        "2.2.2.2": { port: 16197, nodeState: "READY" as NodeState }
      }
    };

    server.unhandledMessages.add("test");

    assert.deepEqual(server.networkState, {});

    t.mock.method(server, "discoverReplyHandler");
    t.mock.method(server, "portSelect");

    assert.strictEqual(
      (server.discoverReplyHandler as any).mock.calls.length,
      0
    );
    assert.strictEqual((server.portSelect as any).mock.calls.length, 0);

    const promise = server.discoverReplyHandler(
      socket,
      localAddress,
      testDiscoverReply
    );
    await promise;

    assert.strictEqual(
      (server.discoverReplyHandler as any).mock.calls.length,
      1
    );
    assert.strictEqual((server.portSelect as any).mock.calls.length, 0);
    assert.strictEqual(server.unhandledMessages.size, 0);
    assert.deepEqual(server.networkState, {});
    assert.strictEqual(server.discoverTimeout, null);
    assert.strictEqual(server.pendingDiscoverId, null);
  });

  it("should DROP a DR message received for another node while this node IS awaiting DR", async (t) => {
    const localAddress = "1.1.1.1";
    const socket = {} as Socket;
    const testDiscoverReply = {
      type: "DISCOVER_REPLY",
      id: "some_other_id",
      host: "3.3.3.3",
      networkState: {
        "2.2.2.2": { port: null, nodeState: "DISCOVERING" as NodeState },
        "3.3.3.3": { port: 16197, nodeState: "READY" as NodeState }
      }
    };

    server.unhandledMessages.add("some_other_id");
    server.pendingDiscoverId = "test";
    server.discoverTimeout = setTimeout(() => {}, 3000);

    assert.deepEqual(server.networkState, {});

    t.mock.method(server, "discoverReplyHandler");
    t.mock.method(server, "portSelect");

    assert.strictEqual(
      (server.discoverReplyHandler as any).mock.calls.length,
      0
    );
    assert.strictEqual((server.portSelect as any).mock.calls.length, 0);

    const promise = server.discoverReplyHandler(
      socket,
      localAddress,
      testDiscoverReply
    );
    await promise;
    clearTimeout(server.discoverTimeout);

    assert.strictEqual(
      (server.discoverReplyHandler as any).mock.calls.length,
      1
    );
    assert.strictEqual((server.portSelect as any).mock.calls.length, 0);
    assert.strictEqual(server.unhandledMessages.size, 0);
    assert.deepEqual(server.networkState, {});
    assert.ok(server.discoverTimeout);
    assert.strictEqual(server.pendingDiscoverId, "test");
  });

  it("should DROP a DR message received for another node while this node IS NOT awaiting DR", async (t) => {
    const localAddress = "1.1.1.1";
    const socket = {} as Socket;
    const testDiscoverReply = {
      type: "DISCOVER_REPLY",
      id: "some_other_id",
      host: "3.3.3.3",
      networkState: {
        "2.2.2.2": { port: null, nodeState: "DISCOVERING" as NodeState },
        "3.3.3.3": { port: 16197, nodeState: "READY" as NodeState }
      }
    };

    server.unhandledMessages.add("some_other_id");

    assert.deepEqual(server.networkState, {});

    t.mock.method(server, "discoverReplyHandler");
    t.mock.method(server, "portSelect");

    assert.strictEqual(
      (server.discoverReplyHandler as any).mock.calls.length,
      0
    );
    assert.strictEqual((server.portSelect as any).mock.calls.length, 0);

    const promise = server.discoverReplyHandler(
      socket,
      localAddress,
      testDiscoverReply
    );
    await promise;

    assert.strictEqual(
      (server.discoverReplyHandler as any).mock.calls.length,
      1
    );
    assert.strictEqual((server.portSelect as any).mock.calls.length, 0);
    assert.strictEqual(server.unhandledMessages.size, 0);
    assert.deepEqual(server.networkState, {});
    assert.strictEqual(server.discoverTimeout, null);
    assert.strictEqual(server.pendingDiscoverId, null);
  });

  it("should ACK a PS message received for another node that HAS NOT been handled", async (t) => {
    const testPortSelect = {
      type: "PORT_SELECT",
      id: "test",
      host: "1.1.1.1",
      port: 16187
    };
    const expectedState = {
      "1.1.1.1": { port: 16187, nodeState: "READY" as NodeState }
    };

    server.unhandledMessages.add("test");

    assert.deepEqual(server.networkState, {});

    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(server, "portSelectHandler");
    server.sendPortSelectAck = t.mock.fn();
    server.sendPortSelectNak = t.mock.fn();

    assert.strictEqual((server.portSelectHandler as any).mock.calls.length, 0);
    assert.strictEqual((server.sendPortSelectAck as any).mock.calls.length, 0);
    assert.strictEqual((server.sendPortSelectNak as any).mock.calls.length, 0);

    const promise = server.portSelectHandler(testPortSelect);
    t.mock.timers.tick(1000);
    await promise;

    assert.strictEqual((server.portSelectHandler as any).mock.calls.length, 1);
    assert.strictEqual((server.sendPortSelectAck as any).mock.calls.length, 1);
    assert.strictEqual((server.sendPortSelectNak as any).mock.calls.length, 0);
    assert.strictEqual(server.unhandledMessages.size, 0);
    assert.deepEqual(server.networkState, expectedState);
  });
  it("should DROP a PS message received for another node that HAS been handled", async (t) => {
    const testPortSelect = {
      type: "PORT_SELECT",
      id: "test",
      host: "1.1.1.1",
      port: 16187
    };
    // this should really be READY as we would have received a PORT_SELECT_ACK
    // from another node (but we have isolated it for this test)
    const expectedState = {
      "1.1.1.1": { port: 16187, nodeState: "SELECTING" as NodeState }
    };

    assert.deepEqual(server.networkState, {});

    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(server, "portSelectHandler");
    server.sendPortSelectAck = t.mock.fn();
    server.sendPortSelectNak = t.mock.fn();

    assert.strictEqual((server.portSelectHandler as any).mock.calls.length, 0);
    assert.strictEqual((server.sendPortSelectAck as any).mock.calls.length, 0);
    assert.strictEqual((server.sendPortSelectNak as any).mock.calls.length, 0);

    const promise = server.portSelectHandler(testPortSelect);
    t.mock.timers.tick(1000);
    await promise;

    assert.strictEqual((server.portSelectHandler as any).mock.calls.length, 1);
    assert.strictEqual((server.sendPortSelectAck as any).mock.calls.length, 0);
    assert.strictEqual((server.sendPortSelectNak as any).mock.calls.length, 0);

    assert.strictEqual(server.unhandledMessages.size, 0);
    assert.deepEqual(server.networkState, expectedState);
  });
  it("should NAK a PS message received for another node where the port is in use", async (t) => {
    const testPortSelect = {
      type: "PORT_SELECT",
      id: "test",
      host: "1.1.1.1",
      port: 16187
    };
    const expectedState = {
      "2.2.2.2": { port: 16187, nodeState: "READY" as NodeState }
    };

    server.unhandledMessages.add("test");
    server.networkState = expectedState;

    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(server, "portSelectHandler");
    server.sendPortSelectAck = t.mock.fn();
    server.sendPortSelectNak = t.mock.fn();

    assert.strictEqual((server.portSelectHandler as any).mock.calls.length, 0);
    assert.strictEqual((server.sendPortSelectAck as any).mock.calls.length, 0);
    assert.strictEqual((server.sendPortSelectNak as any).mock.calls.length, 0);

    const promise = server.portSelectHandler(testPortSelect);
    t.mock.timers.tick(1000);
    await promise;

    assert.strictEqual((server.portSelectHandler as any).mock.calls.length, 1);
    assert.strictEqual((server.sendPortSelectAck as any).mock.calls.length, 0);
    assert.strictEqual((server.sendPortSelectNak as any).mock.calls.length, 1);

    assert.strictEqual(server.unhandledMessages.size, 0);
    assert.deepEqual(server.networkState, expectedState);
  });

  it("should UPDATE STATE when a PS_ACK message is received for ANOTHER node", async (t) => {
    const localAddress = "2.2.2.2";
    const testPortSelectAck = {
      type: "PORT_SELECT_ACK",
      id: "test",
      host: "1.1.1.1",
      port: 16187
    };
    const expectedState = {
      "1.1.1.1": { port: 16187, nodeState: "READY" as NodeState }
    };

    server.unhandledMessages.add("test");

    assert.deepEqual(server.networkState, {});

    t.mock.method(server, "portSelectAckHandler");

    assert.strictEqual(
      (server.portSelectAckHandler as any).mock.calls.length,
      0
    );

    await server.portSelectAckHandler(localAddress, testPortSelectAck);

    assert.strictEqual(
      (server.portSelectAckHandler as any).mock.calls.length,
      1
    );

    assert.strictEqual(server.unhandledMessages.size, 0);
    assert.deepEqual(server.networkState, expectedState);
  });

  it("should UPDATE STATE when a PS_ACK message is received for THIS node", async (t) => {
    const localAddress = "2.2.2.2";
    const testPortSelectAck = {
      type: "PORT_SELECT_ACK",
      id: "test",
      host: "1.1.1.1",
      port: 16187
    };

    server.unhandledMessages.add("test");
    server.portSelectTimeout = setTimeout(() => {}, 3000);
    server.pendingSelectId = "test";

    assert.deepEqual(server.networkState, {});

    t.mock.method(server, "portSelectAckHandler");
    t.mock.method(server, "portConfirm");

    assert.strictEqual(
      (server.portSelectAckHandler as any).mock.calls.length,
      0
    );
    assert.strictEqual((server.portConfirm as any).mock.calls.length, 0);

    await server.portSelectAckHandler(localAddress, testPortSelectAck);

    assert.strictEqual(
      (server.portSelectAckHandler as any).mock.calls.length,
      1
    );
    assert.strictEqual((server.portConfirm as any).mock.calls.length, 1);
    assert.strictEqual(server.state.port, 16187);
    assert.strictEqual(server.state.nodeState, "READY");
    assert.strictEqual(server.portSelectTimeout, null);
    assert.strictEqual(server.pendingSelectId, null);

    assert.strictEqual(server.unhandledMessages.size, 0);
  });

  it("should RESTART discovery when a PS_NAK message is received for THIS node", async (t) => {
    const localAddress = "1.1.1.1";
    const socket = {} as Socket;
    const testPortSelectNak = {
      type: "PORT_SELECT_NAK",
      id: "test",
      host: "1.1.1.1",
      port: 16187
    };

    // mock timer must be before any setTimeout calls
    t.mock.timers.enable({ apis: ["setTimeout"] });
    server.unhandledMessages.add("test");

    server.portSelectTimeout = setTimeout(() => {}, 3000);
    server.pendingSelectId = "test";

    assert.deepEqual(server.networkState, {});

    t.mock.method(server, "portSelectNakHandler");
    t.mock.method(server, "resetState");
    server.initiate = t.mock.fn();

    assert.strictEqual(
      (server.portSelectNakHandler as any).mock.calls.length,
      0
    );

    const promise = server.portSelectNakHandler(
      socket,
      localAddress,
      testPortSelectNak
    );
    t.mock.timers.tick(5000);
    await promise;

    assert.strictEqual(
      (server.portSelectNakHandler as any).mock.calls.length,
      1
    );
    assert.strictEqual((server.resetState as any).mock.calls.length, 1);
    assert.strictEqual((server.initiate as any).mock.calls.length, 1);

    assert.strictEqual(server.discoverTimeout, null);
    assert.strictEqual(server.pendingDiscoverId, null);
    assert.strictEqual(server.portSelectTimeout, null);
    assert.strictEqual(server.pendingSelectId, null);

    assert.deepEqual(server.networkState, {});
    assert.deepEqual(server.state, { port: null, nodeState: "STARTING" });
    assert.strictEqual(server.unhandledMessages.size, 0);
  });

  it("should UPDATE STATE when a PS_NAK message is received for ANOTHER node", async (t) => {
    const localAddress = "1.1.1.1";
    const socket = {} as Socket;
    const testPortSelectNak = {
      type: "PORT_SELECT_NAK",
      id: "test",
      host: "2.2.2.2",
      port: 16187
    };
    const expectedState = { "2.2.2.2": { port: null, nodeState: "STARTING" } };

    server.unhandledMessages.add("test");

    assert.deepEqual(server.networkState, {});

    t.mock.method(server, "portSelectNakHandler");

    assert.strictEqual(
      (server.portSelectNakHandler as any).mock.calls.length,
      0
    );

    await server.portSelectNakHandler(socket, localAddress, testPortSelectNak);

    assert.strictEqual(
      (server.portSelectNakHandler as any).mock.calls.length,
      1
    );

    assert.strictEqual(server.portSelectTimeout, null);
    assert.strictEqual(server.pendingSelectId, null);

    assert.deepEqual(server.networkState, expectedState);
    assert.strictEqual(server.unhandledMessages.size, 0);
  });
});

describe("Port select tests", () => {
  let server: FluxGossipServer;
  beforeEach(
    () => (server = new FluxGossipServer({ txhash: "test_hash", outidx: "0" }))
  );
  afterEach(() => server.stop());

  it("gets UPnP mappings and updates portToNodeMap", async (t) => {
    const testMappingResponse = [
      {
        public: { host: "", port: 16187 },
        private: { host: "2.2.2.2", port: 16187 },
        protocol: "tcp",
        enabled: false,
        description: "Test_node_2",
        ttl: 0,
        local: false
      },
      {
        public: { host: "", port: 16197 },
        private: { host: "1.1.1.1", port: 16197 },
        protocol: "tcp",
        enabled: false,
        description: "Test_node_1",
        ttl: 0,
        local: false
      }
    ];

    const expected = new Map([
      [16187, "2.2.2.2"],
      [16197, "1.1.1.1"]
    ]);

    const mocked = async () => testMappingResponse;
    server.upnpClient.getMappings = t.mock.fn(mocked);
    t.mock.method(server, "updatePortToNodeMap");

    assert.strictEqual(
      (server.updatePortToNodeMap as any).mock.calls.length,
      0
    );
    assert.strictEqual(
      (server.upnpClient.getMappings as any).mock.calls.length,
      0
    );

    await server.updatePortToNodeMap();

    assert.strictEqual(
      (server.updatePortToNodeMap as any).mock.calls.length,
      1
    );
    assert.strictEqual(
      (server.upnpClient.getMappings as any).mock.calls.length,
      1
    );
    assert.deepEqual(server.portToNodeMap, expected);
  });

  it("gets prior fluxnode port", async (t) => {
    const testgetAxiosPortResponse = {
      data: {
        status: "success",
        data: [
          {
            collateral: "COutPoint(test_hash, 0)",
            txhash: "test_hash",
            outidx: "0",
            ip: "1.1.1.1:16167",
            network: "ipv4",
            added_height: 1550439,
            confirmed_height: 1550443,
            last_confirmed_height: 1555292,
            last_paid_height: 1553816,
            tier: "STRATUS",
            payment_address: "test_address",
            pubkey: "test_pubkey",
            activesince: "1704537818",
            lastpaid: "1704946435",
            amount: "40000.00",
            rank: 70
          }
        ]
      }
    };

    t.mock.method(axios, "get", async () => testgetAxiosPortResponse);
    t.mock.method(server, "fluxnodePriorPort");

    assert.strictEqual((server.fluxnodePriorPort as any).mock.calls.length, 0);
    assert.strictEqual((axios.get as any).mock.calls.length, 0);

    const res = await server.fluxnodePriorPort();

    assert.strictEqual((server.fluxnodePriorPort as any).mock.calls.length, 1);
    assert.strictEqual((axios.get as any).mock.calls.length, 1);
    assert.strictEqual(res, 16167);
  });

  it("SELECTS 16197 when no prior port and no other mappings or state", async (t) => {
    const localAddress = "1.1.1.1";
    const socket = {} as Socket;

    t.mock.timers.enable({ apis: ["setTimeout"] });

    server.state.nodeState = "DISCOVERING";
    server.updatePortToNodeMap = t.mock.fn();
    server.fluxnodePriorPort = t.mock.fn(async () => null);
    server.sendPortSelect = t.mock.fn(() => "test_id");

    t.mock.method(server, "portSelect");

    assert.strictEqual((server.portSelect as any).mock.calls.length, 0);

    await server.portSelect(socket, localAddress);

    assert.strictEqual((server.portSelect as any).mock.calls.length, 1);
    assert.strictEqual(
      (server.updatePortToNodeMap as any).mock.calls.length,
      1
    );
    assert.strictEqual((server.fluxnodePriorPort as any).mock.calls.length, 1);
    assert.strictEqual((server.sendPortSelect as any).mock.calls.length, 1);

    assert.strictEqual(server.state.nodeState, "SELECTING");
    assert.strictEqual(server.state.port, 16197);
    assert.strictEqual(server.pendingSelectId, "test_id");
    assert.ok(server.portSelectTimeout);
  });

  it("SELECTS 16187 when no prior port and no other mappings and 16197 taken", async (t) => {
    const localAddress = "1.1.1.1";
    const socket = {} as Socket;

    server.networkState = {
      "2.2.2.2": { port: 16197, nodeState: "SELECTING" as NodeState }
    };
    server.state.nodeState = "DISCOVERING";

    t.mock.timers.enable({ apis: ["setTimeout"] });

    server.updatePortToNodeMap = t.mock.fn();
    server.fluxnodePriorPort = t.mock.fn(async () => null);
    server.sendPortSelect = t.mock.fn(() => "test_id");

    t.mock.method(server, "portSelect");

    assert.strictEqual((server.portSelect as any).mock.calls.length, 0);

    await server.portSelect(socket, localAddress);

    assert.strictEqual((server.portSelect as any).mock.calls.length, 1);
    assert.strictEqual(
      (server.updatePortToNodeMap as any).mock.calls.length,
      1
    );
    assert.strictEqual((server.fluxnodePriorPort as any).mock.calls.length, 1);
    assert.strictEqual((server.sendPortSelect as any).mock.calls.length, 1);

    assert.strictEqual(server.state.nodeState, "SELECTING");
    assert.strictEqual(server.state.port, 16187);
    assert.strictEqual(server.pendingSelectId, "test_id");
    assert.ok(server.portSelectTimeout);
  });

  it("SELECTS previously used port 16137 when node is live and it is available", async (t) => {
    const localAddress = "1.1.1.1";
    const socket = {} as Socket;

    t.mock.timers.enable({ apis: ["setTimeout"] });

    server.state.nodeState = "DISCOVERING";
    server.updatePortToNodeMap = t.mock.fn();
    server.fluxnodePriorPort = t.mock.fn(async () => 16137);
    server.sendPortSelect = t.mock.fn(() => "test_id");

    t.mock.method(server, "portSelect");

    assert.strictEqual((server.portSelect as any).mock.calls.length, 0);

    await server.portSelect(socket, localAddress);

    assert.strictEqual((server.portSelect as any).mock.calls.length, 1);
    assert.strictEqual(
      (server.updatePortToNodeMap as any).mock.calls.length,
      1
    );
    assert.strictEqual((server.fluxnodePriorPort as any).mock.calls.length, 1);
    assert.strictEqual((server.sendPortSelect as any).mock.calls.length, 1);

    assert.strictEqual(server.state.nodeState, "SELECTING");
    assert.strictEqual(server.state.port, 16137);
    assert.strictEqual(server.pendingSelectId, "test_id");
    assert.ok(server.portSelectTimeout);
  });

  it("SELECTS next free port when node is live and existing port is being used", async (t) => {
    const localAddress = "1.1.1.1";
    const socket = {} as Socket;

    const expectedState = {
      "2.2.2.2": { port: 16137, nodeState: "UNKNOWN" as NodeState }
    };

    server.state.nodeState = "DISCOVERING";
    server.portToNodeMap = new Map([[16137, "2.2.2.2"]]);

    t.mock.timers.enable({ apis: ["setTimeout"] });

    server.updatePortToNodeMap = t.mock.fn();
    server.fluxnodePriorPort = t.mock.fn(async () => 16137);
    server.sendPortSelect = t.mock.fn(() => "test_id");
    server.fluxportInUse = t.mock.fn(async () => true);

    t.mock.method(server, "portSelect");

    assert.strictEqual((server.portSelect as any).mock.calls.length, 0);
    assert.strictEqual(
      (server.updatePortToNodeMap as any).mock.calls.length,
      0
    );
    assert.strictEqual((server.fluxnodePriorPort as any).mock.calls.length, 0);
    assert.strictEqual((server.sendPortSelect as any).mock.calls.length, 0);
    assert.strictEqual((server.fluxportInUse as any).mock.calls.length, 0);

    await server.portSelect(socket, localAddress);

    assert.strictEqual((server.portSelect as any).mock.calls.length, 1);
    assert.strictEqual(
      (server.updatePortToNodeMap as any).mock.calls.length,
      1
    );
    assert.strictEqual((server.fluxnodePriorPort as any).mock.calls.length, 1);
    assert.strictEqual((server.sendPortSelect as any).mock.calls.length, 1);
    assert.strictEqual((server.fluxportInUse as any).mock.calls.length, 1);

    assert.strictEqual(server.state.nodeState, "SELECTING");
    assert.strictEqual(server.state.port, 16197);
    assert.deepEqual(server.networkState, expectedState);
    assert.strictEqual(server.pendingSelectId, "test_id");
    assert.ok(server.portSelectTimeout);
  });

  it("SELECTS next free port when node is live and mapping exists and port not it use", async (t) => {
    const localAddress = "1.1.1.1";
    const socket = {} as Socket;

    server.portToNodeMap = new Map([[16137, "2.2.2.2"]]);

    t.mock.timers.enable({ apis: ["setTimeout"] });

    server.updatePortToNodeMap = t.mock.fn();
    server.fluxnodePriorPort = t.mock.fn(async () => 16137);
    server.sendPortSelect = t.mock.fn(() => "test_id");
    server.fluxportInUse = t.mock.fn(async () => false);

    t.mock.method(server, "portSelect");

    assert.strictEqual((server.portSelect as any).mock.calls.length, 0);
    assert.strictEqual(
      (server.updatePortToNodeMap as any).mock.calls.length,
      0
    );
    assert.strictEqual((server.fluxnodePriorPort as any).mock.calls.length, 0);
    assert.strictEqual((server.sendPortSelect as any).mock.calls.length, 0);
    assert.strictEqual((server.fluxportInUse as any).mock.calls.length, 0);

    await server.portSelect(socket, localAddress);

    assert.strictEqual((server.portSelect as any).mock.calls.length, 1);
    assert.strictEqual(
      (server.updatePortToNodeMap as any).mock.calls.length,
      1
    );
    assert.strictEqual((server.fluxnodePriorPort as any).mock.calls.length, 1);
    assert.strictEqual((server.sendPortSelect as any).mock.calls.length, 1);
    assert.strictEqual((server.fluxportInUse as any).mock.calls.length, 1);

    assert.strictEqual(server.state.nodeState, "SELECTING");
    assert.strictEqual(server.state.port, 16197);
    assert.strictEqual(server.pendingSelectId, "test_id");
    assert.ok(server.portSelectTimeout);
  });

  it("RESTARTS when no port is available", async (t) => {
    const localAddress = "1.1.1.1";
    const socket = {} as Socket;

    t.mock.timers.enable({ apis: ["setTimeout"] } as any);

    const testNetworkState = {
      "1.1.1.1": { port: 16197, nodeState: "READY" as NodeState },
      "2.2.2.2": { port: 16187, nodeState: "READY" as NodeState },
      "3.3.3.3": { port: 16177, nodeState: "READY" as NodeState },
      "4.4.4.4": { port: 16167, nodeState: "READY" as NodeState },
      "5.5.5.5": { port: 16157, nodeState: "READY" as NodeState },
      "6.6.6.6": { port: 16147, nodeState: "READY" as NodeState },
      "7.7.7.7": { port: 16137, nodeState: "UNKNOWN" as NodeState },
      "8.8.8.8": { port: 16127, nodeState: "UNKNOWN" as NodeState }
    };

    server.networkState = testNetworkState;
    server.updatePortToNodeMap = t.mock.fn();
    server.fluxnodePriorPort = t.mock.fn(async () => null);
    server.sendPortSelect = t.mock.fn(() => "test_id");
    server.initiate = t.mock.fn();

    t.mock.method(server, "portSelect");
    t.mock.method(server, "resetState");

    assert.strictEqual((server.portSelect as any).mock.calls.length, 0);
    assert.strictEqual(
      (server.updatePortToNodeMap as any).mock.calls.length,
      0
    );
    assert.strictEqual((server.fluxnodePriorPort as any).mock.calls.length, 0);
    assert.strictEqual((server.sendPortSelect as any).mock.calls.length, 0);
    assert.strictEqual((server.initiate as any).mock.calls.length, 0);
    assert.strictEqual((server.resetState as any).mock.calls.length, 0);

    await server.portSelect(socket, localAddress);
    // the above starts a 5 minute timeout to restart... we hurry it along here
    t.mock.timers.tick(300 * 1000);

    assert.strictEqual((server.portSelect as any).mock.calls.length, 1);
    assert.strictEqual(
      (server.updatePortToNodeMap as any).mock.calls.length,
      1
    );
    assert.strictEqual((server.fluxnodePriorPort as any).mock.calls.length, 1);
    assert.strictEqual((server.sendPortSelect as any).mock.calls.length, 0);
    assert.strictEqual((server.initiate as any).mock.calls.length, 1);
    // not sure what form I like yet
    assert.strictEqual((server.resetState as any).mock.callCount(), 1);

    assert.strictEqual(server.state.nodeState, "STARTING");
    assert.strictEqual(server.state.port, null);
    assert.strictEqual(server.pendingSelectId, null);
    assert.strictEqual(server.pendingDiscoverId, null);
    assert.strictEqual(server.portSelectTimeout, null);
    assert.strictEqual(server.discoverTimeout, null);
    assert.deepEqual(server.networkState, {});
  });
});
