use anyhow::{Context, Result};
use rusqlite::Connection;
use std::path::Path;

pub fn init_db(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)
        .with_context(|| format!("Failed to open database at {}", path.display()))?;

    conn.execute_batch("PRAGMA foreign_keys = ON;")?;

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS users (
            id              TEXT PRIMARY KEY,
            username        TEXT NOT NULL UNIQUE,
            display_name    TEXT NOT NULL,
            ip_address      TEXT,
            port            INTEGER,
            status          TEXT DEFAULT 'offline',
            last_seen       TEXT,
            public_key      BLOB
        );

        CREATE TABLE IF NOT EXISTS conversations (
            id              TEXT PRIMARY KEY,
            conv_type       TEXT NOT NULL,
            name            TEXT,
            created_at      TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversation_participants (
            conversation_id TEXT NOT NULL REFERENCES conversations(id),
            user_id         TEXT NOT NULL REFERENCES users(id),
            joined_at       TEXT NOT NULL,
            PRIMARY KEY (conversation_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS messages (
            id              TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL REFERENCES conversations(id),
            sender_id       TEXT NOT NULL REFERENCES users(id),
            content         TEXT NOT NULL,
            content_type    TEXT DEFAULT 'text',
            timestamp       TEXT NOT NULL,
            delivered       INTEGER DEFAULT 0,
            read            INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS file_transfers (
            id              TEXT PRIMARY KEY,
            message_id      TEXT REFERENCES messages(id),
            filename        TEXT NOT NULL,
            file_path       TEXT NOT NULL,
            file_size       INTEGER NOT NULL,
            checksum        TEXT,
            status          TEXT DEFAULT 'pending'
        );

        CREATE INDEX IF NOT EXISTS idx_messages_conv_ts
            ON messages(conversation_id, timestamp);

        CREATE INDEX IF NOT EXISTS idx_users_username
            ON users(username);

        CREATE INDEX IF NOT EXISTS idx_conv_participants_user
            ON conversation_participants(user_id);
        ",
    )
    .with_context(|| "Failed to create database schema")?;

    Ok(conn)
}
