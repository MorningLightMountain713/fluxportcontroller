/**
 * Wire protocol for the token-ring atomic-broadcast layer.
 *
 * Every datagram is separator-framed so several messages may share one datagram
 * (UDP datagrams are atomic, so there is no cross-datagram buffering here — that
 * was only needed for the old stream-style decoder). `version` is injected by
 * `encode` and validated/stripped by `decodeDatagram`; mismatched versions are
 * dropped so a coordinated network bump cannot be corrupted by stragglers.
 */

export const PROTOCOL_VERSION = 1;

/** A separator unlikely to occur inside JSON-encoded payloads. */
export const SEPARATOR = "FPC";

/** Stable node identity: the collateral outpoint "txhash:outidx". */
export type Nid = string;

/** Identifies a membership configuration (the ring). */
export interface RingId {
  rep: Nid;
  seq: number;
}

export type MessageKind = "MCAST" | "TOKEN" | "JOIN" | "COMMIT_TOKEN";

interface Envelope {
  kind: MessageKind;
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
  aru: number;
  aruId: Nid | null;
  rtr: number[];
  fcc: number;
}

/** Membership proposal multicast during GATHER. */
export interface JoinMessage extends Envelope {
  kind: "JOIN";
  senderNid: Nid;
  procSet: Nid[];
  failSet: Nid[];
}

/** Circulated during COMMIT to fix the new ring and collect recovery high-water marks. */
export interface CommitTokenMessage extends Envelope {
  kind: "COMMIT_TOKEN";
  memberStates: MemberState[];
}

export interface MemberState {
  nid: Nid;
  aru: number;
  highSeq: number;
}

export type ProtocolMessage =
  | McastMessage
  | TokenMessage
  | JoinMessage
  | CommitTokenMessage;

const KNOWN_KINDS: ReadonlySet<string> = new Set<MessageKind>([
  "MCAST",
  "TOKEN",
  "JOIN",
  "COMMIT_TOKEN"
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
