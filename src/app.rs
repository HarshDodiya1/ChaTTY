use crate::db::models::{Conversation, Message, User};
use crossterm::event::KeyEvent;
use std::collections::HashMap;

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
}

impl App {
    pub fn new(my_username: String, my_user_id: String, port: u16) -> Self {
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
