use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub username: String,
    pub display_name: String,
    pub port: u16,
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
}

impl Config {
    fn default_data_dir() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".ChaTTY")
    }

    fn default_username() -> String {
        // 1. Linux: /etc/hostname
        if let Ok(h) = std::fs::read_to_string("/etc/hostname") {
            let h = h.trim().to_string();
            if !h.is_empty() {
                return h;
            }
        }
        // 2. Shell env var (bash/zsh)
        if let Ok(h) = std::env::var("HOSTNAME") {
            if !h.is_empty() {
                return h;
            }
        }
        // 3. `hostname` command — works on macOS, BSD, and most Linux distros
        if let Ok(out) = std::process::Command::new("hostname").output() {
            let h = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !h.is_empty() {
                return h;
            }
        }
        "anonymous".to_string()
    }
}

impl Default for Config {
    fn default() -> Self {
        let data_dir = Self::default_data_dir();
        let db_path = data_dir.join("chatapp.db");
        let username = Self::default_username();
        let display_name = username.clone();
        Config {
            username,
            display_name,
            port: 7878,
            data_dir,
            db_path,
        }
    }
}

fn config_path() -> PathBuf {
    Config::default_data_dir().join("config.toml")
}

pub fn load_or_create() -> Result<Config> {
    let path = config_path();

    if path.exists() {
        let contents = fs::read_to_string(&path)
            .with_context(|| format!("Failed to read config file: {}", path.display()))?;
        let config: Config = toml::from_str(&contents)
            .with_context(|| "Failed to parse config.toml")?;
        Ok(config)
    } else {
        let config = Config::default();
        save(&config)?;
        Ok(config)
    }
}

pub fn save(config: &Config) -> Result<()> {
    let path = config_path();

    // Ensure the data directory exists
    fs::create_dir_all(&config.data_dir)
        .with_context(|| format!("Failed to create data directory: {}", config.data_dir.display()))?;

    let contents = toml::to_string_pretty(config)
        .with_context(|| "Failed to serialize config")?;

    fs::write(&path, contents)
        .with_context(|| format!("Failed to write config file: {}", path.display()))?;

    Ok(())
}
