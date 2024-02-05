import assert from "assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import {
  FluxEchoServer,
  Msg,
  Dir
} from "../../src/fluxport-controller/fluxEchoServer";
import { Socket } from "dgram";
import { logController } from "../../src/fluxport-controller/log";
import { AddressInfo } from "net";

describe("handler tests", () => {
  let server: FluxEchoServer;
  beforeEach(() => (server = new FluxEchoServer()));
  afterEach(() => server.stop());

  it("should add INBOUND peer, emit and send PONG when ping message received and less than 2 inbound peers exist", (t) => {
    const socket = {} as Socket;
    const localAddress = "1.1.1.1";
    const remoteAddress = "2.2.2.2";
    const testPing = {
      type: Msg.PING,
      id: "test",
      host: remoteAddress
    };

    t.mock.timers.enable({ apis: ["Date"] });
    t.mock.timers.tick(9999);

    assert.deepEqual(server.inboundPeerCount, 0);

    server.sendPingNak = t.mock.fn();
    server.addPeer = t.mock.fn();
    server.emit = t.mock.fn();
    server.sendPong = t.mock.fn();

    server.pingHandler(socket, localAddress, testPing, remoteAddress);

    assert.deepEqual((server.sendPingNak as any as any).mock.calls.length, 0);
    assert.deepEqual((server.addPeer as any as any).mock.calls.length, 1);
    const addPeerCall = (server.addPeer as any as any).mock.calls[0];
    assert.deepStrictEqual(addPeerCall.arguments, [
      remoteAddress,
      Dir.INBOUND,
      { activeSince: 9999 }
    ]);

    assert.deepEqual((server.emit as any as any).mock.calls.length, 1);
    const emitCall = (server.emit as any as any).mock.calls[0];
    assert.deepStrictEqual(emitCall.arguments, [
      "peerConnected",
      remoteAddress,
      Dir.INBOUND
    ]);

    assert.deepEqual((server.sendPong as any as any).mock.calls.length, 1);
    const sendPongCall = (server.sendPong as any as any).mock.calls[0];
    assert.deepStrictEqual(sendPongCall.arguments, [
      socket,
      localAddress,
      testPing.id,
      "239.2.2.2"
    ]);
  });
  it("should REJECT INBOUND peer when inbound peercount is 2 or greater", (t) => {
    const socket = {} as Socket;
    const localAddress = "1.1.1.1";
    const remoteAddress = "4.4.4.4";
    const testPing = {
      type: Msg.PING,
      id: "test",
      host: remoteAddress
    };

    // logController.addLoggerTransport("console");

    // const info = t.mock.fn();
    // const logger = { info };
    // const getLogger = () => logger;
    // t.mock.fn(logController.getLogger, getLogger);

    server.sendPingNak = t.mock.fn();

    server.inbound = {
      "2.2.2.2": {
        activeSince: 0
      },
      "3.3.3.3": {
        activeSince: 0
      }
    };

    server.pingHandler(socket, localAddress, testPing, remoteAddress);
    // assert.deepEqual(info.mock.calls.length, 1);
    // assert.deepStrictEqual(info.arguments, [
    //   `Max inbound peer count reached. Rejecting: ${remoteAddress}`
    // ]);
    assert.strictEqual((server.sendPingNak as any as any).mock.calls.length, 1);
    const sendPingNakCall = (server.sendPingNak as any as any).mock.calls[0];
    assert.deepStrictEqual(sendPingNakCall.arguments, [
      socket,
      localAddress,
      testPing.id,
      "239.4.4.4"
    ]);
  });
  it("Should handle PONG and emit peerConnected in response to PING", (t) => {
    const peer = "2.2.2.2";
    const testPong = {
      type: Msg.PONG,
      id: "testid",
      host: peer
    };

    t.mock.timers.enable({ apis: ["Date"] });
    t.mock.timers.tick(9999);

    server.outbound = {
      "2.2.2.2": {
        pingTimer: null,
        messageTimeouts: new Map([["testid", setTimeout(() => {})]]),
        missedPingCount: 0,
        timeoutCount: 0,
        activeSince: 0
      }
    };

    server.emit = t.mock.fn();

    // fix this: remove the host from the message (use Partial or something )
    server.pongHandler(testPong, peer);

    assert.strictEqual(server.outbound[peer].messageTimeouts.size, 0);
    assert.strictEqual(server.outbound[peer].activeSince, 9999);
    assert.strictEqual((server.emit as any as any).mock.calls.length, 1);
    const emitCall = (server.emit as any as any).mock.calls[0];
    assert.deepStrictEqual(emitCall.arguments, [
      "peerConnected",
      peer,
      Dir.OUTBOUND
    ]);
  });

  it("Should handle PONG and emit peerReconnect and clear old timeouts when reconnected", (t) => {
    const peer = "2.2.2.2";
    const testPong = {
      type: Msg.PONG,
      id: "testid",
      host: peer
    };

    server.outbound = {
      "2.2.2.2": {
        pingTimer: null,
        messageTimeouts: new Map([
          ["oldTestId", setTimeout(() => {})],
          ["testid", setTimeout(() => {})]
        ]),
        missedPingCount: 2,
        timeoutCount: 1,
        activeSince: 5555
      }
    };

    server.emit = t.mock.fn();

    // fix this: remove the host from the message (use Partial or something )
    server.pongHandler(testPong, peer);

    assert.strictEqual(server.outbound[peer].messageTimeouts.size, 0);
    assert.strictEqual(server.outbound[peer].activeSince, 5555);
    assert.strictEqual(server.outbound[peer].missedPingCount, 0);
    assert.strictEqual(server.outbound[peer].timeoutCount, 0);
    assert.strictEqual((server.emit as any as any).mock.calls.length, 1);
    const emitCall = (server.emit as any as any).mock.calls[0];
    assert.deepStrictEqual(emitCall.arguments, ["peerReconnected", peer]);
  });

  it("Should handle PONG and clear single timeout when PING received, and not emit", (t) => {
    const peer = "2.2.2.2";
    const testPong = {
      type: Msg.PONG,
      id: "testid",
      host: peer
    };

    server.outbound = {
      "2.2.2.2": {
        pingTimer: null,
        messageTimeouts: new Map([["testid", setTimeout(() => {})]]),
        missedPingCount: 0,
        timeoutCount: 0,
        activeSince: 5555
      }
    };

    server.emit = t.mock.fn();

    // fix this: remove the host from the message (use Partial or something )
    server.pongHandler(testPong, peer);

    assert.strictEqual(server.outbound[peer].messageTimeouts.size, 0);
    assert.strictEqual(server.outbound[peer].activeSince, 5555);
    assert.strictEqual(server.outbound[peer].missedPingCount, 0);
    assert.strictEqual(server.outbound[peer].timeoutCount, 0);
    assert.strictEqual((server.emit as any as any).mock.calls.length, 0);
  });

  it("Should handle PING_NAK message, remove peer and emit peerRejected", (t) => {
    const peer = "2.2.2.2";
    const testPingNak = {
      type: Msg.PING_NAK,
      id: "testid",
      host: peer
    };

    server.outbound = {
      "2.2.2.2": {
        pingTimer: null,
        messageTimeouts: new Map([["testid", setTimeout(() => {})]]),
        missedPingCount: 0,
        timeoutCount: 0,
        activeSince: 0
      }
    };

    server.emit = t.mock.fn();
    t.mock.method(server, "removePeer");

    // fix this: remove the host from the message (use Partial or something )
    server.pingNakHandler(testPingNak, peer);

    assert.deepEqual(server.outbound, {});
    assert.strictEqual((server.emit as any as any).mock.calls.length, 1);
    assert.strictEqual((server.removePeer as any as any).mock.calls.length, 1);
    const emitCall = (server.emit as any as any).mock.calls[0];
    assert.deepStrictEqual(emitCall.arguments, ["peerRejected", peer]);
  });
});
