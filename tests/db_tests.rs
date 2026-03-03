use ChaTTY::db::{
    self, conversations, file_transfers, messages, models::*, schema::init_db, users,
};
use std::path::Path;
use tempfile::NamedTempFile;

fn temp_db() -> (NamedTempFile, rusqlite::Connection) {
    let file = NamedTempFile::new().expect("failed to create temp file");
    let conn = init_db(Path::new(file.path())).expect("failed to init db");
    (file, conn)
}

// ── Users ──────────────────────────────────────────────────────────────────

#[test]
fn test_insert_and_get_user() {
    let (_f, conn) = temp_db();
    let user = User {
        id: "u1".to_string(),
        username: "alice".to_string(),
        display_name: "Alice".to_string(),
        ip_address: Some("192.168.1.10".to_string()),
        port: Some(7878),
        status: "online".to_string(),
        last_seen: None,
        public_key: None,
    };
    users::insert_user(&conn, &user).unwrap();
    let fetched = users::get_user_by_id(&conn, "u1").unwrap().unwrap();
    assert_eq!(fetched.username, "alice");
    assert_eq!(fetched.status, "online");
}

#[test]
fn test_get_user_by_username() {
    let (_f, conn) = temp_db();
    let user = User {
        id: "u2".to_string(),
        username: "bob".to_string(),
        display_name: "Bob".to_string(),
        ip_address: None,
        port: None,
        status: "offline".to_string(),
        last_seen: None,
        public_key: None,
    };
    users::insert_user(&conn, &user).unwrap();
    let fetched = users::get_user_by_username(&conn, "bob").unwrap().unwrap();
    assert_eq!(fetched.id, "u2");
}

#[test]
fn test_get_all_users() {
    let (_f, conn) = temp_db();
    for i in 0..3u32 {
        let user = User {
            id: format!("u{}", i),
            username: format!("user{}", i),
            display_name: format!("User {}", i),
            ip_address: None,
            port: None,
            status: "offline".to_string(),
            last_seen: None,
            public_key: None,
        };
        users::insert_user(&conn, &user).unwrap();
    }
    let all = users::get_all_users(&conn).unwrap();
    assert_eq!(all.len(), 3);
}

#[test]
fn test_update_user_status() {
    let (_f, conn) = temp_db();
    let user = User {
        id: "u3".to_string(),
        username: "carol".to_string(),
        display_name: "Carol".to_string(),
        ip_address: None,
        port: None,
        status: "offline".to_string(),
        last_seen: None,
        public_key: None,
    };
    users::insert_user(&conn, &user).unwrap();
    users::update_user_status(&conn, "u3", "online", "2024-01-01T00:00:00Z").unwrap();
    let fetched = users::get_user_by_id(&conn, "u3").unwrap().unwrap();
    assert_eq!(fetched.status, "online");
}

#[test]
fn test_upsert_user() {
    let (_f, conn) = temp_db();
    let mut user = User {
        id: "u4".to_string(),
        username: "dave".to_string(),
        display_name: "Dave".to_string(),
        ip_address: None,
        port: None,
        status: "offline".to_string(),
        last_seen: None,
        public_key: None,
    };
    users::upsert_user(&conn, &user).unwrap();
    user.display_name = "David".to_string();
    user.status = "online".to_string();
    users::upsert_user(&conn, &user).unwrap();
    let fetched = users::get_user_by_id(&conn, "u4").unwrap().unwrap();
    assert_eq!(fetched.display_name, "David");
    assert_eq!(fetched.status, "online");
}

// ── Conversations & Participants ────────────────────────────────────────────

#[test]
fn test_create_conversation_and_participants() {
    let (_f, conn) = temp_db();

    // Need users to satisfy FK
    for (id, name) in [("u1", "alice"), ("u2", "bob")] {
        users::insert_user(
            &conn,
            &User {
                id: id.to_string(),
                username: name.to_string(),
                display_name: name.to_string(),
                ip_address: None,
                port: None,
                status: "online".to_string(),
                last_seen: None,
                public_key: None,
            },
        )
        .unwrap();
    }

    let conv = Conversation {
        id: "c1".to_string(),
        conv_type: "direct".to_string(),
        name: None,
        created_at: "2024-01-01T00:00:00Z".to_string(),
    };
    conversations::create_conversation(&conn, &conv).unwrap();
    conversations::add_participant(&conn, "c1", "u1").unwrap();
    conversations::add_participant(&conn, "c1", "u2").unwrap();

    let participants = conversations::get_participants(&conn, "c1").unwrap();
    assert_eq!(participants.len(), 2);
}

#[test]
fn test_get_or_create_direct_conversation_idempotent() {
    let (_f, conn) = temp_db();

    for (id, name) in [("u1", "alice"), ("u2", "bob")] {
        users::insert_user(
            &conn,
            &User {
                id: id.to_string(),
                username: name.to_string(),
                display_name: name.to_string(),
                ip_address: None,
                port: None,
                status: "online".to_string(),
                last_seen: None,
                public_key: None,
            },
        )
        .unwrap();
    }

    let c1 = conversations::get_or_create_direct_conversation(&conn, "u1", "u2").unwrap();
    let c2 = conversations::get_or_create_direct_conversation(&conn, "u1", "u2").unwrap();
    assert_eq!(c1.id, c2.id);

    let all = conversations::get_conversations_for_user(&conn, "u1").unwrap();
    assert_eq!(all.len(), 1);
}

// ── Messages ────────────────────────────────────────────────────────────────

#[test]
fn test_insert_and_retrieve_messages() {
    let (_f, conn) = temp_db();

    users::insert_user(
        &conn,
        &User {
            id: "u1".to_string(),
            username: "alice".to_string(),
            display_name: "Alice".to_string(),
            ip_address: None,
            port: None,
            status: "online".to_string(),
            last_seen: None,
            public_key: None,
        },
    )
    .unwrap();

    let conv = Conversation {
        id: "c1".to_string(),
        conv_type: "direct".to_string(),
        name: None,
        created_at: "2024-01-01T00:00:00Z".to_string(),
    };
    conversations::create_conversation(&conn, &conv).unwrap();
    conversations::add_participant(&conn, "c1", "u1").unwrap();

    for i in 0..5u32 {
        messages::insert_message(
            &conn,
            &Message {
                id: format!("m{}", i),
                conversation_id: "c1".to_string(),
                sender_id: "u1".to_string(),
                content: format!("Hello {}", i),
                content_type: "text".to_string(),
                timestamp: format!("2024-01-01T00:00:0{}Z", i),
                delivered: false,
                read: false,
            },
        )
        .unwrap();
    }

    let msgs = messages::get_messages_for_conversation(&conn, "c1", 10, 0).unwrap();
    assert_eq!(msgs.len(), 5);
    assert_eq!(msgs[0].content, "Hello 0");
}

#[test]
fn test_mark_delivered_and_read() {
    let (_f, conn) = temp_db();

    users::insert_user(
        &conn,
        &User {
            id: "u1".to_string(),
            username: "alice".to_string(),
            display_name: "Alice".to_string(),
            ip_address: None,
            port: None,
            status: "online".to_string(),
            last_seen: None,
            public_key: None,
        },
    )
    .unwrap();

    let conv = Conversation {
        id: "c1".to_string(),
        conv_type: "direct".to_string(),
        name: None,
        created_at: "2024-01-01T00:00:00Z".to_string(),
    };
    conversations::create_conversation(&conn, &conv).unwrap();
    conversations::add_participant(&conn, "c1", "u1").unwrap();

    let msg = Message {
        id: "m1".to_string(),
        conversation_id: "c1".to_string(),
        sender_id: "u1".to_string(),
        content: "test".to_string(),
        content_type: "text".to_string(),
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        delivered: false,
        read: false,
    };
    messages::insert_message(&conn, &msg).unwrap();

    messages::mark_message_delivered(&conn, "m1").unwrap();
    messages::mark_messages_read(&conn, "c1", "u1").unwrap();

    let fetched = messages::get_messages_for_conversation(&conn, "c1", 10, 0).unwrap();
    assert!(fetched[0].delivered);
    assert!(fetched[0].read);
}

// ── File Transfers ──────────────────────────────────────────────────────────

#[test]
fn test_file_transfer_crud() {
    let (_f, conn) = temp_db();

    let ft = FileTransfer {
        id: "ft1".to_string(),
        message_id: None,
        filename: "photo.jpg".to_string(),
        file_path: "/tmp/photo.jpg".to_string(),
        file_size: 1024,
        checksum: Some("abc123".to_string()),
        status: "pending".to_string(),
    };
    file_transfers::insert_file_transfer(&conn, &ft).unwrap();

    let pending = file_transfers::get_pending_transfers(&conn).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].filename, "photo.jpg");

    file_transfers::update_transfer_status(&conn, "ft1", "complete").unwrap();
    let pending_after = file_transfers::get_pending_transfers(&conn).unwrap();
    assert!(pending_after.is_empty());
}
