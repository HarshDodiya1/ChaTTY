/// Integration tests for the TCP networking layer.
///
/// These tests spin up real TcpServer instances on loopback addresses and
/// verify that messages sent through PeerConnection are received.
use ChaTTY::network::{ConnectionPool, NetworkEvent, NetworkMessage, TcpServer};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::sync::mpsc;

/// Bind a TcpServer on a random loopback port and return (bound_addr, event_rx).
async fn start_server() -> (SocketAddr, mpsc::Receiver<NetworkEvent>) {
    // Bind to port 0 to let OS pick a free port, then restart on that port.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("failed to bind");
    let addr = listener.local_addr().unwrap();
    drop(listener);

    let (tx, rx) = mpsc::channel(32);
    let server = TcpServer::new(addr.port());
    let pool = ConnectionPool::new();
    server.start(tx, pool);

    // Give the server a moment to start
    tokio::time::sleep(Duration::from_millis(50)).await;
    (addr, rx)
}

#[tokio::test]
async fn test_server_accepts_connection() {
    let (addr, mut rx) = start_server().await;

    // Connect from client side
    let (_conn, _read) = ChaTTY::network::PeerConnection::connect(addr)
        .await
        .expect("connect failed");

    // Should receive ConnectionEstablished
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(ev) = rx.recv().await {
                if let NetworkEvent::ConnectionEstablished { .. } = ev {
                    return;
                }
            }
        }
    })
    .await
    .expect("ConnectionEstablished not received within 2s");
}

#[tokio::test]
async fn test_send_and_receive_message() {
    let (addr, mut rx) = start_server().await;

    let (conn, _read) = ChaTTY::network::PeerConnection::connect(addr)
        .await
        .expect("connect failed");

    let msg = NetworkMessage::ChatMessage {
        id: "m1".into(),
        conversation_id: "c1".into(),
        sender_id: "u1".into(),
        content: "hello from test".into(),
        content_type: "text".into(),
        timestamp: "2024-01-01T00:00:00Z".into(),
    };

    conn.send(&msg).await.expect("send failed");

    // Drain ConnectionEstablished then look for MessageReceived
    let received = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(ev) = rx.recv().await {
                if let NetworkEvent::MessageReceived { message, .. } = ev {
                    return message;
                }
            }
        }
    })
    .await
    .expect("MessageReceived not received within 2s");

    if let NetworkMessage::ChatMessage { content, .. } = received {
        assert_eq!(content, "hello from test");
    } else {
        panic!("wrong message variant received");
    }
}

#[tokio::test]
async fn test_multiple_messages() {
    let (addr, mut rx) = start_server().await;
    let (conn, _read) = ChaTTY::network::PeerConnection::connect(addr)
        .await
        .unwrap();

    for i in 0u32..5 {
        conn.send(&NetworkMessage::ChatMessage {
            id: format!("m{}", i),
            conversation_id: "c1".into(),
            sender_id: "u1".into(),
            content: format!("msg {}", i),
            content_type: "text".into(),
            timestamp: "2024-01-01T00:00:00Z".into(),
        })
        .await
        .unwrap();
    }

    let mut count = 0usize;
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(ev) = rx.recv().await {
                if matches!(ev, NetworkEvent::MessageReceived { .. }) {
                    count += 1;
                    if count == 5 {
                        return;
                    }
                }
            }
        }
    })
    .await
    .expect("did not receive all 5 messages");

    assert_eq!(count, 5);
}

#[tokio::test]
async fn test_ping_pong_roundtrip() {
    let (addr, mut rx) = start_server().await;
    let (conn, _read) = ChaTTY::network::PeerConnection::connect(addr).await.unwrap();

    conn.send(&NetworkMessage::Ping).await.unwrap();

    let received = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(ev) = rx.recv().await {
                if let NetworkEvent::MessageReceived { message, .. } = ev {
                    return message;
                }
            }
        }
    })
    .await
    .expect("Ping not received");

    assert!(matches!(received, NetworkMessage::Ping));
}

#[tokio::test]
async fn test_connection_pool_broadcast() {
    // Start two servers and broadcast to both
    let (addr1, mut rx1) = start_server().await;
    let (addr2, mut rx2) = start_server().await;

    let pool = ChaTTY::network::ConnectionPool::new();
    pool.get_or_connect("peer1", addr1).await.unwrap();
    pool.get_or_connect("peer2", addr2).await.unwrap();

    pool.broadcast(&NetworkMessage::Ping).await.unwrap();

    // Check rx1
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(ev) = rx1.recv().await {
                if let NetworkEvent::MessageReceived { message, .. } = ev {
                    if matches!(message, NetworkMessage::Ping) {
                        return;
                    }
                }
            }
        }
    })
    .await
    .expect("Ping not received on server 1");

    // Check rx2
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(ev) = rx2.recv().await {
                if let NetworkEvent::MessageReceived { message, .. } = ev {
                    if matches!(message, NetworkMessage::Ping) {
                        return;
                    }
                }
            }
        }
    })
    .await
    .expect("Ping not received on server 2");
}
