import assert from "assert/strict";
import { describe, it } from "node:test";
import {
  SerializedUpnpClient,
  UpnpClientLike,
  UpnpInfoLike,
  UpnpMapping
} from "@/fluxport-controller/upnpClient";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const MAPPING: UpnpMapping = {
  public: { host: "", port: 16197 },
  private: { host: "10.0.0.11", port: 16197 },
  protocol: "tcp",
  enabled: true,
  description: "flux",
  ttl: 0
};

/** Records inbound call order and stays in flight until released. */
class FakeInner implements UpnpClientLike {
  inFlight = 0;
  maxInFlight = 0;
  readonly calls: string[] = [];
  readonly gate = deferred<void>();
  lastQuery: { public: number; protocol?: string } | null = null;
  mappingResult: UpnpMapping | null = MAPPING;

  private async enter(name: string): Promise<void> {
    this.calls.push(name);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await this.gate.promise;
    this.inFlight -= 1;
  }

  async getGateway(): Promise<UpnpInfoLike> {
    await this.enter("getGateway");
    return {
      gateway: { description: "http://10.0.0.1/rootDesc.xml" },
      getLocalAddress: async () => "10.0.0.11"
    };
  }
  async getMappings(): Promise<UpnpMapping[]> {
    await this.enter("getMappings");
    return [MAPPING];
  }
  async getMapping(q: {
    public: number;
    protocol?: string;
  }): Promise<UpnpMapping | null> {
    await this.enter("getMapping");
    this.lastQuery = q;
    return this.mappingResult;
  }
  async createMapping(): Promise<void> {
    await this.enter("createMapping");
  }
  async removeMapping(): Promise<void> {
    await this.enter("removeMapping");
  }
  close(): void {}
}

describe("SerializedUpnpClient", () => {
  it("reaches the inner client one call at a time, in call order", async () => {
    const inner = new FakeInner();
    const client = new SerializedUpnpClient(inner);

    const all = Promise.all([
      client.getMappings(),
      client.getMapping({ public: 16197 }),
      client.createMapping({
        public: 16197,
        private: { host: "10.0.0.11", port: 16197 }
      })
    ]);

    // All three are queued, but only the first has reached the inner client.
    await Promise.resolve();
    assert.equal(inner.inFlight, 1);
    assert.deepEqual(inner.calls, ["getMappings"]);

    inner.gate.resolve();
    await all;

    assert.equal(inner.maxInFlight, 1, "never more than one SOAP call in flight");
    assert.deepEqual(inner.calls, ["getMappings", "getMapping", "createMapping"]);
  });

  it("delegates each method and returns the inner result", async () => {
    const inner = new FakeInner();
    inner.gate.resolve();
    const client = new SerializedUpnpClient(inner);

    const gw = await client.getGateway();
    assert.equal(await gw.getLocalAddress(), "10.0.0.11");
    assert.deepEqual(await client.getMappings(), [MAPPING]);
    assert.deepEqual(await client.getMapping({ public: 16197 }), MAPPING);
    await client.createMapping({
      public: 16197,
      private: { host: "10.0.0.11", port: 16197 }
    });
    await client.removeMapping({ public: 16197 });
    assert.deepEqual(inner.calls, [
      "getGateway",
      "getMappings",
      "getMapping",
      "createMapping",
      "removeMapping"
    ]);
  });

  it("passes the query through and returns null when the inner returns null", async () => {
    const inner = new FakeInner();
    inner.gate.resolve();
    inner.mappingResult = null;
    const client = new SerializedUpnpClient(inner);

    const result = await client.getMapping({ public: 16177, protocol: "udp" });
    assert.equal(result, null);
    assert.deepEqual(inner.lastQuery, { public: 16177, protocol: "udp" });
  });
});
