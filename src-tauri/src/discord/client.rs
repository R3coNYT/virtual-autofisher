//! `DiscordClient`: what the rest of the app uses. `LiveClient` = Gateway + REST for a user account.

use super::gateway::{self, Fatal, GatewayEvent};
use super::identity::{API_BASE, GATEWAY_URL};
use super::permissions::can_use_commands;
use super::rest::Rest;
use super::slash::{interaction_payload, nonce};
use super::{to_bot_message, VIRTUAL_FISHER_ID};
use crate::logger::Logger;
use crate::model::{BotMessage, ChannelInfo, GuildInfo, SelfUser, SlashCommandInfo, SlashOption, SlashOptions};
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, oneshot, watch};

const LOGIN_TIMEOUT: Duration = Duration::from_secs(20);
const GUILD_CHECK_CONCURRENCY: usize = 3;

#[derive(Debug, Clone, PartialEq)]
pub enum DiscordEvent {
    BotMessage(BotMessage),
    Disconnected,
    Reconnected,
    RateLimited(u64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum LoginError {
    #[error("Invalid or expired token")]
    InvalidToken,
    #[error("Unable to connect to Discord")]
    Network,
}

#[async_trait]
pub trait DiscordClient: Send + Sync {
    async fn login(&self, token: &str) -> std::result::Result<SelfUser, LoginError>;
    async fn logout(&self);
    async fn list_guilds(&self, refresh: bool) -> Result<Vec<GuildInfo>>;
    async fn list_channels(&self, guild_id: &str) -> Result<Vec<ChannelInfo>>;
    async fn get_bot_commands(&self, guild_id: &str) -> Result<Vec<SlashCommandInfo>>;
    async fn send_slash(&self, channel_id: &str, command: &str, options: SlashOptions) -> Result<()>;
    fn set_active_channel(&self, channel_id: Option<String>);
    fn subscribe(&self) -> broadcast::Receiver<DiscordEvent>;
    fn seed_vf_cache(&self, map: HashMap<String, bool>);
    fn vf_cache(&self) -> HashMap<String, bool>;
    fn set_capture_dir(&self, dir: Option<PathBuf>);
}

#[derive(Debug, Clone)]
pub struct GatewayConfig {
    pub url: String,
    pub api_base: String,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self { url: GATEWAY_URL.into(), api_base: API_BASE.into() }
    }
}

struct Session {
    user: SelfUser,
    session_id: String,
    rest: Rest,
    /// Raw guild objects (roles, channels, owner) by id, from READY / GUILD_CREATE.
    guilds: HashMap<String, Value>,
    /// Our role ids per guild, when READY told us.
    my_roles: HashMap<String, Vec<String>>,
    stop: watch::Sender<bool>,
}

#[derive(Default)]
struct Inner {
    session: Option<Session>,
    active_channel: Option<String>,
    vf: HashMap<String, bool>,
    commands: HashMap<String, Vec<SlashCommandInfo>>,
    capture_dir: Option<PathBuf>,
    generation: u64,
}

#[derive(Clone)]
pub struct LiveClient {
    inner: Arc<Mutex<Inner>>,
    events: broadcast::Sender<DiscordEvent>,
    cfg: GatewayConfig,
    logger: Arc<Logger>,
}

impl LiveClient {
    pub fn new(cfg: GatewayConfig, logger: Arc<Logger>) -> Self {
        let (events, _) = broadcast::channel(256);
        Self { inner: Arc::new(Mutex::new(Inner::default())), events, cfg, logger }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn rest(&self) -> Result<Rest> {
        self.lock().session.as_ref().map(|s| s.rest.clone()).ok_or_else(|| anyhow!("Not connected"))
    }

    async fn command_index(&self, guild_id: &str) -> Result<Value> {
        self.rest()?.get(&format!("/guilds/{guild_id}/application-command-index")).await
    }

    /// Processes the Gateway events of one session (generation `gen`).
    fn spawn_pump(&self, gen: u64, mut rx: mpsc::UnboundedReceiver<GatewayEvent>, ready: oneshot::Sender<Result<Value, LoginError>>) {
        let me = self.clone();
        tokio::spawn(async move {
            let mut ready = Some(ready);
            while let Some(ev) = rx.recv().await {
                let current = me.lock().generation == gen || ready.is_some();
                if !current {
                    break; // a newer login replaced this session
                }
                match ev {
                    GatewayEvent::Ready(d) => {
                        if let Some(r) = ready.take() {
                            let _ = r.send(Ok(d));
                        } else {
                            me.apply_ready(&d);
                        }
                    }
                    GatewayEvent::Fatal(f) => {
                        let err = if f == Fatal::InvalidToken { LoginError::InvalidToken } else { LoginError::Network };
                        match ready.take() {
                            Some(r) => {
                                let _ = r.send(Err(err));
                            }
                            None => {
                                let _ = me.events.send(DiscordEvent::Disconnected);
                            }
                        }
                        break;
                    }
                    GatewayEvent::Disconnected => {
                        let _ = me.events.send(DiscordEvent::Disconnected);
                    }
                    GatewayEvent::Reconnected => {
                        let _ = me.events.send(DiscordEvent::Reconnected);
                    }
                    GatewayEvent::Dispatch { t, d } => me.on_dispatch(&t, d),
                }
            }
        });
    }

    fn apply_ready(&self, d: &Value) {
        let mut inner = self.lock();
        if let Some(s) = inner.session.as_mut() {
            let (guilds, roles) = parse_ready(d, &s.user.id);
            s.guilds = guilds;
            s.my_roles = roles;
            if let Some(sid) = d["session_id"].as_str() {
                s.session_id = sid.into();
            }
        }
    }

    fn on_dispatch(&self, t: &str, d: Value) {
        match t {
            "MESSAGE_CREATE" | "MESSAGE_UPDATE" => {
                let (self_id, active, capture) = {
                    let inner = self.lock();
                    let Some(s) = inner.session.as_ref() else { return };
                    (s.user.id.clone(), inner.active_channel.clone(), inner.capture_dir.clone())
                };
                if active.as_deref() != d["channel_id"].as_str() || active.is_none() {
                    return;
                }
                let Some(bm) = to_bot_message(&d, &self_id, t == "MESSAGE_UPDATE") else { return };
                if let Some(dir) = capture {
                    self.capture(&dir, &bm, &d["components"]);
                }
                let _ = self.events.send(DiscordEvent::BotMessage(bm));
            }
            "GUILD_CREATE" => {
                let mut inner = self.lock();
                if let (Some(s), Some(id)) = (inner.session.as_mut(), d["id"].as_str()) {
                    if let Some(roles) = own_roles(&d, &s.user.id) {
                        s.my_roles.insert(id.into(), roles);
                    }
                    s.guilds.insert(id.into(), d);
                }
            }
            _ => {}
        }
    }

    fn capture(&self, dir: &std::path::Path, bm: &BotMessage, raw_components: &Value) {
        let mut v = serde_json::to_value(bm).unwrap_or(Value::Null);
        v["rawComponents"] = if raw_components.is_array() { raw_components.clone() } else { json!([]) };
        let ms = chrono_ms();
        let path = dir.join(format!("{ms}-{}.json", bm.id));
        let res = std::fs::create_dir_all(dir)
            .and_then(|_| std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap_or_default()));
        if let Err(e) = res {
            self.logger.warn(&format!("capture failed: {e}"));
        }
    }

    async fn my_roles(&self, guild_id: &str) -> Vec<String> {
        if let Some(r) = self.lock().session.as_ref().and_then(|s| s.my_roles.get(guild_id).cloned()) {
            return r;
        }
        // Not in READY: ask Discord for our own member (user endpoint).
        let Ok(rest) = self.rest() else { return vec![] };
        match rest.get(&format!("/users/@me/guilds/{guild_id}/member")).await {
            Ok(m) => {
                let roles: Vec<String> = m["roles"].as_array().into_iter().flatten().filter_map(|r| r.as_str().map(str::to_string)).collect();
                if let Some(s) = self.lock().session.as_mut() {
                    s.my_roles.insert(guild_id.into(), roles.clone());
                }
                roles
            }
            Err(_) => vec![],
        }
    }
}

fn chrono_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn own_roles(guild: &Value, user_id: &str) -> Option<Vec<String>> {
    guild["members"].as_array()?.iter().find(|m| m["user"]["id"].as_str() == Some(user_id)).map(|m| {
        m["roles"].as_array().into_iter().flatten().filter_map(|r| r.as_str().map(str::to_string)).collect()
    })
}

/// Guilds and our roles from READY (`guilds[]`, and `merged_members[i]` aligned with guilds).
fn parse_ready(d: &Value, user_id: &str) -> (HashMap<String, Value>, HashMap<String, Vec<String>>) {
    let mut guilds = HashMap::new();
    let mut roles = HashMap::new();
    let merged = d["merged_members"].as_array();
    for (i, g) in d["guilds"].as_array().into_iter().flatten().enumerate() {
        let Some(id) = g["id"].as_str() else { continue };
        let mine = own_roles(g, user_id).or_else(|| {
            merged?.get(i)?.as_array()?.iter().find(|m| m["user_id"].as_str() == Some(user_id)).map(|m| {
                m["roles"].as_array().into_iter().flatten().filter_map(|r| r.as_str().map(str::to_string)).collect()
            })
        });
        if let Some(r) = mine {
            roles.insert(id.to_string(), r);
        }
        guilds.insert(id.to_string(), g.clone());
    }
    (guilds, roles)
}

fn guild_name(g: &Value) -> String {
    g["name"].as_str().or_else(|| g["properties"]["name"].as_str()).unwrap_or("?").to_string()
}

fn guild_icon(g: &Value) -> Option<String> {
    let id = g["id"].as_str()?;
    let icon = g["icon"].as_str().or_else(|| g["properties"]["icon"].as_str())?;
    Some(format!("https://cdn.discordapp.com/icons/{id}/{icon}.png"))
}

fn self_user(u: &Value) -> SelfUser {
    let id = u["id"].as_str().unwrap_or("").to_string();
    let avatar = u["avatar"].as_str().map(|a| format!("https://cdn.discordapp.com/avatars/{id}/{a}.png")).unwrap_or_default();
    SelfUser { username: u["username"].as_str().unwrap_or("").to_string(), avatar_url: avatar, id }
}

/// `application-command-index` → Virtual Fisher's commands.
pub fn commands_from_index(index: &Value) -> Vec<SlashCommandInfo> {
    let mut app_ids: Vec<String> = index["applications"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| a["id"].as_str() == Some(VIRTUAL_FISHER_ID) || a["bot_id"].as_str() == Some(VIRTUAL_FISHER_ID))
        .filter_map(|a| a["id"].as_str().map(str::to_string))
        .collect();
    app_ids.push(VIRTUAL_FISHER_ID.into());
    index["application_commands"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["application_id"].as_str().is_some_and(|a| app_ids.iter().any(|x| x == a)))
        .map(|c| SlashCommandInfo {
            name: c["name"].as_str().unwrap_or("").into(),
            id: c["id"].as_str().unwrap_or("").into(),
            version: c["version"].as_str().unwrap_or("").into(),
            options: c["options"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|o| {
                    let choices = o["choices"].as_array();
                    SlashOption {
                        name: o["name"].as_str().unwrap_or("").into(),
                        kind: o["type"].as_u64().unwrap_or(3) as u8,
                        required: o["required"].as_bool().unwrap_or(false),
                        choices: choices.map(|cs| {
                            cs.iter().map(|ch| match &ch["value"] { Value::String(s) => s.clone(), v => v.to_string() }).collect()
                        }),
                        choice_names: choices.map(|cs| cs.iter().map(|ch| ch["name"].as_str().unwrap_or("").to_string()).collect()),
                    }
                })
                .collect(),
        })
        .collect()
}

/// Whether the index lists Virtual Fisher.
pub fn index_has_vf(index: &Value) -> bool {
    index["applications"]
        .as_array()
        .is_some_and(|a| a.iter().any(|x| x["id"].as_str() == Some(VIRTUAL_FISHER_ID) || x["bot_id"].as_str() == Some(VIRTUAL_FISHER_ID)))
}

#[async_trait]
impl DiscordClient for LiveClient {
    async fn login(&self, token: &str) -> std::result::Result<SelfUser, LoginError> {
        let gen = { self.lock().generation + 1 };
        let (tx, rx) = mpsc::unbounded_channel();
        let (stop_tx, stop_rx) = watch::channel(false);
        let (ready_tx, ready_rx) = oneshot::channel();
        tokio::spawn(gateway::run(self.cfg.url.clone(), token.to_string(), tx, stop_rx));
        self.spawn_pump(gen, rx, ready_tx);
        let ready = match tokio::time::timeout(LOGIN_TIMEOUT, ready_rx).await {
            Ok(Ok(Ok(d))) => d,
            Ok(Ok(Err(e))) => {
                let _ = stop_tx.send(true);
                return Err(e);
            }
            _ => {
                let _ = stop_tx.send(true);
                return Err(LoginError::Network);
            }
        };
        let events = self.events.clone();
        let rest = Rest::new(&self.cfg.api_base, token, Arc::new(move |ms| {
            let _ = events.send(DiscordEvent::RateLimited(ms));
        }))
        .map_err(|_| LoginError::Network)?;
        let user = self_user(&ready["user"]);
        let (guilds, my_roles) = parse_ready(&ready, &user.id);
        let session = Session {
            user: user.clone(),
            session_id: ready["session_id"].as_str().unwrap_or("").into(),
            rest,
            guilds,
            my_roles,
            stop: stop_tx,
        };
        // swap only now: a failed login never drops the live session
        let mut inner = self.lock();
        if let Some(old) = inner.session.take() {
            let _ = old.stop.send(true);
        }
        inner.generation = gen;
        inner.commands.clear();
        inner.session = Some(session);
        Ok(user)
    }

    async fn logout(&self) {
        let mut inner = self.lock();
        if let Some(s) = inner.session.take() {
            let _ = s.stop.send(true);
        }
        inner.generation += 1;
        inner.active_channel = None;
        inner.commands.clear();
    }

    async fn list_guilds(&self, refresh: bool) -> Result<Vec<GuildInfo>> {
        if refresh {
            self.lock().vf.clear();
        }
        let guilds: Vec<Value> = {
            let inner = self.lock();
            inner.session.as_ref().ok_or_else(|| anyhow!("Not connected"))?.guilds.values().cloned().collect()
        };
        let sem = Arc::new(tokio::sync::Semaphore::new(GUILD_CHECK_CONCURRENCY));
        let mut tasks = Vec::new();
        for g in guilds {
            let me = self.clone();
            let sem = sem.clone();
            tasks.push(tokio::spawn(async move {
                let id = g["id"].as_str().unwrap_or("").to_string();
                let known = me.lock().vf.get(&id).copied();
                let has = match known {
                    Some(k) => k,
                    None => {
                        let _permit = sem.acquire().await;
                        match me.command_index(&id).await {
                            Ok(index) => {
                                let has = index_has_vf(&index);
                                me.lock().vf.insert(id.clone(), has);
                                has
                            }
                            Err(_) => false, // not cached: checked again next time
                        }
                    }
                };
                GuildInfo { name: guild_name(&g), icon_url: guild_icon(&g), has_virtual_fisher: has, id }
            }));
        }
        let mut out = Vec::new();
        for t in tasks {
            if let Ok(g) = t.await {
                out.push(g);
            }
        }
        out.sort_by(|a, b| b.has_virtual_fisher.cmp(&a.has_virtual_fisher).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(out)
    }

    async fn list_channels(&self, guild_id: &str) -> Result<Vec<ChannelInfo>> {
        let (guild, user_id) = {
            let inner = self.lock();
            let s = inner.session.as_ref().ok_or_else(|| anyhow!("Not connected"))?;
            (s.guilds.get(guild_id).cloned().ok_or_else(|| anyhow!("Unknown server"))?, s.user.id.clone())
        };
        let roles = self.my_roles(guild_id).await;
        let channels = guild["channels"].as_array().cloned().unwrap_or_default();
        let name_of = |id: &str| channels.iter().find(|c| c["id"].as_str() == Some(id)).and_then(|c| c["name"].as_str()).map(str::to_string);
        let mut out: Vec<ChannelInfo> = channels
            .iter()
            .filter(|c| matches!(c["type"].as_u64(), Some(0) | Some(5)))
            .filter(|c| can_use_commands(&guild, c, &user_id, &roles))
            .map(|c| ChannelInfo {
                id: c["id"].as_str().unwrap_or("").into(),
                name: c["name"].as_str().unwrap_or("").into(),
                parent_name: c["parent_id"].as_str().and_then(name_of),
            })
            .collect();
        out.sort_by(|a, b| a.parent_name.cmp(&b.parent_name).then(a.name.cmp(&b.name)));
        Ok(out)
    }

    async fn get_bot_commands(&self, guild_id: &str) -> Result<Vec<SlashCommandInfo>> {
        if let Some(c) = self.lock().commands.get(guild_id).cloned() {
            return Ok(c);
        }
        let cmds = commands_from_index(&self.command_index(guild_id).await?);
        self.lock().commands.insert(guild_id.into(), cmds.clone());
        Ok(cmds)
    }

    async fn send_slash(&self, channel_id: &str, command: &str, options: SlashOptions) -> Result<()> {
        let (guild_id, session_id, rest) = {
            let inner = self.lock();
            let s = inner.session.as_ref().ok_or_else(|| anyhow!("Not connected"))?;
            let guild_id = s
                .guilds
                .iter()
                .find(|(_, g)| g["channels"].as_array().is_some_and(|cs| cs.iter().any(|c| c["id"].as_str() == Some(channel_id))))
                .map(|(id, _)| id.clone())
                .ok_or_else(|| anyhow!("Channel not found"))?;
            (guild_id, s.session_id.clone(), s.rest.clone())
        };
        let info = self
            .get_bot_commands(&guild_id)
            .await?
            .into_iter()
            .find(|c| c.name == command)
            .ok_or_else(|| anyhow!("Command not found: /{command}"))?;
        let body = interaction_payload(&info, VIRTUAL_FISHER_ID, &guild_id, channel_id, &session_id, &nonce(chrono_ms()), &options)?;
        rest.post("/interactions", &body).await?;
        Ok(())
    }

    fn set_active_channel(&self, channel_id: Option<String>) {
        self.lock().active_channel = channel_id;
    }

    fn subscribe(&self) -> broadcast::Receiver<DiscordEvent> {
        self.events.subscribe()
    }

    fn seed_vf_cache(&self, map: HashMap<String, bool>) {
        self.lock().vf.extend(map);
    }

    fn vf_cache(&self) -> HashMap<String, bool> {
        self.lock().vf.clone()
    }

    fn set_capture_dir(&self, dir: Option<PathBuf>) {
        self.lock().capture_dir = dir;
    }
}

#[cfg(test)]
mod tests {
    use super::super::gateway::mock::{serve, Out};
    use super::*;
    use tokio::time::timeout;
    use wiremock::matchers::{header_exists, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn next<T>(rx: &mut mpsc::UnboundedReceiver<T>) -> T {
        timeout(Duration::from_secs(10), rx.recv()).await.expect("timed out").expect("closed")
    }

    fn ready_payload() -> Value {
        json!({
            "session_id": "sess1", "resume_gateway_url": "ws://127.0.0.1:1",
            "user": { "id": "111", "username": "player", "avatar": null },
            "guilds": [{
                "id": "900", "name": "Fishers", "icon": null, "owner_id": "999",
                "roles": [{ "id": "900", "permissions": ((1u64 << 10) | (1u64 << 11) | (1u64 << 31)).to_string() }],
                "channels": [
                    { "id": "500", "type": 4, "name": "Games" },
                    { "id": "501", "type": 0, "name": "fishing", "parent_id": "500" },
                    { "id": "502", "type": 0, "name": "staff", "permission_overwrites": [{ "id": "900", "type": 0, "allow": "0", "deny": (1u64 << 10).to_string() }] },
                    { "id": "503", "type": 2, "name": "voice" }
                ],
                "members": [{ "user": { "id": "111" }, "roles": [] }]
            }]
        })
    }

    fn index() -> Value {
        json!({
            "applications": [{ "id": VIRTUAL_FISHER_ID, "bot_id": VIRTUAL_FISHER_ID }],
            "application_commands": [
                { "id": "1", "application_id": VIRTUAL_FISHER_ID, "version": "7", "name": "fish", "options": [] },
                { "id": "2", "application_id": VIRTUAL_FISHER_ID, "version": "8", "name": "sell",
                  "options": [{ "type": 3, "name": "amount", "required": true, "choices": [{ "name": "All", "value": "all" }] }] },
                { "id": "3", "application_id": "other", "version": "1", "name": "play", "options": [] }
            ]
        })
    }

    /// Logs a LiveClient in against a mock Gateway (returns the client and the Gateway's outbound sender).
    async fn logged_in(api: &MockServer) -> (LiveClient, mpsc::UnboundedSender<Out>) {
        let (url, mut conns) = serve().await;
        let tmp = tempfile::tempdir().unwrap();
        let client = LiveClient::new(GatewayConfig { url, api_base: api.uri() }, Arc::new(Logger::new(tmp.keep())));
        let c2 = client.clone();
        let login = tokio::spawn(async move { c2.login("tok").await });
        let (mut inbound, out) = next(&mut conns).await;
        out.send(Out::Json(json!({ "op": 10, "d": { "heartbeat_interval": 45000 } }))).ok();
        next(&mut inbound).await;
        out.send(Out::Json(json!({ "op": 0, "s": 1, "t": "READY", "d": ready_payload() }))).ok();
        let user = login.await.unwrap().unwrap();
        assert_eq!(user.username, "player");
        (client, out)
    }

    #[tokio::test]
    async fn lists_guilds_with_vf_and_usable_channels() {
        let api = MockServer::start().await;
        Mock::given(method("GET")).and(path("/guilds/900/application-command-index"))
            .respond_with(ResponseTemplate::new(200).set_body_json(index())).expect(1).mount(&api).await;
        let (client, _out) = logged_in(&api).await;
        let guilds = client.list_guilds(false).await.unwrap();
        assert_eq!(guilds, vec![GuildInfo { id: "900".into(), name: "Fishers".into(), icon_url: None, has_virtual_fisher: true }]);
        client.list_guilds(false).await.unwrap(); // cached: still one request (expect(1))
        let channels = client.list_channels("900").await.unwrap();
        assert_eq!(channels, vec![ChannelInfo { id: "501".into(), name: "fishing".into(), parent_name: Some("Games".into()) }]);
    }

    #[tokio::test]
    async fn vf_detection_errors_are_not_cached() {
        let api = MockServer::start().await;
        Mock::given(method("GET")).and(path("/guilds/900/application-command-index"))
            .respond_with(ResponseTemplate::new(500)).mount(&api).await;
        let (client, _out) = logged_in(&api).await;
        assert!(!client.list_guilds(false).await.unwrap()[0].has_virtual_fisher);
        assert!(client.vf_cache().is_empty());
    }

    #[tokio::test]
    async fn send_slash_posts_interaction_with_library_headers() {
        let api = MockServer::start().await;
        Mock::given(method("GET")).and(path("/guilds/900/application-command-index"))
            .respond_with(ResponseTemplate::new(200).set_body_json(index())).expect(1).mount(&api).await;
        Mock::given(method("POST")).and(path("/interactions")).and(header_exists("x-super-properties"))
            .respond_with(ResponseTemplate::new(204)).expect(2).mount(&api).await;
        let (client, _out) = logged_in(&api).await;
        let mut opts = SlashOptions::new();
        opts.insert("amount".into(), json!("all"));
        client.send_slash("501", "sell", opts).await.unwrap();
        client.send_slash("501", "fish", SlashOptions::new()).await.unwrap(); // index cached
        let reqs = api.received_requests().await.unwrap();
        let post = reqs.iter().find(|r| r.url.path() == "/interactions").unwrap();
        assert_eq!(post.headers.get("authorization").unwrap(), "tok");
        let body: Value = serde_json::from_slice(&post.body).unwrap();
        assert_eq!(body["data"]["name"], "sell");
        assert_eq!(body["session_id"], "sess1");
        assert_eq!(body["data"]["options"][0]["value"], "all");
    }

    #[tokio::test]
    async fn only_the_active_channel_reaches_the_engine() {
        let api = MockServer::start().await;
        let (client, out) = logged_in(&api).await;
        let mut rx = client.subscribe();
        client.set_active_channel(Some("501".into()));
        let msg = |ch: &str, id: &str| Out::Json(json!({ "op": 0, "s": 2, "t": "MESSAGE_CREATE", "d": {
            "id": id, "channel_id": ch, "content": "", "author": { "id": VIRTUAL_FISHER_ID },
            "interaction_metadata": { "user": { "id": "111" } }, "embeds": [], "flags": 0
        }}));
        out.send(msg("777", "other-channel")).ok();
        out.send(msg("501", "ours")).ok();
        let ev = timeout(Duration::from_secs(5), rx.recv()).await.unwrap().unwrap();
        assert!(matches!(ev, DiscordEvent::BotMessage(m) if m.id == "ours"));
    }

    #[tokio::test]
    async fn invalid_token_vs_network() {
        let (url, mut conns) = serve().await;
        let tmp = tempfile::tempdir().unwrap();
        let client = LiveClient::new(GatewayConfig { url, api_base: "http://127.0.0.1:1".into() }, Arc::new(Logger::new(tmp.keep())));
        let c2 = client.clone();
        let login = tokio::spawn(async move { c2.login("bad").await });
        let (mut inbound, out) = next(&mut conns).await;
        out.send(Out::Json(json!({ "op": 10, "d": { "heartbeat_interval": 45000 } }))).ok();
        next(&mut inbound).await;
        out.send(Out::Close(4004)).ok();
        assert_eq!(login.await.unwrap(), Err(LoginError::InvalidToken));

        let tmp2 = tempfile::tempdir().unwrap();
        let offline = LiveClient::new(GatewayConfig { url: "ws://127.0.0.1:1".into(), api_base: "http://127.0.0.1:1".into() }, Arc::new(Logger::new(tmp2.keep())));
        assert_eq!(offline.login("t").await, Err(LoginError::Network));
    }

    #[test]
    fn index_maps_choices_with_labels() {
        let cmds = commands_from_index(&index());
        assert_eq!(cmds.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["fish", "sell"]);
        assert_eq!(cmds[1].options[0].choices, Some(vec!["all".to_string()]));
        assert_eq!(cmds[1].options[0].choice_names, Some(vec!["All".to_string()]));
    }
}
