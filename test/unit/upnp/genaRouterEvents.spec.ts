/**
 * GenaRouterEvents over real HTTP, against a router served on 127.0.0.1.
 */

import assert from "assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { GenaRouterEvents, RouterEvent } from "@/fluxport-controller/upnp/routerEvents";

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

/** A router: its description, and GENA answers the test scripts. */
class LocalRouter {
  seen: Seen[] = [];
  description = descriptionXml({ ip: "/evt/IPConn" });
  answer: (req: http.IncomingMessage, res: http.ServerResponse) => void = (req, res) => {
    if (req.method === "SUBSCRIBE") {
      res.writeHead(200, { SID: (req.headers["sid"] as string) ?? "uuid:sub-1", TIMEOUT: "Second-1800" }).end();
    } else {
      res.writeHead(200).end();
    }
  };
  private server = http.createServer((req, res) => {
    this.seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/xml" }).end(this.description);
      return;
    }
    this.answer(req, res);
  });
  port = 0;

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
  }
  stop(): void {
    this.server.closeAllConnections();
    this.server.close();
  }
  get descriptionUrl(): string {
    return `http://127.0.0.1:${this.port}/rootDesc.xml`;
  }
}

function descriptionXml(urls: { ip?: string; ip2?: string; ppp?: string; base?: string }): string {
  const service = (type: string, evt: string) =>
    `<service><serviceType>${type}</serviceType><controlURL>/ctl</controlURL><eventSubURL>${evt}</eventSubURL><SCPDURL>/scpd.xml</SCPDURL></service>`;
  return (
    `<?xml version="1.0"?><root>${urls.base ? `<URLBase>${urls.base}</URLBase>` : ""}<device><serviceList>` +
    service("urn:schemas-upnp-org:service:Layer3Forwarding:1", "/evt/L3F") +
    (urls.ppp ? service("urn:schemas-upnp-org:service:WANPPPConnection:1", urls.ppp) : "") +
    (urls.ip ? service("urn:schemas-upnp-org:service:WANIPConnection:1", urls.ip) : "") +
    (urls.ip2 ? service("urn:schemas-upnp-org:service:WANIPConnection:2", urls.ip2) : "") +
    `</serviceList></device></root>`
  );
}

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function notify(
  port: number,
  headers: Record<string, string>,
  body = "",
  method = "NOTIFY"
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: "/", headers: { "Content-Length": Buffer.byteLength(body), ...headers } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

const PROPERTY_SET =
  '<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0"><e:property><ExternalIPAddress>203.0.113.1</ExternalIPAddress></e:property>' +
  "<e:property><PortMappingNumberOfEntries>7</PortMappingNumberOfEntries></e:property></e:propertyset>";

describe("GenaRouterEvents", () => {
  let router: LocalRouter;

  before(async () => {
    router = new LocalRouter();
    await router.start();
  });
  after(() => router.stop());

  const make = async (opts: { requestTimeoutMs?: number } = {}) =>
    new GenaRouterEvents({
      descriptionUrl: router.descriptionUrl,
      localAddress: "127.0.0.1",
      port: await freePort(),
      requestTimeoutMs: opts.requestTimeoutMs
    });

  it("subscribes on the WAN service's eventSubURL with a callback, NT and TIMEOUT", async () => {
    router.seen = [];
    const events = await make();
    const sub = await events.subscribe();
    assert.deepEqual(sub, { sid: "uuid:sub-1", timeoutSeconds: 1800 });
    const s = router.seen.find((x) => x.method === "SUBSCRIBE")!;
    assert.equal(s.url, "/evt/IPConn");
    assert.match(String(s.headers["callback"]), /^<http:\/\/127\.0\.0\.1:\d+\/>$/);
    assert.equal(s.headers["nt"], "upnp:event");
    assert.equal(s.headers["timeout"], "Second-1800");
  });

  it("reads the description once", async () => {
    router.seen = [];
    const events = await make();
    await events.subscribe();
    await events.renew("uuid:sub-1");
    await events.unsubscribe("uuid:sub-1");
    assert.equal(router.seen.filter((x) => x.method === "GET").length, 1);
  });

  it("renews with the SID alone, and unsubscribes with the SID", async () => {
    router.seen = [];
    const events = await make();
    await events.renew("uuid:abc");
    await events.unsubscribe("uuid:abc");
    const renew = router.seen.find((x) => x.method === "SUBSCRIBE")!;
    assert.equal(renew.headers["sid"], "uuid:abc");
    assert.equal(renew.headers["callback"], undefined, "a renewal names no callback");
    assert.equal(renew.headers["nt"], undefined);
    assert.equal(router.seen.find((x) => x.method === "UNSUBSCRIBE")!.headers["sid"], "uuid:abc");
  });

  it("reads an infinite subscription as no timeout", async () => {
    const saved = router.answer;
    router.answer = (_req, res) => res.writeHead(200, { SID: "uuid:x", TIMEOUT: "infinite" }).end();
    try {
      assert.deepEqual(await (await make()).subscribe(), { sid: "uuid:x", timeoutSeconds: null });
    } finally {
      router.answer = saved;
    }
  });

  for (const [name, answer, pattern] of [
    ["a refusal", (_q: http.IncomingMessage, r: http.ServerResponse) => r.writeHead(412).end(), /answered 412/],
    ["an answer without a SID", (_q: http.IncomingMessage, r: http.ServerResponse) => r.writeHead(200).end(), /without a SID/],
    ["no answer", () => {}, /timed out/]
  ] as const) {
    it(`throws on ${name} to SUBSCRIBE`, async () => {
      const saved = router.answer;
      router.answer = answer;
      try {
        await assert.rejects((await make({ requestTimeoutMs: 300 })).subscribe(), pattern);
      } finally {
        router.answer = saved;
      }
    });
  }

  it("prefers WANIPConnection:2, then :1, then WANPPPConnection, and honours URLBase", async () => {
    const saved = router.description;
    try {
      for (const [urls, expected] of [
        [{ ip: "/a", ip2: "/b", ppp: "/c" }, "/b"],
        [{ ip: "/a", ppp: "/c" }, "/a"],
        [{ ppp: "/c" }, "/c"],
        [{ ip: "/a", base: `http://127.0.0.1:${router.port}/base/` }, "/a"],
        [{ ip: "rel/evt", base: `http://127.0.0.1:${router.port}/base/` }, "/base/rel/evt"]
      ] as const) {
        router.description = descriptionXml(urls);
        router.seen = [];
        await (await make()).subscribe();
        assert.equal(router.seen.find((x) => x.method === "SUBSCRIBE")!.url, expected, JSON.stringify(urls));
      }
    } finally {
      router.description = saved;
    }
  });

  it("throws when the WAN service has no eventSubURL", async () => {
    const saved = router.description;
    router.description = descriptionXml({});
    try {
      await assert.rejects((await make()).subscribe(), /no eventSubURL/);
    } finally {
      router.description = saved;
    }
  });

  describe("the listener", () => {
    let events: GenaRouterEvents;
    let port: number;
    const received: RouterEvent[] = [];

    before(async () => {
      port = await freePort();
      events = new GenaRouterEvents({
        descriptionUrl: router.descriptionUrl,
        localAddress: "127.0.0.1",
        port
      });
      await events.listen((e) => received.push(e));
    });
    after(() => events.close());

    it("reports a NOTIFY with its SID, SEQ and PortMappingNumberOfEntries", async () => {
      received.length = 0;
      const status = await notify(port, { SID: "uuid:s", SEQ: "4", NT: "upnp:event", NTS: "upnp:propchange" }, PROPERTY_SET);
      assert.equal(status, 200);
      assert.deepEqual(received, [{ sid: "uuid:s", seq: 4, entries: 7 }]);
    });

    it("reports a NOTIFY without the entry count as null", async () => {
      received.length = 0;
      await notify(port, { SID: "uuid:s", SEQ: "5" }, "<e:propertyset/>");
      assert.deepEqual(received, [{ sid: "uuid:s", seq: 5, entries: null }]);
    });

    it("answers 412 to a NOTIFY without a SID or a usable SEQ, and reports nothing", async () => {
      received.length = 0;
      assert.equal(await notify(port, { SEQ: "1" }), 412);
      assert.equal(await notify(port, { SID: "uuid:s", SEQ: "x" }), 412);
      assert.equal(await notify(port, { SID: "uuid:s", SEQ: "-1" }), 412);
      assert.deepEqual(received, []);
    });

    it("answers 405 to anything but NOTIFY", async () => {
      assert.equal(await notify(port, { SID: "uuid:s", SEQ: "1" }, "", "POST"), 405);
    });

    it("refuses a body over 64 KiB", async () => {
      received.length = 0;
      const status = await notify(port, { SID: "uuid:s", SEQ: "1" }, "x".repeat(70 * 1024)).catch(() => 413);
      assert.equal(status, 413);
      assert.deepEqual(received, []);
    });
  });

  it("refuses a NOTIFY from any address but the gateway's", async () => {
    const port = await freePort();
    const events = new GenaRouterEvents({
      descriptionUrl: "http://192.0.2.1:5000/rootDesc.xml", // the gateway is elsewhere
      localAddress: "127.0.0.1",
      port
    });
    const received: RouterEvent[] = [];
    await events.listen((e) => received.push(e));
    try {
      assert.equal(await notify(port, { SID: "uuid:s", SEQ: "1" }, PROPERTY_SET), 403);
      assert.deepEqual(received, []);
    } finally {
      events.close();
    }
  });

  it("rejects listen() when the port is taken", async () => {
    const taken = http.createServer();
    await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
    const port = (taken.address() as AddressInfo).port;
    try {
      const events = new GenaRouterEvents({ descriptionUrl: router.descriptionUrl, localAddress: "127.0.0.1", port });
      await assert.rejects(events.listen(() => {}), /EADDRINUSE/);
    } finally {
      taken.close();
    }
  });
});
