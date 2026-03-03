use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection};
use uuid::Uuid;

use super::models::{Conversation, User};

pub fn create_conversation(conn: &Connection, conversation: &Conversation) -> Result<()> {
    conn.execute(
        "INSERT INTO conversations (id, conv_type, name, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![
            conversation.id,
            conversation.conv_type,
            conversation.name,
            conversation.created_at,
        ],
    )
    .with_context(|| format!("Failed to create conversation '{}'", conversation.id))?;
    Ok(())
}

pub fn get_conversation_by_id(
    conn: &Connection,
    id: &str,
) -> Result<Option<Conversation>> {
    let mut stmt = conn.prepare(
        "SELECT id, conv_type, name, created_at FROM conversations WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(Conversation {
            id: row.get(0)?,
            conv_type: row.get(1)?,
            name: row.get(2)?,
            created_at: row.get(3)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn get_conversations_for_user(
    conn: &Connection,
    user_id: &str,
) -> Result<Vec<Conversation>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.conv_type, c.name, c.created_at
         FROM conversations c
         JOIN conversation_participants cp ON cp.conversation_id = c.id
         WHERE cp.user_id = ?1
         ORDER BY c.created_at DESC",
    )?;
    let convs = stmt
        .query_map(params![user_id], |row| {
            Ok(Conversation {
                id: row.get(0)?,
                conv_type: row.get(1)?,
                name: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(convs)
}

pub fn get_or_create_direct_conversation(
    conn: &Connection,
    user1_id: &str,
    user2_id: &str,
) -> Result<Conversation> {
    // Find an existing direct conversation between these two users
    let mut stmt = conn.prepare(
        "SELECT c.id, c.conv_type, c.name, c.created_at
         FROM conversations c
         JOIN conversation_participants cp1 ON cp1.conversation_id = c.id AND cp1.user_id = ?1
         JOIN conversation_participants cp2 ON cp2.conversation_id = c.id AND cp2.user_id = ?2
         WHERE c.conv_type = 'direct'
         LIMIT 1",
    )?;
    let mut rows = stmt.query(params![user1_id, user2_id])?;

    if let Some(row) = rows.next()? {
        return Ok(Conversation {
            id: row.get(0)?,
            conv_type: row.get(1)?,
            name: row.get(2)?,
            created_at: row.get(3)?,
        });
    }

    // Create new direct conversation
    let conv = Conversation {
        id: Uuid::new_v4().to_string(),
        conv_type: "direct".to_string(),
        name: None,
        created_at: Utc::now().to_rfc3339(),
    };
    create_conversation(conn, &conv)?;
    add_participant(conn, &conv.id, user1_id)?;
    add_participant(conn, &conv.id, user2_id)?;
    Ok(conv)
}

pub fn add_participant(conn: &Connection, conversation_id: &str, user_id: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO conversation_participants (conversation_id, user_id, joined_at)
         VALUES (?1, ?2, ?3)",
        params![conversation_id, user_id, Utc::now().to_rfc3339()],
    )
    .with_context(|| {
        format!(
            "Failed to add participant '{}' to conversation '{}'",
            user_id, conversation_id
        )
    })?;
    Ok(())
}

pub fn get_participants(conn: &Connection, conversation_id: &str) -> Result<Vec<User>> {
    let mut stmt = conn.prepare(
        "SELECT u.id, u.username, u.display_name, u.ip_address, u.port, u.status, u.last_seen, u.public_key
         FROM users u
         JOIN conversation_participants cp ON cp.user_id = u.id
         WHERE cp.conversation_id = ?1",
    )?;
    let users = stmt
        .query_map(params![conversation_id], |row| {
            Ok(User {
                id: row.get(0)?,
                username: row.get(1)?,
                display_name: row.get(2)?,
                ip_address: row.get(3)?,
                port: row.get(4)?,
                status: row.get(5)?,
                last_seen: row.get(6)?,
                public_key: row.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(users)
}
