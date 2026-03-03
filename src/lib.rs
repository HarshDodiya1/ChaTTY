// Several features (file transfer UI, crypto, group panel) are fully implemented
// but not yet wired into the main event loop. Suppress dead_code until they are.
#![allow(dead_code)]

pub mod app;
pub mod config;
pub mod db;
pub mod handlers;
pub mod network;
pub mod ui;
pub mod utils;
