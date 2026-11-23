//! AppCore scenarios, ported from v1 `handlers.test.ts` and the persistence cases of
//! `dailyPersistence.test.ts`. Real engine actor + fake Discord, tokio time paused.

use super::commands::{AppCore, AppDeps};
use super::events::Emitter;
use crate::config::ConfigStore;
use crate::discord::fake::FakeClient;
use crate::discord::{DiscordClient, DiscordEvent, LoginError};
use crate::dpapi::Cipher;
use crate::engine::core::EngineCore;
use crate::engine::sim::{content, embed, fixture, one_fish};
use crate::logger::Logger;
use crate::model::{BotMessage, EngineState as S, GuildInfo};
use crate::paths::Paths;
use crate::persist::state_store::StateStore;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const TOKEN: &str = "MTExMjIyMzMzNDQ0NTU1NjY2.GabcdE.abcdefghijklmnopqrstuvwxyz0";

struct B64Cipher;
impl Cipher for B64Cipher {
    fn encrypt(&self, s: &str) -> anyhow::Result<String> {
        Ok(format!("dpapi:{}", STANDARD.encode(s)))
    }
    fn decrypt(&self, s: &str) -> anyhow::Result<String> {
        Ok(String::from_utf8(STANDARD.decode(s.trim_start_matches("dpapi:"))?)?)
    }
    fn available(&self) -> bool {
        true
    }
}
fn enc() -> String {
    format!("dpapi:{}", STANDARD.encode(TOKEN))
}

#[derive(Default)]
struct Rec(Mutex<Vec<(String, Value)>>);
impl Emitter for Rec {
    fn emit(&self, channel: &str, payload: Value) {
        self.0.lock().unwrap().push((channel.into(), payload));
    }
}

struct T {
    _dir: tempfile::TempDir,
    root: PathBuf,
    app: Arc<AppCore>,
    client: Arc<FakeClient>,
    rec: Arc<Rec>,
    opened: Arc<Mutex<Vec<PathBuf>>>,
}

impl T {
    fn sent(&self) -> Vec<(String, Value)> {
        self.rec.0.lock().unwrap().clone()
    }
    fn channel(&self, c: &str) -> Vec<Value> {
        self.sent().into_iter().filter(|(ch, _)| ch == c).map(|(_, v)| v).collect()
    }
    fn statuses(&self) -> Vec<Value> {
        self.channel("connection.status")
    }
    fn toasts(&self) -> Vec<String> {
        self.channel("toast").iter().map(|t| t["message"].as_str().unwrap().to_string()).collect()
    }
    async fn state(&self) -> S {
        self.app.engine_status().await.unwrap().state
    }
    fn config(&self) -> ConfigStore {
        let paths = Paths::new(self.root.clone());
        let mut c = ConfigStore::new(&paths, Arc::new(B64Cipher), Arc::new(Logger::new(paths.logs.clone())));
        c.load();
        c
    }
}

/// Lets the actor, its spawned Discord calls and the relay run (no time passes).
async fn settle() {
    for _ in 0..200 {
        tokio::task::yield_now().await;
    }
}
async fn advance(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
    settle().await;
}

struct Opts {
    token: bool,
    target: bool,
    persisted_vf: bool,
    core: EngineCore,
}
impl Default for Opts {
    fn default() -> Self {
        Self { token: false, target: false, persisted_vf: true, core: EngineCore::with_rand(Box::new(|| 0.5)) }
    }
}

async fn setup_with(o: Opts) -> T {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let paths = Paths::new(root.clone());
    let logger = Arc::new(Logger::new(paths.logs.clone()));
    if o.persisted_vf {
        StateStore::new(root.clone(), logger.clone()).set_vf_guilds([("old".to_string(), true)].into_iter().collect()).unwrap();
    }
    let mut config = ConfigStore::new(&paths, Arc::new(B64Cipher), logger.clone());
    config.load();
    if o.token {
        config.set_token(TOKEN).unwrap();
    }
    if o.target {
        config.update(json!({ "target": { "guildId": "10001", "channelId": "20001" } }));
    }
    let client = FakeClient::new();
    let rec = Arc::new(Rec::default());
    let opened = Arc::new(Mutex::new(vec![]));
    let o2 = opened.clone();
    let app = AppCore::start(AppDeps {
        paths,
        config,
        client: client.clone(),
        emitter: rec.clone(),
        logger,
        opener: Box::new(move |p| {
            o2.lock().unwrap().push(p.to_path_buf());
            Ok(())
        }),
        core: o.core,
    });
    settle().await;
    T { _dir: dir, root, app, client, rec, opened }
}
async fn setup() -> T {
    setup_with(Opts::default()).await
}
async fn setup_target() -> T {
    setup_with(Opts { target: true, ..Default::default() }).await
}
fn fx(name: &str) -> BotMessage {
    fixture(name)
}

#[tokio::test(start_paused = true)]
async fn set_token_stores_the_token_and_returns_the_user() {
    let t = setup().await;
    let user = t.app.auth_set_token(TOKEN.into()).await.unwrap();
    assert_eq!(user.username, "tester");
    assert_eq!(t.config().token().as_deref(), Some(TOKEN));
}

#[tokio::test(start_paused = true)]
async fn set_token_failure_rejects_and_stores_nothing() {
    let t = setup().await;
    *t.client.fail_login.lock().unwrap() = Some(LoginError::InvalidToken);
    assert_eq!(t.app.auth_set_token(TOKEN.into()).await.unwrap_err(), "Invalid or expired token");
    assert_eq!(t.config().token(), None);
}

#[tokio::test(start_paused = true)]
async fn config_get_and_update_never_expose_the_token() {
    let t = setup().await;
    t.app.auth_set_token(TOKEN.into()).await.unwrap();
    assert_eq!(t.config().get().token_encrypted, Some(enc()));
    let got = serde_json::to_value(t.app.config_get()).unwrap();
    assert!(got.get("tokenEncrypted").is_none());
    let updated = serde_json::to_value(t.app.config_update(json!({ "sessionLimitH": 2, "tokenEncrypted": "evil" }))).unwrap();
    assert!(updated.get("tokenEncrypted").is_none());
    assert_eq!(updated["sessionLimitH"], json!(2.0));
    assert_eq!(t.config().get().token_encrypted, Some(enc())); // the renderer cannot overwrite it
}

#[tokio::test(start_paused = true)]
async fn no_token_in_any_payload() {
    let t = setup_with(Opts { token: true, ..Default::default() }).await;
    let mut results: Vec<Value> = vec![];
    t.app.auto_login().await;
    settle().await;
    *t.client.guilds.lock().unwrap() = vec![GuildInfo { id: "10001".into(), name: "G".into(), icon_url: None, has_virtual_fisher: true }];
    results.push(serde_json::to_value(t.app.guilds_list(false).await.unwrap()).unwrap());
    t.app.target_set("10001".into(), "20001".into()).await.unwrap();
    results.push(serde_json::to_value(t.app.config_update(json!({ "capture": true }))).unwrap());
    t.app.engine_start().unwrap();
    settle().await;
    t.client.emit_bot(fx("catch-basic"));
    t.client.emit_bot(fx("captcha-image"));
    t.client.emit(DiscordEvent::Disconnected);
    t.client.emit(DiscordEvent::Reconnected);
    settle().await;
    t.app.captcha_submit("abc".into());
    results.push(serde_json::to_value(t.app.auth_status()).unwrap());
    results.push(serde_json::to_value(t.app.engine_status().await.unwrap()).unwrap());
    results.push(serde_json::to_value(t.app.config_get()).unwrap());
    advance(5_000).await;
    t.app.auth_logout().await.unwrap();
    settle().await;
    let sent = t.sent();
    assert!(sent.len() > 5);
    let all = format!("{} {}", serde_json::to_string(&sent).unwrap(), serde_json::to_string(&results).unwrap());
    assert!(!all.contains(TOKEN));
    assert!(!all.contains("dpapi:"));
    assert!(!all.contains("tokenEncrypted"));
    let log = std::fs::read_to_string(t.root.join("logs/app.log")).unwrap_or_default();
    assert!(!log.contains(TOKEN));
    let state = std::fs::read_to_string(t.root.join("state.json")).unwrap();
    assert!(!state.contains(TOKEN) && !state.contains("dpapi:"));
}

#[tokio::test(start_paused = true)]
async fn seeds_the_vf_cache_after_login_and_saves_it_after_guilds_list() {
    let t = setup().await;
    t.app.auth_set_token(TOKEN.into()).await.unwrap();
    assert_eq!(t.client.vf_cache().get("old"), Some(&true));
    *t.client.guilds.lock().unwrap() = vec![GuildInfo { id: "10001".into(), name: "G".into(), icon_url: None, has_virtual_fisher: true }];
    t.app.guilds_list(false).await.unwrap();
    assert_eq!(t.client.list_guilds_calls.lock().unwrap().last(), Some(&false));
    let vf = StateStore::new(t.root.clone(), Arc::new(Logger::new(t.root.join("logs")))).vf_guilds();
    assert_eq!(vf, [("10001".to_string(), true), ("old".to_string(), true)].into_iter().collect());
}

#[tokio::test(start_paused = true)]
async fn guilds_list_refresh_clears_the_persisted_map_and_re_detects() {
    let t = setup().await;
    t.app.auth_set_token(TOKEN.into()).await.unwrap();
    *t.client.guilds.lock().unwrap() = vec![GuildInfo { id: "10001".into(), name: "G".into(), icon_url: None, has_virtual_fisher: false }];
    t.app.guilds_list(true).await.unwrap();
    assert_eq!(t.client.list_guilds_calls.lock().unwrap().last(), Some(&true));
    let vf = StateStore::new(t.root.clone(), Arc::new(Logger::new(t.root.join("logs")))).vf_guilds();
    assert_eq!(vf, [("10001".to_string(), false)].into_iter().collect()); // 'old' is gone
}

#[tokio::test(start_paused = true)]
async fn target_set_persists_the_target_and_restarts_a_running_engine() {
    let t = setup().await;
    t.app.target_set("10001".into(), "20001".into()).await.unwrap();
    settle().await;
    assert_eq!(t.config().get().target.unwrap().channel_id, "20001");
    assert_eq!(t.state().await, S::Idle);
    t.app.engine_start().unwrap();
    settle().await;
    assert_eq!(t.state().await, S::Running);
    t.app.target_set("10001".into(), "20002".into()).await.unwrap();
    settle().await;
    assert_eq!(t.config().get().target.unwrap().channel_id, "20002");
    assert_eq!(t.state().await, S::Running);
    assert_eq!(t.client.active().as_deref(), Some("20002"));
}

#[tokio::test(start_paused = true)]
async fn engine_start_without_a_target_rejects() {
    let t = setup().await;
    assert_eq!(t.app.engine_start().unwrap_err(), "No channel selected");
}

#[tokio::test(start_paused = true)]
async fn engine_stop_writes_the_session_summary_to_sessions() {
    let t = setup_target().await;
    t.app.engine_start().unwrap();
    settle().await;
    t.client.emit_bot(fx("catch-basic"));
    settle().await;
    let started = t.app.engine_status().await.unwrap().snapshot.session.started_at.unwrap();
    t.app.engine_stop(Some(false)).await;
    settle().await;
    let files: Vec<String> = std::fs::read_dir(t.root.join("sessions")).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    assert_eq!(files, [format!("{started}.json")]);
    let summary: Value = serde_json::from_str(&std::fs::read_to_string(t.root.join("sessions").join(&files[0])).unwrap()).unwrap();
    assert_eq!(summary["catches"], json!(3));
    assert!(summary["endedAt"].as_i64().unwrap() > 0);
}

#[tokio::test(start_paused = true)]
async fn token_revoked_mid_session_stops_fishing_clears_the_token_and_reports_it() {
    let t = setup_with(Opts { token: true, target: true, ..Default::default() }).await;
    t.app.auto_login().await;
    t.app.engine_start().unwrap();
    settle().await;
    t.client.emit(DiscordEvent::InvalidToken);
    settle().await;
    assert_eq!(t.config().token(), None);
    assert_eq!(t.statuses().last().unwrap(), &json!({ "status": "invalidToken" }));
    let st = serde_json::to_value(t.app.auth_status()).unwrap();
    assert_eq!((st["user"].clone(), st["hasToken"].clone()), (Value::Null, json!(false)));
    assert_eq!(t.app.engine_status().await.unwrap().state, crate::model::EngineState::Idle);
}

#[tokio::test(start_paused = true)]
async fn shutdown_returns_only_after_the_session_summary_is_written() {
    let t = setup_target().await;
    t.app.engine_start().unwrap();
    settle().await;
    t.client.emit_bot(fx("catch-basic"));
    settle().await;
    t.app.shutdown().await; // no settle: the process exits right after this on quit
    let files = std::fs::read_dir(t.root.join("sessions")).map(|d| d.count()).unwrap_or(0);
    assert_eq!(files, 1);
}

#[tokio::test(start_paused = true)]
async fn engine_stop_is_graceful_by_default_false_halts_at_once() {
    let t = setup_target().await;
    t.app.engine_start().unwrap();
    settle().await;
    t.client.emit_bot(fx("catch-basic"));
    settle().await;
    t.app.engine_stop(None).await;
    settle().await;
    assert_eq!(t.state().await, S::Stopping);
    advance(25_000).await;
    assert_eq!(t.state().await, S::Idle);
    assert_eq!(t.client.names(), ["profile", "profile", "quests"]); // start sends /profile first (data before /fish)

    t.app.engine_start().unwrap();
    settle().await;
    t.app.engine_stop(Some(false)).await;
    settle().await;
    assert_eq!(t.state().await, S::Idle);
    t.app.engine_start().unwrap();
    settle().await;
    t.app.engine_stop(Some(true)).await;
    settle().await;
    assert_eq!(t.state().await, S::Stopping);
    t.app.engine_stop(Some(true)).await; // second click: immediate
    settle().await;
    assert_eq!(t.state().await, S::Idle);
}

#[tokio::test(start_paused = true)]
async fn relays_engine_state_commands_game_patch_log_and_captcha_show_hide() {
    let t = setup_target().await;
    t.app.engine_start().unwrap();
    settle().await;
    let channels = |t: &T| t.sent().into_iter().map(|(c, _)| c).collect::<Vec<_>>();
    for c in ["engine.state", "engine.commands", "game.patch"] {
        assert!(channels(&t).contains(&c.to_string()), "{c}");
    }
    t.client.emit_bot(fx("captcha-image"));
    settle().await;
    assert_eq!(t.channel("captcha.show")[0]["imageUrl"], json!("https://cdn.example.test/captcha/abc123.png"));
    t.client.emit_bot(fx("captcha-solved"));
    advance(20_000).await;
    assert!(channels(&t).contains(&"captcha.hide".to_string()));
    let logs = t.channel("log.append");
    assert!(!logs.is_empty() && logs.iter().all(|l| l.as_array().is_some_and(|a| !a.is_empty())));
    for p in t.channel("game.patch") {
        assert!(p.get("newLog").is_none());
    }
    assert_eq!(t.channel("engine.state")[0], json!({ "state": "connecting", "info": {} }));
}

#[tokio::test(start_paused = true)]
async fn auto_login_valid_token_connects_invalid_is_cleared_and_reported() {
    let a = setup_with(Opts { token: true, ..Default::default() }).await;
    a.app.auto_login().await;
    assert_eq!(a.statuses(), [json!({ "status": "connecting" }), json!({ "status": "connected" })]);
    let st = serde_json::to_value(a.app.auth_status()).unwrap();
    assert_eq!((st["user"]["username"].clone(), st["target"].clone(), st["hasToken"].clone(), st["connection"].clone()), (json!("tester"), Value::Null, json!(true), json!({ "status": "connected" })));

    let b = setup_with(Opts { token: true, ..Default::default() }).await;
    *b.client.fail_login.lock().unwrap() = Some(LoginError::InvalidToken);
    b.app.auto_login().await;
    assert_eq!(b.config().token(), None);
    assert_eq!(b.statuses().last().unwrap(), &json!({ "status": "invalidToken" }));
    let st = serde_json::to_value(b.app.auth_status()).unwrap();
    assert_eq!((st["user"].clone(), st["hasToken"].clone(), st["connection"].clone()), (Value::Null, json!(false), json!({ "status": "invalidToken" })));
}

#[tokio::test(start_paused = true)]
async fn a_bad_token_leaves_a_running_session_untouched() {
    let t = setup_target().await;
    t.app.auth_set_token(TOKEN.into()).await.unwrap();
    settle().await;
    t.app.engine_start().unwrap();
    settle().await;
    *t.client.fail_login.lock().unwrap() = Some(LoginError::InvalidToken);
    assert_eq!(t.app.auth_set_token("bad".into()).await.unwrap_err(), "Invalid or expired token");
    settle().await;
    assert_eq!(t.state().await, S::Running);
    assert_eq!(t.config().token().as_deref(), Some(TOKEN));
    assert_eq!(t.statuses().last().unwrap(), &json!({ "status": "connected" }));
}

fn connecting(t: &T) -> usize {
    t.statuses().iter().filter(|s| s["status"] == "connecting").count()
}

#[tokio::test(start_paused = true)]
async fn auto_login_network_failure_keeps_the_token_and_retries_with_backoff() {
    let t = setup_with(Opts { token: true, ..Default::default() }).await;
    *t.client.fail_login.lock().unwrap() = Some(LoginError::Network);
    t.app.auto_login().await;
    assert_eq!(t.config().token().as_deref(), Some(TOKEN));
    assert_eq!(t.statuses().last().unwrap(), &json!({ "status": "disconnected", "message": "Unable to connect to Discord" }));
    advance(29_000).await;
    assert_eq!(connecting(&t), 1);
    advance(1_500).await; // 30 s: attempt 2, still failing
    assert_eq!(connecting(&t), 2);
    *t.client.fail_login.lock().unwrap() = None;
    advance(60_000).await; // 60 s later: succeeds
    assert_eq!(t.statuses().last().unwrap(), &json!({ "status": "connected" }));
    assert_eq!(t.config().token().as_deref(), Some(TOKEN));
    advance(300_000).await;
    assert_eq!(connecting(&t), 3);
}

#[tokio::test(start_paused = true)]
async fn a_manual_set_token_cancels_the_retry_and_wins_over_an_in_flight_auto_login() {
    let t = setup_with(Opts { token: true, ..Default::default() }).await;
    *t.client.fail_login.lock().unwrap() = Some(LoginError::Network);
    t.app.auto_login().await; // schedules a retry
    *t.client.fail_login.lock().unwrap() = None;
    t.app.auth_set_token(TOKEN.into()).await.unwrap();
    let n = connecting(&t);
    advance(300_000).await;
    assert_eq!(connecting(&t), n); // the retry was cancelled

    // in-flight auto-login superseded by setToken
    let (release, gate) = tokio::sync::oneshot::channel();
    *t.client.login_gate.lock().unwrap() = Some(gate);
    let auto = tokio::spawn(t.app.auto_login());
    settle().await;
    t.app.auth_set_token(TOKEN.into()).await.unwrap();
    release.send(()).unwrap();
    auto.await.unwrap();
    assert_eq!(t.config().token().as_deref(), Some(TOKEN)); // the stale failure did not clear the token
    assert_eq!(t.statuses().last().unwrap(), &json!({ "status": "connected" }));
}

#[tokio::test(start_paused = true)]
async fn dispose_cancels_the_retry_timer() {
    let t = setup_with(Opts { token: true, ..Default::default() }).await;
    *t.client.fail_login.lock().unwrap() = Some(LoginError::Network);
    t.app.auto_login().await;
    let n = t.sent().len();
    t.app.dispose();
    advance(300_000).await;
    assert_eq!(t.sent().len(), n);
}

#[tokio::test(start_paused = true)]
async fn target_set_validates_ids_and_config_update_cannot_set_the_target() {
    let t = setup().await;
    assert_eq!(t.app.target_set("g1".into(), "20001".into()).await.unwrap_err(), "Invalid server id");
    assert_eq!(t.app.target_set("10001".into(), "".into()).await.unwrap_err(), "Invalid channel id");
    assert_eq!(t.app.channels_list("x".into()).await.unwrap_err(), "Invalid server id");
    assert_eq!(t.config().get().target, None);
    t.app.config_update(json!({ "target": { "guildId": "10001", "channelId": "20001" } }));
    assert_eq!(t.config().get().target, None);
}

#[tokio::test(start_paused = true)]
async fn target_set_while_paused_stops_the_engine_and_is_rejected_during_a_captcha() {
    let t = setup_target().await;
    t.app.engine_start().unwrap();
    settle().await;
    t.app.engine_pause();
    settle().await;
    assert_eq!(t.state().await, S::Paused);
    t.app.target_set("10001".into(), "20002".into()).await.unwrap();
    settle().await;
    assert_eq!(t.state().await, S::Idle);
    assert_eq!(t.config().get().target.unwrap().channel_id, "20002");

    t.app.engine_start().unwrap();
    settle().await;
    t.client.emit_bot(fx("captcha-image"));
    settle().await;
    assert_eq!(t.state().await, S::Captcha);
    assert!(t.app.target_set("10001".into(), "20003".into()).await.unwrap_err().contains("captcha"));
    assert_eq!(t.config().get().target.unwrap().channel_id, "20002");
}

#[tokio::test(start_paused = true)]
async fn logout_stops_the_engine_clears_the_token_and_reports_disconnected() {
    let t = setup_target().await;
    t.app.auth_set_token(TOKEN.into()).await.unwrap();
    t.app.engine_start().unwrap();
    settle().await;
    t.app.auth_logout().await.unwrap();
    settle().await;
    assert_eq!(t.state().await, S::Idle);
    assert_eq!(t.config().token(), None);
    assert_eq!(t.statuses().last().unwrap(), &json!({ "status": "disconnected" }));
    assert_eq!(t.client.active(), None);
    assert_eq!(t.channel("engine.commands").last().unwrap(), &json!([]));
}

#[tokio::test(start_paused = true)]
async fn capture_toggles_live_and_open_data_dir_opens_the_data_folder() {
    let t = setup().await;
    assert_eq!(*t.client.capture_dir.lock().unwrap(), Some(None));
    t.app.config_update(json!({ "capture": true }));
    assert_eq!(*t.client.capture_dir.lock().unwrap(), Some(Some(t.root.join("captures"))));
    t.app.config_update(json!({ "capture": false }));
    assert_eq!(*t.client.capture_dir.lock().unwrap(), Some(None));
    t.app.app_open_data_dir().unwrap();
    assert_eq!(*t.opened.lock().unwrap(), std::slice::from_ref(&t.root));
}

#[tokio::test(start_paused = true)]
async fn toasts_no_response_exception_error_and_session_limit() {
    let a = setup_target().await;
    a.app.engine_start().unwrap();
    settle().await;
    // nothing answers: /profile, /daily, /quests, then 3 fish timeouts → paused (noResponse)
    advance(120_000).await;
    assert_eq!(a.state().await, S::Paused);
    assert_eq!(a.toasts(), ["Virtual Fisher is not responding — fishing paused"]);
    a.app.config_update(json!({ "sessionLimitH": 1 }));
    advance(3_600_000).await;
    assert_eq!(a.state().await, S::Idle);
    assert_eq!(a.toasts().last().unwrap(), "Session limit reached — fishing stopped");

    let mut core = EngineCore::with_rand(Box::new(|| 0.5));
    core.panic_on_route = true;
    let b = setup_with(Opts { target: true, core, ..Default::default() }).await;
    b.app.engine_start().unwrap();
    settle().await;
    b.client.emit_bot(fx("catch-basic"));
    settle().await;
    assert_eq!(b.state().await, S::Paused);
    assert_eq!(b.toasts(), ["Unexpected error — fishing paused"]);
    b.app.engine_resume();
    settle().await;
    b.client.emit(DiscordEvent::Disconnected);
    advance(120_000).await;
    assert_eq!(b.state().await, S::Error);
    assert_eq!(b.toasts().last().unwrap(), "Error: Connection to Discord lost for more than 2 minutes");

    // a user pause or a plain stop is not toasted
    let c = setup_target().await;
    c.app.engine_start().unwrap();
    settle().await;
    c.app.engine_pause();
    c.app.engine_stop(None).await;
    advance(30_000).await;
    assert!(c.toasts().is_empty());
}

#[tokio::test(start_paused = true)]
async fn engine_status_rebuilds_after_reload() {
    let t = setup_target().await;
    let st = serde_json::to_value(t.app.engine_status().await.unwrap()).unwrap();
    assert_eq!((st["state"].clone(), st["captcha"].clone(), st["snapshot"]["session"]["catches"].clone()), (json!("idle"), Value::Null, json!(0)));
    t.app.engine_start().unwrap();
    settle().await;
    t.client.emit_bot(fx("catch-basic"));
    settle().await;
    t.app.engine_pause();
    let st = serde_json::to_value(t.app.engine_status().await.unwrap()).unwrap();
    assert_eq!((st["state"].clone(), st["info"]["reason"].clone(), st["captcha"].clone()), (json!("paused"), json!("user"), Value::Null));
    t.client.emit_bot(fx("captcha-image"));
    settle().await;
    let st = serde_json::to_value(t.app.engine_status().await.unwrap()).unwrap();
    assert_eq!(st["state"], json!("captcha"));
    assert_eq!(st["captcha"]["imageUrl"], json!("https://cdn.example.test/captcha/abc123.png"));
    assert!(st["captcha"]["text"].as_str().unwrap().to_lowercase().contains("captcha"));
    assert_eq!((st["snapshot"]["session"]["catches"].clone(), st["snapshot"]["session"]["captchas"].clone()), (json!(3), json!(1)));
    assert!(!st["snapshot"]["log"].as_array().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn captcha_solved_shows_solved_then_hides() {
    let t = setup_target().await;
    t.app.engine_start().unwrap();
    settle().await;
    t.client.emit_bot(fx("captcha-image"));
    t.client.emit_bot(fx("captcha-solved"));
    settle().await;
    assert_eq!(
        t.channel("captcha.show").last().unwrap(),
        &json!({ "imageUrl": "https://cdn.example.test/captcha/abc123.png", "text": "Captcha solved — resuming in a few seconds…", "solved": true })
    );
    assert_eq!(serde_json::to_value(t.app.engine_status().await.unwrap()).unwrap()["captcha"]["solved"], json!(true));
    advance(15_000).await;
    assert_eq!(t.channel("captcha.hide").len(), 1);
}

#[tokio::test(start_paused = true)]
async fn target_set_while_idle_loads_the_commands_and_command_send_works_idle() {
    let t = setup().await;
    t.app.target_set("10001".into(), "20001".into()).await.unwrap();
    settle().await;
    assert_eq!(t.state().await, S::Idle);
    assert_eq!(t.client.active().as_deref(), Some("20001"));
    let emitted = t.channel("engine.commands");
    assert_eq!(emitted.len(), 1);
    assert!(emitted[0].as_array().unwrap().iter().any(|c| c["name"] == "profile"));

    t.app.command_send("profile".into(), None).await.unwrap();
    settle().await;
    assert_eq!(t.client.names(), ["profile"]);
    assert_eq!(t.client.sent.lock().unwrap()[0].0, "20001");
    t.client.emit_bot(fx("catch-basic"));
    advance(10 * 60_000).await;
    assert_eq!(t.client.names(), ["profile"]); // no fishing started
    assert_eq!(t.state().await, S::Idle);
}

#[tokio::test(start_paused = true)]
async fn command_send_without_a_channel_is_refused() {
    let t = setup().await;
    assert_eq!(t.app.command_send("profile".into(), None).await.unwrap_err(), "Choose a channel first");
}

#[tokio::test(start_paused = true)]
async fn commands_are_loaded_after_auto_login_and_set_token_when_a_target_exists() {
    let a = setup_with(Opts { token: true, target: true, ..Default::default() }).await;
    a.app.auto_login().await;
    settle().await;
    assert!(a.channel("engine.commands").iter().any(|c| !c.as_array().unwrap().is_empty()));
    assert_eq!(a.client.active().as_deref(), Some("20001"));

    let b = setup_target().await;
    b.app.auth_set_token(TOKEN.into()).await.unwrap();
    settle().await;
    assert_ne!(b.channel("engine.commands").last().unwrap(), &json!([]));
    assert_eq!(b.client.active().as_deref(), Some("20001"));
}

#[tokio::test(start_paused = true)]
async fn failing_to_load_the_commands_toasts_and_empties_the_list_login_still_succeeds() {
    let t = setup_target().await;
    t.client.fail_commands.store(true, std::sync::atomic::Ordering::SeqCst);
    t.app.auth_set_token(TOKEN.into()).await.unwrap();
    settle().await;
    assert_eq!(t.channel("engine.commands").last().unwrap(), &json!([]));
    assert!(t.toasts().contains(&"Unable to load the Virtual Fisher commands".to_string()));
    assert!(t.statuses().iter().any(|s| s["status"] == "connected"));
}

#[tokio::test(start_paused = true)]
async fn a_plain_stop_keeps_the_channel() {
    let t = setup_target().await;
    t.app.auth_set_token(TOKEN.into()).await.unwrap();
    t.app.engine_start().unwrap();
    settle().await;
    t.app.engine_stop(Some(false)).await;
    settle().await;
    assert_eq!(t.client.active().as_deref(), Some("20001"));
}

#[tokio::test(start_paused = true)]
async fn engine_stop_during_a_captcha_is_idle_hides_it_and_sends_nothing() {
    let t = setup_target().await;
    t.app.engine_start().unwrap();
    settle().await;
    t.client.emit_bot(fx("captcha-image"));
    settle().await;
    let before = t.client.names().len();
    t.app.engine_stop(None).await;
    settle().await;
    assert_eq!(t.state().await, S::Idle);
    assert_eq!(t.channel("captcha.hide").len(), 1);
    advance(60_000).await;
    assert_eq!(t.client.names().len(), before);
    assert!(!t.client.names().contains(&"verify".to_string()));
}

// ---- persistence through the app ------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn hydrates_at_boot_and_saves_on_account_change_next_daily_and_session_end() {
    let dir = tempfile::tempdir().unwrap();
    let logger = Arc::new(Logger::new(dir.path().join("logs")));
    std::fs::write(
        dir.path().join("state.json"),
        r#"{"version":1,"account":{"balance":777,"level":3},"nextDailyAt":null,"vfGuilds":{},"savedAt":1}"#,
    )
    .unwrap();
    let paths = Paths::new(dir.path().to_path_buf());
    let mut config = ConfigStore::new(&paths, Arc::new(B64Cipher), logger.clone());
    config.load();
    config.update(json!({ "target": { "guildId": "10001", "channelId": "20001" }, "daily": { "enabled": false }, "quests": { "enabled": false } }));
    let client = FakeClient::new();
    let app = AppCore::start(AppDeps {
        paths,
        config,
        client: client.clone(),
        emitter: Arc::new(Rec::default()),
        logger: logger.clone(),
        opener: Box::new(|_| Ok(())),
        core: EngineCore::with_rand(Box::new(|| 0.5)),
    });
    settle().await;
    // shown before any login or /profile
    let snap = app.engine_status().await.unwrap().snapshot;
    assert_eq!((snap.account.balance, snap.account.level, snap.session.catches), (Some(777), Some(3), 0));

    let saved = || StateStore::new(dir.path().to_path_buf(), logger.clone()).load().unwrap();
    app.engine_start().unwrap();
    settle().await;
    assert_eq!(client.names(), ["profile"]);
    client.emit_bot(embed("Inventory of Player One", "Balance: $2,000\nFish Value: $500\nLevel 12 - 100/200 XP to next level"));
    advance(2_500).await; // saved 2 s after the account change, without waiting for the end
    assert_eq!(saved().account.balance, Some(2_000));

    client.emit_bot(content("You claimed your daily reward: $5,000!")); // nextDailyAt → saved at once
    settle().await;
    assert!(saved().next_daily_at.is_some());

    client.emit_bot(one_fish());
    app.engine_stop(Some(false)).await;
    settle().await;
    let s = saved();
    assert_eq!((s.account.balance, s.account.level, s.account.fish_value), (Some(2_000), Some(12), Some(500)));
    let raw = std::fs::read_to_string(dir.path().join("state.json")).unwrap();
    assert!(!raw.contains("catches") && !raw.contains("session") && !raw.to_lowercase().contains("token"));
}
