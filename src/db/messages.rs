use anyhow::{Context, Result};
use rusqlite::{params, Connection};

use super::models::Message;

pub fn insert_message(conn: &Connection, message: &Message) -> Result<()> {
    conn.execute(
        "INSERT INTO messages (id, conversation_id, sender_id, content, content_type, timestamp, delivered, read)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            message.id,
            message.conversation_id,
            message.sender_id,
            message.content,
            message.content_type,
            message.timestamp,
            message.delivered as i64,
            message.read as i64,
        ],
    )
    .with_context(|| format!("Failed to insert message '{}'", message.id))?;
    Ok(())
}

pub fn get_messages_for_conversation(
    conn: &Connection,
    conversation_id: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<Message>> {
    let mut stmt = conn.prepare(
        "SELECT id, conversation_id, sender_id, content, content_type, timestamp, delivered, read
         FROM messages
         WHERE conversation_id = ?1
         ORDER BY timestamp ASC
         LIMIT ?2 OFFSET ?3",
    )?;
    let messages = stmt
        .query_map(params![conversation_id, limit, offset], |row| {
            Ok(row_to_message(row))
        })?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .collect::<Result<Vec<_>>>()?;
    Ok(messages)
}

/// Get all messages for a conversation (no limit).
pub fn get_all_messages_for_conversation(
    conn: &Connection,
    conversation_id: &str,
) -> Result<Vec<Message>> {
    let mut stmt = conn.prepare(
        "SELECT id, conversation_id, sender_id, content, content_type, timestamp, delivered, read
         FROM messages
         WHERE conversation_id = ?1
         ORDER BY timestamp ASC",
    )?;
    let messages = stmt
        .query_map(params![conversation_id], |row| {
            Ok(row_to_message(row))
        })?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .collect::<Result<Vec<_>>>()?;
    Ok(messages)
}

pub fn get_undelivered_messages(conn: &Connection, _recipient_id: &str) -> Result<Vec<Message>> {
    let mut stmt = conn.prepare(
        "SELECT id, conversation_id, sender_id, content, content_type, timestamp, delivered, read
         FROM messages
         WHERE delivered = 0",
    )?;
    let messages = stmt
        .query_map([], |row| Ok(row_to_message(row)))?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .collect::<Result<Vec<_>>>()?;
    Ok(messages)
}

pub fn mark_message_delivered(conn: &Connection, message_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE messages SET delivered = 1 WHERE id = ?1",
        params![message_id],
    )
    .with_context(|| format!("Failed to mark message '{}' as delivered", message_id))?;
    Ok(())
}

pub fn mark_messages_read(
    conn: &Connection,
    conversation_id: &str,
    _reader_id: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE messages SET read = 1 WHERE conversation_id = ?1",
        params![conversation_id],
    )
    .with_context(|| {
        format!(
            "Failed to mark messages as read in conversation '{}'",
            conversation_id
        )
    })?;
    Ok(())
}

/// Search messages in `conversation_id` whose content matches the LIKE pattern `%query%`.
pub fn search_messages(
    conn: &Connection,
    conversation_id: &str,
    query: &str,
    limit: i64,
) -> Result<Vec<Message>> {
    let pattern = format!("%{}%", query);
    let mut stmt = conn.prepare(
        "SELECT id, conversation_id, sender_id, content, content_type, timestamp, delivered, read
         FROM messages
         WHERE conversation_id = ?1 AND content LIKE ?2
         ORDER BY timestamp DESC
         LIMIT ?3",
    )?;
    let messages = stmt
        .query_map(params![conversation_id, pattern, limit], |row| {
            Ok(row_to_message(row))
        })?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .collect::<Result<Vec<_>>>()?;
    Ok(messages)
}

fn row_to_message(row: &rusqlite::Row) -> Result<Message> {
    Ok(Message {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        sender_id: row.get(2)?,
        content: row.get(3)?,
        content_type: row.get(4)?,
        timestamp: row.get(5)?,
        delivered: row.get::<_, i64>(6)? != 0,
        read: row.get::<_, i64>(7)? != 0,
    })
}
