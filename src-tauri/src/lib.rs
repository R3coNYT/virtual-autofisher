//! Virtual AutoFisher backend (Tauri 2).

pub mod config;
pub mod discord;
pub mod engine;
pub mod dpapi;
pub mod logger;
pub mod model;
pub mod parser;
pub mod paths;

pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Virtual AutoFisher");
}
