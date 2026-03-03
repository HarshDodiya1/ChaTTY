use crate::app::App;
use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState},
    Frame,
};

pub fn render(frame: &mut Frame, app: &App, area: Rect) {
    let mut items: Vec<ListItem> = Vec::new();

    // ── Direct Messages ────────────────────────────────────────────────
    items.push(
        ListItem::new(Line::from(Span::styled(
            " Direct Messages ",
            Style::default().fg(Color::DarkGray).add_modifier(Modifier::ITALIC),
        )))
        .style(Style::default()),
    );

    for user in &app.users {
        let unread = app.unread_counts.get(&user.id).copied().unwrap_or(0);
        let (bullet, color) = match user.status.as_str() {
            "online" => ("●", Color::Green),
            "away" => ("●", Color::Yellow),
            _ => ("○", Color::DarkGray),
        };

        let label = if unread > 0 {
            format!("{} {} [{}]", bullet, user.display_name, unread)
        } else {
            format!("{} {}", bullet, user.display_name)
        };

        let style = if user.status == "online" {
            Style::default().fg(color).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(color).add_modifier(Modifier::DIM)
        };

        items.push(ListItem::new(label).style(style));
    }

    if app.users.is_empty() {
        items.push(ListItem::new("  (discovering…)").style(
            Style::default().fg(Color::DarkGray).add_modifier(Modifier::ITALIC),
        ));
    }

    // ── Groups ────────────────────────────────────────────────────────
    if !app.groups.is_empty() {
        items.push(ListItem::new(Line::from(Span::styled(
            " Groups ",
            Style::default().fg(Color::DarkGray).add_modifier(Modifier::ITALIC),
        ))));

        for group in &app.groups {
            let name = group.name.as_deref().unwrap_or("(unnamed)");
            let unread = app.unread_counts.get(&group.id).copied().unwrap_or(0);
            let label = if unread > 0 {
                format!("# {} [{}]", name, unread)
            } else {
                format!("# {}", name)
            };
            items.push(
                ListItem::new(label).style(Style::default().fg(Color::Cyan)),
            );
        }
    }

    let block = Block::default()
        .title(" Peers ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::DarkGray));

    let list = List::new(items)
        .block(block)
        .highlight_style(
            Style::default()
                .bg(Color::DarkGray)
                .add_modifier(Modifier::BOLD),
        );

    let mut state = ListState::default();
    if !app.users.is_empty() && app.state == crate::app::AppState::UserList {
        // +1 for the section header item
        state.select(Some(app.selected_user_index + 1));
    }

    frame.render_stateful_widget(list, area, &mut state);
}
