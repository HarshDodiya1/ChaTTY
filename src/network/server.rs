use std::net::SocketAddr;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::client::{ConnectionPool, PeerConnection};
use super::protocol::NetworkMessage;

#[derive(Debug)]
pub enum NetworkEvent {
    MessageReceived {
        from: SocketAddr,
        message: NetworkMessage,
    },
    ConnectionEstablished {
        peer_addr: SocketAddr,
    },
    ConnectionLost {
        peer_addr: SocketAddr,
    },
}

pub struct TcpServer {
    port: u16,
}

impl TcpServer {
    pub fn new(port: u16) -> Self {
        TcpServer { port }
    }

    /// Bind and start accepting connections. Returns a JoinHandle for the
    /// accept loop, plus the channel through which network events are delivered.
    ///
    /// The `pool` is used to store the write-half of accepted connections so
    /// that replies (e.g. HelloAck) can be sent back on the same TCP stream
    /// instead of requiring a separate outbound connection.
    pub fn start(self, tx: mpsc::Sender<NetworkEvent>, pool: ConnectionPool) -> JoinHandle<()> {
        tokio::spawn(async move {
            let addr = format!("0.0.0.0:{}", self.port);
            let listener = match TcpListener::bind(&addr).await {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("TCP server failed to bind {}: {}", addr, e);
                    return;
                }
            };
            log::info!("TCP server listening on {}", addr);

            loop {
                match listener.accept().await {
                    Ok((stream, peer_addr)) => {
                        let tx2 = tx.clone();
                        let _ = tx2
                            .send(NetworkEvent::ConnectionEstablished { peer_addr })
                            .await;

                        // Split the stream: store the write half in the pool
                        // so replies can go back on this same connection.
                        let (read_half, write_half) = stream.into_split();

                        // Key the inbound connection by address; it will be
                        // re-keyed to the peer's user_id once we receive their
                        // Hello/HelloAck message.
                        let inbound_key = format!("inbound-{}", peer_addr);
                        let peer_conn = PeerConnection::from_write_half(write_half, peer_addr);
                        pool.insert(&inbound_key, peer_conn).await;
                        log::info!("Stored inbound write-half for {} as '{}'", peer_addr, inbound_key);

                        let pool2 = pool.clone();
                        tokio::spawn(async move {
                            handle_connection(read_half, peer_addr, tx2).await;
                            // Clean up inbound pool entry on disconnect
                            let inbound_key = format!("inbound-{}", peer_addr);
                            pool2.remove(&inbound_key).await;
                        });
                    }
                    Err(e) => {
                        eprintln!("Accept error: {}", e);
                    }
                }
            }
        })
    }
}

async fn handle_connection(
    mut read_half: tokio::net::tcp::OwnedReadHalf,
    peer_addr: SocketAddr,
    tx: mpsc::Sender<NetworkEvent>,
) {
    log::info!("Handling incoming connection from {}", peer_addr);
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
                log::debug!("Received message from {}: {:?}", peer_addr, std::mem::discriminant(&message));
                if tx
                    .send(NetworkEvent::MessageReceived { from: peer_addr, message })
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
}
