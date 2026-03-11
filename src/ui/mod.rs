pub mod chat_view;
pub mod file_transfer_ui;
pub mod group_panel;
pub mod input_bar;
pub mod popup;
pub mod status_bar;
pub mod user_list;

use crate::app::App;
use ratatui::{
    layout::{Constraint, Direction, Layout},
    Frame,
};

/// Main draw dispatcher — called every tick.
pub fn draw(frame: &mut Frame, app: &App) {
    let area = frame.area();

    // Vertical: [status bar 1] [main body flex] [input bar 3]
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(0),
            Constraint::Length(3),
        ])
        .split(area);

    status_bar::render(frame, app, vertical[0]);

    // Horizontal: [user list 25%] [chat 75%]
    let horizontal = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(25), Constraint::Percentage(75)])
        .split(vertical[1]);

    user_list::render(frame, app, horizontal[0]);
    
    // Split chat area for file transfers if any active
    let has_active_transfers = !app.active_transfers.is_empty();
    if has_active_transfers {
        let chat_split = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(5), Constraint::Length(6)])
            .split(horizontal[1]);
        chat_view::render(frame, app, chat_split[0]);
        file_transfer_ui::render(frame, app, chat_split[1]);
    } else {
        chat_view::render(frame, app, horizontal[1]);
    }

    input_bar::render(frame, app, vertical[2]);

    // Search overlay (renders instead of normal chat when active)
    if app.search_query.is_some() {
        chat_view::render_search_overlay(frame, app, horizontal[1]);
    }

    // Popup renders on top of everything
    popup::render(frame, app);
}
