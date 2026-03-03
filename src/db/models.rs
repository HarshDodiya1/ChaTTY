use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub ip_address: Option<String>,
    pub port: Option<i64>,
    pub status: String,
    pub last_seen: Option<String>,
    pub public_key: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub conv_type: String,
    pub name: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationParticipant {
    pub conversation_id: String,
    pub user_id: String,
    pub joined_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub sender_id: String,
    pub content: String,
    pub content_type: String,
    pub timestamp: String,
    pub delivered: bool,
    pub read: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileTransfer {
    pub id: String,
    pub message_id: Option<String>,
    pub filename: String,
    pub file_path: String,
    pub file_size: i64,
    pub checksum: Option<String>,
    pub status: String,
}
