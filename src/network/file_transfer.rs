use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::app::TransferProgress;
use crate::db::{self, Database, FileTransfer};
use crate::network::{ConnectionPool, NetworkMessage};

pub const CHUNK_SIZE: usize = 256 * 1024; // 256KB chunks for better speed
pub const MAX_FILE_SIZE: u64 = 100 * 1024 * 1024;

pub struct FileTransferManager {
    downloads_dir: PathBuf,
}

impl FileTransferManager {
    pub fn new(data_dir: &Path) -> Self {
        FileTransferManager {
            downloads_dir: data_dir.join("downloads"),
        }
    }

    /// Initiate a file send to `peer_id`.
    pub async fn send_file(
        &self,
        path: &Path,
        peer_id: &str,
        _conversation_id: &str,
        _my_user_id: &str,
        database: &Database,
        pool: &ConnectionPool,
    ) -> Result<String> {
        // Validate
        let meta = fs::metadata(path)
            .await
            .with_context(|| format!("Cannot access file: {}", path.display()))?;

        if meta.len() > MAX_FILE_SIZE {
            bail!("File exceeds 100 MB limit ({} bytes)", meta.len());
        }

        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();

        // Compute SHA-256 checksum
        let checksum = compute_checksum(path).await?;

        let transfer_id = Uuid::new_v4().to_string();

        // Create DB record (message_id is None until transfer completes)
        let ft = FileTransfer {
            id: transfer_id.clone(),
            message_id: None,  // No message yet - will be created when transfer completes
            filename: filename.clone(),
            file_path: path.to_string_lossy().to_string(),
            file_size: meta.len() as i64,
            checksum: Some(checksum.clone()),
            status: "pending".to_string(),
        };
        {
            let conn = database.lock();
            db::insert_file_transfer(&conn, &ft)?;
        }

        // Send FileOffer
        let offer = NetworkMessage::FileOffer {
            transfer_id: transfer_id.clone(),
            message_id: transfer_id.clone(),  // Use transfer_id as message_id for protocol
            filename,
            file_size: meta.len(),
            checksum,
        };
        pool.send_to(peer_id, &offer).await?;

        Ok(transfer_id)
    }

    /// Respond to a FileAccept and start sending chunks.
    pub async fn start_sending(
        &self,
        transfer_id: &str,
        peer_id: &str,
        database: &Database,
        pool: &ConnectionPool,
        progress_tx: mpsc::UnboundedSender<TransferProgress>,
    ) -> Result<()> {
        let file_path = {
            let conn = database.lock();
            let pending = db::get_pending_transfers(&conn)?;
            pending
                .into_iter()
                .find(|t| t.id == transfer_id)
                .map(|t| t.file_path)
                .unwrap_or_default()
        };

        if file_path.is_empty() {
            let _ = progress_tx.send(TransferProgress::Failed {
                transfer_id: transfer_id.to_string(),
                error: "Transfer not found".to_string(),
            });
            bail!("Transfer {} not found in pending transfers", transfer_id);
        }

        {
            let conn = database.lock();
            db::update_transfer_status(&conn, transfer_id, "in_progress")?;
        }

        let path = Path::new(&file_path);
        let file_size = fs::metadata(path).await?.len();
        let mut file = fs::File::open(path)
            .await
            .with_context(|| format!("Cannot open {}", file_path))?;

        let mut chunk_index = 0u32;
        let mut bytes_sent: u64 = 0;
        let mut buf = vec![0u8; CHUNK_SIZE];
        
        loop {
            let n = file.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            
            bytes_sent += n as u64;
            let is_last = bytes_sent >= file_size;
            let data = buf[..n].to_vec();

            let chunk = NetworkMessage::FileChunk {
                transfer_id: transfer_id.to_string(),
                chunk_index,
                data,
                is_last,
            };
            pool.send_to(peer_id, &chunk).await?;
            
            // Send progress update
            let _ = progress_tx.send(TransferProgress::BytesSent {
                transfer_id: transfer_id.to_string(),
                bytes: bytes_sent,
            });
            
            chunk_index += 1;

            if is_last {
                break;
            }
        }

        {
            let conn = database.lock();
            db::update_transfer_status(&conn, transfer_id, "complete")?;
        }

        let _ = progress_tx.send(TransferProgress::Completed {
            transfer_id: transfer_id.to_string(),
        });

        Ok(())
    }

    /// Handle a received FileChunk; return true when the transfer is complete.
    pub async fn receive_chunk(
        &self,
        transfer_id: &str,
        chunk_index: u32,
        data: &[u8],
        is_last: bool,
        expected_checksum: &str,
        database: &Database,
    ) -> Result<bool> {
        // Ensure downloads directory exists
        fs::create_dir_all(&self.downloads_dir).await?;

        let file_path = self.downloads_dir.join(format!("{}.part", transfer_id));
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file_path)
            .await
            .with_context(|| format!("Cannot open part file for transfer {}", transfer_id))?;

        tokio::io::AsyncWriteExt::write_all(&mut file, data).await?;
        drop(file);

        if is_last || chunk_index == 0 {
            let _ = chunk_index; // suppress warning
        }

        if is_last {
            // Verify checksum
            let actual = compute_checksum(&file_path).await?;
            if actual != expected_checksum {
                fs::remove_file(&file_path).await.ok();
                let conn = database.lock();
                db::update_transfer_status(&conn, transfer_id, "failed")?;
                bail!(
                    "Checksum mismatch for transfer {}: expected {}, got {}",
                    transfer_id,
                    expected_checksum,
                    actual
                );
            }

            // Move from .part to final filename
            // (In a real impl, we'd store the filename in the DB)
            let final_path = self.downloads_dir.join(transfer_id);
            fs::rename(&file_path, &final_path).await?;

            let conn = database.lock();
            db::update_transfer_status(&conn, transfer_id, "complete")?;
            return Ok(true);
        }

        Ok(false)
    }
}

/// Compute the SHA-256 hex digest of a file.
pub async fn compute_checksum(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)
        .await
        .with_context(|| format!("Cannot open file for checksum: {}", path.display()))?;

    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK_SIZE];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

/// Produce a unique destination path that doesn't overwrite existing files.
pub fn unique_path(dir: &Path, filename: &str) -> PathBuf {
    let base = Path::new(filename);
    let stem = base.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = base.extension().and_then(|e| e.to_str()).unwrap_or("");

    let candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }

    for i in 1u32.. {
        let name = if ext.is_empty() {
            format!("{}_{}", stem, i)
        } else {
            format!("{}_{}.{}", stem, i, ext)
        };
        let path = dir.join(&name);
        if !path.exists() {
            return path;
        }
    }
    unreachable!()
}
