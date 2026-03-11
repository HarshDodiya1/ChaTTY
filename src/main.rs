#![allow(dead_code, unused_imports)]

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
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind},
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
    // ── CLI args ──────────────────────────────────────────────────────────
    let args: Vec<String> = std::env::args().collect();
    let mut name_override: Option<String> = None;
    let mut port_override: Option<u16> = None;
    let mut data_dir_override: Option<String> = None;
    let mut manual_peers: Vec<String> = Vec::new();

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
                     \t--data-dir <path>   Override data directory (default: ~/.ChaTTY/)\n\
                     \t--peer <host:port>  Connect to a peer directly (repeatable)\n\
                     \t--help, -h          Show this help\n\n\
                     DATA:\n\
                     \tConfig:  ~/.ChaTTY/config.toml\n\
                     \tDB:      ~/.ChaTTY/chatapp.db\n\
                     \tLogs:    ~/.ChaTTY/chatty.log\n\n\
                     EXAMPLES:\n\
                     \tChaTTY --name alice\n\
                     \tChaTTY --name bob --port 7879 --peer 192.168.1.10:7878",
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
            "--data-dir" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    data_dir_override = Some(val.clone());
                }
            }
            "--peer" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    manual_peers.push(val.clone());
                }
            }
            _ => {}
        }
        i += 1;
    }

    // ── Config ────────────────────────────────────────────────────────────
    let mut config = if let Some(ref dir) = data_dir_override {
        let data_dir = std::path::PathBuf::from(dir);
        config::load_or_create_in(&data_dir)?
    } else {
        config::load_or_create()?
    };
    if let Some(name) = name_override {
        config.username = name.clone();
        config.display_name = name;
        config::save(&config)?;
    }
    if let Some(port) = port_override {
        config.port = port;
        config::save(&config)?;
    }

    // ── File-based logging ────────────────────────────────────────────────
    // Logs go to ~/.ChaTTY/chatty.log (not stdout, which is used by the TUI)
    {
        use std::io::Write;
        std::fs::create_dir_all(&config.data_dir)?;
        let log_path = config.data_dir.join("chatty.log");
        let log_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)?;
        env_logger::Builder::from_env(
            env_logger::Env::default().default_filter_or("info")
        )
        .target(env_logger::Target::Pipe(Box::new(log_file)))
        .format(|buf, record| {
            writeln!(
                buf,
                "[{} {:5} {}] {}",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
                record.level(),
                record.module_path().unwrap_or(""),
                record.args()
            )
        })
        .init();
    }
    log::info!("=== ChaTTY starting ===");
    log::info!("Config: {:?}", config);
    log::info!("Data dir: {}", config.data_dir.display());

    // ── Database ──────────────────────────────────────────────────────────
    log::info!("Opening database at {}", config.db_path.display());
    let database = Arc::new(Database::open(&config.db_path)?);
    let user_id = {
        let conn = database.lock();
        if let Some(existing) = db::get_user_by_username(&conn, &config.username)? {
            // Update status to online
            let _ = db::update_user_status(&conn, &existing.id, "online", &Utc::now().to_rfc3339());
            log::info!("Existing user '{}' id={}", config.username, existing.id);
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
            log::info!("Created new user '{}' id={}", config.username, id);
            id
        }
    };

    let is_first_run = std::env::var("CHATTY_FIRST_RUN").is_ok();

    // ── App state ─────────────────────────────────────────────────────────
    let mut app_state = app::App::new(
        config.display_name.clone(),
        user_id.clone(),
        config.port,
        config.data_dir.clone(),
    );
    app_state.first_run = is_first_run;

    // ── Network ───────────────────────────────────────────────────────────
    log::info!("Starting network: port={}, user_id={}", config.port, user_id);
    let net_manager = network::NetworkManager::new(&config, user_id.clone());
    let pool = net_manager.pool.clone();
    let (_server_handle, mut net_rx) = net_manager.start()?;
    log::info!("Network started, TCP server listening on 0.0.0.0:{}", config.port);

    // ── File Transfer Manager ─────────────────────────────────────────────
    let file_manager = Arc::new(network::file_transfer::FileTransferManager::new(&config.data_dir));
    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::unbounded_channel::<app::TransferProgress>();

    // ── Auto-reconnect to known peers + manual peer connections ────────────
    {
        let pool_clone = pool.clone();
        let user_id_clone = user_id.clone();
        let username_clone = config.username.clone();
        let display_name_clone = config.display_name.clone();
        let my_port = config.port;
        let database_clone = database.clone();
        
        tokio::spawn(async move {
            // Small delay to let the TCP server fully start
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            
            // Helper to send Hello to a peer
            let send_hello = |pool: &network::ConnectionPool, peer_id: String, addr: std::net::SocketAddr, user_id: String, username: String, display_name: String, port: u16| {
                let pool = pool.clone();
                async move {
                    match pool.get_or_connect(&peer_id, addr).await {
                        Ok(conn) => {
                            let hello = network::NetworkMessage::Hello {
                                user_id,
                                username,
                                display_name,
                                port,
                                public_key: vec![],
                            };
                            if let Err(e) = conn.send(&hello).await {
                                log::error!("Failed to send Hello to {}: {}", addr, e);
                            } else {
                                log::info!("Sent Hello to {}", addr);
                            }
                        }
                        Err(e) => {
                            log::debug!("Failed to connect to {}: {}", addr, e);
                        }
                    }
                }
            };

            // 1. Connect to manual peers from --peer flag
            if !manual_peers.is_empty() {
                log::info!("Connecting to {} manual peer(s)...", manual_peers.len());
            }
            for peer_addr_str in &manual_peers {
                match peer_addr_str.parse::<std::net::SocketAddr>() {
                    Ok(addr) => {
                        log::info!("Manual peer: connecting to {}", addr);
                        let temp_peer_id = format!("manual-{}", addr);
                        send_hello(
                            &pool_clone,
                            temp_peer_id,
                            addr,
                            user_id_clone.clone(),
                            username_clone.clone(),
                            display_name_clone.clone(),
                            my_port,
                        ).await;
                    }
                    Err(e) => {
                        log::error!("Invalid --peer address '{}': {}", peer_addr_str, e);
                    }
                }
            }

            // 2. Auto-reconnect to known peers from database
            let known_peers: Vec<db::User> = {
                let conn = database_clone.lock();
                db::get_all_users(&conn).unwrap_or_default()
            };
            
            let reconnect_count = known_peers.iter()
                .filter(|u| u.id != user_id_clone && u.ip_address.is_some() && u.port.is_some())
                .count();
            
            if reconnect_count > 0 {
                log::info!("Auto-reconnecting to {} known peer(s) from database...", reconnect_count);
            }
            
            for peer in known_peers {
                // Skip self
                if peer.id == user_id_clone {
                    continue;
                }
                // Skip peers without connection info
                let (Some(ip), Some(port)) = (&peer.ip_address, peer.port) else {
                    continue;
                };
                
                // Parse address
                let addr_str = format!("{}:{}", ip, port);
                match addr_str.parse::<std::net::SocketAddr>() {
                    Ok(addr) => {
                        log::info!("Auto-reconnect: trying {} ({})", peer.display_name, addr);
                        send_hello(
                            &pool_clone,
                            peer.id.clone(),
                            addr,
                            user_id_clone.clone(),
                            username_clone.clone(),
                            display_name_clone.clone(),
                            my_port,
                        ).await;
                    }
                    Err(e) => {
                        log::debug!("Invalid address for peer {}: {}", peer.display_name, e);
                    }
                }
            }
        });
    }

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
            biased;
            
            // Network events have highest priority
            Some(event) = net_rx.recv() => {
                let from = match &event {
                    network::NetworkEvent::MessageReceived { from, .. } => Some(*from),
                    network::NetworkEvent::ConnectionEstablished { peer_addr } => Some(*peer_addr),
                    network::NetworkEvent::ConnectionLost { peer_addr } => Some(*peer_addr),
                };
                handlers::network_events::handle_network_event(
                    &mut app_state, &database, &pool, from, event
                ).await;
                
                // Process any pending chunk sends (triggered by FileAccept)
                let chunks_to_send: Vec<_> = app_state.pending_chunk_sends.drain(..).collect();
                for (transfer_id, peer_id) in chunks_to_send {
                    log::info!("Starting chunk transmission for transfer {}", transfer_id);
                    let fm = file_manager.clone();
                    let db = database.clone();
                    let p = pool.clone();
                    let tid = transfer_id.clone();
                    let ptx = progress_tx.clone();
                    
                    // Spawn a task to send chunks
                    tokio::spawn(async move {
                        match fm.start_sending(&tid, &peer_id, &db, &p, ptx).await {
                            Ok(()) => log::info!("Transfer {} completed successfully", tid),
                            Err(e) => log::error!("Transfer {} failed: {}", tid, e),
                        }
                    });
                }
            }
            
            // Handle file transfer progress updates
            Some(progress) = progress_rx.recv() => {
                match progress {
                    app::TransferProgress::BytesSent { transfer_id, bytes } => {
                        if let Some(t) = app_state.active_transfers.iter_mut().find(|t| t.id == transfer_id) {
                            t.bytes_transferred = bytes;
                            t.status = app::TransferStatus::InProgress;
                        }
                    }
                    app::TransferProgress::Completed { transfer_id } => {
                        if let Some(t) = app_state.active_transfers.iter_mut().find(|t| t.id == transfer_id) {
                            t.status = app::TransferStatus::Complete;
                        }
                        app_state.show_popup("File Sent", "File transfer completed!", Some(3.0));
                    }
                    app::TransferProgress::Failed { transfer_id, error } => {
                        if let Some(t) = app_state.active_transfers.iter_mut().find(|t| t.id == transfer_id) {
                            t.status = app::TransferStatus::Failed(error.clone());
                        }
                        app_state.show_popup("Transfer Failed", &error, Some(5.0));
                    }
                }
            }
            
            Some(ev) = term_rx.recv() => {
                if let Event::Key(key) = ev {
                    // Only process key Press events (not Release/Repeat)
                    if key.kind != KeyEventKind::Press {
                        continue;
                    }

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

                        // Send typing stopped indicator to peer when message is sent
                        if typing_sent {
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
                        }
                        typing_sent = false;
                        last_typed_at = None;

                        if raw.starts_with('/') {
                            handlers::commands::handle_command(&mut app_state, &raw);
                            // Run search if command set search_query
                            if let Some(query) = app_state.search_query.clone() {
                                run_search(&mut app_state, &database, &query);
                            }
                            // Handle export command
                            if app_state.export_requested {
                                app_state.export_requested = false;
                                export_conversation(&mut app_state, &database);
                            }
                            // Handle file send command
                            if let Some(file_path) = app_state.pending_file_send.take() {
                                if let Some(peer) = app_state.users.get(app_state.selected_user_index) {
                                    let peer_id = peer.id.clone();
                                    let peer_name = peer.display_name.clone();
                                    let conv_id = app_state.selected_conversation.clone().unwrap_or_default();
                                    
                                    match file_manager.send_file(
                                        std::path::Path::new(&file_path),
                                        &peer_id,
                                        &conv_id,
                                        &app_state.my_user_id,
                                        &database,
                                        &pool,
                                    ).await {
                                        Ok(transfer_id) => {
                                            let file_size = std::fs::metadata(&file_path)
                                                .map(|m| m.len())
                                                .unwrap_or(0);
                                            let filename = std::path::Path::new(&file_path)
                                                .file_name()
                                                .and_then(|n| n.to_str())
                                                .unwrap_or("file")
                                                .to_string();
                                            app_state.active_transfers.push(app::ActiveTransfer {
                                                id: transfer_id,
                                                filename,
                                                file_size,
                                                bytes_transferred: 0,
                                                is_upload: true,
                                                peer_name,
                                                status: app::TransferStatus::Pending,
                                                started_at: Instant::now(),
                                            });
                                            app_state.show_popup("File Transfer", "File offer sent, waiting for acceptance...", Some(3.0));
                                        }
                                        Err(e) => {
                                            app_state.show_popup("Error", &format!("Failed to send file: {}", e), Some(5.0));
                                        }
                                    }
                                } else {
                                    app_state.show_popup("Error", "No peer selected to send file to", Some(3.0));
                                }
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
    log::info!("Shutting down...");
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

/// Export the current conversation to a text file.
fn export_conversation(app: &mut app::App, database: &Arc<Database>) {
    let conv_id = match &app.selected_conversation {
        Some(id) => id.clone(),
        None => {
            app.show_popup("Export Error", "No conversation selected.", Some(3.0));
            return;
        }
    };
    
    // Get peer name for filename
    let peer_name = app.users
        .get(app.selected_user_index)
        .map(|u| u.display_name.clone())
        .unwrap_or_else(|| "chat".to_string());
    
    let conn = database.lock();
    let messages = match db::get_all_messages_for_conversation(&conn, &conv_id) {
        Ok(msgs) => msgs,
        Err(e) => {
            app.show_popup("Export Error", &format!("Failed to load messages: {}", e), Some(3.0));
            return;
        }
    };
    drop(conn);
    
    if messages.is_empty() {
        app.show_popup("Export", "No messages to export.", Some(3.0));
        return;
    }
    
    // Build the export content
    let mut content = String::new();
    content.push_str(&format!("# ChaTTY Chat Export\n"));
    content.push_str(&format!("# Conversation with: {}\n", peer_name));
    content.push_str(&format!("# Exported: {}\n", chrono::Local::now().format("%Y-%m-%d %H:%M:%S")));
    content.push_str(&format!("# Total messages: {}\n", messages.len()));
    content.push_str("# ─────────────────────────────────────────\n\n");
    
    for msg in &messages {
        let time = chrono::DateTime::parse_from_rfc3339(&msg.timestamp)
            .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
            .unwrap_or_else(|_| msg.timestamp.clone());
        
        // Look up sender display name
        let sender_name = if msg.sender_id == app.my_user_id {
            app.my_username.clone()
        } else {
            app.users
                .iter()
                .find(|u| u.id == msg.sender_id)
                .map(|u| u.display_name.clone())
                .unwrap_or_else(|| msg.sender_id.clone())
        };
        
        content.push_str(&format!("[{}] {}: {}\n", time, sender_name, msg.content));
    }
    
    // Save to file in data_dir
    let safe_name: String = peer_name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let filename = format!("chat_{}_{}.txt", safe_name, timestamp);
    let export_path = app.data_dir.join(&filename);
    
    match std::fs::write(&export_path, &content) {
        Ok(_) => {
            app.show_popup(
                "Export Complete",
                &format!("Chat exported to:\n{}\n\n{} messages saved.", export_path.display(), messages.len()),
                None,
            );
        }
        Err(e) => {
            app.show_popup("Export Error", &format!("Failed to write file: {}", e), Some(3.0));
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

    log::info!("Loading conversation with '{}' (id={})", peer.display_name, peer.id);
    let conn = database.lock();
    let conv = db::get_or_create_direct_conversation(&conn, my_user_id, &peer.id)?;
    app.selected_conversation = Some(conv.id.clone());

    let msgs = db::get_messages_for_conversation(&conn, &conv.id, 50, 0)?;
    log::info!("Loaded {} messages for conversation {}", msgs.len(), conv.id);
    app.messages = msgs;
    app.scroll_offset = 0;
    app.unread_counts.remove(&peer.id);

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
    match pool.send_to(&peer.id, &net_msg).await {
        Ok(_) => log::info!("Sent message to '{}' (id={})", peer.display_name, peer.id),
        Err(e) => log::warn!("Failed to send message to '{}': {} (saved in DB for retry)", peer.display_name, e),
    }

    Ok(())
}
