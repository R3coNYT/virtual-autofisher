//! IPC commands (port of v1 `handlers.ts`). `AppCore` holds the logic without Tauri types (tested
//! directly); the `#[tauri::command]` wrappers at the bottom only forward to it. Errors cross to the
//! renderer as masked strings; the token never does (`public_config`, no payload carries it).

use super::events::{Emitter, Relay};
use crate::config::{public_config, ConfigStore};
use crate::discord::{DiscordClient, DiscordEvent, LoginError};
use crate::engine::actor::{spawn_engine_with, EngineHandle};
use crate::engine::core::{EngineCore, EngineInput, NO_CHANNEL};
use crate::logger::{mask_secrets, Logger};
use crate::model::{AuthStatus, ChannelInfo, Config, ConnectionEvent, ConnectionStatus, EngineState, EngineStatus, GuildInfo, SelfUser, SlashCommandInfo, SlashOptions, Target};
use crate::paths::Paths;
use crate::persist::state_store::StateStore;
use crate::persist::wire::StatePersistence;
use serde_json::{json, Value};
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

const RETRY_DELAYS_MS: [u64; 3] = [30_000, 60_000, 120_000];

pub type Opener = Box<dyn Fn(&Path) -> anyhow::Result<()> + Send + Sync>;
type BoxFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

fn masked(e: impl std::fmt::Display) -> String {
    mask_secrets(&e.to_string())
}

/// Discord ids only (`^\d{5,25}$`).
fn assert_id(v: &str, what: &str) -> Result<(), String> {
    if (5..=25).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_digit()) {
        Ok(())
    } else {
        Err(format!("Invalid {what} id"))
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub struct AppDeps {
    pub paths: Paths,
    pub config: ConfigStore,
    pub client: Arc<dyn DiscordClient>,
    pub emitter: Arc<dyn Emitter>,
    pub logger: Arc<Logger>,
    pub opener: Opener,
    pub core: EngineCore,
}

#[derive(Default)]
struct Auth {
    user: Option<SelfUser>,
    connection: Option<ConnectionEvent>,
    attempt: usize,
    retry: Option<JoinHandle<()>>,
}

pub struct AppCore {
    config: Mutex<ConfigStore>,
    client: Arc<dyn DiscordClient>,
    engine: EngineHandle,
    store: Arc<Mutex<StateStore>>,
    emitter: Arc<dyn Emitter>,
    logger: Arc<Logger>,
    paths: Paths,
    opener: Opener,
    auth: Mutex<Auth>,
    /// Bumped by every manual setToken: stale auto-login results are ignored.
    login_gen: AtomicU64,
    /// Waits until the relay has handled every effect queued so far (quit path: session file written).
    relay_barrier: mpsc::UnboundedSender<oneshot::Sender<()>>,
}

impl AppCore {
    /// Spawns the engine actor (hydrated from state.json) and the event relay. Needs a tokio runtime.
    pub fn start(d: AppDeps) -> Arc<Self> {
        let store = Arc::new(Mutex::new(StateStore::new(d.paths.root.clone(), d.logger.clone())));
        let (out_tx, out_rx) = mpsc::channel(1024);
        let persist = StatePersistence::new(store.clone(), d.logger.clone());
        let (barrier_tx, barrier_rx) = mpsc::unbounded_channel();
        let engine = spawn_engine_with(d.core, d.client.clone(), d.config.subscribe(), out_tx, Some(persist));
        let app = Arc::new(Self {
            config: Mutex::new(d.config),
            client: d.client,
            engine,
            store,
            emitter: d.emitter,
            logger: d.logger,
            paths: d.paths,
            opener: d.opener,
            auth: Mutex::new(Auth::default()),
            login_gen: AtomicU64::new(0),
            relay_barrier: barrier_tx,
        });
        app.apply_capture();
        tokio::spawn(relay_loop(app.clone(), out_rx, barrier_rx));
        app
    }

    fn cfg(&self) -> Config {
        lock(&self.config).get()
    }

    async fn state(&self) -> EngineState {
        self.engine.status().await.map_or(EngineState::Idle, |s| s.state)
    }

    fn set_connection(&self, status: ConnectionStatus, message: Option<String>) {
        let ev = ConnectionEvent { status, message };
        lock(&self.auth).connection = Some(ev.clone());
        self.emitter.emit("connection.status", serde_json::to_value(ev).unwrap_or(Value::Null));
    }

    fn apply_capture(&self) {
        let dir = self.cfg().capture.then(|| self.paths.captures.clone());
        self.client.set_capture_dir(dir);
    }

    fn seed_vf(&self) {
        let map = lock(&self.store).vf_guilds();
        self.client.seed_vf_cache(map.into_iter().collect());
    }

    /// Manual mode: listen to the target channel and load its commands without a session, so the quick
    /// commands work while idle (a failure is toasted by the engine, the list emptied).
    fn load_commands(&self) {
        if let Some(target) = self.cfg().target {
            self.engine.send(EngineInput::UseTarget { target });
        }
    }

    fn cancel_retry(&self) {
        let mut a = lock(&self.auth);
        if let Some(h) = a.retry.take() {
            h.abort();
        }
        a.attempt = 0;
    }

    /// Cancels the pending auto-login retry (quit).
    pub fn dispose(&self) {
        self.cancel_retry();
    }

    // ---- auth -------------------------------------------------------------------------

    pub async fn auth_set_token(&self, token: String) -> Result<SelfUser, String> {
        self.login_gen.fetch_add(1, Ordering::SeqCst);
        self.cancel_retry();
        self.set_connection(ConnectionStatus::Connecting, None);
        // validate first: a bad token must not touch the running session
        let me = match self.client.login(&token).await {
            Ok(u) => u,
            Err(e) => {
                let has_user = lock(&self.auth).user.is_some();
                self.set_connection(if has_user { ConnectionStatus::Connected } else { ConnectionStatus::Disconnected }, None);
                return Err(masked(e));
            }
        };
        self.cancel_retry();
        self.engine.send(EngineInput::Detach); // possibly another account: forget the channel and its commands
        let stored = lock(&self.config).set_token(&token);
        if let Err(e) = stored {
            self.client.logout().await;
            return Err(masked(e));
        }
        lock(&self.auth).user = Some(me.clone());
        self.seed_vf();
        self.set_connection(ConnectionStatus::Connected, None);
        self.load_commands();
        Ok(me)
    }

    pub async fn auth_logout(&self) -> Result<(), String> {
        self.cancel_retry();
        self.engine.send(EngineInput::Detach); // stops listening to the channel
        self.client.logout().await;
        lock(&self.config).clear_token();
        lock(&self.auth).user = None;
        self.cancel_retry();
        self.set_connection(ConnectionStatus::Disconnected, None);
        Ok(())
    }

    pub fn auth_status(&self) -> AuthStatus {
        let (user, connection) = {
            let a = lock(&self.auth);
            (a.user.clone(), a.connection.clone())
        };
        let cfg = lock(&self.config);
        AuthStatus { user, target: cfg.get().target, has_token: cfg.token().is_some(), connection }
    }

    /// Logs in with the stored token. Auth rejection clears it; network errors keep it and retry with
    /// backoff (30 s, 60 s, then every 120 s).
    pub fn auto_login(self: &Arc<Self>) -> BoxFuture {
        let me = self.clone();
        Box::pin(async move {
            lock(&me.auth).retry = None; // the timer that got us here (if any) is done
            let Some(token) = lock(&me.config).token() else { return };
            let gen = me.login_gen.load(Ordering::SeqCst);
            me.set_connection(ConnectionStatus::Connecting, None);
            let res = me.client.login(&token).await;
            if gen != me.login_gen.load(Ordering::SeqCst) {
                return; // a manual setToken started meanwhile
            }
            match res {
                Ok(user) => {
                    {
                        let mut a = lock(&me.auth);
                        a.user = Some(user);
                        a.attempt = 0;
                    }
                    me.seed_vf();
                    me.set_connection(ConnectionStatus::Connected, None);
                    me.load_commands();
                }
                Err(LoginError::Network) => {
                    lock(&me.auth).user = None;
                    me.set_connection(ConnectionStatus::Disconnected, Some(LoginError::Network.to_string()));
                    let mut a = lock(&me.auth);
                    let delay = RETRY_DELAYS_MS[a.attempt.min(RETRY_DELAYS_MS.len() - 1)];
                    a.attempt += 1;
                    let again = me.clone();
                    a.retry = Some(tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                        again.auto_login().await;
                    }));
                }
                Err(_) => {
                    lock(&me.auth).user = None;
                    lock(&me.config).clear_token();
                    me.set_connection(ConnectionStatus::InvalidToken, None);
                }
            }
        })
    }

    // ---- discord lookups / target ------------------------------------------------------------

    /// `refresh`: forget which servers have Virtual Fisher (also the persisted map) and check them all again.
    pub async fn guilds_list(&self, refresh: bool) -> Result<Vec<GuildInfo>, String> {
        if refresh {
            if let Err(e) = lock(&self.store).set_vf_guilds(Default::default()) {
                self.logger.warn(&format!("Unable to save the server cache: {e}"));
            }
        }
        let list = self.client.list_guilds(refresh).await.map_err(masked)?;
        let cache = self.client.vf_cache().into_iter().collect();
        if let Err(e) = lock(&self.store).set_vf_guilds(cache) {
            self.logger.warn(&format!("Unable to save the server cache: {e}"));
        }
        Ok(list)
    }

    pub async fn channels_list(&self, guild_id: String) -> Result<Vec<ChannelInfo>, String> {
        assert_id(&guild_id, "server")?;
        self.client.list_channels(&guild_id).await.map_err(masked)
    }

    pub async fn target_set(&self, guild_id: String, channel_id: String) -> Result<(), String> {
        assert_id(&guild_id, "server")?;
        assert_id(&channel_id, "channel")?;
        let was = self.state().await;
        if was == EngineState::Captcha {
            return Err("Solve the captcha before changing channel".into());
        }
        let target = Target { guild_id, channel_id };
        lock(&self.config).update(json!({ "target": target }));
        match was {
            EngineState::Running | EngineState::Resting => {
                self.engine.send(EngineInput::Start { target }); // stops the old session itself
                return Ok(());
            }
            EngineState::Paused | EngineState::Stopping => self.engine.send(EngineInput::Stop { graceful: false }), // resuming would fish in the old channel
            _ => {}
        }
        self.load_commands(); // idle: listen to the new channel, commands of its guild (emitted)
        Ok(())
    }

    // ---- engine ------------------------------------------------------------------------------

    pub fn engine_start(&self) -> Result<(), String> {
        let target = self.cfg().target.ok_or("No channel selected")?;
        self.engine.send(EngineInput::Start { target });
        Ok(())
    }
    pub fn engine_pause(&self) {
        self.engine.send(EngineInput::Pause);
    }
    pub fn engine_resume(&self) {
        self.engine.send(EngineInput::Resume);
    }
    /// Graceful unless told otherwise; during a captcha "Stop" always means now.
    pub async fn engine_stop(&self, graceful: Option<bool>) {
        let graceful = graceful != Some(false) && self.state().await != EngineState::Captcha;
        self.engine.send(EngineInput::Stop { graceful });
    }
    pub async fn engine_commands(&self) -> Vec<SlashCommandInfo> {
        self.engine.commands().await
    }
    pub async fn engine_status(&self) -> Result<EngineStatus, String> {
        self.engine.status().await.ok_or_else(|| "Engine unavailable".to_string())
    }
    pub async fn command_send(&self, name: String, options: Option<SlashOptions>) -> Result<(), String> {
        let st = self.state().await;
        if matches!(st, EngineState::Idle | EngineState::Error) && self.cfg().target.is_none() {
            return Err(NO_CHANNEL.into());
        }
        self.engine.send(EngineInput::SendManual { name, options: options.unwrap_or_default() });
        Ok(())
    }
    pub fn captcha_submit(&self, answer: String) {
        self.engine.send(EngineInput::SubmitCaptcha(answer));
    }
    pub fn captcha_regen(&self) {
        self.engine.send(EngineInput::RegenCaptcha);
    }

    // ---- config / app ------------------------------------------------------------------------

    pub fn config_get(&self) -> Config {
        public_config(&self.cfg())
    }

    /// Token and target are not writable here (target: `target_set`).
    pub fn config_update(&self, patch: Value) -> Config {
        let mut patch = patch;
        if let Some(o) = patch.as_object_mut() {
            o.remove("tokenEncrypted");
            o.remove("target");
        }
        let c = lock(&self.config).update(patch);
        self.apply_capture();
        public_config(&c)
    }

    pub fn app_open_data_dir(&self) -> Result<(), String> {
        (self.opener)(&self.paths.root).map_err(masked)
    }

    /// Quit path: no retry, halt at once (session summary written), state saved, logged out.
    pub async fn shutdown(&self) {
        self.dispose();
        self.engine.send(EngineInput::Stop { graceful: false });
        self.engine.flush().await; // the actor has queued the session end before replying
        let (tx, rx) = oneshot::channel();
        if self.relay_barrier.send(tx).is_ok() {
            let _ = rx.await;
        }
        self.client.logout().await;
    }

    /// Toast shown by the renderer (tray actions).
    pub fn toast(&self, t: &crate::model::Toast) {
        self.emitter.emit("toast", serde_json::to_value(t).unwrap_or(Value::Null));
    }

    pub fn log_warn(&self, msg: &str) {
        self.logger.warn(msg);
    }

    pub fn engine(&self) -> &EngineHandle {
        &self.engine
    }
}

async fn relay_loop(
    app: Arc<AppCore>,
    mut rx: mpsc::Receiver<crate::engine::core::Effect>,
    mut barrier: mpsc::UnboundedReceiver<oneshot::Sender<()>>,
) {
    let mut relay = Relay::new(app.emitter.clone(), app.logger.clone(), app.paths.sessions.clone());
    let mut events = app.client.subscribe();
    let mut events_open = true;
    loop {
        tokio::select! {
            biased;
            e = rx.recv() => match e {
                Some(e) => relay.on_effect(e),
                None => return,
            },
            ev = events.recv(), if events_open => match ev {
                Ok(DiscordEvent::Disconnected) => app.set_connection(ConnectionStatus::Disconnected, None),
                Ok(DiscordEvent::Reconnected) => app.set_connection(ConnectionStatus::Connected, None),
                Err(RecvError::Closed) => events_open = false,
                _ => {}
            },
            Some(reply) = barrier.recv() => {
                while let Ok(e) = rx.try_recv() {
                    relay.on_effect(e);
                }
                let _ = reply.send(());
            }
        }
    }
}

// ---- Tauri commands ----------------------------------------------------------------------------

type AppState<'a> = tauri::State<'a, Arc<AppCore>>;

fn logged<T>(app: &AppCore, cmd: &str, r: Result<T, String>) -> Result<T, String> {
    if let Err(e) = &r {
        app.logger.warn(&format!("ipc {cmd} failed: {e}"));
    }
    r
}

#[tauri::command]
pub async fn auth_set_token(app: AppState<'_>, token: String) -> Result<SelfUser, String> {
    let r = app.auth_set_token(token).await;
    logged(&app, "auth_set_token", r)
}
#[tauri::command]
pub async fn auth_logout(app: AppState<'_>) -> Result<(), String> {
    app.auth_logout().await
}
#[tauri::command]
pub async fn auth_status(app: AppState<'_>) -> Result<AuthStatus, String> {
    Ok(app.auth_status())
}
#[tauri::command]
pub async fn guilds_list(app: AppState<'_>, refresh: Option<bool>) -> Result<Vec<GuildInfo>, String> {
    let r = app.guilds_list(refresh == Some(true)).await;
    logged(&app, "guilds_list", r)
}
#[tauri::command]
pub async fn channels_list(app: AppState<'_>, guild_id: String) -> Result<Vec<ChannelInfo>, String> {
    let r = app.channels_list(guild_id).await;
    logged(&app, "channels_list", r)
}
#[tauri::command]
pub async fn target_set(app: AppState<'_>, guild_id: String, channel_id: String) -> Result<(), String> {
    let r = app.target_set(guild_id, channel_id).await;
    logged(&app, "target_set", r)
}
#[tauri::command]
pub async fn engine_start(app: AppState<'_>) -> Result<(), String> {
    let r = app.engine_start();
    logged(&app, "engine_start", r)
}
#[tauri::command]
pub async fn engine_pause(app: AppState<'_>) -> Result<(), String> {
    app.engine_pause();
    Ok(())
}
#[tauri::command]
pub async fn engine_resume(app: AppState<'_>) -> Result<(), String> {
    app.engine_resume();
    Ok(())
}
#[tauri::command]
pub async fn engine_stop(app: AppState<'_>, graceful: Option<bool>) -> Result<(), String> {
    app.engine_stop(graceful).await;
    Ok(())
}
#[tauri::command]
pub async fn engine_commands(app: AppState<'_>) -> Result<Vec<SlashCommandInfo>, String> {
    Ok(app.engine_commands().await)
}
#[tauri::command]
pub async fn engine_status(app: AppState<'_>) -> Result<EngineStatus, String> {
    app.engine_status().await
}
#[tauri::command]
pub async fn command_send(app: AppState<'_>, name: String, options: Option<SlashOptions>) -> Result<(), String> {
    let r = app.command_send(name, options).await;
    logged(&app, "command_send", r)
}
#[tauri::command]
pub async fn captcha_submit(app: AppState<'_>, answer: String) -> Result<(), String> {
    app.captcha_submit(answer);
    Ok(())
}
#[tauri::command]
pub async fn captcha_regen(app: AppState<'_>) -> Result<(), String> {
    app.captcha_regen();
    Ok(())
}
#[tauri::command]
pub async fn config_get(app: AppState<'_>) -> Result<Config, String> {
    Ok(app.config_get())
}
#[tauri::command]
pub async fn config_update(app: AppState<'_>, patch: Value) -> Result<Config, String> {
    Ok(app.config_update(patch))
}
#[tauri::command]
pub async fn app_open_data_dir(app: AppState<'_>) -> Result<(), String> {
    let r = app.app_open_data_dir();
    logged(&app, "app_open_data_dir", r)
}
