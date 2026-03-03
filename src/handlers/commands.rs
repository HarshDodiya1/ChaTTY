use crate::app::App;

/// Parse and execute a slash command typed in the input bar.
/// Returns true if the input was a valid command (even if unknown).
pub fn handle_command(app: &mut App, input: &str) -> bool {
    let trimmed = input.trim_start_matches('/');
    let mut parts = trimmed.splitn(3, ' ');
    let cmd = parts.next().unwrap_or("");
    let rest = parts.next().unwrap_or("");

    match cmd {
        "quit" | "q" => {
            app.should_quit = true;
        }
        "clear" => {
            app.messages.clear();
        }
        "help" => {
            app.show_popup(
                "Available Commands",
                "/help  /quit  /clear\n\
                 /nick <name>  /status <online|away>\n\
                 /group create <name> <user…>\n\
                 /group invite <user>\n\
                 /group leave\n\
                 /group list\n\
                 /file <path>  /files\n\
                 /search <query>  /history [n]\n\
                 /info",
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
        "group" => handle_group_command(app, rest, parts.next().unwrap_or("")),
        "file" => {
            if rest.is_empty() {
                app.show_popup("Error", "Usage: /file <path>", Some(3.0));
            } else {
                app.show_popup("File Transfer", "File transfer — implemented in Section 9.", Some(3.0));
            }
        }
        "files" => {
            app.show_popup("File Transfers", "File transfer list — implemented in Section 9.", Some(3.0));
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
        "history" => {
            // Signal main loop to load more history (n defaults to 100)
            let n: i64 = rest.trim().parse().unwrap_or(100);
            app.show_popup("History", &format!("Loading last {} messages…", n), Some(2.0));
            // Main loop responds to search_query being None and loads via scroll
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
