/**
 * UPnP eventing (GENA) on the router's WAN connection service. NOTIFYs are accepted only
 * from the gateway's address, since any other host on the LAN could otherwise make the
 * leader read the router's table. Whether a NOTIFY's SID is the current subscription's is
 * the caller's to check.
 */

import http from "node:http";
import { isIP } from "node:net";

export interface RouterEvent {
  sid: string;
  seq: number;
  /** PortMappingNumberOfEntries, when the NOTIFY carries it. */
  entries: number | null;
}

export interface Subscription {
  sid: string;
  /** The subscription's lifetime the router granted; null when it granted "infinite". */
  timeoutSeconds: number | null;
}

export interface RouterEvents {
  listen(onEvent: (event: RouterEvent) => void): Promise<void>;
  /** Throws when the router refuses, does not answer, or gives no SID. */
  subscribe(): Promise<Subscription>;
  /** Throws when the router refuses (one that rebooted answers 412) or does not answer. */
  renew(sid: string): Promise<Subscription>;
  unsubscribe(sid: string): Promise<void>;
  close(): void;
}

const WAN_SERVICES = [
  "urn:schemas-upnp-org:service:WANIPConnection:2",
  "urn:schemas-upnp-org:service:WANIPConnection:1",
  "urn:schemas-upnp-org:service:WANPPPConnection:1"
];
const MAX_NOTIFY_BYTES = 64 * 1024;

export interface GenaRouterEventsOptions {
  /** The router's device description URL (nat-upnp's `gateway.description`). */
  descriptionUrl: string;
  /** This node's LAN address: the listener binds to it, and it is the callback host. */
  localAddress: string;
  /** The port the listener binds to — the one the node's firewall lets the gateway reach. */
  port: number;
  timeoutSeconds?: number;
  requestTimeoutMs?: number;
}

export class GenaRouterEvents implements RouterEvents {
  private readonly descriptionUrl: URL;
  private readonly localAddress: string;
  private readonly port: number;
  private readonly timeoutSeconds: number;
  private readonly requestTimeoutMs: number;
  private server: http.Server | null = null;
  private eventUrl: URL | null = null;

  constructor(options: GenaRouterEventsOptions) {
    this.descriptionUrl = new URL(options.descriptionUrl);
    this.localAddress = options.localAddress;
    this.port = options.port;
    this.timeoutSeconds = options.timeoutSeconds ?? 1800;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  private get gatewayAddress(): string {
    return this.descriptionUrl.hostname;
  }

  listen(onEvent: (event: RouterEvent) => void): Promise<void> {
    if (this.server) return Promise.resolve();
    const server = http.createServer((req, res) => {
      const from = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
      if (req.method !== "NOTIFY" || from !== this.gatewayAddress) {
        res.writeHead(req.method !== "NOTIFY" ? 405 : 403).end();
        req.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_NOTIFY_BYTES) {
          res.writeHead(413).end();
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (res.writableEnded) return;
        const sid = header(req.headers["sid"]);
        const seq = Number(header(req.headers["seq"]));
        if (!sid || !Number.isInteger(seq) || seq < 0) {
          res.writeHead(412).end();
          return;
        }
        res.writeHead(200, { "Content-Length": "0" }).end();
        const body = Buffer.concat(chunks).toString("utf8");
        const count = /<(?:\w+:)?PortMappingNumberOfEntries>\s*(\d+)\s*</.exec(body);
        onEvent({ sid, seq, entries: count ? Number(count[1]) : null });
      });
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.localAddress, () => {
        server.off("error", reject);
        resolve();
      });
    });
  }

  async subscribe(): Promise<Subscription> {
    const url = await this.eventSubUrl();
    return this.gena("SUBSCRIBE", url, {
      CALLBACK: `<http://${hostForUrl(this.localAddress)}:${this.port}/>`,
      NT: "upnp:event",
      TIMEOUT: `Second-${this.timeoutSeconds}`
    });
  }

  async renew(sid: string): Promise<Subscription> {
    const url = await this.eventSubUrl();
    return this.gena("SUBSCRIBE", url, { SID: sid, TIMEOUT: `Second-${this.timeoutSeconds}` });
  }

  async unsubscribe(sid: string): Promise<void> {
    const url = await this.eventSubUrl();
    await this.request("UNSUBSCRIBE", url, { SID: sid });
  }

  close(): void {
    this.server?.close();
    this.server = null;
  }

  private async gena(method: string, url: URL, headers: Record<string, string>): Promise<Subscription> {
    const res = await this.request(method, url, headers);
    if (res.status !== 200) throw new Error(`${method} answered ${res.status}`);
    const sid = header(res.headers["sid"]) || headers.SID;
    if (!sid) throw new Error(`${method} answered without a SID`);
    return { sid, timeoutSeconds: parseTimeout(header(res.headers["timeout"])) };
  }

  private async eventSubUrl(): Promise<URL> {
    if (this.eventUrl) return this.eventUrl;
    const res = await this.request("GET", this.descriptionUrl, {});
    if (res.status !== 200) throw new Error(`device description answered ${res.status}`);
    const xml = res.body;
    const base = /<URLBase>\s*([^<\s]+)\s*<\/URLBase>/.exec(xml)?.[1] ?? this.descriptionUrl.href;
    const services = [...xml.matchAll(/<service>([\s\S]*?)<\/service>/g)].map((m) => m[1]);
    for (const type of WAN_SERVICES) {
      const service = services.find((s) => tag(s, "serviceType") === type);
      const path = service && tag(service, "eventSubURL");
      if (path) {
        this.eventUrl = new URL(path, base);
        return this.eventUrl;
      }
    }
    throw new Error("the router's WAN connection service has no eventSubURL");
  }

  private request(
    method: string,
    url: URL,
    headers: Record<string, string>
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        url,
        { method, headers: { HOST: url.host, ...headers }, timeout: this.requestTimeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8")
            })
          );
          res.on("error", reject);
        }
      );
      req.on("timeout", () => req.destroy(new Error(`${method} timed out`)));
      req.on("error", reject);
      req.end();
    });
  }
}

function header(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value ?? "").trim();
}

function tag(xml: string, name: string): string | null {
  return new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml)?.[1] ?? null;
}

/** "Second-1800" → 1800; "infinite" (or nothing parseable) → null. */
function parseTimeout(value: string): number | null {
  const m = /^Second-(\d+)$/i.exec(value);
  return m ? Number(m[1]) : null;
}

function hostForUrl(address: string): string {
  return isIP(address) === 6 ? `[${address}]` : address;
}
