// One TCP connection to one peer: handshake, encryption, framing.
//
// Handshake (both frames plaintext, everything after is sealed):
//   dialer   → acceptor : hello     { identity, ephemeral X25519 key, signature }
//   acceptor → dialer   : hello_ack { identity, ephemeral X25519 key, signature }
// Both sides verify the peer's signature, run X25519 and derive a Session.

import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import type { Logger } from "../util/logger.ts";
import { Ephemeral, handshakeTranscript, Identity, Session } from "./crypto.ts";
import {
  decodeJson,
  encodeFrame,
  encodeJson,
  type Frame,
  FrameDecoder,
  FrameKind,
  type HandshakeMessage,
  type PeerMessage,
  PROTOCOL_VERSION,
  type PresenceStatus,
  parseHandshake,
  parsePeerMessage,
} from "./protocol.ts";

export interface LocalProfile {
  userId: string;
  username: string;
  displayName: string;
  status: PresenceStatus;
  port: number;
}

export interface PeerInfo {
  userId: string;
  username: string;
  displayName: string;
  status: PresenceStatus;
  port: number;
  identityKey: string;
  /** Remote IP as seen on the socket. */
  host: string;
}

export const HANDSHAKE_TIMEOUT_MS = 8000;

let nextConnId = 1;

export interface ConnectionEvents {
  ready: [PeerInfo];
  message: [PeerMessage];
  close: [string];
}

export class Connection extends EventEmitter<ConnectionEvents> {
  readonly id = nextConnId++;
  state: "handshaking" | "ready" | "closed" = "handshaking";
  peer: PeerInfo | null = null;
  lastReceived = Date.now();

  private readonly decoder = new FrameDecoder();
  private readonly ephemeral = new Ephemeral();
  private session: Session | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private drainWaiters: Array<() => void> = [];

  constructor(
    private readonly socket: Socket,
    readonly initiatedByMe: boolean,
    private readonly profile: () => LocalProfile,
    private readonly identity: Identity,
    private readonly log: Logger,
  ) {
    super();
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10_000);
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("drain", () => this.flushDrain());
    socket.on("error", (err) => this.log.debug(`socket error (${this.remote})`, err.message));
    socket.on("close", () => this.finish("socket closed"));
  }

  get remote(): string {
    return `${this.socket.remoteAddress ?? "?"}:${this.socket.remotePort ?? "?"}`;
  }

  get remoteHost(): string {
    const addr = this.socket.remoteAddress ?? "";
    return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  }

  private isClosed(): boolean {
    return this.state === "closed";
  }

  get encrypted(): boolean {
    return this.session !== null;
  }

  /** Kick off the handshake. The dialer speaks first. */
  start(): void {
    this.handshakeTimer = setTimeout(() => this.close("handshake timeout"), HANDSHAKE_TIMEOUT_MS);
    if (this.initiatedByMe) this.sendHandshake("hello");
  }

  private sendHandshake(t: "hello" | "hello_ack"): void {
    const p = this.profile();
    const msg: HandshakeMessage = {
      t,
      v: PROTOCOL_VERSION,
      userId: p.userId,
      username: p.username,
      displayName: p.displayName,
      status: p.status,
      port: p.port,
      identityKey: this.identity.publicKeyB64,
      ephemeralKey: this.ephemeral.publicKeyB64,
      sig: this.identity.sign(handshakeTranscript(t, p.userId, this.ephemeral.publicKeyB64)),
    };
    this.socket.write(encodeFrame(FrameKind.Plain, encodeJson(msg)));
  }

  private onData(chunk: Buffer): void {
    if (this.state === "closed") return;
    this.lastReceived = Date.now();
    let frames: Frame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      this.close(`protocol error: ${(err as Error).message}`);
      return;
    }
    for (const frame of frames) {
      if (this.isClosed()) return;
      try {
        if (this.state === "handshaking") {
          if (frame.kind !== FrameKind.Plain) throw new Error("sealed frame before handshake");
          this.onHandshake(parseHandshake(decodeJson(frame.payload)));
        } else {
          if (frame.kind !== FrameKind.Sealed) throw new Error("plaintext frame after handshake");
          const msg = parsePeerMessage(decodeJson(this.session!.open(frame.payload)));
          this.emit("message", msg);
        }
      } catch (err) {
        this.close(`protocol error: ${(err as Error).message}`);
        return;
      }
    }
  }

  private onHandshake(msg: HandshakeMessage): void {
    const expected = this.initiatedByMe ? "hello_ack" : "hello";
    if (msg.t !== expected) throw new Error(`expected ${expected}, got ${msg.t}`);
    if (msg.v !== PROTOCOL_VERSION) throw new Error(`unsupported protocol version ${msg.v}`);
    if (!Identity.verify(msg.identityKey, handshakeTranscript(msg.t, msg.userId, msg.ephemeralKey), msg.sig)) {
      throw new Error("bad handshake signature");
    }
    if (msg.userId === this.profile().userId) {
      this.close("connected to self");
      return;
    }
    if (!this.initiatedByMe) this.sendHandshake("hello_ack");

    const shared = this.ephemeral.agree(msg.ephemeralKey);
    const [dialerEph, acceptorEph] = this.initiatedByMe
      ? [this.ephemeral.publicKeyB64, msg.ephemeralKey]
      : [msg.ephemeralKey, this.ephemeral.publicKeyB64];
    this.session = Session.derive(shared, dialerEph, acceptorEph, this.initiatedByMe);

    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.peer = {
      userId: msg.userId,
      username: msg.username,
      displayName: msg.displayName,
      status: msg.status,
      port: msg.port,
      identityKey: msg.identityKey,
      host: this.remoteHost,
    };
    this.state = "ready";
    this.log.debug(`handshake complete with ${msg.username} (${this.remote}, conn #${this.id})`);
    this.emit("ready", this.peer);
  }

  /**
   * Seal and write a message. Resolves once the socket accepted the bytes
   * (waits for 'drain' under backpressure, which paces file transfers).
   */
  send(msg: PeerMessage): Promise<void> {
    if (this.state !== "ready" || !this.session) {
      return Promise.reject(new Error(`connection not ready (${this.state})`));
    }
    const frame = encodeFrame(FrameKind.Sealed, this.session.seal(encodeJson(msg)));
    const flushed = this.socket.write(frame);
    if (flushed) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  private flushDrain(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const w of waiters) w();
  }

  close(reason: string): void {
    if (this.state === "closed") return;
    this.log.debug(`closing conn #${this.id} (${this.remote}): ${reason}`);
    this.finish(reason);
    this.socket.destroy();
  }

  /** Gracefully end after flushing pending writes. */
  end(): Promise<void> {
    if (this.state === "closed") return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.close("end timeout");
        resolve();
      }, 500);
      this.socket.end(() => {
        clearTimeout(t);
        this.finish("ended");
        resolve();
      });
    });
  }

  private finish(reason: string): void {
    if (this.state === "closed") return;
    this.state = "closed";
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.flushDrain();
    this.emit("close", reason);
  }
}
