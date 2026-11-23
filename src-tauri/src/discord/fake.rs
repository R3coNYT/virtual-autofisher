//! Test-only fake `DiscordClient` (port of v1 `FakeDiscordClient`): records slash commands, answers
//! lookups from fields, and delivers bot messages to the active channel only.

use super::{DiscordClient, DiscordEvent, LoginError};
use crate::engine::sim::default_commands;
use crate::model::{BotMessage, ChannelInfo, GuildInfo, SelfUser, SlashCommandInfo, SlashOptions};
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, oneshot};

pub struct FakeClient {
    pub sent: Mutex<Vec<(String, String, SlashOptions)>>,
    pub active: Mutex<Option<String>>,
    pub events: broadcast::Sender<DiscordEvent>,
    pub commands: Mutex<Vec<SlashCommandInfo>>,
    pub fail_login: Mutex<Option<LoginError>>,
    pub fail_commands: AtomicBool,
    pub guilds: Mutex<Vec<GuildInfo>>,
    pub vf: Mutex<HashMap<String, bool>>,
    pub list_guilds_calls: Mutex<Vec<bool>>,
    /// Last capture directory set (outer None: never called).
    pub capture_dir: Mutex<Option<Option<PathBuf>>>,
    /// The next login waits for this gate, then fails (in-flight auto-login test).
    pub login_gate: Mutex<Option<oneshot::Receiver<()>>>,
    pub logins: AtomicU64,
    next_msg: AtomicU64,
}

impl FakeClient {
    pub fn new() -> Arc<Self> {
        let (events, _) = broadcast::channel(256);
        Arc::new(Self {
            sent: Mutex::new(vec![]),
            active: Mutex::new(None),
            events,
            commands: Mutex::new(default_commands()),
            fail_login: Mutex::new(None),
            fail_commands: AtomicBool::new(false),
            guilds: Mutex::new(vec![]),
            vf: Mutex::new(HashMap::new()),
            list_guilds_calls: Mutex::new(vec![]),
            capture_dir: Mutex::new(None),
            login_gate: Mutex::new(None),
            logins: AtomicU64::new(0),
            next_msg: AtomicU64::new(1),
        })
    }

    pub fn names(&self) -> Vec<String> {
        self.sent.lock().unwrap().iter().map(|(_, n, _)| n.clone()).collect()
    }
    pub fn active(&self) -> Option<String> {
        self.active.lock().unwrap().clone()
    }

    /// Mirrors the real filter: delivered only if the message is in the active channel.
    pub fn emit_bot(&self, mut m: BotMessage) {
        if m.id.is_empty() {
            m.id = format!("m{}", self.next_msg.fetch_add(1, Ordering::SeqCst));
        }
        let active = self.active();
        if m.channel_id.is_empty() {
            m.channel_id = active.clone().unwrap_or_else(|| "c1".into());
        }
        if Some(&m.channel_id) == active.as_ref() {
            let _ = self.events.send(DiscordEvent::BotMessage(m));
        }
    }
    pub fn emit(&self, e: DiscordEvent) {
        let _ = self.events.send(e);
    }
}

#[async_trait]
impl DiscordClient for FakeClient {
    async fn login(&self, _token: &str) -> std::result::Result<SelfUser, LoginError> {
        self.logins.fetch_add(1, Ordering::SeqCst);
        let gate = self.login_gate.lock().unwrap().take();
        if let Some(g) = gate {
            let _ = g.await;
            return Err(LoginError::Network);
        }
        if let Some(e) = *self.fail_login.lock().unwrap() {
            return Err(e);
        }
        Ok(SelfUser { id: "me".into(), username: "tester".into(), avatar_url: String::new() })
    }
    async fn logout(&self) {}
    async fn list_guilds(&self, refresh: bool) -> Result<Vec<GuildInfo>> {
        self.list_guilds_calls.lock().unwrap().push(refresh);
        let mut vf = self.vf.lock().unwrap();
        if refresh {
            vf.clear();
        }
        let guilds = self.guilds.lock().unwrap().clone();
        for g in &guilds {
            vf.insert(g.id.clone(), g.has_virtual_fisher);
        }
        Ok(guilds)
    }
    async fn list_channels(&self, _guild_id: &str) -> Result<Vec<ChannelInfo>> {
        Ok(vec![])
    }
    async fn get_bot_commands(&self, _guild_id: &str) -> Result<Vec<SlashCommandInfo>> {
        if self.fail_commands.load(Ordering::SeqCst) {
            return Err(anyhow!("Commands unavailable"));
        }
        Ok(self.commands.lock().unwrap().clone())
    }
    async fn send_slash(&self, channel_id: &str, command: &str, options: SlashOptions) -> Result<()> {
        self.sent.lock().unwrap().push((channel_id.into(), command.into(), options));
        Ok(())
    }
    fn set_active_channel(&self, channel_id: Option<String>) {
        *self.active.lock().unwrap() = channel_id;
    }
    fn subscribe(&self) -> broadcast::Receiver<DiscordEvent> {
        self.events.subscribe()
    }
    fn seed_vf_cache(&self, map: HashMap<String, bool>) {
        self.vf.lock().unwrap().extend(map);
    }
    fn vf_cache(&self) -> HashMap<String, bool> {
        self.vf.lock().unwrap().clone()
    }
    fn set_capture_dir(&self, dir: Option<PathBuf>) {
        *self.capture_dir.lock().unwrap() = Some(dir);
    }
}
