use crate::app::{App, TransferStatus};
use crate::db::FileTransfer;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Gauge, Paragraph},
    Frame,
};

/// Render active transfer progress bars at the bottom of the chat area.
pub fn render(frame: &mut Frame, app: &App, area: Rect) {
    if area.height == 0 {
        return;
    }
    
    let block = Block::default()
        .title(" File Transfer ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan));
    
    let inner = block.inner(area);
    frame.render_widget(block, area);
    
    if app.active_transfers.is_empty() {
        let hint = Paragraph::new("No active transfers. Use /file <path> to send a file.")
            .style(Style::default().fg(Color::DarkGray));
        frame.render_widget(hint, inner);
        return;
    }
    
    // Create rows for each transfer
    let transfers_to_show: Vec<_> = app.active_transfers.iter()
        .filter(|t| !matches!(t.status, TransferStatus::Complete))
        .take(inner.height as usize)
        .collect();
    
    if transfers_to_show.is_empty() {
        // Show recently completed
        let completed: Vec<_> = app.active_transfers.iter()
            .filter(|t| matches!(t.status, TransferStatus::Complete))
            .take(3)
            .collect();
        
        if completed.is_empty() {
            let hint = Paragraph::new("No active transfers")
                .style(Style::default().fg(Color::DarkGray));
            frame.render_widget(hint, inner);
        } else {
            let lines: Vec<Line> = completed.iter().map(|t| {
                Line::from(vec![
                    Span::styled("✓ ", Style::default().fg(Color::Green)),
                    Span::styled(&t.filename, Style::default().fg(Color::White)),
                    Span::styled(
                        format!(" ({:.2} MB) - Complete", t.file_size as f64 / 1024.0 / 1024.0),
                        Style::default().fg(Color::DarkGray)
                    ),
                ])
            }).collect();
            let para = Paragraph::new(lines);
            frame.render_widget(para, inner);
        }
        return;
    }
    
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(
            transfers_to_show.iter().map(|_| Constraint::Length(2)).collect::<Vec<_>>()
        )
        .split(inner);
    
    for (i, transfer) in transfers_to_show.iter().enumerate() {
        if i >= chunks.len() {
            break;
        }
        
        let progress = transfer.progress_percent();
        let speed = transfer.speed_mbps();
        let direction = if transfer.is_upload { "↑" } else { "↓" };
        
        let (status_icon, status_color) = match &transfer.status {
            TransferStatus::Pending => ("⏳", Color::Yellow),
            TransferStatus::InProgress => (direction, Color::Cyan),
            TransferStatus::Complete => ("✓", Color::Green),
            TransferStatus::Failed(_) => ("✗", Color::Red),
        };
        
        let label = format!(
            "{} {} - {:.1}% ({:.2} MB/s) [{}]",
            status_icon,
            transfer.filename,
            progress,
            speed,
            transfer.peer_name
        );
        
        let gauge = Gauge::default()
            .gauge_style(Style::default().fg(status_color).add_modifier(Modifier::BOLD))
            .percent(progress.min(100.0) as u16)
            .label(label);
        
        frame.render_widget(gauge, chunks[i]);
    }
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
