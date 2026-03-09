pub mod conversations;
pub mod file_transfers;
pub mod messages;
pub mod models;
pub mod schema;
pub mod users;

pub use conversations::{
    add_participant, create_conversation, get_conversation_by_id,
    get_conversations_for_user, get_or_create_direct_conversation,
    get_participants,
};
pub use file_transfers::{get_pending_transfers, insert_file_transfer, update_transfer_status};
pub use messages::{
    get_messages_for_conversation, get_undelivered_messages, insert_message,
    mark_message_delivered, mark_messages_read, search_messages,
};
pub use models::*;
pub use schema::init_db;
pub use users::*;

use anyhow::Result;
use rusqlite::Connection;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = init_db(path)?;
        Ok(Database {
            conn: Mutex::new(conn),
        })
    }

    pub fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().expect("Database mutex poisoned")
    }
}
