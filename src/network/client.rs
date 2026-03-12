use anyhow::{Context, Result};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};
use tokio::time::timeout;

use super::protocol::NetworkMessage;
use super::server::NetworkEvent;

/// An active TCP connection to a single peer.
#[derive(Clone)]
pub struct PeerConnection {
    // tokio::sync::Mutex is hold-across-await safe
    writer: Arc<Mutex<Option<tokio::net::tcp::OwnedWriteHalf>>>,
    pub addr: SocketAddr,
}

impl PeerConnection {
    /// Connect to `addr` with a 5-second timeout.
    /// Returns the PeerConnection (write-half) and the read-half so the caller
    /// can spawn a reader task.
    pub async fn connect(addr: SocketAddr) -> Result<(Self, tokio::net::tcp::OwnedReadHalf)> {
        log::debug!("Connecting to {}...", addr);
        let stream = timeout(Duration::from_secs(5), TcpStream::connect(addr))
            .await
            .with_context(|| format!("Connection to {} timed out", addr))?
            .with_context(|| format!("Failed to connect to {}", addr))?;

        let (read, write) = stream.into_split();

        Ok((
            PeerConnection {
                writer: Arc::new(Mutex::new(Some(write))),
                addr,
            },
            read,
        ))
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

/// Spawn a reader task that reads framed messages from a TCP read-half and
/// forwards them as `NetworkEvent::MessageReceived` to the event channel.
/// This is used for BOTH inbound (server-accepted) and outbound connections.
pub fn spawn_reader(
    mut read_half: tokio::net::tcp::OwnedReadHalf,
    peer_addr: SocketAddr,
    tx: mpsc::Sender<NetworkEvent>,
) {
    tokio::spawn(async move {
        loop {
            // Read 4-byte length prefix
            let mut len_buf = [0u8; 4];
            match read_half.read_exact(&mut len_buf).await {
                Ok(_) => {}
                Err(_) => break,
            }
            let len = u32::from_be_bytes(len_buf) as usize;

            // Read payload
            let mut payload = vec![0u8; len];
            match read_half.read_exact(&mut payload).await {
                Ok(_) => {}
                Err(_) => break,
            }

            match NetworkMessage::deserialize(&payload) {
                Ok(message) => {
                    log::debug!(
                        "Received message from {}: {:?}",
                        peer_addr,
                        std::mem::discriminant(&message)
                    );
                    if tx
                        .send(NetworkEvent::MessageReceived {
                            from: peer_addr,
                            message,
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(e) => {
                    eprintln!("Deserialize error from {}: {}", peer_addr, e);
                }
            }
        }

        let _ = tx.send(NetworkEvent::ConnectionLost { peer_addr }).await;
    });
}

/// A thread-safe pool of active peer connections.
#[derive(Clone)]
pub struct ConnectionPool {
    conns: Arc<Mutex<HashMap<String, PeerConnection>>>,
    /// Event sender for spawning reader tasks on new outbound connections.
    event_tx: Arc<Mutex<Option<mpsc::Sender<NetworkEvent>>>>,
}

impl Default for ConnectionPool {
    fn default() -> Self {
        ConnectionPool {
            conns: Arc::new(Mutex::new(HashMap::new())),
            event_tx: Arc::new(Mutex::new(None)),
        }
    }
}

impl ConnectionPool {
    pub fn new() -> Self {
        ConnectionPool::default()
    }

    /// Set the event sender so outbound connections can spawn reader tasks.
    /// Must be called after the event channel is created.
    pub async fn set_event_sender(&self, tx: mpsc::Sender<NetworkEvent>) {
        *self.event_tx.lock().await = Some(tx);
    }

    /// Return existing connection or connect fresh.
    /// If an event sender has been set, spawns a reader task for new
    /// outbound connections so that replies can be received.
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

        let (conn, read_half) = PeerConnection::connect(addr).await?;

        // Spawn a reader task so we can receive replies on this connection
        if let Some(tx) = self.event_tx.lock().await.clone() {
            log::info!("Spawning reader for outbound connection to {}", addr);
            spawn_reader(read_half, addr, tx);
        } else {
            log::warn!("No event sender set — outbound connection to {} will be write-only", addr);
        }

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
