import assert from "assert/strict";
import { describe, it } from "node:test";
import { SerialQueue } from "@/fluxport-controller/serialQueue";

/** A manually-settled promise + its resolve/reject handles. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush the microtask queue until `cond` holds (the chain hops several thens
 *  between an op settling and the next starting), bounded so a bug still fails. */
async function flushUntil(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !cond(); i += 1) await Promise.resolve();
}

describe("SerialQueue", () => {
  it("runs ops one at a time, in FIFO order, with no overlap", async () => {
    const q = new SerialQueue();
    const log: string[] = [];
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];

    const op = (i: number) => () => {
      log.push(`start-${i}`);
      return gates[i].promise.then(() => {
        log.push(`end-${i}`);
      });
    };

    // Fire all three concurrently; only the first should have started.
    const all = Promise.all([q.run(op(0)), q.run(op(1)), q.run(op(2))]);
    await flushUntil(() => log.length >= 1);
    assert.deepEqual(log, ["start-0"]);

    // Release each in turn; the next starts only once the prior has ended.
    gates[0].resolve();
    await flushUntil(() => log.includes("start-1"));
    assert.deepEqual(log, ["start-0", "end-0", "start-1"]);

    gates[1].resolve();
    await flushUntil(() => log.includes("start-2"));
    assert.deepEqual(log, ["start-0", "end-0", "start-1", "end-1", "start-2"]);

    gates[2].resolve();
    await all;
    assert.deepEqual(log, [
      "start-0",
      "end-0",
      "start-1",
      "end-1",
      "start-2",
      "end-2"
    ]);
  });

  it("returns each op's own result", async () => {
    const q = new SerialQueue();
    const a = await q.run(async () => 1);
    const b = await q.run(async () => "two");
    assert.equal(a, 1);
    assert.equal(b, "two");
  });

  it("a rejecting op does not block the next; the chain survives", async () => {
    const q = new SerialQueue();
    const log: string[] = [];

    const boom = q.run(async () => {
      log.push("boom");
      throw new Error("fail");
    });
    const after = q.run(async () => {
      log.push("after");
      return "ok";
    });

    await assert.rejects(boom, /fail/);
    assert.equal(await after, "ok");
    assert.deepEqual(log, ["boom", "after"]);
  });
});
