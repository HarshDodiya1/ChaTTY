use crate::app::App;
use crate::db::FileTransfer;
use ratatui::{
    layout::Rect,
    style::{Color, Style},
    widgets::{Block, Borders, Gauge},
    Frame,
};

/// Render active transfer progress bars at the bottom of the chat area.
pub fn render(frame: &mut Frame, _app: &App, area: Rect) {
    // In Section 9, active transfers are tracked in App (added when wiring main.rs).
    // For now, render a placeholder if the area is non-zero.
    if area.height == 0 {
        return;
    }
    let block = Block::default()
        .title(" File Transfers ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::DarkGray));
    frame.render_widget(block, area);
}

/// Render a single transfer progress gauge.
pub fn render_transfer_gauge(
    frame: &mut Frame,
    transfer: &FileTransfer,
    bytes_done: u64,
    area: Rect,
) {
    let total = transfer.file_size as u64;
    let ratio = if total > 0 {
        (bytes_done as f64 / total as f64).min(1.0)
    } else {
        0.0
    };
    let pct = (ratio * 100.0) as u16;

    let label = format!(
        "{} — {}%",
        transfer.filename,
        pct
    );

    let gauge = Gauge::default()
        .block(
            Block::default()
                .borders(Borders::NONE),
        )
        .gauge_style(Style::default().fg(Color::Green))
        .percent(pct)
        .label(label);

    frame.render_widget(gauge, area);
}

/// Format a file message for display in the chat view.
pub fn format_file_message(transfer: &FileTransfer) -> String {
    let size_mb = transfer.file_size as f64 / (1024.0 * 1024.0);
    let status = match transfer.status.as_str() {
        "complete" => "✓ Transferred",
        "failed" => "✗ Failed",
        "in_progress" => "Transferring…",
        _ => "Pending…",
    };
    format!(
        "📎 {} ({:.1} MB) — {}",
        transfer.filename, size_mb, status
    )
}
