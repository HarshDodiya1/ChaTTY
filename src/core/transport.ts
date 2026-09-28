// TCP transport: listener, outbound dialing with reconnect, one live connection
// per peer, keepalive.
//
// Duplicate connections (both peers dial each other at once, e.g. both started
// with --peer) are resolved deterministically: the connection *initiated by the
// peer with the smaller user id* wins, on both sides. The loser is closed quietly.

import { EventEmitter } from "node:events";
import net from "node:net";
import type { Logger } from "../util/logger.ts";
import { Connection, type LocalProfile, type PeerInfo } from "./connection.ts";
import type { Identity } from "./crypto.ts";
import type { PeerMessage } from "./protocol.ts";

export interface TransportOptions {
  port: number;
  host?: string;
  profile: () => LocalProfile;
  identity: Identity;
  log: Logger;
  pingIntervalMs?: number;
  peerTimeoutMs?: number;
  dialTimeoutMs?: number;
  maxBackoffMs?: number;
}

export interface TransportEvents {
  /** A peer became reachable (or its connection was replaced by a better one). */
  peer_up: [PeerInfo, Connection];
  peer_down: [string, string];
  message: [string, PeerMessage];
}

interface Target {
  key: string;
  host: string;
  port: number;
  /** Manual targets (--peer / /connect) are never pruned. */
  manual: boolean;
  peerId: string | null;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
  dialing: boolean;
}

export class Transport extends EventEmitter<TransportEvents> {
  private server: net.Server | null = null;
  private readonly live = new Map<string, Connection>();
  private readonly pending = new Set<Connection>();
  private readonly targets = new Map<string, Target>();
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  port = 0;

  constructor(private readonly opts: TransportOptions) {
    super();
  }

  private get log() {
    return this.opts.log;
  }

  async listen(): Promise<number> {
    const server = net.createServer((socket) => this.adopt(socket, false));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        reject(
          err.code === "EADDRINUSE" ? new Error(`Port ${this.opts.port} is already in use — try --port <other>`) : err,
        );
      };
      server.once("error", onError);
      server.listen(this.opts.port, this.opts.host ?? "0.0.0.0", () => {
        server.off("error", onError);
        resolve();
      });
    });
    server.on("error", (err) => this.log.error("server error", err));
    const addr = server.address();
    this.port = typeof addr === "object" && addr ? addr.port : this.opts.port;
    const interval = this.opts.pingIntervalMs ?? 5000;
    this.keepalive = setInterval(() => this.tickKeepalive(), interval);
    this.log.info(`listening on ${this.opts.host ?? "0.0.0.0"}:${this.port}`);
    return this.port;
  }

  // ── connections ────────────────────────────────────────────────────────

  private adopt(socket: net.Socket, initiatedByMe: boolean, target?: Target): Connection {
    const conn = new Connection(socket, initiatedByMe, this.opts.profile, this.opts.identity, this.log);
    this.pending.add(conn);
    conn.on("ready", (peer) => {
      this.pending.delete(conn);
      if (target) {
        target.peerId = peer.userId;
        target.attempts = 0;
        this.pruneTargetsFor(peer.userId, target);
      }
      this.register(conn, peer);
    });
    conn.on("message", (msg) => {
      if (conn.peer && this.live.get(conn.peer.userId) === conn) this.emit("message", conn.peer.userId, msg);
    });
    conn.on("close", (reason) => {
      this.pending.delete(conn);
      const peerId = conn.peer?.userId;
      if (peerId && this.live.get(peerId) === conn) {
        this.live.delete(peerId);
        this.log.info(`peer ${conn.peer!.username} disconnected: ${reason}`);
        this.emit("peer_down", peerId, reason);
        this.redialPeer(peerId);
      }
      if (target) this.scheduleDial(target);
    });
    conn.start();
    return conn;
  }

  private register(conn: Connection, peer: PeerInfo): void {
    const existing = this.live.get(peer.userId);
    if (existing && existing !== conn) {
      const myId = this.opts.profile().userId;
      const winnerIsMine = myId < peer.userId;
      const newWins =
        existing.initiatedByMe === conn.initiatedByMe
          ? true // same direction: the newer socket supersedes a stale one
          : conn.initiatedByMe === winnerIsMine;
      if (!newWins) {
        this.log.debug(`dropping duplicate connection #${conn.id} to ${peer.username}`);
        conn.close("duplicate");
        return;
      }
      this.log.debug(`replacing connection #${existing.id} with #${conn.id} for ${peer.username}`);
      this.live.set(peer.userId, conn);
      existing.close("superseded");
    } else {
      this.live.set(peer.userId, conn);
      this.log.info(`peer ${peer.username} connected (${conn.initiatedByMe ? "outbound" : "inbound"} ${conn.remote})`);
    }
    this.emit("peer_up", peer, conn);
  }

  isConnected(peerId: string): boolean {
    return this.live.get(peerId)?.state === "ready";
  }

  connection(peerId: string): Connection | undefined {
    return this.live.get(peerId);
  }

  connectedPeers(): PeerInfo[] {
    return [...this.live.values()].filter((c) => c.state === "ready" && c.peer).map((c) => c.peer!);
  }

  /** Send to one peer. Resolves false when the peer is not connected or the write fails. */
  async send(peerId: string, msg: PeerMessage): Promise<boolean> {
    const conn = this.live.get(peerId);
    if (conn?.state !== "ready") return false;
    try {
      await conn.send(msg);
      return true;
    } catch (err) {
      this.log.debug(`send to ${peerId} failed`, (err as Error).message);
      return false;
    }
  }

  async broadcast(msg: PeerMessage): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.send(id, msg)));
  }

  disconnect(peerId: string, reason: string): void {
    this.live.get(peerId)?.close(reason);
  }

  // ── dialing ────────────────────────────────────────────────────────────

  /** Remember an address and keep a connection to it alive. */
  addTarget(host: string, port: number, opts: { manual?: boolean; peerId?: string } = {}): void {
    if (this.stopped) return;
    const key = `${host}:${port}`;
    let t = this.targets.get(key);
    if (t) {
      if (opts.manual) t.manual = true;
      if (opts.peerId) t.peerId = opts.peerId;
      if (!t.dialing && !(t.peerId && this.isConnected(t.peerId))) {
        t.attempts = 0;
        this.scheduleDial(t, 0);
      }
      return;
    }
    t = {
      key,
      host,
      port,
      manual: !!opts.manual,
      peerId: opts.peerId ?? null,
      attempts: 0,
      timer: null,
      dialing: false,
    };
    this.targets.set(key, t);
    this.scheduleDial(t, 0);
  }

  /** Forget auto-discovered addresses for a peer, except `keep`. */
  private pruneTargetsFor(peerId: string, keep: Target): void {
    for (const t of this.targets.values()) {
      if (t !== keep && !t.manual && t.peerId === peerId) {
        if (t.timer) clearTimeout(t.timer);
        this.targets.delete(t.key);
      }
    }
  }

  private redialPeer(peerId: string): void {
    for (const t of this.targets.values()) {
      if (t.peerId === peerId && !t.dialing) {
        t.attempts = 0;
        this.scheduleDial(t, 1000);
      }
    }
  }

  private scheduleDial(t: Target, delay?: number): void {
    if (this.stopped || !this.targets.has(t.key)) return;
    if (t.timer) clearTimeout(t.timer);
    const max = this.opts.maxBackoffMs ?? 30_000;
    const wait = delay ?? Math.min(max, 1000 * 2 ** Math.min(t.attempts, 5));
    t.timer = setTimeout(() => {
      t.timer = null;
      this.dial(t);
    }, wait);
  }

  private dial(t: Target): void {
    if (this.stopped || t.dialing) return;
    if (t.peerId && this.isConnected(t.peerId)) {
      // Already connected (maybe inbound); check again later in case it drops.
      t.attempts = 0;
      this.scheduleDial(t, this.opts.maxBackoffMs ?? 30_000);
      return;
    }
    t.dialing = true;
    t.attempts++;
    this.log.debug(`dialing ${t.key} (attempt ${t.attempts})`);
    const socket = net.connect({ host: t.host, port: t.port });
    const timeout = setTimeout(() => socket.destroy(new Error("connect timeout")), this.opts.dialTimeoutMs ?? 5000);
    const onFail = (err: Error) => {
      clearTimeout(timeout);
      t.dialing = false;
      this.log.debug(`failed to connect to ${t.key}: ${err.message}`);
      this.scheduleDial(t);
    };
    socket.once("error", onFail);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.off("error", onFail);
      t.dialing = false;
      this.adopt(socket, true, t);
    });
  }

  // ── keepalive ──────────────────────────────────────────────────────────

  private tickKeepalive(): void {
    const timeout = this.opts.peerTimeoutMs ?? 20_000;
    const now = Date.now();
    for (const conn of this.live.values()) {
      if (now - conn.lastReceived > timeout) {
        conn.close("keepalive timeout");
      } else {
        conn.send({ t: "ping", ts: now }).catch(() => {});
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.keepalive) clearInterval(this.keepalive);
    for (const t of this.targets.values()) if (t.timer) clearTimeout(t.timer);
    this.targets.clear();
    const all = [...this.live.values(), ...this.pending];
    await Promise.all(all.map((c) => c.end()));
    this.live.clear();
    this.pending.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}
