// SQLite persistence via bun:sqlite. All timestamps are epoch milliseconds.

import { Database } from "bun:sqlite";
import type { PresenceStatus } from "../core/protocol.ts";

export type ConvType = "direct" | "group";
export type MessageKind = "text" | "file" | "system";
export type TransferDirection = "out" | "in";
export type TransferStatus = "offered" | "accepted" | "in_progress" | "complete" | "failed" | "declined" | "cancelled";

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  status: PresenceStatus;
  last_seen: number | null;
  host: string | null;
  port: number | null;
  identity_key: string | null;
  key_changed: number;
  is_self: number;
}

export interface ConversationRow {
  id: string;
  type: ConvType;
  name: string | null;
  created_by: string | null;
  created_at: number;
  version: number;
  left_group: number;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  kind: MessageKind;
  ts: number;
  transfer_id: string | null;
  read_by_me: number;
}

export interface DeliveryRow {
  message_id: string;
  user_id: string;
  delivered_at: number | null;
  read_at: number | null;
}

export interface TransferRow {
  id: string;
  message_id: string | null;
  conversation_id: string;
  peer_id: string;
  direction: TransferDirection;
  name: string;
  path: string | null;
  size: number;
  sha256: string;
  bytes: number;
  status: TransferStatus;
  error: string | null;
  created_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'offline',
  last_seen     INTEGER,
  host          TEXT,
  port          INTEGER,
  identity_key  TEXT,
  key_changed   INTEGER NOT NULL DEFAULT 0,
  is_self       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('direct','group')),
  name        TEXT,
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  version     INTEGER NOT NULL DEFAULT 0,
  left_group  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS participants (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       TEXT NOT NULL,
  body            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'text',
  ts              INTEGER NOT NULL,
  transfer_id     TEXT,
  read_by_me      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS deliveries (
  message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  delivered_at INTEGER,
  read_at      INTEGER,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS transfers (
  id              TEXT PRIMARY KEY,
  message_id      TEXT,
  conversation_id TEXT NOT NULL,
  peer_id         TEXT NOT NULL,
  direction       TEXT NOT NULL,
  name            TEXT NOT NULL,
  path            TEXT,
  size            INTEGER NOT NULL,
  sha256          TEXT NOT NULL,
  bytes           INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,
  error           TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages(conversation_id, ts);
CREATE INDEX IF NOT EXISTS idx_participants_user ON participants(user_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_pending ON deliveries(user_id, delivered_at);
`;

export class Store {
  readonly db: Database;

  constructor(file: string) {
    this.db = new Database(file, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 3000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ── users ──────────────────────────────────────────────────────────────

  upsertUser(u: {
    id: string;
    username: string;
    displayName: string;
    status?: PresenceStatus;
    host?: string | null;
    port?: number | null;
    isSelf?: boolean;
  }): void {
    this.db
      .query(
        `INSERT INTO users (id, username, display_name, status, last_seen, host, port, is_self)
         VALUES ($id, $username, $displayName, $status, $now, $host, $port, $isSelf)
         ON CONFLICT(id) DO UPDATE SET
           username = excluded.username,
           display_name = excluded.display_name,
           status = COALESCE($statusOrNull, users.status),
           last_seen = excluded.last_seen,
           host = COALESCE(excluded.host, users.host),
           port = COALESCE(excluded.port, users.port),
           is_self = MAX(users.is_self, excluded.is_self)`,
      )
      .run({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        status: u.status ?? "offline",
        statusOrNull: u.status ?? null,
        now: Date.now(),
        host: u.host ?? null,
        port: u.port ?? null,
        isSelf: u.isSelf ? 1 : 0,
      });
  }

  /** Make sure a row exists for `id` without clobbering an existing one. */
  ensureUser(id: string, username: string, displayName: string): void {
    this.db
      .query(
        `INSERT INTO users (id, username, display_name) VALUES ($id, $username, $displayName)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run({ id, username, displayName });
  }

  getUser(id: string): UserRow | null {
    return this.db.query<UserRow, [string]>("SELECT * FROM users WHERE id = ?").get(id);
  }

  listPeers(): UserRow[] {
    return this.db.query<UserRow, []>("SELECT * FROM users WHERE is_self = 0").all();
  }

  findUsersByName(name: string): UserRow[] {
    return this.db
      .query<UserRow, [string, string]>(
        `SELECT * FROM users WHERE is_self = 0 AND (lower(username) = lower(?) OR lower(display_name) = lower(?))`,
      )
      .all(name, name);
  }

  setUserStatus(id: string, status: PresenceStatus): void {
    this.db.query("UPDATE users SET status = ?, last_seen = ? WHERE id = ?").run(status, Date.now(), id);
  }

  setAllPeersOffline(): void {
    this.db.query("UPDATE users SET status = 'offline' WHERE is_self = 0").run();
  }

  setUserDisplayName(id: string, displayName: string): void {
    this.db.query("UPDATE users SET display_name = ? WHERE id = ?").run(displayName, id);
  }

  setUserAddress(id: string, host: string, port: number): void {
    this.db.query("UPDATE users SET host = ?, port = ? WHERE id = ?").run(host, port, id);
  }

  setIdentityKey(id: string, key: string, changed: boolean): void {
    this.db.query("UPDATE users SET identity_key = ?, key_changed = ? WHERE id = ?").run(key, changed ? 1 : 0, id);
  }

  clearKeyChanged(id: string): void {
    this.db.query("UPDATE users SET key_changed = 0 WHERE id = ?").run(id);
  }

  // ── conversations ──────────────────────────────────────────────────────

  ensureConversation(c: {
    id: string;
    type: ConvType;
    name?: string | null;
    createdBy?: string | null;
    createdAt?: number;
    version?: number;
  }): void {
    this.db
      .query(
        `INSERT INTO conversations (id, type, name, created_by, created_at, version)
         VALUES ($id, $type, $name, $createdBy, $createdAt, $version)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run({
        id: c.id,
        type: c.type,
        name: c.name ?? null,
        createdBy: c.createdBy ?? null,
        createdAt: c.createdAt ?? Date.now(),
        version: c.version ?? 0,
      });
  }

  getConversation(id: string): ConversationRow | null {
    return this.db.query<ConversationRow, [string]>("SELECT * FROM conversations WHERE id = ?").get(id);
  }

  listConversations(type?: ConvType): ConversationRow[] {
    if (type) {
      return this.db
        .query<ConversationRow, [string]>("SELECT * FROM conversations WHERE type = ? ORDER BY created_at")
        .all(type);
    }
    return this.db.query<ConversationRow, []>("SELECT * FROM conversations ORDER BY created_at").all();
  }

  updateGroup(id: string, fields: { name?: string; version?: number; left?: boolean }): void {
    const cur = this.getConversation(id);
    if (!cur) return;
    this.db
      .query("UPDATE conversations SET name = ?, version = ?, left_group = ? WHERE id = ?")
      .run(
        fields.name ?? cur.name,
        fields.version ?? cur.version,
        fields.left === undefined ? cur.left_group : fields.left ? 1 : 0,
        id,
      );
  }

  setParticipants(convId: string, userIds: string[]): void {
    this.tx(() => {
      this.db.query("DELETE FROM participants WHERE conversation_id = ?").run(convId);
      const ins = this.db.query("INSERT OR IGNORE INTO participants (conversation_id, user_id) VALUES (?, ?)");
      for (const uid of userIds) ins.run(convId, uid);
    });
  }

  addParticipant(convId: string, userId: string): void {
    this.db.query("INSERT OR IGNORE INTO participants (conversation_id, user_id) VALUES (?, ?)").run(convId, userId);
  }

  removeParticipant(convId: string, userId: string): void {
    this.db.query("DELETE FROM participants WHERE conversation_id = ? AND user_id = ?").run(convId, userId);
  }

  participants(convId: string): string[] {
    return this.db
      .query<{ user_id: string }, [string]>("SELECT user_id FROM participants WHERE conversation_id = ?")
      .all(convId)
      .map((r) => r.user_id);
  }

  groupsWithMember(userId: string): ConversationRow[] {
    return this.db
      .query<ConversationRow, [string]>(
        `SELECT c.* FROM conversations c JOIN participants p ON p.conversation_id = c.id
         WHERE c.type = 'group' AND p.user_id = ?`,
      )
      .all(userId);
  }

  // ── messages ───────────────────────────────────────────────────────────

  /** Insert a message; returns false when the id already exists (duplicate delivery). */
  insertMessage(m: {
    id: string;
    conversationId: string;
    senderId: string;
    body: string;
    kind: MessageKind;
    ts: number;
    transferId?: string | null;
    readByMe?: boolean;
  }): boolean {
    const res = this.db
      .query(
        `INSERT OR IGNORE INTO messages (id, conversation_id, sender_id, body, kind, ts, transfer_id, read_by_me)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.id, m.conversationId, m.senderId, m.body, m.kind, m.ts, m.transferId ?? null, m.readByMe ? 1 : 0);
    return res.changes > 0;
  }

  getMessage(id: string): MessageRow | null {
    return this.db.query<MessageRow, [string]>("SELECT * FROM messages WHERE id = ?").get(id);
  }

  /** Latest `limit` messages of a conversation, oldest first. */
  recentMessages(convId: string, limit: number): MessageRow[] {
    return this.db
      .query<MessageRow, [string, number]>(
        `SELECT id, conversation_id, sender_id, body, kind, ts, transfer_id, read_by_me FROM (
           SELECT *, rowid AS rid FROM messages WHERE conversation_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?
         ) ORDER BY ts ASC, rid ASC`,
      )
      .all(convId, limit);
  }

  messageCount(convId: string): number {
    return this.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?")
      .get(convId)!.n;
  }

  lastMessage(convId: string): MessageRow | null {
    return this.db
      .query<MessageRow, [string]>(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY ts DESC, rowid DESC LIMIT 1",
      )
      .get(convId);
  }

  searchMessages(convId: string, query: string, limit = 50): MessageRow[] {
    const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
    return this.db
      .query<MessageRow, [string, string, number]>(
        `SELECT * FROM messages WHERE conversation_id = ? AND kind != 'system' AND body LIKE ? ESCAPE '\\'
         ORDER BY ts DESC LIMIT ?`,
      )
      .all(convId, `%${escaped}%`, limit);
  }

  unreadCount(convId: string, selfId: string): number {
    return this.db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_id != ? AND read_by_me = 0 AND kind != 'system'`,
      )
      .get(convId, selfId)!.n;
  }

  /** Marks incoming messages as read; returns them grouped by sender for receipts. */
  markConversationRead(convId: string, selfId: string): Map<string, string[]> {
    const rows = this.db
      .query<{ id: string; sender_id: string }, [string, string]>(
        `SELECT id, sender_id FROM messages WHERE conversation_id = ? AND sender_id != ? AND read_by_me = 0 AND kind != 'system'`,
      )
      .all(convId, selfId);
    const bySender = new Map<string, string[]>();
    if (rows.length === 0) return bySender;
    this.tx(() => {
      const upd = this.db.query("UPDATE messages SET read_by_me = 1 WHERE id = ?");
      for (const r of rows) {
        upd.run(r.id);
        const list = bySender.get(r.sender_id) ?? [];
        list.push(r.id);
        bySender.set(r.sender_id, list);
      }
    });
    return bySender;
  }

  // ── deliveries ─────────────────────────────────────────────────────────

  addDeliveries(messageId: string, userIds: string[]): void {
    const ins = this.db.query("INSERT OR IGNORE INTO deliveries (message_id, user_id) VALUES (?, ?)");
    this.tx(() => {
      for (const uid of userIds) ins.run(messageId, uid);
    });
  }

  markDelivered(messageIds: string[], userId: string): number {
    let changed = 0;
    const upd = this.db.query(
      "UPDATE deliveries SET delivered_at = COALESCE(delivered_at, ?) WHERE message_id = ? AND user_id = ? AND delivered_at IS NULL",
    );
    const now = Date.now();
    this.tx(() => {
      for (const id of messageIds) changed += upd.run(now, id, userId).changes;
    });
    return changed;
  }

  markReadBy(messageIds: string[], userId: string): number {
    let changed = 0;
    const upd = this.db.query(
      `UPDATE deliveries SET read_at = COALESCE(read_at, $now), delivered_at = COALESCE(delivered_at, $now)
       WHERE message_id = $id AND user_id = $uid AND read_at IS NULL`,
    );
    const now = Date.now();
    this.tx(() => {
      for (const id of messageIds) changed += upd.run({ now, id, uid: userId }).changes;
    });
    return changed;
  }

  deliveries(messageId: string): DeliveryRow[] {
    return this.db.query<DeliveryRow, [string]>("SELECT * FROM deliveries WHERE message_id = ?").all(messageId);
  }

  deliveriesFor(messageIds: string[]): Map<string, DeliveryRow[]> {
    const out = new Map<string, DeliveryRow[]>();
    if (messageIds.length === 0) return out;
    const q = this.db.query<DeliveryRow, [string]>("SELECT * FROM deliveries WHERE message_id = ?");
    for (const id of messageIds) out.set(id, q.all(id));
    return out;
  }

  /** Messages I sent that `userId` has not acknowledged yet, oldest first. */
  undeliveredFor(userId: string, selfId: string): MessageRow[] {
    return this.db
      .query<MessageRow, [string, string]>(
        `SELECT m.* FROM messages m JOIN deliveries d ON d.message_id = m.id
         WHERE d.user_id = ? AND d.delivered_at IS NULL AND m.sender_id = ? AND m.kind = 'text'
         ORDER BY m.ts ASC`,
      )
      .all(userId, selfId);
  }

  // ── transfers ──────────────────────────────────────────────────────────

  insertTransfer(t: Omit<TransferRow, "bytes" | "error" | "created_at"> & { created_at?: number }): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO transfers (id, message_id, conversation_id, peer_id, direction, name, path, size, sha256, bytes, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?)`,
      )
      .run(
        t.id,
        t.message_id,
        t.conversation_id,
        t.peer_id,
        t.direction,
        t.name,
        t.path,
        t.size,
        t.sha256,
        t.status,
        t.created_at ?? Date.now(),
      );
  }

  getTransfer(id: string): TransferRow | null {
    return this.db.query<TransferRow, [string]>("SELECT * FROM transfers WHERE id = ?").get(id);
  }

  updateTransfer(id: string, fields: Partial<Pick<TransferRow, "status" | "bytes" | "path" | "error">>): void {
    const cur = this.getTransfer(id);
    if (!cur) return;
    this.db
      .query("UPDATE transfers SET status = ?, bytes = ?, path = ?, error = ? WHERE id = ?")
      .run(
        fields.status ?? cur.status,
        fields.bytes ?? cur.bytes,
        fields.path === undefined ? cur.path : fields.path,
        fields.error === undefined ? cur.error : fields.error,
        id,
      );
  }

  listTransfers(limit = 50): TransferRow[] {
    return this.db.query<TransferRow, [number]>("SELECT * FROM transfers ORDER BY created_at DESC LIMIT ?").all(limit);
  }

  /** Transfers left mid-flight by a previous run can never finish. */
  failStaleTransfers(): void {
    this.db
      .query(
        `UPDATE transfers SET status = 'failed', error = 'interrupted' WHERE status IN ('offered','accepted','in_progress')`,
      )
      .run();
  }
}
