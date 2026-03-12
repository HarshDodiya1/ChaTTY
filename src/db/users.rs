use anyhow::{Context, Result};
use rusqlite::{params, Connection};

use super::models::User;

pub fn insert_user(conn: &Connection, user: &User) -> Result<()> {
    conn.execute(
        "INSERT INTO users (id, username, display_name, ip_address, port, status, last_seen, public_key)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            user.id,
            user.username,
            user.display_name,
            user.ip_address,
            user.port,
            user.status,
            user.last_seen,
            user.public_key,
        ],
    )
    .with_context(|| format!("Failed to insert user '{}'", user.username))?;
    Ok(())
}

pub fn get_user_by_id(conn: &Connection, id: &str) -> Result<Option<User>> {
    let mut stmt = conn.prepare(
        "SELECT id, username, display_name, ip_address, port, status, last_seen, public_key
         FROM users WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row_to_user(row)?))
    } else {
        Ok(None)
    }
}

pub fn get_user_by_username(conn: &Connection, username: &str) -> Result<Option<User>> {
    let mut stmt = conn.prepare(
        "SELECT id, username, display_name, ip_address, port, status, last_seen, public_key
         FROM users WHERE username = ?1",
    )?;
    let mut rows = stmt.query(params![username])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row_to_user(row)?))
    } else {
        Ok(None)
    }
}

pub fn get_all_users(conn: &Connection) -> Result<Vec<User>> {
    let mut stmt = conn.prepare(
        "SELECT id, username, display_name, ip_address, port, status, last_seen, public_key
         FROM users",
    )?;
    let users = stmt
        .query_map([], |row| Ok(row_to_user(row)))?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .collect::<Result<Vec<_>>>()?;
    Ok(users)
}

pub fn update_user_status(
    conn: &Connection,
    id: &str,
    status: &str,
    last_seen: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE users SET status = ?1, last_seen = ?2 WHERE id = ?3",
        params![status, last_seen, id],
    )
    .with_context(|| format!("Failed to update status for user '{}'", id))?;
    Ok(())
}

pub fn upsert_user(conn: &Connection, user: &User) -> Result<()> {
    conn.execute(
        "INSERT INTO users (id, username, display_name, ip_address, port, status, last_seen, public_key)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(username) DO UPDATE SET
             id           = excluded.id,
             display_name = excluded.display_name,
             ip_address   = excluded.ip_address,
             port         = excluded.port,
             status       = excluded.status,
             last_seen    = excluded.last_seen,
             public_key   = excluded.public_key",
        params![
            user.id,
            user.username,
            user.display_name,
            user.ip_address,
            user.port,
            user.status,
            user.last_seen,
            user.public_key,
        ],
    )
    .with_context(|| format!("Failed to upsert user '{}'", user.username))?;
    Ok(())
}

fn row_to_user(row: &rusqlite::Row) -> Result<User> {
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
}
