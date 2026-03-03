use crate::app::App;
use ratatui::{
    layout::Rect,
    style::{Color, Style},
    widgets::Paragraph,
    Frame,
};

pub fn render(frame: &mut Frame, app: &App, area: Rect) {
    let online = app.online_count();
    let enc_status = if app.encryption_enabled {
        " [E2E]"
    } else {
        ""
    };
    let text = format!(
        " [ChaTTY]{}  {}  |  {} online  |  Port: {}",
        enc_status, app.my_username, online, app.port
    );

    let paragraph = Paragraph::new(text).style(Style::default().fg(Color::Cyan));
    frame.render_widget(paragraph, area);
}
