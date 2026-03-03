use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NetworkMessage {
    // Discovery & handshake
    Hello {
        user_id: String,
        username: String,
        display_name: String,
        port: u16,
        public_key: Vec<u8>,
    },
    HelloAck {
        user_id: String,
        username: String,
        display_name: String,
        port: u16,
        public_key: Vec<u8>,
    },

    // Presence
    StatusUpdate {
        user_id: String,
        status: String,
    },
    Ping,
    Pong,

    // Messaging
    ChatMessage {
        id: String,
        conversation_id: String,
        sender_id: String,
        content: String,
        content_type: String,
        timestamp: String,
    },
    MessageDelivered {
        message_id: String,
    },
    MessageRead {
        conversation_id: String,
        reader_id: String,
    },
    TypingIndicator {
        user_id: String,
        conversation_id: String,
        is_typing: bool,
    },

    // Group management
    GroupCreate {
        conversation_id: String,
        name: String,
        creator_id: String,
        member_ids: Vec<String>,
    },
    GroupInvite {
        conversation_id: String,
        inviter_id: String,
        invitee_id: String,
    },

    // File transfer
    FileOffer {
        transfer_id: String,
        message_id: String,
        filename: String,
        file_size: u64,
        checksum: String,
    },
    FileAccept {
        transfer_id: String,
    },
    FileReject {
        transfer_id: String,
    },
    FileChunk {
        transfer_id: String,
        chunk_index: u32,
        data: Vec<u8>,
        is_last: bool,
    },

    // Sync
    SyncRequest {
        last_seen_timestamp: String,
    },
    SyncResponse {
        messages: Vec<NetworkMessage>,
    },

    // Disconnect
    Goodbye {
        user_id: String,
    },

    // Encryption wrapper — used for all messages except Hello/HelloAck/Ping/Pong
    EncryptedMessage {
        sender_id: String,
        encrypted_data: Vec<u8>,
    },
}

impl NetworkMessage {
    /// Serialize to bytes using bincode.
    pub fn serialize(&self) -> Result<Vec<u8>> {
        bincode::serialize(self).with_context(|| "Failed to serialize NetworkMessage")
    }

    /// Deserialize from bytes using bincode.
    pub fn deserialize(bytes: &[u8]) -> Result<NetworkMessage> {
        bincode::deserialize(bytes).with_context(|| "Failed to deserialize NetworkMessage")
    }

    /// Encode as a length-prefixed frame: [4-byte big-endian length][payload].
    pub fn to_frame(&self) -> Result<Vec<u8>> {
        let payload = self.serialize()?;
        let len = payload.len() as u32;
        let mut frame = Vec::with_capacity(4 + payload.len());
        frame.extend_from_slice(&len.to_be_bytes());
        frame.extend_from_slice(&payload);
        Ok(frame)
    }

    /// Read a length-prefixed frame from a `Read` source and decode it.
    pub fn from_frame<R: Read>(reader: &mut R) -> Result<NetworkMessage> {
        let mut len_buf = [0u8; 4];
        reader
            .read_exact(&mut len_buf)
            .with_context(|| "Failed to read frame length")?;
        let len = u32::from_be_bytes(len_buf) as usize;

        let mut payload = vec![0u8; len];
        reader
            .read_exact(&mut payload)
            .with_context(|| "Failed to read frame payload")?;

        Self::deserialize(&payload)
    }

    /// Write a length-prefixed frame to a `Write` sink.
    pub fn write_frame<W: Write>(&self, writer: &mut W) -> Result<()> {
        let frame = self.to_frame()?;
        writer
            .write_all(&frame)
            .with_context(|| "Failed to write frame")?;
        Ok(())
    }
}
