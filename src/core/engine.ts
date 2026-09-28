// ChatEngine — the headless heart of ChaTTY. Owns the transport, discovery and
// the store; turns peer messages into DB updates and exposes view models plus a
// small command API for the UI. Everything here is testable without a terminal.

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import type { ConversationRow, MessageRow, Store, TransferRow, TransferStatus, UserRow } from "../store/db.ts";
import type { Logger } from "../util/logger.ts";
import type { Connection, PeerInfo } from "./connection.ts";
import { fingerprint, type Identity, safetyNumber, sha256File } from "./crypto.ts";
import { type Discovery, localAddresses } from "./discovery.ts";
import type { GroupMember, PeerMessage, PresenceStatus } from "./protocol.ts";
import { Transport, type TransportOptions } from "./transport.ts";

export const FILE_CHUNK_BYTES = 64 * 1024;
export const MAX_FILE_BYTES = 1024 * 1024 * 1024;
export const MAX_MESSAGE_CHARS = 16_000;
const TYPING_TTL_MS = 5000;
const TYPING_IDLE_MS = 3000;
const TYPING_RESEND_MS = 2500;

export type DeliveryStatus = "sent" | "delivered" | "read";

export interface ContactView {
  id: string;
  convId: string;
  username: string;
  displayName: string;
  label: string;
  status: PresenceStatus;
  connected: boolean;
  lastSeen: number | null;
  unread: number;
  lastMessage: { body: string; ts: number; fromMe: boolean; system: boolean } | null;
  keyChanged: boolean;
}

export interface MemberView {
  id: string;
  label: string;
  status: PresenceStatus;
  isMe: boolean;
}

export interface GroupView {
  id: string;
  name: string;
  members: MemberView[];
  unread: number;
  lastMessage: { body: string; ts: number; fromMe: boolean; sender: string; system: boolean } | null;
  left: boolean;
}

export interface TransferView {
  id: string;
  convId: string;
  messageId: string | null;
  name: string;
  size: number;
  bytes: number;
  status: TransferStatus;
  direction: "in" | "out";
  peerId: string;
  peerLabel: string;
  path: string | null;
  error: string | null;
  createdAt: number;
}

export interface MessageView {
  id: string;
  convId: string;
  senderId: string;
  senderLabel: string;
  fromMe: boolean;
  body: string;
  kind: "text" | "file" | "system";
  ts: number;
  status: DeliveryStatus | null;
  transfer: TransferView | null;
}

export interface ConversationInfo {
  id: string;
  type: "direct" | "group";
  title: string;
  peer: ContactView | null;
  group: GroupView | null;
  encrypted: boolean;
}

export interface Notice {
  level: "info" | "success" | "warn" | "error";
  title: string;
  text: string;
  icon?: string;
}

export interface IncomingMessage {
  convId: string;
  senderLabel: string;
  body: string;
  isGroup: boolean;
  groupName?: string;
}

export interface EngineEvents {
  change: [];
  notice: [Notice];
  incoming: [IncomingMessage];
  file_offer: [TransferView];
}

export interface EngineOptions {
  config: Config;
  store: Store;
  identity: Identity;
  log: Logger;
  saveConfig?: (c: Config) => void;
  discovery?: (self: { userId: string; username: string; port: number }) => Discovery | null;
  listenHost?: string;
  transport?: Partial<Pick<TransportOptions, "pingIntervalMs" | "peerTimeoutMs" | "dialTimeoutMs" | "maxBackoffMs">>;
  retryIntervalMs?: number;
}

export function directConvId(a: string, b: string): string {
  return `dm:${[a, b].sort().join(":")}`;
}

export function safeFilename(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/"));
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return cleaned.slice(0, 200) || "file";
}

/** `dir/name.ext`, or `dir/name_1.ext`, `dir/name_2.ext`… when taken. */
export function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem}_${i}${ext}`);
  return candidate;
}

interface IncomingTransfer {
  fd: number;
  partPath: string;
  hash: crypto.Hash;
  nextSeq: number;
  bytes: number;
}

export class ChatEngine extends EventEmitter<EngineEvents> {
  readonly config: Config;
  readonly store: Store;
  readonly identity: Identity;
  readonly transport: Transport;
  private readonly log: Logger;
  private discovery: Discovery | null = null;
  private status: PresenceStatus = "online";
  private activeConv: string | null = null;
  private changeQueued = false;
  private started = false;
  private stopping = false;

  /** convId → (userId → expiry) */
  private readonly typing = new Map<string, Map<string, number>>();
  private readonly outgoingTyping = new Map<string, { lastSent: number; idle: ReturnType<typeof setTimeout> }>();
  private readonly goodbyes = new Set<string>();
  private readonly pendingReads = new Map<string, Map<string, string[]>>();
  private readonly incoming = new Map<string, IncomingTransfer>();
  private readonly outgoing = new Map<string, { cancelled: boolean }>();
  private readonly lastProgressEmit = new Map<string, number>();
  private timers: Array<ReturnType<typeof setInterval>> = [];

  constructor(private readonly opts: EngineOptions) {
    super();
    this.config = opts.config;
    this.store = opts.store;
    this.identity = opts.identity;
    this.log = opts.log.child("engine");
    this.transport = new Transport({
      port: this.config.port,
      host: opts.listenHost,
      identity: this.identity,
      log: opts.log.child("net"),
      profile: () => ({
        userId: this.config.userId,
        username: this.config.username,
        displayName: this.config.displayName,
        status: this.status,
        port: this.transport.port || this.config.port,
      }),
      ...opts.transport,
    });
    this.transport.on("peer_up", (peer, conn) => this.onPeerUp(peer, conn));
    this.transport.on("peer_down", (id, reason) => this.onPeerDown(id, reason));
    this.transport.on("message", (id, msg) => {
      try {
        this.onMessage(id, msg);
      } catch (err) {
        this.log.error(`error handling '${msg.t}' from ${id}`, err);
      }
    });
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  get me() {
    return {
      id: this.config.userId,
      username: this.config.username,
      displayName: this.config.displayName,
      status: this.status,
      port: this.transport.port || this.config.port,
    };
  }

  get port(): number {
    return this.transport.port;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.store.setAllPeersOffline();
    this.store.failStaleTransfers();
    fs.mkdirSync(this.config.downloadsDir, { recursive: true });
    const port = await this.transport.listen();
    this.store.upsertUser({
      id: this.config.userId,
      username: this.config.username,
      displayName: this.config.displayName,
      status: "online",
      port,
      isSelf: true,
    });
    this.store.setIdentityKey(this.config.userId, this.identity.publicKeyB64, false);

    this.discovery =
      this.opts.discovery?.({ userId: this.config.userId, username: this.config.username, port }) ?? null;
    if (this.discovery) {
      this.discovery.on("peer", (p) => this.transport.addTarget(p.host, p.port, { peerId: p.userId }));
      this.discovery.start();
    }

    // Reconnect to peers we knew last time.
    for (const u of this.store.listPeers()) {
      if (u.host && u.port && u.last_seen && Date.now() - u.last_seen < 14 * 86_400_000) {
        this.transport.addTarget(u.host, u.port, { peerId: u.id });
      }
    }

    this.timers.push(setInterval(() => this.sweepTyping(), 1000));
    this.timers.push(setInterval(() => this.retryUndelivered(), this.opts.retryIntervalMs ?? 15_000));
    this.log.info(`engine started as ${this.config.username} (${this.config.userId}) on port ${port}`);
    this.changed();
  }

  async stop(): Promise<void> {
    if (!this.started || this.stopping) return;
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    for (const t of this.outgoingTyping.values()) clearTimeout(t.idle);
    for (const [id, t] of this.incoming) {
      try {
        fs.closeSync(t.fd);
        fs.rmSync(t.partPath, { force: true });
      } catch {}
      this.store.updateTransfer(id, { status: "failed", error: "interrupted" });
    }
    this.incoming.clear();
    for (const o of this.outgoing.values()) o.cancelled = true;
    await this.transport.broadcast({ t: "goodbye" });
    await this.discovery?.stop();
    await this.transport.stop();
    this.store.setAllPeersOffline();
    this.store.setUserStatus(this.config.userId, "offline");
    this.log.info("engine stopped");
  }

  /** Coalesce state-change notifications into one per tick. */
  private changed(): void {
    if (this.changeQueued) return;
    this.changeQueued = true;
    setImmediate(() => {
      this.changeQueued = false;
      this.emit("change");
    });
  }

  private notice(level: Notice["level"], title: string, text: string): void {
    this.emit("notice", { level, title, text });
  }

  // ── view models ────────────────────────────────────────────────────────

  private labelMap(): Map<string, string> {
    const users = this.store.listPeers();
    const counts = new Map<string, number>();
    for (const u of users)
      counts.set(u.display_name.toLowerCase(), (counts.get(u.display_name.toLowerCase()) ?? 0) + 1);
    const out = new Map<string, string>();
    for (const u of users) {
      const dup = (counts.get(u.display_name.toLowerCase()) ?? 0) > 1;
      out.set(u.id, dup ? `${u.display_name}#${u.id.slice(0, 4)}` : u.display_name);
    }
    out.set(this.config.userId, this.config.displayName);
    return out;
  }

  labelOf(userId: string): string {
    return this.labelMap().get(userId) ?? this.store.getUser(userId)?.display_name ?? "unknown";
  }

  private statusOf(u: UserRow): PresenceStatus {
    if (!this.transport.isConnected(u.id)) return "offline";
    return u.status === "away" ? "away" : "online";
  }

  contacts(): ContactView[] {
    const labels = this.labelMap();
    const views = this.store.listPeers().map((u): ContactView => {
      const convId = directConvId(this.config.userId, u.id);
      const last = this.store.lastMessage(convId);
      return {
        id: u.id,
        convId,
        username: u.username,
        displayName: u.display_name,
        label: labels.get(u.id) ?? u.display_name,
        status: this.statusOf(u),
        connected: this.transport.isConnected(u.id),
        lastSeen: u.last_seen,
        unread: this.store.unreadCount(convId, this.config.userId),
        lastMessage: last
          ? {
              body: preview(last),
              ts: last.ts,
              fromMe: last.sender_id === this.config.userId,
              system: last.kind === "system",
            }
          : null,
        keyChanged: u.key_changed === 1,
      };
    });
    const rank = (c: ContactView) => (c.status === "offline" ? 1 : 0);
    return views.sort(
      (a, b) =>
        rank(a) - rank(b) || (b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0) || a.label.localeCompare(b.label),
    );
  }

  groups(): GroupView[] {
    const labels = this.labelMap();
    return this.store
      .listConversations("group")
      .map((c) => this.groupView(c, labels))
      .sort(
        (a, b) =>
          Number(a.left) - Number(b.left) ||
          (b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0) ||
          a.name.localeCompare(b.name),
      );
  }

  private groupView(c: ConversationRow, labels = this.labelMap()): GroupView {
    const members = this.store.participants(c.id).map((id): MemberView => {
      const isMe = id === this.config.userId;
      const u = isMe ? null : this.store.getUser(id);
      return {
        id,
        isMe,
        label: labels.get(id) ?? u?.display_name ?? "unknown",
        status: isMe ? this.status : u ? this.statusOf(u) : "offline",
      };
    });
    members.sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.label.localeCompare(b.label));
    const last = this.store.lastMessage(c.id);
    return {
      id: c.id,
      name: c.name ?? "group",
      members,
      unread: this.store.unreadCount(c.id, this.config.userId),
      lastMessage: last
        ? {
            body: preview(last),
            ts: last.ts,
            fromMe: last.sender_id === this.config.userId,
            sender: labels.get(last.sender_id) ?? "unknown",
            system: last.kind === "system",
          }
        : null,
      left: c.left_group === 1,
    };
  }

  conversationInfo(convId: string): ConversationInfo | null {
    if (convId.startsWith("dm:")) {
      const peerId = this.peerOfDirect(convId);
      if (!peerId) return null;
      const peer = this.contacts().find((c) => c.id === peerId) ?? null;
      if (!peer) return null;
      return { id: convId, type: "direct", title: peer.label, peer, group: null, encrypted: this.isEncrypted(peerId) };
    }
    const c = this.store.getConversation(convId);
    if (c?.type !== "group") return null;
    const group = this.groupView(c);
    const others = group.members.filter((m) => !m.isMe && m.status !== "offline");
    return {
      id: convId,
      type: "group",
      title: group.name,
      peer: null,
      group,
      encrypted: others.length > 0 && others.every((m) => this.isEncrypted(m.id)),
    };
  }

  peerOfDirect(convId: string): string | null {
    const parts = convId.split(":");
    if (parts.length !== 3 || parts[0] !== "dm") return null;
    if (parts[1] === this.config.userId) return parts[2]!;
    if (parts[2] === this.config.userId) return parts[1]!;
    return null;
  }

  isEncrypted(peerId: string): boolean {
    return this.transport.connection(peerId)?.encrypted ?? false;
  }

  onlineCount(): number {
    return this.transport.connectedPeers().length;
  }

  messages(convId: string, limit = 200): MessageView[] {
    const rows = this.store.recentMessages(convId, limit);
    const labels = this.labelMap();
    const mine = rows.filter((r) => r.sender_id === this.config.userId && r.kind !== "system").map((r) => r.id);
    const deliveries = this.store.deliveriesFor(mine);
    return rows.map((r) => this.messageView(r, labels, deliveries.get(r.id)));
  }

  private messageView(
    r: MessageRow,
    labels: Map<string, string>,
    deliveries?: Array<{ delivered_at: number | null; read_at: number | null }>,
  ): MessageView {
    const fromMe = r.sender_id === this.config.userId;
    let status: DeliveryStatus | null = null;
    if (fromMe && r.kind === "text") {
      const d = deliveries ?? [];
      if (d.length > 0 && d.every((x) => x.read_at)) status = "read";
      else if (d.length > 0 && d.every((x) => x.delivered_at)) status = "delivered";
      else status = "sent";
    }
    const t = r.transfer_id ? this.store.getTransfer(r.transfer_id) : null;
    return {
      id: r.id,
      convId: r.conversation_id,
      senderId: r.sender_id,
      senderLabel: labels.get(r.sender_id) ?? "unknown",
      fromMe,
      body: r.body,
      kind: r.kind,
      ts: r.ts,
      status,
      transfer: t ? this.transferView(t, labels) : null,
    };
  }

  private transferView(t: TransferRow, labels = this.labelMap()): TransferView {
    return {
      id: t.id,
      convId: t.conversation_id,
      messageId: t.message_id,
      name: t.name,
      size: t.size,
      bytes: t.bytes,
      status: t.status,
      direction: t.direction,
      peerId: t.peer_id,
      peerLabel: labels.get(t.peer_id) ?? "unknown",
      path: t.path,
      error: t.error,
      createdAt: t.created_at,
    };
  }

  transfers(limit = 30): TransferView[] {
    const labels = this.labelMap();
    return this.store.listTransfers(limit).map((t) => this.transferView(t, labels));
  }

  pendingOffers(): TransferView[] {
    return this.transfers(100).filter((t) => t.direction === "in" && t.status === "offered");
  }

  typingIn(convId: string): string[] {
    const m = this.typing.get(convId);
    if (!m) return [];
    const now = Date.now();
    return [...m.entries()].filter(([, exp]) => exp > now).map(([id]) => this.labelOf(id));
  }

  totalUnread(): number {
    return this.contacts().reduce((n, c) => n + c.unread, 0) + this.groups().reduce((n, g) => n + g.unread, 0);
  }

  search(convId: string, query: string): MessageView[] {
    const labels = this.labelMap();
    return this.store.searchMessages(convId, query).map((r) => this.messageView(r, labels));
  }

  findUser(name: string): ContactView[] {
    const q = name.replace(/^@/, "").toLowerCase();
    const all = this.contacts();
    const exact = all.filter(
      (c) =>
        c.label.toLowerCase() === q ||
        c.username.toLowerCase() === q ||
        c.displayName.toLowerCase() === q ||
        c.id === q,
    );
    if (exact.length) return exact;
    return all.filter((c) => c.id.startsWith(q) || c.label.toLowerCase().startsWith(q));
  }

  info() {
    return {
      ...this.me,
      addresses: localAddresses(),
      fingerprint: fingerprint(this.identity.publicKeyB64),
      downloadsDir: this.config.downloadsDir,
      online: this.onlineCount(),
    };
  }

  safetyNumberWith(peerId: string): string | null {
    const u = this.store.getUser(peerId);
    if (!u?.identity_key) return null;
    return safetyNumber(this.identity.publicKeyB64, u.identity_key);
  }

  markVerified(peerId: string): void {
    this.store.clearKeyChanged(peerId);
    this.changed();
  }

  // ── commands (called by the UI) ────────────────────────────────────────

  /** The UI tells us which conversation is on screen so reads can be acknowledged. */
  setActiveConversation(convId: string | null): void {
    this.activeConv = convId;
    if (convId) this.markRead(convId);
  }

  connect(host: string, port: number): void {
    this.transport.addTarget(host, port, { manual: true });
  }

  ensureDirect(peerId: string): string {
    const convId = directConvId(this.config.userId, peerId);
    this.store.ensureConversation({ id: convId, type: "direct" });
    this.store.setParticipants(convId, [this.config.userId, peerId]);
    return convId;
  }

  private recipients(convId: string): string[] {
    if (convId.startsWith("dm:")) {
      const peer = this.peerOfDirect(convId);
      return peer ? [peer] : [];
    }
    const c = this.store.getConversation(convId);
    if (!c || c.left_group) return [];
    return this.store.participants(convId).filter((id) => id !== this.config.userId);
  }

  async sendText(convId: string, body: string): Promise<MessageView> {
    const text = body.replace(/\r\n?/g, "\n").trimEnd();
    if (!text.trim()) throw new Error("Message is empty");
    if (text.length > MAX_MESSAGE_CHARS) throw new Error(`Message too long (max ${MAX_MESSAGE_CHARS} characters)`);
    const isDirect = convId.startsWith("dm:");
    if (isDirect) {
      const peer = this.peerOfDirect(convId);
      if (!peer) throw new Error("Unknown conversation");
      this.ensureDirect(peer);
    } else {
      const c = this.store.getConversation(convId);
      if (!c) throw new Error("Unknown conversation");
      if (c.left_group) throw new Error("You left this group");
    }
    const recipients = this.recipients(convId);
    const id = crypto.randomUUID();
    const ts = Date.now();
    this.store.tx(() => {
      this.store.insertMessage({
        id,
        conversationId: convId,
        senderId: this.config.userId,
        body: text,
        kind: "text",
        ts,
        readByMe: true,
      });
      this.store.addDeliveries(id, recipients);
    });
    this.stopTyping(convId);
    this.changed();
    const msg: PeerMessage = { t: "chat", id, convId, convType: isDirect ? "direct" : "group", body: text, ts };
    await Promise.all(recipients.map((r) => this.transport.send(r, msg)));
    return this.messageView(this.store.getMessage(id)!, this.labelMap(), this.store.deliveries(id));
  }

  /** Call on every keystroke in a conversation; throttled on the wire. */
  notifyTyping(convId: string): void {
    const now = Date.now();
    const cur = this.outgoingTyping.get(convId);
    if (cur) clearTimeout(cur.idle);
    const idle = setTimeout(() => this.stopTyping(convId), TYPING_IDLE_MS);
    if (!cur || now - cur.lastSent > TYPING_RESEND_MS) {
      this.outgoingTyping.set(convId, { lastSent: now, idle });
      this.sendToConv(convId, { t: "typing", convId, typing: true });
    } else {
      cur.idle = idle;
    }
  }

  stopTyping(convId: string): void {
    const cur = this.outgoingTyping.get(convId);
    if (!cur) return;
    clearTimeout(cur.idle);
    this.outgoingTyping.delete(convId);
    this.sendToConv(convId, { t: "typing", convId, typing: false });
  }

  private sendToConv(convId: string, msg: PeerMessage): void {
    for (const r of this.recipients(convId)) void this.transport.send(r, msg);
  }

  markRead(convId: string): void {
    const bySender = this.store.markConversationRead(convId, this.config.userId);
    if (bySender.size === 0) return;
    for (const [sender, ids] of bySender) {
      const msg: PeerMessage = { t: "read", convId, ids };
      void this.transport.send(sender, msg).then((ok) => {
        if (!ok) this.queueRead(sender, convId, ids);
      });
    }
    this.changed();
  }

  private queueRead(peerId: string, convId: string, ids: string[]): void {
    const byConv = this.pendingReads.get(peerId) ?? new Map<string, string[]>();
    byConv.set(convId, [...(byConv.get(convId) ?? []), ...ids]);
    this.pendingReads.set(peerId, byConv);
  }

  setDisplayName(name: string): void {
    const clean = name.trim().slice(0, 32);
    if (!clean) throw new Error("Name cannot be empty");
    this.config.displayName = clean;
    this.opts.saveConfig?.(this.config);
    this.store.setUserDisplayName(this.config.userId, clean);
    void this.transport.broadcast({ t: "presence", status: this.status, displayName: clean });
    this.changed();
  }

  /** Persist config changes made from the UI (toggles like /notify). */
  saveSettings(): void {
    this.opts.saveConfig?.(this.config);
  }

  setStatus(status: "online" | "away"): void {
    this.status = status;
    this.store.setUserStatus(this.config.userId, status);
    void this.transport.broadcast({ t: "presence", status, displayName: this.config.displayName });
    this.changed();
  }

  // ── groups ─────────────────────────────────────────────────────────────

  private nextVersion(c: ConversationRow | null): number {
    return Math.max((c?.version ?? 0) + 1, Date.now());
  }

  private groupPayload(convId: string): PeerMessage | null {
    const c = this.store.getConversation(convId);
    if (c?.type !== "group") return null;
    const members: GroupMember[] = this.store.participants(convId).map((id) => {
      const u = this.store.getUser(id);
      return { id, username: u?.username ?? "unknown", displayName: u?.display_name ?? "unknown" };
    });
    return {
      t: "group",
      convId,
      name: c.name ?? "group",
      createdBy: c.created_by ?? this.config.userId,
      createdAt: c.created_at,
      version: c.version,
      members,
    };
  }

  private syncGroup(convId: string, extraRecipients: string[] = []): void {
    const payload = this.groupPayload(convId);
    if (!payload) return;
    const to = new Set([...this.recipients(convId), ...extraRecipients]);
    for (const id of to) void this.transport.send(id, payload);
  }

  createGroup(name: string, memberIds: string[] = []): string {
    const clean = name.trim().replace(/^#/, "").slice(0, 40);
    if (!clean) throw new Error("Group name cannot be empty");
    if (this.groups().some((g) => !g.left && g.name.toLowerCase() === clean.toLowerCase())) {
      throw new Error(`You already have a group named #${clean}`);
    }
    const id = `grp:${crypto.randomUUID()}`;
    const now = Date.now();
    this.store.tx(() => {
      this.store.ensureConversation({
        id,
        type: "group",
        name: clean,
        createdBy: this.config.userId,
        createdAt: now,
        version: now,
      });
      this.store.setParticipants(id, [this.config.userId, ...memberIds]);
      this.systemMessage(id, `You created #${clean}`);
      for (const m of memberIds) this.systemMessage(id, `You added ${this.labelOf(m)}`);
    });
    this.syncGroup(id);
    this.changed();
    return id;
  }

  inviteToGroup(convId: string, userId: string): void {
    const c = this.store.getConversation(convId);
    if (c?.type !== "group") throw new Error("Not a group conversation");
    if (c.left_group) throw new Error("You left this group");
    if (userId === this.config.userId) throw new Error("You are already in this group");
    if (this.store.participants(convId).includes(userId))
      throw new Error(`${this.labelOf(userId)} is already a member`);
    this.store.tx(() => {
      this.store.addParticipant(convId, userId);
      this.store.updateGroup(convId, { version: this.nextVersion(c) });
      this.systemMessage(convId, `You added ${this.labelOf(userId)}`);
    });
    this.syncGroup(convId);
    this.changed();
  }

  leaveGroup(convId: string): void {
    const c = this.store.getConversation(convId);
    if (c?.type !== "group") throw new Error("Not a group conversation");
    if (c.left_group) throw new Error("You already left this group");
    const version = this.nextVersion(c);
    const msg: PeerMessage = { t: "group_leave", convId, version };
    for (const r of this.recipients(convId)) void this.transport.send(r, msg);
    this.store.tx(() => {
      this.store.removeParticipant(convId, this.config.userId);
      this.store.updateGroup(convId, { version, left: true });
      this.systemMessage(convId, "You left the group");
    });
    this.changed();
  }

  private systemMessage(convId: string, body: string): void {
    this.store.insertMessage({
      id: crypto.randomUUID(),
      conversationId: convId,
      senderId: this.config.userId,
      body,
      kind: "system",
      ts: Date.now(),
      readByMe: true,
    });
  }

  // ── files ──────────────────────────────────────────────────────────────

  async sendFile(convId: string, filePath: string): Promise<TransferView> {
    const peerId = this.peerOfDirect(convId);
    if (!peerId) throw new Error("Files can only be sent in direct conversations");
    if (!this.transport.isConnected(peerId)) throw new Error(`${this.labelOf(peerId)} is offline`);
    const resolved = path.resolve(filePath.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
    let st: fs.Stats;
    try {
      st = fs.statSync(resolved);
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }
    if (!st.isFile()) throw new Error(`Not a regular file: ${filePath}`);
    if (st.size > MAX_FILE_BYTES) throw new Error(`File too large (max ${formatBytes(MAX_FILE_BYTES)})`);
    const sha256 = await sha256File(resolved);
    const id = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const name = safeFilename(path.basename(resolved));
    const ts = Date.now();
    this.ensureDirect(peerId);
    this.store.tx(() => {
      this.store.insertMessage({
        id: messageId,
        conversationId: convId,
        senderId: this.config.userId,
        body: name,
        kind: "file",
        ts,
        transferId: id,
        readByMe: true,
      });
      this.store.insertTransfer({
        id,
        message_id: messageId,
        conversation_id: convId,
        peer_id: peerId,
        direction: "out",
        name,
        path: resolved,
        size: st.size,
        sha256,
        status: "offered",
      });
    });
    const ok = await this.transport.send(peerId, {
      t: "file_offer",
      id,
      messageId,
      convId,
      name,
      size: st.size,
      sha256,
      ts,
    });
    if (!ok) this.failTransfer(id, "peer disconnected");
    this.changed();
    return this.transferView(this.store.getTransfer(id)!);
  }

  acceptFile(id: string): void {
    const t = this.store.getTransfer(id);
    if (t?.direction !== "in") throw new Error("No such incoming file");
    if (t.status !== "offered") throw new Error(`Transfer is already ${t.status}`);
    if (!this.transport.isConnected(t.peer_id)) {
      this.failTransfer(id, "peer disconnected");
      throw new Error(`${this.labelOf(t.peer_id)} is offline`);
    }
    fs.mkdirSync(this.config.downloadsDir, { recursive: true });
    const partPath = path.join(this.config.downloadsDir, `.${id}.part`);
    const fd = fs.openSync(partPath, "w", 0o600);
    this.incoming.set(id, { fd, partPath, hash: crypto.createHash("sha256"), nextSeq: 0, bytes: 0 });
    this.store.updateTransfer(id, { status: "accepted" });
    void this.transport.send(t.peer_id, { t: "file_accept", id });
    this.changed();
  }

  declineFile(id: string): void {
    const t = this.store.getTransfer(id);
    if (t?.direction !== "in") throw new Error("No such incoming file");
    if (t.status !== "offered") throw new Error(`Transfer is already ${t.status}`);
    this.store.updateTransfer(id, { status: "declined" });
    void this.transport.send(t.peer_id, { t: "file_decline", id });
    this.changed();
  }

  cancelTransfer(id: string): void {
    const t = this.store.getTransfer(id);
    if (!t) throw new Error("No such transfer");
    if (!["offered", "accepted", "in_progress"].includes(t.status)) throw new Error(`Transfer is already ${t.status}`);
    void this.transport.send(t.peer_id, { t: "file_cancel", id, reason: "cancelled" });
    this.finishTransfer(id, "cancelled", "cancelled by you");
  }

  private failTransfer(id: string, reason: string): void {
    this.finishTransfer(id, "failed", reason);
  }

  private finishTransfer(id: string, status: TransferStatus, reason: string | null): void {
    const inc = this.incoming.get(id);
    if (inc) {
      try {
        fs.closeSync(inc.fd);
      } catch {}
      fs.rmSync(inc.partPath, { force: true });
      this.incoming.delete(id);
    }
    const out = this.outgoing.get(id);
    if (out) out.cancelled = true;
    this.store.updateTransfer(id, { status, error: reason });
    this.changed();
  }

  private async streamFile(t: TransferRow): Promise<void> {
    const state = { cancelled: false };
    this.outgoing.set(t.id, state);
    this.store.updateTransfer(t.id, { status: "in_progress" });
    this.changed();
    let seq = 0;
    let bytes = 0;
    try {
      const stream = fs.createReadStream(t.path!, { highWaterMark: FILE_CHUNK_BYTES });
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        if (state.cancelled) {
          stream.destroy();
          return;
        }
        const ok = await this.transport.send(t.peer_id, {
          t: "file_chunk",
          id: t.id,
          seq: seq++,
          data: chunk.toString("base64"),
        });
        if (!ok) throw new Error("peer disconnected");
        bytes += chunk.length;
        this.progress(t.id, bytes);
      }
      if (state.cancelled) return;
      this.store.updateTransfer(t.id, { bytes });
      if (!(await this.transport.send(t.peer_id, { t: "file_done", id: t.id }))) throw new Error("peer disconnected");
      this.changed();
    } catch (err) {
      if (!state.cancelled) this.failTransfer(t.id, (err as Error).message);
    } finally {
      this.outgoing.delete(t.id);
    }
  }

  private progress(id: string, bytes: number): void {
    const now = Date.now();
    if (now - (this.lastProgressEmit.get(id) ?? 0) < 100) return;
    this.lastProgressEmit.set(id, now);
    this.store.updateTransfer(id, { bytes });
    this.changed();
  }

  // ── network events ─────────────────────────────────────────────────────

  private onPeerUp(peer: PeerInfo, _conn: Connection): void {
    if (this.stopping) return;
    const existing = this.store.getUser(peer.userId);
    const wasOnline = existing ? existing.status !== "offline" : false;
    this.goodbyes.delete(peer.userId);
    this.store.upsertUser({
      id: peer.userId,
      username: peer.username,
      displayName: peer.displayName,
      status: peer.status,
      host: peer.host,
      port: peer.port,
    });

    // Trust on first use: remember the identity key, flag any change.
    if (!existing?.identity_key) {
      this.store.setIdentityKey(peer.userId, peer.identityKey, false);
    } else if (existing.identity_key !== peer.identityKey) {
      this.store.setIdentityKey(peer.userId, peer.identityKey, true);
      const convId = this.ensureDirect(peer.userId);
      this.systemMessage(convId, `⚠ ${peer.displayName}'s security key changed. Verify with /verify`);
      this.notice(
        "warn",
        "Security key changed",
        `${peer.displayName}'s identity key is different from last time. Run /verify to compare safety numbers.`,
      );
    }

    this.transport.addTarget(peer.host, peer.port, { peerId: peer.userId });

    // Mesh: tell the newcomer about everyone else we can reach.
    const others = this.transport
      .connectedPeers()
      .filter((p) => p.userId !== peer.userId)
      .map((p) => ({ id: p.userId, host: p.host, port: p.port }));
    if (others.length) void this.transport.send(peer.userId, { t: "peers", peers: others });

    for (const g of this.store.groupsWithMember(peer.userId)) {
      if (!g.left_group) {
        const payload = this.groupPayload(g.id);
        if (payload) void this.transport.send(peer.userId, payload);
      }
    }
    this.flushUndelivered(peer.userId);
    const reads = this.pendingReads.get(peer.userId);
    if (reads) {
      this.pendingReads.delete(peer.userId);
      for (const [convId, ids] of reads) void this.transport.send(peer.userId, { t: "read", convId, ids });
    }
    if (!wasOnline) this.notice("success", "Peer online", `${this.labelOf(peer.userId)} is online`);
    this.changed();
  }

  private onPeerDown(peerId: string, reason: string): void {
    if (this.stopping) return;
    this.store.setUserStatus(peerId, "offline");
    for (const m of this.typing.values()) m.delete(peerId);
    for (const t of this.store.listTransfers(200)) {
      if (t.peer_id === peerId && ["offered", "accepted", "in_progress"].includes(t.status)) {
        this.failTransfer(t.id, "peer disconnected");
      }
    }
    const said = this.goodbyes.has(peerId);
    this.notice(said ? "info" : "warn", "Peer offline", `${this.labelOf(peerId)} ${said ? "left" : "disconnected"}`);
    this.log.info(`peer ${peerId} down: ${reason}`);
    this.changed();
  }

  private flushUndelivered(peerId: string): void {
    const pending = this.store.undeliveredFor(peerId, this.config.userId);
    // A peer that missed a group update would drop its messages; resend the state first.
    const groups = new Set(pending.filter((m) => m.conversation_id.startsWith("grp:")).map((m) => m.conversation_id));
    for (const convId of groups) {
      const payload = this.groupPayload(convId);
      if (payload) void this.transport.send(peerId, payload);
    }
    for (const m of pending) {
      void this.transport.send(peerId, {
        t: "chat",
        id: m.id,
        convId: m.conversation_id,
        convType: m.conversation_id.startsWith("dm:") ? "direct" : "group",
        body: m.body,
        ts: m.ts,
      });
    }
    if (pending.length) this.log.info(`resent ${pending.length} undelivered message(s) to ${peerId}`);
  }

  private retryUndelivered(): void {
    for (const p of this.transport.connectedPeers()) this.flushUndelivered(p.userId);
  }

  private sweepTyping(): void {
    const now = Date.now();
    let changed = false;
    for (const m of this.typing.values()) {
      for (const [id, exp] of m) {
        if (exp <= now) {
          m.delete(id);
          changed = true;
        }
      }
    }
    if (changed) this.changed();
  }

  private onMessage(from: string, msg: PeerMessage): void {
    switch (msg.t) {
      case "ping":
        void this.transport.send(from, { t: "pong", ts: msg.ts });
        return;
      case "pong":
        return;
      case "presence":
        this.store.setUserStatus(from, msg.status === "away" ? "away" : "online");
        this.store.setUserDisplayName(from, msg.displayName.slice(0, 32));
        this.changed();
        return;
      case "goodbye":
        this.goodbyes.add(from);
        return;
      case "peers":
        this.onPeers(from, msg.peers);
        return;
      case "chat":
        this.onChat(from, msg);
        return;
      case "delivered":
        if (this.store.markDelivered(msg.ids, from) > 0) this.changed();
        return;
      case "read":
        if (this.store.markReadBy(msg.ids, from) > 0) this.changed();
        return;
      case "typing": {
        if (!this.recipients(msg.convId).includes(from)) return;
        const m = this.typing.get(msg.convId) ?? new Map<string, number>();
        if (msg.typing) m.set(from, Date.now() + TYPING_TTL_MS);
        else m.delete(from);
        this.typing.set(msg.convId, m);
        this.changed();
        return;
      }
      case "group":
        this.onGroup(from, msg);
        return;
      case "group_leave":
        this.onGroupLeave(from, msg.convId, msg.version);
        return;
      case "file_offer":
        this.onFileOffer(from, msg);
        return;
      case "file_accept": {
        const t = this.store.getTransfer(msg.id);
        if (t && t.direction === "out" && t.peer_id === from && t.status === "offered") void this.streamFile(t);
        return;
      }
      case "file_decline": {
        const t = this.store.getTransfer(msg.id);
        if (t && t.direction === "out" && t.peer_id === from && t.status === "offered") {
          this.finishTransfer(t.id, "declined", `${this.labelOf(from)} declined`);
          this.notice("info", "File declined", `${this.labelOf(from)} declined ${t.name}`);
        }
        return;
      }
      case "file_chunk":
        this.onFileChunk(from, msg.id, msg.seq, msg.data);
        return;
      case "file_done":
        this.onFileDone(from, msg.id);
        return;
      case "file_result": {
        const t = this.store.getTransfer(msg.id);
        if (t?.direction !== "out" || t.peer_id !== from) return;
        if (msg.ok) {
          this.store.updateTransfer(t.id, { status: "complete", bytes: t.size });
          this.notice("success", "File sent", `${t.name} delivered to ${this.labelOf(from)}`);
          this.changed();
        } else {
          this.failTransfer(t.id, msg.reason ?? "rejected by receiver");
          this.notice("error", "File failed", `${t.name}: ${msg.reason ?? "rejected"}`);
        }
        return;
      }
      case "file_cancel": {
        const t = this.store.getTransfer(msg.id);
        if (t && t.peer_id === from && ["offered", "accepted", "in_progress"].includes(t.status)) {
          this.finishTransfer(t.id, "cancelled", `cancelled by ${this.labelOf(from)}`);
        }
        return;
      }
    }
  }

  private onPeers(from: string, peers: Array<{ id: string; host: string; port: number }>): void {
    const senderHost = this.transport.connection(from)?.peer?.host;
    for (const p of peers) {
      if (p.id === this.config.userId || this.transport.isConnected(p.id)) continue;
      // A loopback address is only meaningful on the sender's machine.
      const host = p.host.startsWith("127.") && senderHost && !senderHost.startsWith("127.") ? senderHost : p.host;
      this.transport.addTarget(host, p.port, { peerId: p.id });
    }
  }

  private onChat(from: string, msg: Extract<PeerMessage, { t: "chat" }>): void {
    const ack = () => void this.transport.send(from, { t: "delivered", ids: [msg.id] });
    let groupName: string | undefined;
    if (msg.convType === "direct") {
      if (msg.convId !== directConvId(this.config.userId, from)) {
        this.log.warn(`rejecting direct message with foreign conversation id from ${from}`);
        return;
      }
      this.ensureDirect(from);
    } else {
      const c = this.store.getConversation(msg.convId);
      if (c?.type !== "group") return; // wait for the group sync; sender will retry
      if (c.left_group) {
        ack();
        return;
      }
      if (!this.store.participants(msg.convId).includes(from)) return;
      groupName = c.name ?? "group";
    }
    const body = msg.body.slice(0, MAX_MESSAGE_CHARS);
    const isNew = this.store.insertMessage({
      id: msg.id,
      conversationId: msg.convId,
      senderId: from,
      body,
      kind: "text",
      ts: Math.min(msg.ts, Date.now() + 60_000),
    });
    ack();
    if (!isNew) return;
    this.typing.get(msg.convId)?.delete(from);
    if (this.activeConv === msg.convId) this.markRead(msg.convId);
    this.emit("incoming", {
      convId: msg.convId,
      senderLabel: this.labelOf(from),
      body,
      isGroup: msg.convType === "group",
      groupName,
    });
    this.changed();
  }

  private onGroup(from: string, msg: Extract<PeerMessage, { t: "group" }>): void {
    if (!msg.convId.startsWith("grp:")) return;
    const newIds = msg.members.map((m) => m.id);
    const local = this.store.getConversation(msg.convId);
    const localMembers = local ? this.store.participants(msg.convId) : [];
    // Only members may change a group.
    if (!newIds.includes(from) && !localMembers.includes(from)) return;
    if (local && msg.version <= local.version) return;
    const includesMe = newIds.includes(this.config.userId);
    if (!local && !includesMe) return;

    const labelBefore = (id: string) => this.labelOf(id);
    this.store.tx(() => {
      for (const m of msg.members) {
        if (m.id === this.config.userId) continue;
        const u = this.store.getUser(m.id);
        if (!u) this.store.upsertUser({ id: m.id, username: m.username, displayName: m.displayName });
        else if (!this.transport.isConnected(m.id)) this.store.setUserDisplayName(m.id, m.displayName);
      }
      if (!local) {
        this.store.ensureConversation({
          id: msg.convId,
          type: "group",
          name: msg.name,
          createdBy: msg.createdBy,
          createdAt: msg.createdAt,
          version: msg.version,
        });
        this.store.setParticipants(msg.convId, newIds);
        this.systemMessage(msg.convId, `${labelBefore(from)} added you to #${msg.name}`);
        return;
      }
      const added = newIds.filter((id) => !localMembers.includes(id) && id !== this.config.userId);
      const removed = localMembers.filter((id) => !newIds.includes(id) && id !== this.config.userId);
      this.store.setParticipants(msg.convId, newIds);
      this.store.updateGroup(msg.convId, { name: msg.name, version: msg.version, left: !includesMe });
      if (local.left_group && includesMe) this.systemMessage(msg.convId, `${labelBefore(from)} added you back`);
      if (!local.left_group && !includesMe) this.systemMessage(msg.convId, `You were removed from #${msg.name}`);
      for (const id of added) this.systemMessage(msg.convId, `${labelBefore(from)} added ${this.labelOf(id)}`);
      for (const id of removed) this.systemMessage(msg.convId, `${this.labelOf(id)} left`);
    });
    if (!local) this.notice("info", "New group", `${this.labelOf(from)} added you to #${msg.name}`);
    this.changed();
  }

  private onGroupLeave(from: string, convId: string, version: number): void {
    const c = this.store.getConversation(convId);
    if (c?.type !== "group") return;
    if (!this.store.participants(convId).includes(from)) return;
    this.store.tx(() => {
      this.store.removeParticipant(convId, from);
      this.store.updateGroup(convId, { version: Math.max(version, c.version) });
      this.systemMessage(convId, `${this.labelOf(from)} left`);
    });
    this.typing.get(convId)?.delete(from);
    this.changed();
  }

  private onFileOffer(from: string, msg: Extract<PeerMessage, { t: "file_offer" }>): void {
    if (msg.convId !== directConvId(this.config.userId, from)) return;
    if (this.store.getTransfer(msg.id)) return;
    const name = safeFilename(msg.name);
    if (msg.size < 0 || msg.size > MAX_FILE_BYTES || !/^[0-9a-f]{64}$/.test(msg.sha256)) {
      void this.transport.send(from, { t: "file_decline", id: msg.id });
      return;
    }
    this.ensureDirect(from);
    this.store.tx(() => {
      this.store.insertMessage({
        id: msg.messageId,
        conversationId: msg.convId,
        senderId: from,
        body: name,
        kind: "file",
        ts: Math.min(msg.ts, Date.now() + 60_000),
        transferId: msg.id,
      });
      this.store.insertTransfer({
        id: msg.id,
        message_id: msg.messageId,
        conversation_id: msg.convId,
        peer_id: from,
        direction: "in",
        name,
        path: null,
        size: msg.size,
        sha256: msg.sha256,
        status: "offered",
      });
    });
    if (this.activeConv === msg.convId) this.markRead(msg.convId);
    const view = this.transferView(this.store.getTransfer(msg.id)!);
    if (this.config.autoAcceptFiles) {
      this.acceptFile(msg.id);
    } else {
      this.emit("file_offer", view);
    }
    this.emit("incoming", {
      convId: msg.convId,
      senderLabel: view.peerLabel,
      body: `📎 ${name} (${formatBytes(msg.size)})`,
      isGroup: false,
    });
    this.changed();
  }

  private onFileChunk(from: string, id: string, seq: number, data: string): void {
    const inc = this.incoming.get(id);
    const t = this.store.getTransfer(id);
    if (!inc || !t || t.peer_id !== from) return;
    if (seq !== inc.nextSeq) {
      this.rejectIncoming(t, "chunk out of order");
      return;
    }
    const buf = Buffer.from(data, "base64");
    inc.bytes += buf.length;
    if (inc.bytes > t.size) {
      this.rejectIncoming(t, "more data than announced");
      return;
    }
    inc.nextSeq++;
    inc.hash.update(buf);
    fs.writeSync(inc.fd, buf);
    if (t.status !== "in_progress") this.store.updateTransfer(id, { status: "in_progress" });
    this.progress(id, inc.bytes);
  }

  private onFileDone(from: string, id: string): void {
    const inc = this.incoming.get(id);
    const t = this.store.getTransfer(id);
    if (!inc || !t || t.peer_id !== from) return;
    fs.closeSync(inc.fd);
    this.incoming.delete(id);
    const digest = inc.hash.digest("hex");
    if (inc.bytes !== t.size || digest !== t.sha256) {
      fs.rmSync(inc.partPath, { force: true });
      const reason = inc.bytes !== t.size ? "size mismatch" : "checksum mismatch";
      this.store.updateTransfer(id, { status: "failed", error: reason, bytes: inc.bytes });
      void this.transport.send(from, { t: "file_result", id, ok: false, reason });
      this.notice("error", "File rejected", `${t.name}: ${reason} — file deleted`);
      this.changed();
      return;
    }
    const finalPath = uniquePath(this.config.downloadsDir, t.name);
    fs.renameSync(inc.partPath, finalPath);
    try {
      fs.chmodSync(finalPath, 0o644);
    } catch {}
    this.store.updateTransfer(id, { status: "complete", bytes: t.size, path: finalPath });
    void this.transport.send(from, { t: "file_result", id, ok: true });
    this.notice("success", "File received", `${t.name} saved to ${finalPath}`);
    this.changed();
  }

  private rejectIncoming(t: TransferRow, reason: string): void {
    void this.transport.send(t.peer_id, { t: "file_cancel", id: t.id, reason });
    this.failTransfer(t.id, reason);
    this.notice("error", "File failed", `${t.name}: ${reason}`);
  }
}

function preview(m: MessageRow): string {
  if (m.kind === "file") return `📎 ${m.body}`;
  return m.body.replace(/\s+/g, " ");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
