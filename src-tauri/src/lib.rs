//! Virtual AutoFisher backend (Tauri 2).

pub mod config;
pub mod discord;
pub mod dpapi;
pub mod engine;
pub mod ipc;
pub mod logger;
pub mod model;
pub mod parser;
pub mod paths;
pub mod persist;

use config::ConfigStore;
use discord::{DiscordClient, GatewayConfig, LiveClient};
use engine::core::EngineCore;
use ipc::commands::{self, AppCore, AppDeps};
use ipc::events::{tauri_event_name, Emitter};
use logger::Logger;
use paths::{data_dir, Paths};
use std::sync::Arc;

/// Backend events to the webview (v1 channel names, `.` mapped to `:`).
struct TauriEmitter(tauri::AppHandle);

impl Emitter for TauriEmitter {
    fn emit(&self, channel: &str, payload: serde_json::Value) {
        use tauri::Emitter as _;
        let _ = self.0.emit(&tauri_event_name(channel), payload);
    }
}

fn open_folder(path: &std::path::Path) -> anyhow::Result<()> {
    std::process::Command::new("explorer").arg(path).spawn()?;
    Ok(())
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager as _;
    let paths = Paths::new(data_dir());
    paths.ensure()?;
    let logger = Arc::new(Logger::new(paths.logs.clone()));
    logger.info(&format!("Virtual AutoFisher {} starting", env!("CARGO_PKG_VERSION")));
    let mut config = ConfigStore::new(&paths, Arc::new(dpapi::DpapiCipher), logger.clone());
    config.load();
    let client: Arc<dyn DiscordClient> = Arc::new(LiveClient::new(GatewayConfig::default(), logger.clone()));
    let deps = AppDeps {
        paths,
        config,
        client,
        emitter: Arc::new(TauriEmitter(app.handle().clone())),
        logger,
        opener: Box::new(open_folder),
        core: EngineCore::new(rand::random()),
    };
    let core = tauri::async_runtime::block_on(async { AppCore::start(deps) });
    // the connection status is buffered (auth_status), so a renderer that loads later still sees it
    tauri::async_runtime::spawn(core.auto_login());
    app.manage(core);
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .setup(setup)
        .invoke_handler(tauri::generate_handler![
            commands::auth_set_token,
            commands::auth_logout,
            commands::auth_status,
            commands::guilds_list,
            commands::channels_list,
            commands::target_set,
            commands::engine_start,
            commands::engine_pause,
            commands::engine_resume,
            commands::engine_stop,
            commands::engine_commands,
            commands::engine_status,
            commands::command_send,
            commands::captcha_submit,
            commands::captcha_regen,
            commands::config_get,
            commands::config_update,
            commands::app_open_data_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Virtual AutoFisher");
}
