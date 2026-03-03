use std::net::SocketAddr;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

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
    pub fn start(self, tx: mpsc::Sender<NetworkEvent>) -> JoinHandle<()> {
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

                        tokio::spawn(async move {
                            handle_connection(stream, peer_addr, tx2).await;
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
    mut stream: tokio::net::TcpStream,
    peer_addr: SocketAddr,
    tx: mpsc::Sender<NetworkEvent>,
) {
    loop {
        // Read 4-byte length prefix
        let mut len_buf = [0u8; 4];
        match stream.read_exact(&mut len_buf).await {
            Ok(_) => {}
            Err(_) => break,
        }
        let len = u32::from_be_bytes(len_buf) as usize;

        // Read payload
        let mut payload = vec![0u8; len];
        match stream.read_exact(&mut payload).await {
            Ok(_) => {}
            Err(_) => break,
        }

        match NetworkMessage::deserialize(&payload) {
            Ok(message) => {
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
