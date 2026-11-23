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
pub mod shell;

use config::ConfigStore;
use discord::{DiscordClient, GatewayConfig, LiveClient};
use engine::core::EngineCore;
use ipc::commands::{self, AppCore, AppDeps};
use logger::Logger;
use paths::{data_dir, Paths};
use std::sync::Arc;

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
        emitter: Arc::new(shell::TauriEmitter::new(app.handle().clone())),
        logger,
        opener: Box::new(open_folder),
        core: EngineCore::new(rand::random()),
    };
    let core = tauri::async_runtime::block_on(async { AppCore::start(deps) });
    // the connection status is buffered (auth_status), so a renderer that loads later still sees it
    tauri::async_runtime::spawn(core.auto_login());
    app.manage(core);
    shell::create_tray(app.handle())?;
    Ok(())
}

pub fn run() {
    use std::sync::atomic::Ordering;
    use tauri::{Manager as _, RunEvent, WindowEvent};
    tauri::Builder::default()
        // first plugin: a second launch only focuses the running window
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| shell::show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .setup(setup)
        .on_window_event(|w, ev| {
            // close = hide to the tray (unless disabled); a real quit goes through the tray menu
            if let WindowEvent::CloseRequested { api, .. } = ev {
                let to_tray = w.app_handle().try_state::<Arc<AppCore>>().is_some_and(|c| c.config_get().ui.close_to_tray);
                if to_tray && !shell::QUITTING.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = w.hide();
                }
            }
        })
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
        .build(tauri::generate_context!())
        .expect("error while building Virtual AutoFisher")
        .run(|app, ev| {
            // every exit (last window closed, tray Quit) goes through the quit path once
            if let RunEvent::ExitRequested { api, .. } = ev {
                if !shell::QUITTING.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    shell::quit(app);
                }
            }
        });
}
