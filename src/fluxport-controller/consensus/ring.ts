/**
 * Pure ring helpers. Members are ordered by `nid` (the stable outpoint identity),
 * which is identical on every node, so the ring shape and the successor each node
 * passes the token to are agreed without any negotiation.
 */

import { Nid } from "./messages";

/** Sorted, de-duplicated member list — the canonical ring order. */
export function sortMembers(nids: Nid[]): Nid[] {
  return Array.from(new Set(nids)).sort();
}

/** The node `self` passes the token to, wrapping around the ring. */
export function successorOf(self: Nid, members: Nid[]): Nid {
  const sorted = sortMembers(members);
  const i = sorted.indexOf(self);
  if (i === -1) return self; // not a member: degenerate singleton
  return sorted[(i + 1) % sorted.length];
}

/** The representative (token originator / membership leader) = lowest nid. */
export function representativeOf(members: Nid[]): Nid | null {
  const sorted = sortMembers(members);
  return sorted.length ? sorted[0] : null;
}
