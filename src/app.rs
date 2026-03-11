use crate::db::models::{Conversation, Message, User};
use crossterm::event::KeyEvent;
use std::collections::HashMap;
use std::time::Instant;

/// Progress update from file transfer task
#[derive(Debug, Clone)]
pub enum TransferProgress {
    BytesSent { transfer_id: String, bytes: u64 },
    Completed { transfer_id: String },
    Failed { transfer_id: String, error: String },
}

/// Tracks an active file transfer for progress display
#[derive(Debug, Clone)]
pub struct ActiveTransfer {
    pub id: String,
    pub filename: String,
    pub file_size: u64,
    pub bytes_transferred: u64,
    pub is_upload: bool,
    pub peer_name: String,
    pub status: TransferStatus,
    pub started_at: Instant,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TransferStatus {
    Pending,
    InProgress,
    Complete,
    Failed(String),
}

impl ActiveTransfer {
    pub fn progress_percent(&self) -> f64 {
        if self.file_size == 0 {
            return 100.0;
        }
        (self.bytes_transferred as f64 / self.file_size as f64) * 100.0
    }
    
    pub fn speed_mbps(&self) -> f64 {
        let elapsed = self.started_at.elapsed().as_secs_f64();
        if elapsed < 0.001 {
            return 0.0;
        }
        (self.bytes_transferred as f64 / elapsed) / (1024.0 * 1024.0)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum AppState {
    UserList,
    Chat,
    GroupPanel,
    FileTransfer,
}

#[derive(Debug, Clone)]
pub struct Popup {
    pub title: String,
    pub message: String,
    /// Seconds remaining before auto-dismiss (None = stay until user dismisses)
    pub ttl: Option<f64>,
}

pub struct App {
    pub state: AppState,
    pub selected_user_index: usize,
    pub selected_conversation: Option<String>,
    pub input_buffer: String,
    pub input_cursor: usize,
    pub messages: Vec<Message>,
    pub users: Vec<User>,
    pub scroll_offset: usize,
    pub should_quit: bool,
    pub status_message: String,

    /// username for the local user (for display)
    pub my_username: String,
    pub my_user_id: String,
    pub port: u16,

    /// Unread message counts per user_id
    pub unread_counts: HashMap<String, usize>,

    /// Whether all active connections use E2E encryption
    pub encryption_enabled: bool,

    /// Group conversations this user is part of
    pub groups: Vec<Conversation>,

    /// Active popup (if any)
    pub popup: Option<Popup>,

    /// Typing indicator: user_id → is_typing
    pub typing: HashMap<String, bool>,

    /// Search overlay: query string and results
    pub search_query: Option<String>,
    pub search_results: Vec<Message>,

    /// Whether this is the very first run (triggers welcome screen)
    pub first_run: bool,
    
    /// Active file transfers (for progress tracking)
    pub active_transfers: Vec<ActiveTransfer>,
    
    /// Pending file path for /file command (set by command, actioned by main loop)
    pub pending_file_send: Option<String>,
    
    /// Pending incoming file offers: transfer_id -> (filename, file_size, checksum, sender_id, sender_name)
    pub pending_file_offers: HashMap<String, (String, u64, String, String, String)>,
    
    /// Transfers that were accepted and need to start sending chunks: (transfer_id, peer_id)
    pub pending_chunk_sends: Vec<(String, String)>,
    
    /// Data directory for storing downloads etc
    pub data_dir: std::path::PathBuf,
    
    /// Flag to request chat export (handled by main loop)
    pub export_requested: bool,
}

impl App {
    pub fn new(my_username: String, my_user_id: String, port: u16, data_dir: std::path::PathBuf) -> Self {
        App {
            state: AppState::UserList,
            selected_user_index: 0,
            selected_conversation: None,
            input_buffer: String::new(),
            input_cursor: 0,
            messages: Vec::new(),
            users: Vec::new(),
            scroll_offset: 0,
            should_quit: false,
            status_message: String::from("Discovering peers…"),
            my_username,
            my_user_id,
            port,
            unread_counts: HashMap::new(),
            encryption_enabled: false,
            groups: Vec::new(),
            popup: None,
            typing: HashMap::new(),
            search_query: None,
            search_results: Vec::new(),
            first_run: false,
            active_transfers: Vec::new(),
            pending_file_send: None,
            pending_file_offers: HashMap::new(),
            pending_chunk_sends: Vec::new(),
            data_dir,
            export_requested: false,
        }
    }

    pub fn online_count(&self) -> usize {
        self.users.iter().filter(|u| u.status == "online").count()
    }

    /// Dismiss the active popup.
    pub fn dismiss_popup(&mut self) {
        self.popup = None;
    }

    /// Show a timed popup.
    pub fn show_popup(&mut self, title: &str, message: &str, ttl_secs: Option<f64>) {
        self.popup = Some(Popup {
            title: title.to_string(),
            message: message.to_string(),
            ttl: ttl_secs,
        });
    }

    /// Handle a keyboard event — delegates to the input handler.
    pub fn on_key(&mut self, key: KeyEvent) {
        crate::handlers::input::handle_key(self, key);
    }
}
