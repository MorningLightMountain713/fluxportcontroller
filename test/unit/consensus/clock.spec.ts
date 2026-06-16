import assert from "assert/strict";
import { describe, it } from "node:test";
import { ManualClock } from "../../../src/fluxport-controller/consensus/clock";

describe("ManualClock", () => {
  it("starts at 0 and advances", () => {
    const c = new ManualClock();
    assert.equal(c.now(), 0);
    c.advance(100);
    assert.equal(c.now(), 100);
  });

  it("fires a timer at its deadline, not before", () => {
    const c = new ManualClock();
    let fired = false;
    c.setTimer(100, () => (fired = true));
    c.advance(99);
    assert.equal(fired, false);
    c.advance(1);
    assert.equal(fired, true);
  });

  it("sets now() to the timer's deadline while the callback runs", () => {
    const c = new ManualClock();
    let at = -1;
    c.setTimer(40, () => (at = c.now()));
    c.advance(100);
    assert.equal(at, 40);
  });

  it("fires multiple timers in chronological order", () => {
    const c = new ManualClock();
    const order: number[] = [];
    c.setTimer(30, () => order.push(30));
    c.setTimer(10, () => order.push(10));
    c.setTimer(20, () => order.push(20));
    c.advance(100);
    assert.deepEqual(order, [10, 20, 30]);
  });

  it("does not fire a cleared timer", () => {
    const c = new ManualClock();
    let fired = false;
    const id = c.setTimer(50, () => (fired = true));
    c.clearTimer(id);
    c.advance(100);
    assert.equal(fired, false);
    assert.equal(c.pending, 0);
  });

  it("fires timers scheduled from within a callback if they fall due", () => {
    const c = new ManualClock();
    const order: number[] = [];
    c.setTimer(10, () => {
      order.push(10);
      c.setTimer(10, () => order.push(20)); // due at 20
    });
    c.advance(100);
    assert.deepEqual(order, [10, 20]);
  });
});
