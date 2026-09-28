// Wire protocol for ChaTTY v2.
//
// Frame layout on the TCP stream:
//   [u32 BE length][u8 kind][payload ...]
// `length` counts the kind byte plus the payload.
//   kind 0 — plaintext JSON, only allowed for the handshake (hello / hello_ack)
//   kind 1 — AES-256-GCM sealed JSON (see crypto.ts `Session`)

export const PROTOCOL_VERSION = 2;
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export const FrameKind = {
  Plain: 0,
  Sealed: 1,
} as const;
export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

export type PresenceStatus = "online" | "away" | "offline";

export interface HandshakeMessage {
  t: "hello" | "hello_ack";
  v: number;
  userId: string;
  username: string;
  displayName: string;
  status: PresenceStatus;
  /** TCP port this peer listens on (so the other side can dial back later). */
  port: number;
  /** Ed25519 identity public key, base64url (raw 32 bytes). */
  identityKey: string;
  /** Ephemeral X25519 public key for this connection, base64url (raw 32 bytes). */
  ephemeralKey: string;
  /** Ed25519 signature over the handshake transcript, base64url. */
  sig: string;
}

export interface GroupMember {
  id: string;
  username: string;
  displayName: string;
}

export type PeerMessage =
  | { t: "ping"; ts: number }
  | { t: "pong"; ts: number }
  | { t: "presence"; status: PresenceStatus; displayName: string }
  | { t: "goodbye" }
  | { t: "peers"; peers: Array<{ id: string; host: string; port: number }> }
  | {
      t: "chat";
      id: string;
      convId: string;
      convType: "direct" | "group";
      body: string;
      ts: number;
    }
  | { t: "delivered"; ids: string[] }
  | { t: "read"; convId: string; ids: string[] }
  | { t: "typing"; convId: string; typing: boolean }
  | {
      t: "group";
      convId: string;
      name: string;
      createdBy: string;
      createdAt: number;
      version: number;
      members: GroupMember[];
    }
  | { t: "group_leave"; convId: string; version: number }
  | {
      t: "file_offer";
      id: string;
      messageId: string;
      convId: string;
      name: string;
      size: number;
      sha256: string;
      ts: number;
    }
  | { t: "file_accept"; id: string }
  | { t: "file_decline"; id: string }
  | { t: "file_chunk"; id: string; seq: number; data: string }
  | { t: "file_done"; id: string }
  | { t: "file_result"; id: string; ok: boolean; reason?: string }
  | { t: "file_cancel"; id: string; reason: string };

export type PeerMessageType = PeerMessage["t"];

/** Encode one frame. */
export function encodeFrame(kind: FrameKind, payload: Uint8Array): Buffer {
  const len = payload.length + 1;
  if (len > MAX_FRAME_BYTES) {
    throw new Error(`frame too large: ${len} bytes (max ${MAX_FRAME_BYTES})`);
  }
  const buf = Buffer.allocUnsafe(4 + len);
  buf.writeUInt32BE(len, 0);
  buf.writeUInt8(kind, 4);
  buf.set(payload, 5);
  return buf;
}

export interface Frame {
  kind: FrameKind;
  payload: Buffer;
}

/**
 * Incremental frame decoder. Feed it arbitrary TCP chunks; it yields whole frames.
 * Throws on a corrupt stream (bad kind, oversize frame) — the caller should drop
 * the connection.
 */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;

  push(chunk: Buffer): Frame[] {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    const frames: Frame[] = [];
    let buf = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.buffered);
    let offset = 0;
    while (buf.length - offset >= 4) {
      const len = buf.readUInt32BE(offset);
      if (len < 1 || len > MAX_FRAME_BYTES) {
        throw new Error(`invalid frame length ${len}`);
      }
      if (buf.length - offset < 4 + len) break;
      const kind = buf.readUInt8(offset + 4);
      if (kind !== FrameKind.Plain && kind !== FrameKind.Sealed) {
        throw new Error(`invalid frame kind ${kind}`);
      }
      frames.push({ kind: kind as FrameKind, payload: Buffer.from(buf.subarray(offset + 5, offset + 4 + len)) });
      offset += 4 + len;
    }
    if (offset > 0) buf = buf.subarray(offset);
    this.chunks = buf.length > 0 ? [buf] : [];
    this.buffered = buf.length;
    return frames;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeJson(value: unknown): Uint8Array {
  return enc.encode(JSON.stringify(value));
}

export function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(dec.decode(bytes));
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isStatus = (v: unknown): v is PresenceStatus => v === "online" || v === "away" || v === "offline";

export function parseHandshake(value: unknown): HandshakeMessage {
  const m = value as Record<string, unknown>;
  if (
    !m ||
    (m.t !== "hello" && m.t !== "hello_ack") ||
    !isNum(m.v) ||
    !isStr(m.userId) ||
    !isStr(m.username) ||
    !isStr(m.displayName) ||
    !isStatus(m.status) ||
    !isNum(m.port) ||
    !isStr(m.identityKey) ||
    !isStr(m.ephemeralKey) ||
    !isStr(m.sig)
  ) {
    throw new Error("malformed handshake");
  }
  return m as unknown as HandshakeMessage;
}

/** Validate an untrusted decoded object as a PeerMessage. Throws when malformed. */
export function parsePeerMessage(value: unknown): PeerMessage {
  const m = value as Record<string, unknown>;
  if (!m || typeof m !== "object" || !isStr(m.t)) throw new Error("malformed message");
  const ok = (() => {
    switch (m.t) {
      case "ping":
      case "pong":
        return isNum(m.ts);
      case "presence":
        return isStatus(m.status) && isStr(m.displayName);
      case "goodbye":
        return true;
      case "peers":
        return (
          Array.isArray(m.peers) && m.peers.every((p) => isObj(p) && isStr(p.id) && isStr(p.host) && isNum(p.port))
        );
      case "chat":
        return (
          isStr(m.id) &&
          isStr(m.convId) &&
          (m.convType === "direct" || m.convType === "group") &&
          isStr(m.body) &&
          isNum(m.ts)
        );
      case "delivered":
        return isStrArr(m.ids);
      case "read":
        return isStr(m.convId) && isStrArr(m.ids);
      case "typing":
        return isStr(m.convId) && isBool(m.typing);
      case "group":
        return (
          isStr(m.convId) &&
          isStr(m.name) &&
          isStr(m.createdBy) &&
          isNum(m.createdAt) &&
          isNum(m.version) &&
          Array.isArray(m.members) &&
          m.members.every((x) => isObj(x) && isStr(x.id) && isStr(x.username) && isStr(x.displayName))
        );
      case "group_leave":
        return isStr(m.convId) && isNum(m.version);
      case "file_offer":
        return (
          isStr(m.id) &&
          isStr(m.messageId) &&
          isStr(m.convId) &&
          isStr(m.name) &&
          isNum(m.size) &&
          isStr(m.sha256) &&
          isNum(m.ts)
        );
      case "file_accept":
      case "file_decline":
      case "file_done":
        return isStr(m.id);
      case "file_chunk":
        return isStr(m.id) && isNum(m.seq) && isStr(m.data);
      case "file_result":
        return isStr(m.id) && isBool(m.ok);
      case "file_cancel":
        return isStr(m.id) && isStr(m.reason);
      default:
        return false;
    }
  })();
  if (!ok) throw new Error(`malformed '${m.t}' message`);
  return m as unknown as PeerMessage;
}
