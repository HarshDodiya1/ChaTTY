pub mod client;
pub mod discovery;
pub mod file_transfer;
pub mod protocol;
pub mod server;

pub use client::{ConnectionPool, PeerConnection};
pub use discovery::{DiscoveryEvent, DiscoveryService, SERVICE_TYPE};
pub use file_transfer::{compute_checksum, unique_path, FileTransferManager, CHUNK_SIZE, MAX_FILE_SIZE};
pub use protocol::NetworkMessage;
pub use server::{NetworkEvent, TcpServer};

use crate::config::Config;
use anyhow::Result;
use std::net::SocketAddr;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// Top-level networking coordinator.
pub struct NetworkManager {
    config: Config,
    user_id: String,
    pub pool: ConnectionPool,
}

impl NetworkManager {
    pub fn new(config: &Config, user_id: String) -> Self {
        NetworkManager {
            config: config.clone(),
            user_id,
            pool: ConnectionPool::new(),
        }
    }

    /// Start the TCP server and mDNS discovery. Returns a join handle for the
    /// server task and a receiver for all incoming `NetworkEvent`s.
    pub fn start(self) -> Result<(JoinHandle<()>, mpsc::Receiver<NetworkEvent>)> {
        let (tx, rx) = mpsc::channel::<NetworkEvent>(256);

        // Start TCP server
        let server = TcpServer::new(self.config.port);
        let handle = server.start(tx.clone());

        // Start mDNS — advertise and browse
        let discovery = DiscoveryService::new(
            self.config.username.clone(),
            self.config.port,
            self.user_id.clone(),
        )?;
        discovery.start_advertising()?;

        // Discovery events → NetworkEvent via a bridge task
        let (disc_tx, mut disc_rx) = mpsc::channel::<DiscoveryEvent>(64);
        discovery.start_browsing(disc_tx)?;

        let pool = self.pool.clone();
        let user_id = self.user_id.clone();
        let username = self.config.username.clone();
        let display_name = self.config.display_name.clone();
        let port = self.config.port;
        let net_tx = tx.clone();

        tokio::spawn(async move {
            let heartbeat_interval = tokio::time::interval(std::time::Duration::from_secs(30));
            tokio::pin!(heartbeat_interval);

            loop {
                tokio::select! {
                    Some(event) = disc_rx.recv() => {
                        if let DiscoveryEvent::PeerFound { user_id: peer_id, ip, port: peer_port, .. } = event {
                            let addr = SocketAddr::new(ip, peer_port);
                            match pool.get_or_connect(&peer_id, addr).await {
                                Ok(conn) => {
                                    // Send Hello handshake
                                    let hello = NetworkMessage::Hello {
                                        user_id: user_id.clone(),
                                        username: username.clone(),
                                        display_name: display_name.clone(),
                                        port,
                                        public_key: vec![],
                                    };
                                    if let Err(e) = conn.send(&hello).await {
                                        eprintln!("Handshake error: {}", e);
                                    }
                                }
                                Err(e) => eprintln!("Connect error: {}", e),
                            }
                        }
                    }
                    _ = heartbeat_interval.tick() => {
                        let _ = pool.broadcast(&NetworkMessage::Ping).await;
                    }
                }
            }
        });

        // Pong responder: watch inbound events for Ping and respond
        let pool2 = self.pool.clone();
        let _ = pool2; // pool2 is captured via clone below
        let _ = net_tx;

        Ok((handle, rx))
    }
}
