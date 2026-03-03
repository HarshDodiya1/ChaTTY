mod app;
mod config;
mod db;
mod handlers;
mod network;
mod ui;
mod utils;

use anyhow::Result;
use app::AppState;
use chrono::Utc;
use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use db::Database;
use ratatui::{backend::CrosstermBackend, Terminal};
use std::{
    io,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::mpsc;
use uuid::Uuid;

/// How long after the last keystroke before sending TypingIndicator { is_typing: false }.
const TYPING_STOP_DELAY: Duration = Duration::from_secs(3);

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::init();

    // ── CLI args ──────────────────────────────────────────────────────────
    let args: Vec<String> = std::env::args().collect();
    let mut name_override: Option<String> = None;
    let mut port_override: Option<u16> = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--help" | "-h" => {
                println!(
                    "ChaTTY v{} — P2P LAN terminal chat\n\n\
                     USAGE:\n\
                     \tChaTTY [OPTIONS]\n\n\
                     OPTIONS:\n\
                     \t--name <username>   Override display name\n\
                     \t--port <port>       Override listen port (default: 7878)\n\
                     \t--help, -h          Show this help\n\n\
                     DATA:\n\
                     \tConfig:  ~/.ChaTTY/config.toml\n\
                     \tDB:      ~/.ChaTTY/chatapp.db\n\
                     \tLogs:    RUST_LOG=debug ChaTTY",
                    env!("CARGO_PKG_VERSION")
                );
                return Ok(());
            }
            "--name" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    name_override = Some(val.clone());
                }
            }
            "--port" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    port_override = Some(
                        val.parse::<u16>()
                            .expect("--port must be a valid port number"),
                    );
                }
            }
            _ => {}
        }
        i += 1;
    }

    // ── Config ────────────────────────────────────────────────────────────
    let mut config = config::load_or_create()?;
    if let Some(name) = name_override {
        config.username = name.clone();
        config.display_name = name;
        config::save(&config)?;
    }
    if let Some(port) = port_override {
        config.port = port;
        config::save(&config)?;
    }

    // ── Database ──────────────────────────────────────────────────────────
    let database = Arc::new(Database::open(&config.db_path)?);
    let user_id = {
        let conn = database.lock();
        if let Some(existing) = db::get_user_by_username(&conn, &config.username)? {
            // Update status to online
            let _ = db::update_user_status(&conn, &existing.id, "online", &Utc::now().to_rfc3339());
            existing.id
        } else {
            let id = Uuid::new_v4().to_string();
            db::insert_user(
                &conn,
                &db::User {
                    id: id.clone(),
                    username: config.username.clone(),
                    display_name: config.display_name.clone(),
                    ip_address: None,
                    port: Some(config.port as i64),
                    status: "online".to_string(),
                    last_seen: Some(Utc::now().to_rfc3339()),
                    public_key: None,
                },
            )?;
            id
        }
    };

    // First-run detection: config.toml existed before this session?
    let is_first_run = !config.db_path.with_file_name("config.toml").exists()
        || std::env::var("CHATTY_FIRST_RUN").is_ok();

    // ── App state ─────────────────────────────────────────────────────────
    let mut app_state = app::App::new(
        config.display_name.clone(),
        user_id.clone(),
        config.port,
    );
    app_state.first_run = is_first_run;

    // ── Network ───────────────────────────────────────────────────────────
    let net_manager = network::NetworkManager::new(&config, user_id.clone());
    let pool = net_manager.pool.clone();
    let (_server_handle, mut net_rx) = net_manager.start()?;

    // ── Terminal setup ────────────────────────────────────────────────────
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    // Crossterm event thread → tokio channel
    let (term_tx, mut term_rx) = mpsc::channel::<Event>(64);
    std::thread::spawn(move || loop {
        if event::poll(Duration::from_millis(50)).unwrap_or(false) {
            if let Ok(ev) = event::read() {
                if term_tx.blocking_send(ev).is_err() {
                    break;
                }
            }
        }
    });

    // ── Typing indicator state ────────────────────────────────────────────
    let mut last_typed_at: Option<Instant> = None;
    let mut typing_sent = false; // true while we've sent is_typing=true

    // ── Event loop ────────────────────────────────────────────────────────
    let tick_rate = Duration::from_millis(250);
    let mut last_tick = Instant::now();

    loop {
        // Draw
        terminal.draw(|f| ui::draw(f, &app_state))?;

        let timeout = tick_rate
            .checked_sub(last_tick.elapsed())
            .unwrap_or(Duration::ZERO);

        tokio::select! {
            Some(ev) = term_rx.recv() => {
                if let Event::Key(key) = ev {
                    // Typing indicator: any char key in Chat state
                    if app_state.state == AppState::Chat
                        && matches!(key.code, KeyCode::Char(_))
                    {
                        if !typing_sent {
                            // Send TypingIndicator { is_typing: true }
                            if let Some(peer) = app_state.users.get(app_state.selected_user_index) {
                                let peer_id = peer.id.clone();
                                let conv_id = app_state.selected_conversation.clone().unwrap_or_default();
                                let msg = network::NetworkMessage::TypingIndicator {
                                    user_id: app_state.my_user_id.clone(),
                                    conversation_id: conv_id,
                                    is_typing: true,
                                };
                                pool.send_to(&peer_id, &msg).await.ok();
                                typing_sent = true;
                            }
                        }
                        last_typed_at = Some(Instant::now());
                    }

                    // Capture Enter in Chat state before passing to app
                    if app_state.state == AppState::Chat
                        && key.code == KeyCode::Enter
                        && !app_state.input_buffer.is_empty()
                    {
                        let raw = app_state.input_buffer.clone();
                        app_state.input_buffer.clear();
                        app_state.input_cursor = 0;
                        typing_sent = false;
                        last_typed_at = None;

                        if raw.starts_with('/') {
                            handlers::commands::handle_command(&mut app_state, &raw);
                            // Run search if command set search_query
                            if let Some(query) = app_state.search_query.clone() {
                                run_search(&mut app_state, &database, &query);
                            }
                        } else {
                            send_message(&mut app_state, &database, &pool, raw).await?;
                        }
                    } else {
                        let was_user_list = app_state.state == AppState::UserList;
                        app_state.on_key(key);

                        // After Enter on UserList → load conversation
                        if was_user_list && app_state.state == AppState::Chat {
                            load_conversation(&mut app_state, &database, &user_id)?;
                        }
                    }
                }
            }

            Some(event) = net_rx.recv() => {
                let from = match &event {
                    network::NetworkEvent::MessageReceived { from, .. } => Some(*from),
                    network::NetworkEvent::ConnectionEstablished { peer_addr } => Some(*peer_addr),
                    network::NetworkEvent::ConnectionLost { peer_addr } => Some(*peer_addr),
                };
                handlers::network_events::handle_network_event(
                    &mut app_state, &database, &pool, from, event
                ).await;
            }

            _ = tokio::time::sleep(timeout) => {
                last_tick = Instant::now();

                // Update terminal title with unread count
                let total_unread: usize = app_state.unread_counts.values().sum();
                let title = if total_unread > 0 {
                    format!("ChaTTY ({} unread)", total_unread)
                } else {
                    "ChaTTY".to_string()
                };
                let _ = execute!(io::stdout(), crossterm::terminal::SetTitle(&title));

                // Stop typing indicator after delay
                if typing_sent {
                    if let Some(t) = last_typed_at {
                        if t.elapsed() >= TYPING_STOP_DELAY {
                            if let Some(peer) = app_state.users.get(app_state.selected_user_index) {
                                let peer_id = peer.id.clone();
                                let conv_id = app_state.selected_conversation.clone().unwrap_or_default();
                                let msg = network::NetworkMessage::TypingIndicator {
                                    user_id: app_state.my_user_id.clone(),
                                    conversation_id: conv_id,
                                    is_typing: false,
                                };
                                pool.send_to(&peer_id, &msg).await.ok();
                            }
                            typing_sent = false;
                            last_typed_at = None;
                        }
                    }
                }
            }
        }

        if app_state.should_quit {
            break;
        }
    }

    // ── Shutdown ──────────────────────────────────────────────────────────
    // Mark self offline
    {
        let conn = database.lock();
        let _ = db::update_user_status(&conn, &user_id, "offline", &Utc::now().to_rfc3339());
    }

    let _ = pool
        .broadcast(&network::NetworkMessage::Goodbye {
            user_id: user_id.clone(),
        })
        .await;

    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture
    )?;
    terminal.show_cursor()?;
    println!("Goodbye!");

    Ok(())
}

/// Run a full-text search in the current conversation and store results in app.
fn run_search(app: &mut app::App, database: &Arc<Database>, query: &str) {
    let conv_id = match &app.selected_conversation {
        Some(id) => id.clone(),
        None => {
            app.show_popup("Search", "Open a conversation first.", Some(3.0));
            app.search_query = None;
            return;
        }
    };
    let conn = database.lock();
    match db::search_messages(&conn, &conv_id, query, 50) {
        Ok(results) => {
            let count = results.len();
            app.search_results = results;
            if count == 0 {
                app.show_popup("Search", &format!("No results for '{}'", query), Some(3.0));
                app.search_query = None;
            }
        }
        Err(e) => {
            app.show_popup("Search Error", &e.to_string(), Some(3.0));
            app.search_query = None;
        }
    }
}

/// Load or create a direct conversation for the selected user, populating
/// `app_state.messages` from the database.
fn load_conversation(
    app: &mut app::App,
    database: &Arc<Database>,
    my_user_id: &str,
) -> Result<()> {
    let peer = match app.users.get(app.selected_user_index) {
        Some(u) => u.clone(),
        None => return Ok(()),
    };

    let conn = database.lock();
    let conv = db::get_or_create_direct_conversation(&conn, my_user_id, &peer.id)?;
    app.selected_conversation = Some(conv.id.clone());

    let msgs = db::get_messages_for_conversation(&conn, &conv.id, 50, 0)?;
    app.messages = msgs;
    app.scroll_offset = 0;
    app.unread_counts.remove(&peer.id);

    // Send MessageRead to peer
    drop(conn);

    Ok(())
}

/// Build, store, and send a chat message.
async fn send_message(
    app: &mut app::App,
    database: &Arc<Database>,
    pool: &network::ConnectionPool,
    content: String,
) -> Result<()> {
    let Some(conv_id) = app.selected_conversation.clone() else {
        return Ok(());
    };
    let peer = match app.users.get(app.selected_user_index) {
        Some(u) => u.clone(),
        None => return Ok(()),
    };

    let msg_id = Uuid::new_v4().to_string();
    let timestamp = Utc::now().to_rfc3339();

    let msg = db::Message {
        id: msg_id.clone(),
        conversation_id: conv_id.clone(),
        sender_id: app.my_user_id.clone(),
        content: content.clone(),
        content_type: "text".to_string(),
        timestamp: timestamp.clone(),
        delivered: false,
        read: false,
    };

    {
        let conn = database.lock();
        db::insert_message(&conn, &msg)?;
    }

    app.messages.push(msg);

    let net_msg = network::NetworkMessage::ChatMessage {
        id: msg_id,
        conversation_id: conv_id,
        sender_id: app.my_user_id.clone(),
        content,
        content_type: "text".to_string(),
        timestamp,
    };

    // Best-effort send; if peer is offline, message stays in DB for retry
    pool.send_to(&peer.id, &net_msg).await.ok();

    Ok(())
}
