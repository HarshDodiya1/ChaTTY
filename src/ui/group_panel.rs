use crate::app::App;
use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    widgets::{Block, Borders, List, ListItem},
    Frame,
};

/// Render the group members sidebar inside the given area.
pub fn render(frame: &mut Frame, app: &App, area: Rect) {
    // Find participants for the current conversation
    let title = " Members ";

    let items: Vec<ListItem> = app
        .users
        .iter()
        .map(|u| {
            let (bullet, color) = match u.status.as_str() {
                "online" => ("●", Color::Green),
                "away" => ("●", Color::Yellow),
                _ => ("○", Color::DarkGray),
            };
            ListItem::new(format!("{} {}", bullet, u.display_name))
                .style(Style::default().fg(color).add_modifier(Modifier::BOLD))
        })
        .collect();

    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::DarkGray));

    let list = List::new(items).block(block);
    frame.render_widget(list, area);
}
