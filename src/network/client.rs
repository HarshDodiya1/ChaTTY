use anyhow::{Context, Result};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time::timeout;

use super::protocol::NetworkMessage;

/// An active TCP connection to a single peer.
#[derive(Clone)]
pub struct PeerConnection {
    // tokio::sync::Mutex is hold-across-await safe
    writer: Arc<Mutex<Option<tokio::net::tcp::OwnedWriteHalf>>>,
    pub addr: SocketAddr,
}

impl PeerConnection {
    /// Connect to `addr` with a 5-second timeout.
    pub async fn connect(addr: SocketAddr) -> Result<Self> {
        log::debug!("Connecting to {}...", addr);
        let stream = timeout(Duration::from_secs(5), TcpStream::connect(addr))
            .await
            .with_context(|| format!("Connection to {} timed out", addr))?
            .with_context(|| format!("Failed to connect to {}", addr))?;

        let (_read, write) = stream.into_split();

        Ok(PeerConnection {
            writer: Arc::new(Mutex::new(Some(write))),
            addr,
        })
    }

    /// Wrap an already-accepted write half (from the TCP server) as a PeerConnection.
    pub fn from_write_half(write: tokio::net::tcp::OwnedWriteHalf, addr: SocketAddr) -> Self {
        PeerConnection {
            writer: Arc::new(Mutex::new(Some(write))),
            addr,
        }
    }

    /// Serialize, frame, and write a message to this peer.
    pub async fn send(&self, message: &NetworkMessage) -> Result<()> {
        let frame = message.to_frame()?;
        let mut guard = self.writer.lock().await;
        if let Some(w) = guard.as_mut() {
            w.write_all(&frame)
                .await
                .with_context(|| format!("Failed to write to {}", self.addr))?;
        }
        Ok(())
    }

    /// Close the write half.
    pub async fn close(&self) -> Result<()> {
        let mut guard = self.writer.lock().await;
        if let Some(mut w) = guard.take() {
            let _ = w.shutdown().await;
        }
        Ok(())
    }
}

/// A thread-safe pool of active peer connections.
#[derive(Clone)]
pub struct ConnectionPool {
    conns: Arc<Mutex<HashMap<String, PeerConnection>>>,
}

impl Default for ConnectionPool {
    fn default() -> Self {
        ConnectionPool {
            conns: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl ConnectionPool {
    pub fn new() -> Self {
        ConnectionPool::default()
    }

    /// Return existing connection or connect fresh.
    pub async fn get_or_connect(
        &self,
        peer_id: &str,
        addr: SocketAddr,
    ) -> Result<PeerConnection> {
        {
            let guard = self.conns.lock().await;
            if let Some(conn) = guard.get(peer_id) {
                return Ok(conn.clone());
            }
        }

        let conn = PeerConnection::connect(addr).await?;
        self.conns
            .lock()
            .await
            .insert(peer_id.to_string(), conn.clone());
        Ok(conn)
    }

    /// Insert a pre-built connection into the pool.
    pub async fn insert(&self, key: &str, conn: PeerConnection) {
        self.conns.lock().await.insert(key.to_string(), conn);
    }

    /// Re-key a connection: move the entry from `old_key` to `new_key`.
    /// Returns true if the rename happened, false if `old_key` was not found.
    pub async fn rename(&self, old_key: &str, new_key: &str) -> bool {
        let mut guard = self.conns.lock().await;
        if let Some(conn) = guard.remove(old_key) {
            guard.insert(new_key.to_string(), conn);
            true
        } else {
            false
        }
    }

    /// Remove a peer from the pool (e.g. after disconnect).
    pub async fn remove(&self, peer_id: &str) {
        self.conns.lock().await.remove(peer_id);
    }

    /// Send a message to a specific peer (must already be in the pool).
    pub async fn send_to(&self, peer_id: &str, message: &NetworkMessage) -> Result<()> {
        let conn = self.conns.lock().await.get(peer_id).cloned();
        if let Some(conn) = conn {
            conn.send(message).await?;
        } else {
            log::warn!(
                "send_to: no connection for peer '{}' — message dropped",
                peer_id
            );
        }
        Ok(())
    }

    /// Check if a connection exists for a given peer_id.
    pub async fn has_connection(&self, peer_id: &str) -> bool {
        self.conns.lock().await.contains_key(peer_id)
    }

    /// Broadcast a message to every connected peer.
    pub async fn broadcast(&self, message: &NetworkMessage) -> Result<()> {
        let conns: Vec<PeerConnection> = self.conns.lock().await.values().cloned().collect();
        for conn in conns {
            if let Err(e) = conn.send(message).await {
                eprintln!("Broadcast error to {}: {}", conn.addr, e);
            }
        }
        Ok(())
    }
}
