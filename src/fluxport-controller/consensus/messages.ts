/**
 * Wire protocol for the token-ring atomic-broadcast layer.
 *
 * Every datagram is separator-framed so several messages may share one datagram
 * (UDP datagrams are atomic, so there is no cross-datagram buffering here — that
 * was only needed for the old stream-style decoder). `version` is injected by
 * `encode` and validated/stripped by `decodeDatagram`; mismatched versions are
 * dropped so a coordinated network bump cannot be corrupted by stragglers.
 */

export const PROTOCOL_VERSION = 2;

/** A separator unlikely to occur inside JSON-encoded payloads. */
export const SEPARATOR = "FPC";

/** Stable node identity: the collateral outpoint "txhash:outidx". */
export type Nid = string;

/**
 * The named consensus group a message belongs to. Independent groups (each with
 * its own ring, ordering and membership) can share one multicast socket; a
 * message is only ours when its `groupId` matches. Absent on the wire ⇒ this
 * default, so a single-group deployment behaves exactly as before.
 */
export const DEFAULT_GROUP_ID = "default";

/** Identifies a membership configuration (the ring). */
export interface RingId {
  rep: Nid;
  seq: number;
}

export type MessageKind =
  | "MCAST"
  | "TOKEN"
  | "JOIN"
  | "COMMIT_PROPOSE"
  | "COMMIT_REPLY";

interface Envelope {
  kind: MessageKind;
  /**
   * Which named consensus group this message is scoped to. Always stamped on
   * outgoing messages; optional so a peer that predates the field (or absent on
   * the wire) decodes as the default group rather than being rejected.
   */
  groupId?: string;
  ringId: RingId;
}

/** Application (L3) multicast carrying an opaque, totally-ordered payload. */
export interface McastMessage extends Envelope {
  kind: "MCAST";
  senderNid: Nid;
  seq: number;
  payload: unknown;
}

/** The rotating token: grants broadcast privilege, carries ordering + reliability state. */
export interface TokenMessage extends Envelope {
  kind: "TOKEN";
  tokenSeq: number;
  seq: number;
  /** Committed safe watermark: every member has delivered all seqs ≤ safe. */
  safe: number;
  /** Running per-rotation min of members' received-up-to; commits into `safe`. */
  aru: number;
  /** The rotation anchor (representative) that commits aru → safe. */
  aruId: Nid | null;
  rtr: number[];
  fcc: number;
}

/**
 * Membership message. `gathering` distinguishes an active reconfiguration ("I am
 * gathering — join me") from a steady-state discovery announce ("here is my
 * view"). procSet is the sender's believed-alive set (informational); candidates
 * are seeded from JOIN *senders* (proof of life), not procSets, so a crashed
 * member that still appears in others' announced views is not resurrected.
 */
export interface JoinMessage extends Envelope {
  kind: "JOIN";
  senderNid: Nid;
  gathering: boolean;
  procSet: Nid[];
  failSet: Nid[];
}

/**
 * Multicast 2-phase commit of a new view, driven by the representative and
 * retransmitted until every member replies — so no single dropped packet aborts
 * the commit (unlike a unicast token chain).
 *  - `collect`: members reply with their old-ring state;
 *  - `install`: carries the gathered states; members flush, deliver the view
 *    change, install the new ring, and reply.
 */
export interface CommitProposeMessage extends Envelope {
  kind: "COMMIT_PROPOSE";
  phase: "collect" | "install";
  originator: Nid; // the representative driving this commit
  members: Nid[]; // committed member set
  memberStates?: MemberState[]; // present in the install phase
}

/** A member's multicast reply to a COMMIT_PROPOSE (the representative collects). */
export interface CommitReplyMessage extends Envelope {
  kind: "COMMIT_REPLY";
  phase: "collect" | "install";
  senderNid: Nid;
  state?: MemberState; // present in a collect reply
}

export interface MemberState {
  nid: Nid;
  /** The member's old ring. Flush targets are per-old-ring (merged rings have
   *  independent seq spaces, so their recovery cuts are computed separately). */
  oldRing: RingId;
  aru: number;
}

export type ProtocolMessage =
  | McastMessage
  | TokenMessage
  | JoinMessage
  | CommitProposeMessage
  | CommitReplyMessage;

const KNOWN_KINDS: ReadonlySet<string> = new Set<MessageKind>([
  "MCAST",
  "TOKEN",
  "JOIN",
  "COMMIT_PROPOSE",
  "COMMIT_REPLY"
]);

/** Encode one protocol message into a separator-framed datagram buffer. */
export function encode(msg: ProtocolMessage): Buffer {
  return Buffer.from(
    SEPARATOR + JSON.stringify({ version: PROTOCOL_VERSION, ...msg }) + SEPARATOR
  );
}

/**
 * Decode a received datagram into zero or more protocol messages. Tolerant of
 * coalesced messages, empty fragments and malformed JSON, and drops any message
 * whose protocol version does not match or whose kind is unknown.
 */
export function decodeDatagram(data: Buffer): ProtocolMessage[] {
  const parts = data
    .toString()
    .split(SEPARATOR)
    .filter((p) => p.length > 0);

  const messages: ProtocolMessage[] = [];
  for (const part of parts) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(part);
    } catch {
      continue; // drop malformed fragment
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === PROTOCOL_VERSION &&
      typeof parsed.kind === "string" &&
      KNOWN_KINDS.has(parsed.kind)
    ) {
      delete parsed.version; // version is purely a wire concern
      messages.push(parsed as unknown as ProtocolMessage);
    }
  }
  return messages;
}
