"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("assert/strict"));
const node_test_1 = require("node:test");
const fluxGossipServer_1 = require("../../src/fluxport-controller/fluxGossipServer");
const axios_1 = __importDefault(require("axios"));
(0, node_test_1.describe)("handler tests", () => {
    let server;
    (0, node_test_1.beforeEach)(() => (server = new fluxGossipServer_1.FluxGossipServer({ txhash: "555", outidx: "0" })));
    (0, node_test_1.afterEach)(() => server.stop());
    (0, node_test_1.it)("should UPDATE STATE when a D message is received that has ALREADY been handled", async (t) => {
        const testDiscover = { type: "DISCOVER", id: "test", host: "1.1.1.1" };
        strict_1.default.deepEqual(server.networkState, {});
        t.mock.timers.enable(["setTimeout"]);
        t.mock.method(server, "discoverHandler");
        t.mock.method(server, "sendDiscoverReply");
        strict_1.default.strictEqual(server.discoverHandler.mock.calls.length, 0);
        strict_1.default.strictEqual(server.sendDiscoverReply.mock.calls.length, 0);
        const promise = server.discoverHandler(testDiscover);
        t.mock.timers.tick(1000);
        await promise;
        strict_1.default.strictEqual(server.discoverHandler.mock.calls.length, 1);
        strict_1.default.strictEqual(server.sendDiscoverReply.mock.calls.length, 0);
        strict_1.default.deepEqual(server.networkState, {
            "1.1.1.1": { port: null, nodeState: "DISCOVERING" }
        });
    });
    (0, node_test_1.it)("should REPLY when a D message is received that HASN'T been handled yet", async (t) => {
        const testDiscover = { type: "DISCOVER", id: "test", host: "1.1.1.1" };
        server.unhandledMessages.add("test");
        strict_1.default.deepEqual(server.networkState, {});
        t.mock.timers.enable(["setTimeout"]);
        t.mock.method(server, "discoverHandler");
        server.sendDiscoverReply = t.mock.fn();
        strict_1.default.strictEqual(server.discoverHandler.mock.calls.length, 0);
        strict_1.default.strictEqual(server.sendDiscoverReply.mock.calls.length, 0);
        const promise = server.discoverHandler(testDiscover);
        t.mock.timers.tick(1000);
        await promise;
        strict_1.default.strictEqual(server.discoverHandler.mock.calls.length, 1);
        strict_1.default.strictEqual(server.sendDiscoverReply.mock.calls.length, 1);
        strict_1.default.strictEqual(server.unhandledMessages.size, 0);
        strict_1.default.deepEqual(server.networkState, {
            "1.1.1.1": { port: null, nodeState: "DISCOVERING" }
        });
    });
    (0, node_test_1.it)("should UPDATE STATE when a DR message is received for this node within timeout", async (t) => {
        const localAddress = "1.1.1.1";
        const socket = {};
        const testDiscoverReply = {
            type: "DISCOVER_REPLY",
            id: "test",
            host: "2.2.2.2",
            networkState: {
                "1.1.1.1": { port: null, nodeState: "DISCOVERING" },
                "2.2.2.2": { port: 16197, nodeState: "READY" }
            }
        };
        server.unhandledMessages.add("test");
        server.pendingDiscoverId = "test";
        server.discoverTimeout = setTimeout(() => { }, 3000);
        strict_1.default.deepEqual(server.networkState, {});
        t.mock.method(server, "discoverReplyHandler");
        t.mock.method(server, "updateState");
        server.portSelect = t.mock.fn();
        strict_1.default.strictEqual(server.discoverReplyHandler.mock.calls.length, 0);
        strict_1.default.strictEqual(server.portSelect.mock.calls.length, 0);
        const promise = server.discoverReplyHandler(socket, localAddress, testDiscoverReply);
        await promise;
        strict_1.default.strictEqual(server.discoverReplyHandler.mock.calls.length, 1);
        strict_1.default.strictEqual(server.portSelect.mock.calls.length, 1);
        strict_1.default.strictEqual(server.updateState.mock.calls.length, 1);
        strict_1.default.strictEqual(server.unhandledMessages.size, 0);
        strict_1.default.deepEqual(server.networkState, testDiscoverReply.networkState);
        strict_1.default.strictEqual(server.discoverTimeout, null);
        strict_1.default.strictEqual(server.pendingDiscoverId, null);
    });
    (0, node_test_1.it)("should DROP a DR message received for this node outside timeout", async (t) => {
        const localAddress = "1.1.1.1";
        const socket = {};
        const testDiscoverReply = {
            type: "DISCOVER_REPLY",
            id: "test",
            host: "2.2.2.2",
            networkState: {
                "1.1.1.1": { port: null, nodeState: "DISCOVERING" },
                "2.2.2.2": { port: 16197, nodeState: "READY" }
            }
        };
        server.unhandledMessages.add("test");
        strict_1.default.deepEqual(server.networkState, {});
        t.mock.method(server, "discoverReplyHandler");
        t.mock.method(server, "portSelect");
        strict_1.default.strictEqual(server.discoverReplyHandler.mock.calls.length, 0);
        strict_1.default.strictEqual(server.portSelect.mock.calls.length, 0);
        const promise = server.discoverReplyHandler(socket, localAddress, testDiscoverReply);
        await promise;
        strict_1.default.strictEqual(server.discoverReplyHandler.mock.calls.length, 1);
        strict_1.default.strictEqual(server.portSelect.mock.calls.length, 0);
        strict_1.default.strictEqual(server.unhandledMessages.size, 0);
        strict_1.default.deepEqual(server.networkState, {});
        strict_1.default.strictEqual(server.discoverTimeout, null);
        strict_1.default.strictEqual(server.pendingDiscoverId, null);
    });
    (0, node_test_1.it)("should DROP a DR message received for another node while this node IS awaiting DR", async (t) => {
        const localAddress = "1.1.1.1";
        const socket = {};
        const testDiscoverReply = {
            type: "DISCOVER_REPLY",
            id: "some_other_id",
            host: "3.3.3.3",
            networkState: {
                "2.2.2.2": { port: null, nodeState: "DISCOVERING" },
                "3.3.3.3": { port: 16197, nodeState: "READY" }
            }
        };
        server.unhandledMessages.add("some_other_id");
        server.pendingDiscoverId = "test";
        server.discoverTimeout = setTimeout(() => { }, 3000);
        strict_1.default.deepEqual(server.networkState, {});
        t.mock.method(server, "discoverReplyHandler");
        t.mock.method(server, "portSelect");
        strict_1.default.strictEqual(server.discoverReplyHandler.mock.calls.length, 0);
        strict_1.default.strictEqual(server.portSelect.mock.calls.length, 0);
        const promise = server.discoverReplyHandler(socket, localAddress, testDiscoverReply);
        await promise;
        clearTimeout(server.discoverTimeout);
        strict_1.default.strictEqual(server.discoverReplyHandler.mock.calls.length, 1);
        strict_1.default.strictEqual(server.portSelect.mock.calls.length, 0);
        strict_1.default.strictEqual(server.unhandledMessages.size, 0);
        strict_1.default.deepEqual(server.networkState, {});
        strict_1.default.ok(server.discoverTimeout);
        strict_1.default.strictEqual(server.pendingDiscoverId, "test");
    });
    (0, node_test_1.it)("should DROP a DR message received for another node while this node IS NOT awaiting DR", async (t) => {
        const localAddress = "1.1.1.1";
        const socket = {};
        const testDiscoverReply = {
            type: "DISCOVER_REPLY",
            id: "some_other_id",
            host: "3.3.3.3",
            networkState: {
                "2.2.2.2": { port: null, nodeState: "DISCOVERING" },
                "3.3.3.3": { port: 16197, nodeState: "READY" }
            }
        };
        server.unhandledMessages.add("some_other_id");
        strict_1.default.deepEqual(server.networkState, {});
        t.mock.method(server, "discoverReplyHandler");
        t.mock.method(server, "portSelect");
        strict_1.default.strictEqual(server.discoverReplyHandler.mock.calls.length, 0);
        strict_1.default.strictEqual(server.portSelect.mock.calls.length, 0);
        const promise = server.discoverReplyHandler(socket, localAddress, testDiscoverReply);
        await promise;
        strict_1.default.strictEqual(server.discoverReplyHandler.mock.calls.length, 1);
        strict_1.default.strictEqual(server.portSelect.mock.calls.length, 0);
        strict_1.default.strictEqual(server.unhandledMessages.size, 0);
        strict_1.default.deepEqual(server.networkState, {});
        strict_1.default.strictEqual(server.discoverTimeout, null);
        strict_1.default.strictEqual(server.pendingDiscoverId, null);
    });
    (0, node_test_1.it)("should ACK a PS message received for another node that HAS NOT been handled", async (t) => {
        const testPortSelect = {
            type: "PORT_SELECT",
            id: "test",
            host: "1.1.1.1",
            port: 16187
        };
        const expectedState = {
            "1.1.1.1": { port: 16187, nodeState: "READY" }
        };
        server.unhandledMessages.add("test");
        strict_1.default.deepEqual(server.networkState, {});
        t.mock.timers.enable(["setTimeout"]);
        t.mock.method(server, "portSelectHandler");
        server.sendPortSelectAck = t.mock.fn();
        server.sendPortSelectNak = t.mock.fn();
        strict_1.default.strictEqual(server.portSelectHandler.mock.calls.length, 0);
        strict_1.default.strictEqual(server.sendPortSelectAck.mock.calls.length, 0);
        strict_1.default.strictEqual(server.sendPortSelectNak.mock.calls.length, 0);
        const promise = server.portSelectHandler(testPortSelect);
        t.mock.timers.tick(1000);
        await promise;
        strict_1.default.strictEqual(server.portSelectHandler.mock.calls.length, 1);
        strict_1.default.strictEqual(server.sendPortSelectAck.mock.calls.length, 1);
        strict_1.default.strictEqual(server.sendPortSelectNak.mock.calls.length, 0);
        strict_1.default.strictEqual(server.unhandledMessages.size, 0);
        strict_1.default.deepEqual(server.networkState, expectedState);
    });
    (0, node_test_1.it)("should DROP a PS message received for another node that HAS been handled", async (t) => {
        const testPortSelect = {
            type: "PORT_SELECT",
            id: "test",
            host: "1.1.1.1",
            port: 16187
        };
        // this should really be READY as we would have received a PORT_SELECT_ACK
        // from another node (but we have isolated it for this test)
        const expectedState = {
            "1.1.1.1": { port: 16187, nodeState: "SELECTING" }
        };
        strict_1.default.deepEqual(server.networkState, {});
        t.mock.timers.enable(["setTimeout"]);
        t.mock.method(server, "portSelectHandler");
        server.sendPortSelectAck = t.mock.fn();
        server.sendPortSelectNak = t.mock.fn();
        strict_1.default.strictEqual(server.portSelectHandler.mock.calls.length, 0);
        strict_1.default.strictEqual(server.sendPortSelectAck.mock.calls.length, 0);
        strict_1.default.strictEqual(server.sendPortSelectNak.mock.calls.length, 0);
        const promise = server.portSelectHandler(testPortSelect);
        t.mock.timers.tick(1000);
        await promise;
        strict_1.default.strictEqual(server.portSelectHandler.mock.calls.length, 1);
        strict_1.default.strictEqual(server.sendPortSelectAck.mock.calls.length, 0);
        strict_1.default.strictEqual(server.sendPortSelectNak.mock.calls.length, 0);
        strict_1.default.strictEqual(server.unhandledMessages.size, 0);
        strict_1.default.deepEqual(server.networkState, expectedState);
    });
    (0, node_test_1.it)("should NAK a PS message received for another node where the port is in use", async (t) => {
        const testPortSelect = {
            type: "PORT_SELECT",
            id: "test",
            host: "1.1.1.1",
            port: 16187
        };
        const expectedState = {
            "2.2.2.2": { port: 16187, nodeState: "READY" }
        };
        server.unhandledMessages.add("test");
        server.networkState = expectedState;
        t.mock.timers.enable(["setTimeout"]);
        t.mock.method(server, "portSelectHandler");
        server.sendPortSelectAck = t.mock.fn();
        server.sendPortSelectNak = t.mock.fn();
        strict_1.default.strictEqual(server.portSelectHandler.mock.calls.length, 0);
        strict_1.default.strictEqual(server.sendPortSelectAck.mock.calls.length, 0);
        strict_1.default.strictEqual(server.sendPortSelectNak.mock.calls.length, 0);
        const promise = server.portSelectHandler(testPortSelect);
        t.mock.timers.tick(1000);
        await promise;
        strict_1.default.strictEqual(server.portSelectHandler.mock.calls.length, 1);
        strict_1.default.strictEqual(server.sendPortSelectAck.mock.calls.length, 0);
        strict_1.default.strictEqual(server.sendPortSelectNak.mock.calls.length, 1);
        strict_1.default.strictEqual(server.unhandledMessages.size, 0);
        strict_1.default.deepEqual(server.networkState, expectedState);
    });
    (0, node_test_1.it)("should UPDATE STATE when a PS_ACK message is received for ANOTHER node", async (t) => {
        const localAddress = "2.2.2.2";
        const testPortSelectAck = {
            type: "PORT_SELECT_ACK",
            id: "test",
            host: "1.1.1.1",
            port: 16187
        };
        const expectedState = {
            "1.1.1.1": { port: 16187, nodeState: "READY" }
        };
        server.unhandledMessages.add("test");
        strict_1.default.deepEqual(server.networkState, {});
        t.mock.method(server, "portSelectAckHandler");
        strict_1.default.strictEqual(server.portSelectAckHandler.mock.calls.length, 0);
        await server.portSelectAckHandler(localAddress, testPortSelectAck);
        strict_1.default.strictEqual(server.portSelectAckHandler.mock.calls.length, 1);
        strict_1.default.strictEqual(server.unhandledMessages.size, 0);
        strict_1.default.deepEqual(server.networkState, expectedState);
    });
    (0, node_test_1.it)("should UPDATE STATE when a PS_ACK message is received for THIS node", async (t) => {
        const localAddress = "2.2.2.2";
        const testPortSelectAck = {
            type: "PORT_SELECT_ACK",
            id: "test",
            host: "1.1.1.1",
            port: 16187
        };
        server.unhandledMessages.add("test");
        server.portSelectTimeout = setTimeout(() => { }, 3000);
        server.pendingSelectId = "test";
        strict_1.default.deepEqual(server.networkState, {});
        t.mock.method(server, "portSelectAckHandler");
        t.mock.method(server, "portConfirm");
        strict_1.default.strictEqual(server.portSelectAckHandler.mock.calls.length, 0);
        strict_1.default.strictEqual(server.portConfirm.mock.calls.length, 0);
        await server.portSelectAckHandler(localAddress, testPortSelectAck);
        strict_1.default.strictEqual(server.portSelectAckHandler.mock.calls.length, 1);
        strict_1.default.strictEqual(server.portConfirm.mock.calls.length, 1);
        strict_1.default.strictEqual(server.state.port, 16187);
        strict_1.default.strictEqual(server.state.nodeState, "READY");
        strict_1.default.strictEqual(server.portSelectTimeout, null);
        strict_1.default.strictEqual(server.pendingSelectId, null);
        strict_1.default.strictEqual(server.unhandledMessages.size, 0);
    });
    (0, node_test_1.it)("should RESTART discovery when a PS_NAK message is received for THIS node", async (t) => {
        const localAddress = "1.1.1.1";
        const socket = {};
        const testPortSelectNak = {
            type: "PORT_SELECT_NAK",
            id: "test",
            host: "1.1.1.1",
            port: 16187
        };
        // mock timer must be before any setTimeout calls
        t.mock.timers.enable(["setTimeout"]);
        server.unhandledMessages.add("test");
        server.portSelectTimeout = setTimeout(() => { }, 3000);
        server.pendingSelectId = "test";
        strict_1.default.deepEqual(server.networkState, {});
        t.mock.method(server, "portSelectNakHandler");
        t.mock.method(server, "resetState");
        server.initiate = t.mock.fn();
        strict_1.default.strictEqual(server.portSelectNakHandler.mock.calls.length, 0);
        const promise = server.portSelectNakHandler(socket, localAddress, testPortSelectNak);
        t.mock.timers.tick(5000);
        await promise;
        strict_1.default.strictEqual(server.portSelectNakHandler.mock.calls.length, 1);
        strict_1.default.strictEqual(server.resetState.mock.calls.length, 1);
        strict_1.default.strictEqual(server.initiate.mock.calls.length, 1);
        strict_1.default.strictEqual(server.discoverTimeout, null);
        strict_1.default.strictEqual(server.pendingDiscoverId, null);
        strict_1.default.strictEqual(server.portSelectTimeout, null);
        strict_1.default.strictEqual(server.pendingSelectId, null);
        strict_1.default.deepEqual(server.networkState, {});
        strict_1.default.deepEqual(server.state, { port: null, nodeState: "STARTING" });
        strict_1.default.strictEqual(server.unhandledMessages.size, 0);
    });
    (0, node_test_1.it)("should UPDATE STATE when a PS_NAK message is received for ANOTHER node", async (t) => {
        const localAddress = "1.1.1.1";
        const socket = {};
        const testPortSelectNak = {
            type: "PORT_SELECT_NAK",
            id: "test",
            host: "2.2.2.2",
            port: 16187
        };
        const expectedState = { "2.2.2.2": { port: null, nodeState: "STARTING" } };
        server.unhandledMessages.add("test");
        strict_1.default.deepEqual(server.networkState, {});
        t.mock.method(server, "portSelectNakHandler");
        strict_1.default.strictEqual(server.portSelectNakHandler.mock.calls.length, 0);
        await server.portSelectNakHandler(socket, localAddress, testPortSelectNak);
        strict_1.default.strictEqual(server.portSelectNakHandler.mock.calls.length, 1);
        strict_1.default.strictEqual(server.portSelectTimeout, null);
        strict_1.default.strictEqual(server.pendingSelectId, null);
        strict_1.default.deepEqual(server.networkState, expectedState);
        strict_1.default.strictEqual(server.unhandledMessages.size, 0);
    });
});
(0, node_test_1.describe)("Port select tests", () => {
    let server;
    (0, node_test_1.beforeEach)(() => (server = new fluxGossipServer_1.FluxGossipServer({ txhash: "test_hash", outidx: "0" })));
    (0, node_test_1.afterEach)(() => server.stop());
    (0, node_test_1.it)("gets UPnP mappings and updates portToNodeMap", async (t) => {
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
        strict_1.default.strictEqual(server.updatePortToNodeMap.mock.calls.length, 0);
        strict_1.default.strictEqual(server.upnpClient.getMappings.mock.calls.length, 0);
        await server.updatePortToNodeMap();
        strict_1.default.strictEqual(server.updatePortToNodeMap.mock.calls.length, 1);
        strict_1.default.strictEqual(server.upnpClient.getMappings.mock.calls.length, 1);
        strict_1.default.deepEqual(server.portToNodeMap, expected);
    });
    (0, node_test_1.it)("gets prior fluxnode port", async (t) => {
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
        t.mock.method(axios_1.default, "get", async () => testgetAxiosPortResponse);
        t.mock.method(server, "fluxnodePriorPort");
        strict_1.default.strictEqual(server.fluxnodePriorPort.mock.calls.length, 0);
        strict_1.default.strictEqual(axios_1.default.get.mock.calls.length, 0);
        const res = await server.fluxnodePriorPort();
        strict_1.default.strictEqual(server.fluxnodePriorPort.mock.calls.length, 1);
        strict_1.default.strictEqual(axios_1.default.get.mock.calls.length, 1);
        strict_1.default.strictEqual(res, 16167);
    });
    (0, node_test_1.it)("SELECTS 16197 when no prior port and no other mappings or state", async (t) => {
        const localAddress = "1.1.1.1";
        const socket = {};
        t.mock.timers.enable(["setTimeout"]);
        server.state.nodeState = "DISCOVERING";
        server.updatePortToNodeMap = t.mock.fn();
        server.fluxnodePriorPort = t.mock.fn(async () => null);
        server.sendPortSelect = t.mock.fn(() => "test_id");
        t.mock.method(server, "portSelect");
        strict_1.default.strictEqual(server.portSelect.mock.calls.length, 0);
        await server.portSelect(socket, localAddress);
        strict_1.default.strictEqual(server.portSelect.mock.calls.length, 1);
        strict_1.default.strictEqual(server.updatePortToNodeMap.mock.calls.length, 1);
        strict_1.default.strictEqual(server.fluxnodePriorPort.mock.calls.length, 1);
        strict_1.default.strictEqual(server.sendPortSelect.mock.calls.length, 1);
        strict_1.default.strictEqual(server.state.nodeState, "SELECTING");
        strict_1.default.strictEqual(server.state.port, 16197);
        strict_1.default.strictEqual(server.pendingSelectId, "test_id");
        strict_1.default.ok(server.portSelectTimeout);
    });
    (0, node_test_1.it)("SELECTS 16187 when no prior port and no other mappings and 16197 taken", async (t) => {
        const localAddress = "1.1.1.1";
        const socket = {};
        server.networkState = {
            "2.2.2.2": { port: 16197, nodeState: "SELECTING" }
        };
        server.state.nodeState = "DISCOVERING";
        t.mock.timers.enable(["setTimeout"]);
        server.updatePortToNodeMap = t.mock.fn();
        server.fluxnodePriorPort = t.mock.fn(async () => null);
        server.sendPortSelect = t.mock.fn(() => "test_id");
        t.mock.method(server, "portSelect");
        strict_1.default.strictEqual(server.portSelect.mock.calls.length, 0);
        await server.portSelect(socket, localAddress);
        strict_1.default.strictEqual(server.portSelect.mock.calls.length, 1);
        strict_1.default.strictEqual(server.updatePortToNodeMap.mock.calls.length, 1);
        strict_1.default.strictEqual(server.fluxnodePriorPort.mock.calls.length, 1);
        strict_1.default.strictEqual(server.sendPortSelect.mock.calls.length, 1);
        strict_1.default.strictEqual(server.state.nodeState, "SELECTING");
        strict_1.default.strictEqual(server.state.port, 16187);
        strict_1.default.strictEqual(server.pendingSelectId, "test_id");
        strict_1.default.ok(server.portSelectTimeout);
    });
    (0, node_test_1.it)("SELECTS previously used port 16137 when node is live and it is available", async (t) => {
        const localAddress = "1.1.1.1";
        const socket = {};
        t.mock.timers.enable(["setTimeout"]);
        server.state.nodeState = "DISCOVERING";
        server.updatePortToNodeMap = t.mock.fn();
        server.fluxnodePriorPort = t.mock.fn(async () => 16137);
        server.sendPortSelect = t.mock.fn(() => "test_id");
        t.mock.method(server, "portSelect");
        strict_1.default.strictEqual(server.portSelect.mock.calls.length, 0);
        await server.portSelect(socket, localAddress);
        strict_1.default.strictEqual(server.portSelect.mock.calls.length, 1);
        strict_1.default.strictEqual(server.updatePortToNodeMap.mock.calls.length, 1);
        strict_1.default.strictEqual(server.fluxnodePriorPort.mock.calls.length, 1);
        strict_1.default.strictEqual(server.sendPortSelect.mock.calls.length, 1);
        strict_1.default.strictEqual(server.state.nodeState, "SELECTING");
        strict_1.default.strictEqual(server.state.port, 16137);
        strict_1.default.strictEqual(server.pendingSelectId, "test_id");
        strict_1.default.ok(server.portSelectTimeout);
    });
    (0, node_test_1.it)("SELECTS next free port when node is live and existing port is being used", async (t) => {
        const localAddress = "1.1.1.1";
        const socket = {};
        const expectedState = {
            "2.2.2.2": { port: 16137, nodeState: "UNKNOWN" }
        };
        server.state.nodeState = "DISCOVERING";
        server.portToNodeMap = new Map([[16137, "2.2.2.2"]]);
        t.mock.timers.enable(["setTimeout"]);
        server.updatePortToNodeMap = t.mock.fn();
        server.fluxnodePriorPort = t.mock.fn(async () => 16137);
        server.sendPortSelect = t.mock.fn(() => "test_id");
        server.fluxportInUse = t.mock.fn(async () => true);
        t.mock.method(server, "portSelect");
        strict_1.default.strictEqual(server.portSelect.mock.calls.length, 0);
        strict_1.default.strictEqual(server.updatePortToNodeMap.mock.calls.length, 0);
        strict_1.default.strictEqual(server.fluxnodePriorPort.mock.calls.length, 0);
        strict_1.default.strictEqual(server.sendPortSelect.mock.calls.length, 0);
        strict_1.default.strictEqual(server.fluxportInUse.mock.calls.length, 0);
        await server.portSelect(socket, localAddress);
        strict_1.default.strictEqual(server.portSelect.mock.calls.length, 1);
        strict_1.default.strictEqual(server.updatePortToNodeMap.mock.calls.length, 1);
        strict_1.default.strictEqual(server.fluxnodePriorPort.mock.calls.length, 1);
        strict_1.default.strictEqual(server.sendPortSelect.mock.calls.length, 1);
        strict_1.default.strictEqual(server.fluxportInUse.mock.calls.length, 1);
        strict_1.default.strictEqual(server.state.nodeState, "SELECTING");
        strict_1.default.strictEqual(server.state.port, 16197);
        strict_1.default.deepEqual(server.networkState, expectedState);
        strict_1.default.strictEqual(server.pendingSelectId, "test_id");
        strict_1.default.ok(server.portSelectTimeout);
    });
    (0, node_test_1.it)("SELECTS previous used port when node is live and mapping exists but port not it use", async (t) => {
        const localAddress = "1.1.1.1";
        const socket = {};
        server.portToNodeMap = new Map([[16137, "2.2.2.2"]]);
        t.mock.timers.enable(["setTimeout"]);
        server.updatePortToNodeMap = t.mock.fn();
        server.fluxnodePriorPort = t.mock.fn(async () => 16137);
        server.sendPortSelect = t.mock.fn(() => "test_id");
        server.fluxportInUse = t.mock.fn(async () => false);
        t.mock.method(server, "portSelect");
        strict_1.default.strictEqual(server.portSelect.mock.calls.length, 0);
        strict_1.default.strictEqual(server.updatePortToNodeMap.mock.calls.length, 0);
        strict_1.default.strictEqual(server.fluxnodePriorPort.mock.calls.length, 0);
        strict_1.default.strictEqual(server.sendPortSelect.mock.calls.length, 0);
        strict_1.default.strictEqual(server.fluxportInUse.mock.calls.length, 0);
        await server.portSelect(socket, localAddress);
        strict_1.default.strictEqual(server.portSelect.mock.calls.length, 1);
        strict_1.default.strictEqual(server.updatePortToNodeMap.mock.calls.length, 1);
        strict_1.default.strictEqual(server.fluxnodePriorPort.mock.calls.length, 1);
        strict_1.default.strictEqual(server.sendPortSelect.mock.calls.length, 1);
        strict_1.default.strictEqual(server.fluxportInUse.mock.calls.length, 1);
        strict_1.default.strictEqual(server.state.nodeState, "SELECTING");
        strict_1.default.strictEqual(server.state.port, 16137);
        strict_1.default.strictEqual(server.pendingSelectId, "test_id");
        strict_1.default.ok(server.portSelectTimeout);
    });
    (0, node_test_1.it)("RESTARTS when no port is available", async (t) => {
        const localAddress = "1.1.1.1";
        const socket = {};
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const testNetworkState = {
            "1.1.1.1": { port: 16197, nodeState: "READY" },
            "2.2.2.2": { port: 16187, nodeState: "READY" },
            "3.3.3.3": { port: 16177, nodeState: "READY" },
            "4.4.4.4": { port: 16167, nodeState: "READY" },
            "5.5.5.5": { port: 16157, nodeState: "READY" },
            "6.6.6.6": { port: 16147, nodeState: "READY" },
            "7.7.7.7": { port: 16137, nodeState: "READY" },
            "8.8.8.8": { port: 16127, nodeState: "READY" }
        };
        server.networkState = testNetworkState;
        server.updatePortToNodeMap = t.mock.fn();
        server.fluxnodePriorPort = t.mock.fn(async () => null);
        server.sendPortSelect = t.mock.fn(() => "test_id");
        server.initiate = t.mock.fn();
        t.mock.method(server, "portSelect");
        t.mock.method(server, "resetState");
        strict_1.default.strictEqual(server.portSelect.mock.calls.length, 0);
        strict_1.default.strictEqual(server.updatePortToNodeMap.mock.calls.length, 0);
        strict_1.default.strictEqual(server.fluxnodePriorPort.mock.calls.length, 0);
        strict_1.default.strictEqual(server.sendPortSelect.mock.calls.length, 0);
        strict_1.default.strictEqual(server.initiate.mock.calls.length, 0);
        strict_1.default.strictEqual(server.resetState.mock.calls.length, 0);
        await server.portSelect(socket, localAddress);
        // the above starts a 5 minute timeout to restart... we hurry it along here
        t.mock.timers.tick(300 * 1000);
        strict_1.default.strictEqual(server.portSelect.mock.calls.length, 1);
        strict_1.default.strictEqual(server.updatePortToNodeMap.mock.calls.length, 1);
        strict_1.default.strictEqual(server.fluxnodePriorPort.mock.calls.length, 1);
        strict_1.default.strictEqual(server.sendPortSelect.mock.calls.length, 0);
        strict_1.default.strictEqual(server.initiate.mock.calls.length, 1);
        // not sure what form I like yet
        strict_1.default.strictEqual(server.resetState.mock.callCount(), 1);
        strict_1.default.strictEqual(server.state.nodeState, "STARTING");
        strict_1.default.strictEqual(server.state.port, null);
        strict_1.default.strictEqual(server.pendingSelectId, null);
        strict_1.default.strictEqual(server.pendingDiscoverId, null);
        strict_1.default.strictEqual(server.portSelectTimeout, null);
        strict_1.default.strictEqual(server.discoverTimeout, null);
        strict_1.default.deepEqual(server.networkState, {});
    });
});
