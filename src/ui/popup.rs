use crate::app::App;
use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
    Frame,
};

pub fn render(frame: &mut Frame, app: &App) {
    if let Some(popup) = &app.popup {
        // Use larger size for help popup
        let is_help = popup.title.contains("Commands");
        let (pct_x, pct_y) = if is_help { (50, 70) } else { (60, 30) };
        
        let area = centered_rect(pct_x, pct_y, frame.area());

        frame.render_widget(Clear, area);

        let block = Block::default()
            .title(format!(" {} ", popup.title))
            .title_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Yellow))
            .style(Style::default().bg(Color::Black));

        // Use left alignment for help, center for other popups
        let alignment = if is_help { Alignment::Left } else { Alignment::Center };
        
        let text = Paragraph::new(popup.message.clone())
            .block(block)
            .alignment(alignment)
            .wrap(Wrap { trim: false });

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
