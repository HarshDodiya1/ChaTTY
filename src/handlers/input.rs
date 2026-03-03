use crate::app::{App, AppState};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

const COMMANDS: &[&str] = &[
    "/help", "/quit", "/q", "/clear", "/nick", "/status",
    "/group", "/file", "/files", "/search", "/history", "/info",
];

pub fn handle_key(app: &mut App, key: KeyEvent) {
    // Global shortcuts
    if key.modifiers == KeyModifiers::CONTROL {
        match key.code {
            KeyCode::Char('c') => {
                app.should_quit = true;
                return;
            }
            _ => {}
        }
    }

    // Dismiss search overlay on Escape
    if app.search_query.is_some() && key.code == KeyCode::Esc {
        app.search_query = None;
        app.search_results.clear();
        return;
    }

    // Dismiss popup on any key
    if app.popup.is_some() {
        app.popup = None;
        return;
    }

    match app.state {
        AppState::UserList => handle_user_list(app, key),
        AppState::Chat => handle_chat(app, key),
        AppState::GroupPanel => handle_group_panel(app, key),
        AppState::FileTransfer => handle_file_transfer(app, key),
    }
}

fn handle_user_list(app: &mut App, key: KeyEvent) {
    match key.code {
        KeyCode::Up => {
            if app.selected_user_index > 0 {
                app.selected_user_index -= 1;
            }
        }
        KeyCode::Down => {
            if !app.users.is_empty()
                && app.selected_user_index < app.users.len() - 1
            {
                app.selected_user_index += 1;
            }
        }
        KeyCode::Enter => {
            if !app.users.is_empty() {
                app.state = AppState::Chat;
                app.scroll_offset = 0;
                // selected_conversation is set by the main loop after DB query
            }
        }
        KeyCode::Tab => {
            // Cycle focus — future use
        }
        KeyCode::Char('q') => {
            app.should_quit = true;
        }
        _ => {}
    }
}

fn handle_chat(app: &mut App, key: KeyEvent) {
    match key.code {
        KeyCode::Esc => {
            app.state = AppState::UserList;
            app.input_buffer.clear();
            app.input_cursor = 0;
        }
        KeyCode::Enter => {
            // The actual send logic is handled in main.rs which has DB access.
            // Set a flag via a sentinel — main loop checks `input_buffer` after every key.
            // Actual send triggered by checking app.state == Chat && key was Enter.
            // We mark it by NOT clearing here; main loop clears after sending.
        }
        KeyCode::Char(c) => {
            app.input_buffer.insert(app.input_cursor, c);
            app.input_cursor += 1;
        }
        KeyCode::Backspace => {
            if app.input_cursor > 0 {
                app.input_cursor -= 1;
                app.input_buffer.remove(app.input_cursor);
            }
        }
        KeyCode::Delete => {
            if app.input_cursor < app.input_buffer.len() {
                app.input_buffer.remove(app.input_cursor);
            }
        }
        KeyCode::Left => {
            if app.input_cursor > 0 {
                app.input_cursor -= 1;
            }
        }
        KeyCode::Right => {
            if app.input_cursor < app.input_buffer.len() {
                app.input_cursor += 1;
            }
        }
        KeyCode::Home => {
            app.input_cursor = 0;
        }
        KeyCode::End => {
            app.input_cursor = app.input_buffer.len();
        }
        KeyCode::Tab => {
            tab_complete(app);
        }
        KeyCode::PageUp => {
            app.scroll_offset = app.scroll_offset.saturating_add(5);
        }
        KeyCode::PageDown => {
            app.scroll_offset = app.scroll_offset.saturating_sub(5);
        }
        _ => {}
    }
}

/// Auto-complete the current input buffer if it starts with '/'.
fn tab_complete(app: &mut App) {
    if !app.input_buffer.starts_with('/') {
        return;
    }
    let prefix = app.input_buffer.as_str();
    let matches: Vec<&&str> = COMMANDS.iter().filter(|c| c.starts_with(prefix)).collect();
    if matches.len() == 1 {
        let completed = matches[0].to_string() + " ";
        let len = completed.len();
        app.input_buffer = completed;
        app.input_cursor = len;
    } else if matches.len() > 1 {
        // Show all matches in a popup
        let list = matches
            .iter()
            .map(|c| **c)
            .collect::<Vec<_>>()
            .join("  ");
        app.show_popup("Tab Completion", &list, Some(3.0));
    }
}

fn handle_group_panel(app: &mut App, key: KeyEvent) {
    if key.code == KeyCode::Esc {
        app.state = AppState::UserList;
    }
}

fn handle_file_transfer(app: &mut App, key: KeyEvent) {
    if key.code == KeyCode::Esc {
        app.state = AppState::Chat;
    }
}
