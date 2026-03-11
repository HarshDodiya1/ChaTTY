//! Desktop notification support for ChaTTY.
//!
//! Sends system notifications when new messages arrive.
//! Uses notify-rust for cross-platform support (Linux, macOS, Windows).

use notify_rust::Notification;
use std::thread;

/// Send a desktop notification with the given title and body.
/// This spawns the notification in a separate thread and does not block.
/// Failures are silently ignored (notifications are best-effort).
pub fn send_desktop_notification(title: &str, body: &str) {
    let title = title.to_string();
    let body = body.to_string();
    
    // Spawn in a separate thread to avoid blocking the async runtime
    thread::spawn(move || {
        let _ = Notification::new()
            .summary(&title)
            .body(&body)
            .appname("ChaTTY")
            .timeout(5000) // 5 seconds
            .show();
    });
}

/// Send a notification for a new chat message.
pub fn notify_new_message(sender: &str, content: &str) {
    let title = format!("ChaTTY — {}", sender);
    // Truncate long messages for the notification
    let body = if content.len() > 100 {
        format!("{}...", &content[..97])
    } else {
        content.to_string()
    };
    send_desktop_notification(&title, &body);
}

/// Send a notification for a user coming online.
pub fn notify_user_online(username: &str) {
    send_desktop_notification("ChaTTY", &format!("{} is now online", username));
}

/// Send a notification for a file transfer offer.
pub fn notify_file_offer(sender: &str, filename: &str) {
    let title = format!("ChaTTY — File from {}", sender);
    send_desktop_notification(&title, filename);
}

/// Send a notification for a completed file transfer.
pub fn notify_file_complete(filename: &str) {
    send_desktop_notification("ChaTTY — Download Complete", filename);
}
