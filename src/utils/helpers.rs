use chrono::{DateTime, Local, Utc};

/// Format a UTC RFC 3339 timestamp for display in the chat view.
/// - Today: "HH:MM"
/// - This week: "Mon HH:MM"
/// - Older: "MM/DD HH:MM"
pub fn format_timestamp(ts: &str) -> String {
    let Ok(dt) = ts.parse::<DateTime<Utc>>() else {
        return ts.get(11..16).unwrap_or("--:--").to_string();
    };
    let local: DateTime<Local> = dt.into();
    let now = Local::now();

    let days_ago = (now.date_naive() - local.date_naive()).num_days();

    if days_ago == 0 {
        local.format("%H:%M").to_string()
    } else if days_ago < 7 {
        local.format("%a %H:%M").to_string()
    } else {
        local.format("%m/%d %H:%M").to_string()
    }
}

/// Word-wrap `text` to fit within `width` characters, returning lines.
pub fn word_wrap(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![text.to_string()];
    }
    let mut lines = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        if current.is_empty() {
            current.push_str(word);
        } else if current.len() + 1 + word.len() <= width {
            current.push(' ');
            current.push_str(word);
        } else {
            lines.push(current.clone());
            current = word.to_string();
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}
