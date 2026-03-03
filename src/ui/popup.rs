use crate::app::App;
use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Color, Style},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

pub fn render(frame: &mut Frame, app: &App) {
    if let Some(popup) = &app.popup {
        let area = centered_rect(60, 20, frame.area());

        frame.render_widget(Clear, area);

        let block = Block::default()
            .title(format!(" {} ", popup.title))
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Yellow));

        let text = Paragraph::new(popup.message.clone())
            .block(block)
            .alignment(Alignment::Center);

        frame.render_widget(text, area);
    }
}

/// Return a centered Rect with the given percentage of the total area.
fn centered_rect(percent_x: u16, percent_y: u16, total: Rect) -> Rect {
    let vert = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(total);

    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(vert[1])[1]
}
