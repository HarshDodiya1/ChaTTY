use anyhow::{Context, Result};
use rusqlite::{params, Connection};

use super::models::FileTransfer;

pub fn insert_file_transfer(conn: &Connection, transfer: &FileTransfer) -> Result<()> {
    conn.execute(
        "INSERT INTO file_transfers (id, message_id, filename, file_path, file_size, checksum, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            transfer.id,
            transfer.message_id,
            transfer.filename,
            transfer.file_path,
            transfer.file_size,
            transfer.checksum,
            transfer.status,
        ],
    )
    .with_context(|| format!("Failed to insert file transfer '{}'", transfer.id))?;
    Ok(())
}

pub fn update_transfer_status(conn: &Connection, id: &str, status: &str) -> Result<()> {
    conn.execute(
        "UPDATE file_transfers SET status = ?1 WHERE id = ?2",
        params![status, id],
    )
    .with_context(|| format!("Failed to update status for transfer '{}'", id))?;
    Ok(())
}

pub fn get_pending_transfers(conn: &Connection) -> Result<Vec<FileTransfer>> {
    let mut stmt = conn.prepare(
        "SELECT id, message_id, filename, file_path, file_size, checksum, status
         FROM file_transfers
         WHERE status = 'pending'",
    )?;
    let transfers = stmt
        .query_map([], |row| {
            Ok(FileTransfer {
                id: row.get(0)?,
                message_id: row.get(1)?,
                filename: row.get(2)?,
                file_path: row.get(3)?,
                file_size: row.get(4)?,
                checksum: row.get(5)?,
                status: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(transfers)
}
