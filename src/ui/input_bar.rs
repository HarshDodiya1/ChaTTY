use crate::app::{App, AppState};
use ratatui::{
    layout::Rect,
    style::{Color, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

pub fn render(frame: &mut Frame, app: &App, area: Rect) {
    // Typing indicator line
    let typing_text: Option<String> = app
        .typing
        .iter()
        .filter(|(uid, &is_typing)| is_typing && uid.as_str() != app.my_user_id.as_str())
        .map(|(uid, _)| {
            let name = app
                .users
                .iter()
                .find(|u| &u.id == uid)
                .map(|u| u.display_name.as_str())
                .unwrap_or(uid.as_str())
                .to_string();
            format!("{} is typing…", name)
        })
        .next();

    let prompt = match app.state {
        AppState::Chat => "> ",
        _ => "  ",
    };

    let input_text = format!("{}{}", prompt, app.input_buffer);

    // Build lines: optional typing indicator above the input
    let lines: Vec<Line> = if let Some(typing) = typing_text {
        vec![
            Line::from(Span::styled(
                typing,
                Style::default().fg(Color::DarkGray),
            )),
            Line::from(Span::styled(
                input_text,
                Style::default().fg(Color::Yellow),
            )),
        ]
    } else {
        vec![Line::from(Span::styled(
            input_text,
            Style::default().fg(Color::Yellow),
        ))]
    };

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::DarkGray));

    let paragraph = Paragraph::new(lines).block(block);
    frame.render_widget(paragraph, area);

    // Place cursor inside the block
    let cursor_x = area.x + 1 + prompt.len() as u16 + app.input_cursor as u16;
    let cursor_y = area.y + area.height.saturating_sub(2);
    frame.set_cursor_position((cursor_x, cursor_y));
}
