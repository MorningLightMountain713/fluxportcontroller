/**
 * One-in-flight async queue. A consumer-grade router runs a single-threaded
 * miniupnpd that corrupts state if hit concurrently, so every SOAP call for the
 * node is funnelled through one of these to guarantee strict serialization.
 */
export class SerialQueue {
  // The tail of the settled chain: resolves once the last enqueued op SETTLES
  // (resolve OR reject), never rejects itself, so a failed op can't break the chain.
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(op: () => Promise<T>): Promise<T> {
    // Chain off the prior op's SETTLEMENT (then(op, op)) so the next op starts
    // whether the previous resolved or rejected; hand the caller this op's own
    // promise, and swallow it for the next link so rejections don't propagate.
    const result = this.tail.then(op, op);
    this.tail = result.then(
      () => {},
      () => {}
    );
    return result;
  }
}
