import assert from "assert/strict";
import { describe, it } from "node:test";
import {
  sortMembers,
  successorOf,
  representativeOf
} from "../../../src/fluxport-controller/consensus/ring";

describe("ring helpers", () => {
  it("sorts and de-duplicates members", () => {
    assert.deepEqual(sortMembers(["c:0", "a:0", "b:0", "a:0"]), [
      "a:0",
      "b:0",
      "c:0"
    ]);
  });

  it("returns the next member, wrapping at the end", () => {
    const m = ["a:0", "b:0", "c:0"];
    assert.equal(successorOf("a:0", m), "b:0");
    assert.equal(successorOf("b:0", m), "c:0");
    assert.equal(successorOf("c:0", m), "a:0"); // wrap
  });

  it("treats a singleton ring's successor as itself", () => {
    assert.equal(successorOf("a:0", ["a:0"]), "a:0");
  });

  it("returns self when not a member (degenerate)", () => {
    assert.equal(successorOf("z:0", ["a:0", "b:0"]), "z:0");
  });

  it("picks the lowest nid as representative", () => {
    assert.equal(representativeOf(["c:0", "a:0", "b:0"]), "a:0");
    assert.equal(representativeOf([]), null);
  });
});
