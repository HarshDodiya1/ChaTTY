use ChaTTY::network::protocol::NetworkMessage;
use std::io::Cursor;

fn round_trip(msg: &NetworkMessage) -> NetworkMessage {
    let bytes = msg.serialize().expect("serialize failed");
    NetworkMessage::deserialize(&bytes).expect("deserialize failed")
}

fn frame_round_trip(msg: &NetworkMessage) -> NetworkMessage {
    let frame = msg.to_frame().expect("to_frame failed");
    let mut cursor = Cursor::new(frame);
    NetworkMessage::from_frame(&mut cursor).expect("from_frame failed")
}

// ── Serialize / Deserialize each variant ────────────────────────────────────

#[test]
fn test_hello() {
    let msg = NetworkMessage::Hello {
        user_id: "u1".into(),
        username: "alice".into(),
        display_name: "Alice".into(),
        port: 7878,
        public_key: vec![1, 2, 3],
    };
    if let NetworkMessage::Hello { username, port, .. } = round_trip(&msg) {
        assert_eq!(username, "alice");
        assert_eq!(port, 7878);
    } else {
        panic!("wrong variant");
    }
}

#[test]
fn test_hello_ack() {
    let msg = NetworkMessage::HelloAck {
        user_id: "u2".into(),
        username: "bob".into(),
        display_name: "Bob".into(),
        port: 7878,
        public_key: vec![4, 5, 6],
    };
    if let NetworkMessage::HelloAck { username, .. } = round_trip(&msg) {
        assert_eq!(username, "bob");
    } else {
        panic!("wrong variant");
    }
}

#[test]
fn test_status_update() {
    let msg = NetworkMessage::StatusUpdate {
        user_id: "u1".into(),
        status: "away".into(),
    };
    if let NetworkMessage::StatusUpdate { status, .. } = round_trip(&msg) {
        assert_eq!(status, "away");
    } else {
        panic!("wrong variant");
    }
}

#[test]
fn test_ping_pong() {
    let ping = round_trip(&NetworkMessage::Ping);
    assert!(matches!(ping, NetworkMessage::Ping));
    let pong = round_trip(&NetworkMessage::Pong);
    assert!(matches!(pong, NetworkMessage::Pong));
}

#[test]
fn test_chat_message() {
    let msg = NetworkMessage::ChatMessage {
        id: "m1".into(),
        conversation_id: "c1".into(),
        sender_id: "u1".into(),
        content: "Hello, world!".into(),
        content_type: "text".into(),
        timestamp: "2024-01-01T00:00:00Z".into(),
    };
    if let NetworkMessage::ChatMessage { content, .. } = round_trip(&msg) {
        assert_eq!(content, "Hello, world!");
    } else {
        panic!("wrong variant");
    }
}

#[test]
fn test_message_delivered() {
    let msg = NetworkMessage::MessageDelivered {
        message_id: "m1".into(),
    };
    if let NetworkMessage::MessageDelivered { message_id } = round_trip(&msg) {
        assert_eq!(message_id, "m1");
    } else {
        panic!("wrong variant");
    }
}

#[test]
fn test_message_read() {
    let msg = NetworkMessage::MessageRead {
        conversation_id: "c1".into(),
        reader_id: "u2".into(),
    };
    if let NetworkMessage::MessageRead { reader_id, .. } = round_trip(&msg) {
        assert_eq!(reader_id, "u2");
    } else {
        panic!("wrong variant");
    }
}

#[test]
fn test_typing_indicator() {
    let msg = NetworkMessage::TypingIndicator {
        user_id: "u1".into(),
        conversation_id: "c1".into(),
        is_typing: true,
    };
    if let NetworkMessage::TypingIndicator { is_typing, .. } = round_trip(&msg) {
        assert!(is_typing);
    } else {
        panic!("wrong variant");
    }
}

#[test]
fn test_group_create() {
    let msg = NetworkMessage::GroupCreate {
        conversation_id: "c1".into(),
        name: "Devs".into(),
        creator_id: "u1".into(),
        member_ids: vec!["u2".into(), "u3".into()],
    };
    if let NetworkMessage::GroupCreate { name, member_ids, .. } = round_trip(&msg) {
        assert_eq!(name, "Devs");
        assert_eq!(member_ids.len(), 2);
    } else {
        panic!("wrong variant");
    }
}

#[test]
fn test_group_invite() {
    let msg = NetworkMessage::GroupInvite {
        conversation_id: "c1".into(),
        inviter_id: "u1".into(),
        invitee_id: "u2".into(),
    };
    if let NetworkMessage::GroupInvite { invitee_id, .. } = round_trip(&msg) {
        assert_eq!(invitee_id, "u2");
    } else {
        panic!("wrong variant");
    }
}

#[test]
fn test_file_offer() {
    let msg = NetworkMessage::FileOffer {
        transfer_id: "t1".into(),
        message_id: "m1".into(),
        filename: "photo.jpg".into(),
        file_size: 1_048_576,
        checksum: "deadbeef".into(),
    };
    if let NetworkMessage::FileOffer { file_size, filename, .. } = round_trip(&msg) {
        assert_eq!(filename, "photo.jpg");
        assert_eq!(file_size, 1_048_576);
    } else {
        panic!("wrong variant");
    }
}

#[test]
fn test_file_accept_reject() {
    let accept = round_trip(&NetworkMessage::FileAccept { transfer_id: "t1".into() });
    assert!(matches!(accept, NetworkMessage::FileAccept { .. }));

    let reject = round_trip(&NetworkMessage::FileReject { transfer_id: "t1".into() });
    assert!(matches!(reject, NetworkMessage::FileReject { .. }));
}

#[test]
fn test_file_chunk_large() {
    let data = vec![0xABu8; 65536]; // 64 KiB chunk
    let msg = NetworkMessage::FileChunk {
        transfer_id: "t1".into(),
        chunk_index: 42,
        data: data.clone(),
        is_last: false,
    };
    if let NetworkMessage::FileChunk { chunk_index, data: d, is_last, .. } = round_trip(&msg) {
        assert_eq!(chunk_index, 42);
        assert_eq!(d, data);
        assert!(!is_last);
    } else {
        panic!("wrong variant");
    }
}

#[test]
fn test_sync_request_response() {
    let req = round_trip(&NetworkMessage::SyncRequest {
        last_seen_timestamp: "2024-01-01T00:00:00Z".into(),
    });
    assert!(matches!(req, NetworkMessage::SyncRequest { .. }));

    let inner = NetworkMessage::ChatMessage {
        id: "m1".into(),
        conversation_id: "c1".into(),
        sender_id: "u1".into(),
        content: "hi".into(),
        content_type: "text".into(),
        timestamp: "2024-01-01T00:00:00Z".into(),
    };
    let resp = round_trip(&NetworkMessage::SyncResponse {
        messages: vec![inner],
    });
    if let NetworkMessage::SyncResponse { messages } = resp {
        assert_eq!(messages.len(), 1);
    } else {
        panic!("wrong variant");
    }
}

#[test]
fn test_goodbye() {
    let msg = NetworkMessage::Goodbye { user_id: "u1".into() };
    if let NetworkMessage::Goodbye { user_id } = round_trip(&msg) {
        assert_eq!(user_id, "u1");
    } else {
        panic!("wrong variant");
    }
}

// ── Frame encoding / decoding ────────────────────────────────────────────────

#[test]
fn test_frame_encode_decode() {
    let msg = NetworkMessage::ChatMessage {
        id: "m1".into(),
        conversation_id: "c1".into(),
        sender_id: "u1".into(),
        content: "frame test".into(),
        content_type: "text".into(),
        timestamp: "2024-01-01T00:00:00Z".into(),
    };
    if let NetworkMessage::ChatMessage { content, .. } = frame_round_trip(&msg) {
        assert_eq!(content, "frame test");
    } else {
        panic!("wrong variant");
    }
}

#[test]
fn test_frame_length_prefix() {
    let msg = NetworkMessage::Ping;
    let frame = msg.to_frame().unwrap();
    // First 4 bytes are big-endian payload length
    let len = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    assert_eq!(frame.len(), 4 + len);
}

#[test]
fn test_frame_multiple_messages() {
    let messages = vec![
        NetworkMessage::Ping,
        NetworkMessage::StatusUpdate { user_id: "u1".into(), status: "online".into() },
        NetworkMessage::Goodbye { user_id: "u1".into() },
    ];

    let mut buf: Vec<u8> = Vec::new();
    for m in &messages {
        buf.extend(m.to_frame().unwrap());
    }

    let mut cursor = Cursor::new(buf);
    for _ in 0..messages.len() {
        NetworkMessage::from_frame(&mut cursor).expect("failed to read frame");
    }
}

#[test]
fn test_frame_large_payload() {
    let data = vec![0xCCu8; 128 * 1024]; // 128 KiB
    let msg = NetworkMessage::FileChunk {
        transfer_id: "t1".into(),
        chunk_index: 0,
        data,
        is_last: true,
    };
    let decoded = frame_round_trip(&msg);
    if let NetworkMessage::FileChunk { is_last, .. } = decoded {
        assert!(is_last);
    } else {
        panic!("wrong variant");
    }
}
