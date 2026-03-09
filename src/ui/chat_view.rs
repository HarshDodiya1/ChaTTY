use crate::app::App;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, Paragraph, Wrap},
    Frame,
};

pub fn render(frame: &mut Frame, app: &App, area: Rect) {
    // Detect if we're in a group conversation
    let is_group = app
        .selected_conversation
        .as_ref()
        .and_then(|id| app.groups.iter().find(|g| &g.id == id))
        .is_some();

    // Split area: messages | member panel (only for groups)
    let (chat_area, _group_area) = if is_group {
        let chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(0), Constraint::Length(20)])
            .split(area);
        let g = chunks[1];
        super::group_panel::render(frame, app, g);
        (chunks[0], Some(g))
    } else {
        (area, None)
    };
    let area = chat_area;

    let title = if let Some(conv_id) = &app.selected_conversation {
        if let Some(group) = app.groups.iter().find(|g| &g.id == conv_id) {
            format!(" # {} ", group.name.as_deref().unwrap_or("group"))
        } else {
            let peer_name = app
                .users
                .get(app.selected_user_index)
                .map(|u| u.display_name.as_str())
                .unwrap_or(conv_id.as_str());
            format!(" {} ", peer_name)
        }
    } else {
        " Chat ".to_string()
    };

    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::DarkGray));

    if app.messages.is_empty() {
        let placeholder = Paragraph::new("(no messages yet)")
            .block(block)
            .style(Style::default().fg(Color::DarkGray));
        frame.render_widget(placeholder, area);
        return;
    }

    // Build lines from messages, skipping scroll_offset items from the end
    let inner_height = area.height.saturating_sub(2) as usize;
    let total = app.messages.len();
    let start = if total > inner_height + app.scroll_offset {
        total - inner_height - app.scroll_offset
    } else {
        0
    };
    let end = total.saturating_sub(app.scroll_offset);

    let lines: Vec<Line> = app.messages[start..end]
        .iter()
        .map(|msg| format_message(msg, &app.my_user_id, &app.my_username))
        .collect();

    let paragraph = Paragraph::new(lines)
        .block(block)
        .wrap(Wrap { trim: false });
    frame.render_widget(paragraph, area);
}

fn format_message(msg: &crate::db::models::Message, my_user_id: &str, _my_username: &str) -> Line<'static> {
    let time = crate::utils::helpers::format_timestamp(&msg.timestamp);
    let is_mine = msg.sender_id == my_user_id;
    let is_system = msg.content_type == "system";

    let status = if msg.read {
        "✓✓"
    } else if msg.delivered {
        "✓✓"
    } else {
        "✓"
    };

    let (sender_color, content_color) = if is_system {
        (Color::DarkGray, Color::DarkGray)
    } else if is_mine {
        (Color::Green, Color::White)
    } else {
        (Color::Cyan, Color::White)
    };

    let sender_display = if is_system {
        "system".to_string()
    } else if is_mine {
        "you".to_string()
    } else {
        msg.sender_id.clone()
    };

    let mut spans = vec![
        Span::styled(
            format!("[{}] ", time),
            Style::default().fg(Color::DarkGray),
        ),
        Span::styled(
            format!("{}: ", sender_display),
            Style::default()
                .fg(sender_color)
                .add_modifier(Modifier::BOLD),
        ),
    ];

    // Highlight URLs in the message content
    spans.extend(highlight_urls(&msg.content, content_color));

    spans.push(Span::styled(
        format!(" {}", status),
        Style::default().fg(Color::DarkGray),
    ));

    Line::from(spans)
}

/// Split `text` into runs of plain text and URLs, returning styled Spans.
fn highlight_urls(text: &str, default_color: Color) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    let mut remaining = text;

    while let Some(start) = remaining
        .find("http://")
        .or_else(|| remaining.find("https://"))
    {
        // Plain text before the URL
        if start > 0 {
            spans.push(Span::styled(
                remaining[..start].to_string(),
                Style::default().fg(default_color),
            ));
        }
        let rest = &remaining[start..];
        let end = rest.find(|c: char| c.is_whitespace()).unwrap_or(rest.len());
        let url = &rest[..end];
        spans.push(Span::styled(
            url.to_string(),
            Style::default()
                .fg(Color::Blue)
                .add_modifier(Modifier::UNDERLINED),
        ));
        remaining = &rest[end..];
    }

    // Trailing plain text
    if !remaining.is_empty() {
        spans.push(Span::styled(
            remaining.to_string(),
            Style::default().fg(default_color),
        ));
    }

    if spans.is_empty() {
        spans.push(Span::styled(
            text.to_string(),
            Style::default().fg(default_color),
        ));
    }

    spans
}

/// Render the search results overlay (called from mod.rs when search_query is Some).
pub fn render_search_overlay(frame: &mut Frame, app: &App, area: Rect) {
    if app.search_query.is_none() {
        return;
    }

    let query = app.search_query.as_deref().unwrap_or("");
    let title = format!(" Search: '{}' ", query);

    let items: Vec<ListItem> = if app.search_results.is_empty() {
        vec![ListItem::new("No results.").style(Style::default().fg(Color::DarkGray))]
    } else {
        app.search_results
            .iter()
            .map(|m| {
                let time = crate::utils::helpers::format_timestamp(&m.timestamp);
                ListItem::new(format!("[{}] {}: {}", time, m.sender_id, m.content))
            })
            .collect()
    };

    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Yellow));

    let list = List::new(items).block(block);
    frame.render_widget(list, area);
}
