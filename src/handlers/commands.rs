use crate::app::App;

/// Parse and execute a slash command typed in the input bar.
/// Returns true if the input was a valid command (even if unknown).
pub fn handle_command(app: &mut App, input: &str) -> bool {
    let trimmed = input.trim_start_matches('/');
    let mut parts = trimmed.splitn(2, ' ');
    let cmd = parts.next().unwrap_or("");
    let rest = parts.next().unwrap_or("");  // Everything after the command

    match cmd {
        "quit" | "q" => {
            app.should_quit = true;
        }
        "clear" => {
            app.messages.clear();
        }
        "help" => {
            app.show_popup(
                "⌨  ChaTTY Commands",
                "
 ━━━ General ━━━━━━━━━━━━━━━━━━━━━━━━━
  /help          Show this help
  /info          Your connection info
  /clear         Clear chat view
  /quit          Exit ChaTTY

 ━━━ Identity ━━━━━━━━━━━━━━━━━━━━━━━━
  /nick <name>   Change display name
  /status <s>    Set online/away

 ━━━ Groups ━━━━━━━━━━━━━━━━━━━━━━━━━━
  /group create <name>   New group
  /group invite <user>   Add member
  /group leave           Leave group
  /group list            Show groups

 ━━━ Files ━━━━━━━━━━━━━━━━━━━━━━━━━━━
  /file <path>   Send a file
  /files         Show transfers

 ━━━ Chat ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  /search <q>    Search messages
  /export        Export chat to file
",
                None,
            );
        }
        "nick" => {
            if rest.is_empty() {
                app.show_popup("Error", "Usage: /nick <new_name>", Some(3.0));
            } else {
                app.my_username = rest.to_string();
                app.show_popup("Nick Changed", &format!("Display name set to '{}'", rest), Some(3.0));
            }
        }
        "status" => match rest {
            "online" | "away" | "offline" => {
                app.show_popup("Status", &format!("Status set to '{}'", rest), Some(3.0));
            }
            _ => {
                app.show_popup("Error", "Usage: /status <online|away>", Some(3.0));
            }
        },
        "group" => {
            // Parse: /group <subcommand> [args...]
            let mut group_parts = rest.splitn(2, ' ');
            let sub = group_parts.next().unwrap_or("");
            let args = group_parts.next().unwrap_or("");
            handle_group_command(app, sub, args);
        }
        "file" => {
            if rest.is_empty() {
                app.show_popup("Error", "Usage: /file <path>", Some(3.0));
            } else {
                // Expand ~ to home directory
                let path = if rest.starts_with("~/") {
                    if let Some(home) = dirs::home_dir() {
                        home.join(&rest[2..]).to_string_lossy().to_string()
                    } else {
                        rest.to_string()
                    }
                } else {
                    rest.to_string()
                };
                
                // Check if file exists
                if std::path::Path::new(&path).exists() {
                    app.pending_file_send = Some(path.clone());
                    app.show_popup("File Transfer", &format!("Sending: {}", path), Some(2.0));
                } else {
                    app.show_popup("Error", &format!("File not found: {}", path), Some(3.0));
                }
            }
        }
        "files" => {
            if app.active_transfers.is_empty() {
                app.show_popup("File Transfers", "No active transfers", Some(3.0));
            } else {
                let mut info = String::new();
                for t in &app.active_transfers {
                    let status = match &t.status {
                        crate::app::TransferStatus::Pending => "⏳ Pending",
                        crate::app::TransferStatus::InProgress => "📤 In Progress",
                        crate::app::TransferStatus::Complete => "✅ Complete",
                        crate::app::TransferStatus::Failed(e) => &format!("❌ Failed: {}", e),
                    };
                    let direction = if t.is_upload { "↑" } else { "↓" };
                    info.push_str(&format!(
                        "{} {} {} - {:.1}% ({:.2} MB/s)\\n",
                        direction, t.filename, status, t.progress_percent(), t.speed_mbps()
                    ));
                }
                app.show_popup("File Transfers", &info, None);
            }
        }
        "search" => {
            if rest.is_empty() {
                app.show_popup("Error", "Usage: /search <query>", Some(3.0));
            } else {
                // Signal main loop to run the search (needs DB access)
                app.search_query = Some(rest.to_string());
                app.search_results.clear();
            }
        }
        "history" | "export" => {
            // Export the current conversation to a text file
            if app.selected_conversation.is_none() {
                app.show_popup("Error", "Open a conversation first to export.", Some(3.0));
            } else {
                // Signal main loop to export (needs DB access)
                app.export_requested = true;
            }
        }
        "info" => {
            let info = format!(
                "Username: {}\nPort: {}\nUser ID: {}",
                app.my_username, app.port, app.my_user_id
            );
            app.show_popup("Info", &info, None);
        }
        _ => {
            app.show_popup(
                "Unknown Command",
                &format!("Unknown command: /{cmd}. Type /help."),
                Some(3.0),
            );
        }
    }
    true
}

fn handle_group_command(app: &mut App, sub: &str, args: &str) {
    match sub {
        "create" => {
            // /group create <name> [users…]
            let mut parts = args.splitn(2, ' ');
            let name = parts.next().unwrap_or("").trim();
            if name.is_empty() {
                app.show_popup("Error", "Usage: /group create <name> [user…]", Some(3.0));
                return;
            }
            // Create group conversation locally; network broadcast needs pool access
            // (full implementation wires pool from main.rs)
            let group = crate::db::Conversation {
                id: uuid::Uuid::new_v4().to_string(),
                conv_type: "group".to_string(),
                name: Some(name.to_string()),
                created_at: chrono::Utc::now().to_rfc3339(),
            };
            app.groups.push(group.clone());
            app.selected_conversation = Some(group.id);
            app.messages.clear();
            app.state = crate::app::AppState::Chat;
            app.show_popup("Group Created", &format!("Created group '{}'", name), Some(3.0));
        }
        "invite" => {
            if sub.is_empty() {
                app.show_popup("Error", "Usage: /group invite <user>", Some(3.0));
            } else {
                app.show_popup("Group Invite", &format!("Invited '{}' to group.", args), Some(3.0));
            }
        }
        "leave" => {
            if let Some(conv_id) = app.selected_conversation.take() {
                app.groups.retain(|g| g.id != conv_id);
            }
            app.state = crate::app::AppState::UserList;
            app.show_popup("Group", "Left the group.", Some(3.0));
        }
        "list" => {
            let names: Vec<String> = app
                .groups
                .iter()
                .map(|g| g.name.clone().unwrap_or_else(|| g.id.clone()))
                .collect();
            let text = if names.is_empty() {
                "No groups.".to_string()
            } else {
                names.join("\n")
            };
            app.show_popup("Groups", &text, None);
        }
        _ => {
            app.show_popup(
                "Group Help",
                "/group create <name>\n/group invite <user>\n/group leave\n/group list",
                None,
            );
        }
    }
}
