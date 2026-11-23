//! Test-only simulation of the engine (port of the v1 FakeDiscordClient + fake timers): a manual
//! clock, a fake Discord that records slash commands, delivers bot messages to the active channel
//! only, and answers command loads at once. rand = 0.5: fish delay 3029 ms, random_between = midpoint.

use super::core::{Effect, EngineCore, EngineInput, LogLevel};
use crate::discord::model_conv::testkit;
use crate::model::{BotMessage, Config, Embed, EngineInfo, EngineState, SessionSummary, SlashCommandInfo, SlashOption, SlashOptions, Target, Toast};
use std::collections::VecDeque;

/// Same epoch as v1's fake timers (Date.now() > 0).
pub const T0: i64 = 1_700_000_000_000;
pub const FISH_DELAY: i64 = 3029;

pub fn target(guild: &str, channel: &str) -> Target {
    Target { guild_id: guild.into(), channel_id: channel.into() }
}

fn cmd(name: &str, i: u32, options: &[&str]) -> SlashCommandInfo {
    SlashCommandInfo {
        name: name.into(),
        id: format!("cmd-{i}"),
        version: format!("ver-{i}"),
        options: options.iter().map(|o| SlashOption { name: (*o).into(), kind: 3, required: false, choices: None, choice_names: None }).collect(),
    }
}

pub fn default_commands() -> Vec<SlashCommandInfo> {
    vec![
        cmd("fish", 1, &[]),
        cmd("sell", 2, &["amount"]),
        cmd("buy", 3, &["item", "amount"]),
        cmd("verify", 4, &["answer"]),
        cmd("profile", 5, &[]),
        cmd("daily", 6, &[]),
        cmd("quests", 7, &[]),
        cmd("boosts", 8, &[]),
    ]
}

/// The v1 test config: sell/daily/quests/profile refresh off unless a test turns them on.
pub fn test_config(patch: impl FnOnce(&mut Config)) -> Config {
    let mut cfg = Config::default();
    cfg.sell.enabled = false;
    cfg.daily.enabled = false;
    cfg.quests.enabled = false;
    cfg.profile.refresh_min = 0.0;
    patch(&mut cfg);
    cfg
}

// ---- messages -----------------------------------------------------------------

pub fn content(s: &str) -> BotMessage {
    BotMessage { content: s.into(), ..BotMessage::default() }
}
pub fn embed(title: &str, description: &str) -> BotMessage {
    BotMessage { embeds: vec![Embed { title: Some(title.into()), description: Some(description.into()), ..Embed::default() }], ..BotMessage::default() }
}
pub fn one_fish() -> BotMessage {
    embed("You caught:", "Cod x1")
}
pub fn cooldown(sec: f64) -> BotMessage {
    content(&format!("You must wait {sec} seconds before fishing again."))
}
pub fn boosts_msg(description: &str) -> BotMessage {
    embed("Active boosts", description)
}
/// v1 fixture (tests/fixtures/messages) without id/channel, so it goes to the active channel.
pub fn fixture(name: &str) -> BotMessage {
    let mut m: BotMessage = serde_json::from_value(testkit::read_json(&format!("messages/{name}.json"))).unwrap();
    m.id.clear();
    m.channel_id.clear();
    m
}
/// Anonymized real capture through the Gateway conversion, without its channel.
pub fn real(name: &str) -> BotMessage {
    let mut m = testkit::load_capture("real", name);
    m.channel_id.clear();
    m.interaction_user_id = Some("me".into());
    m
}
pub fn with_id(mut m: BotMessage, id: &str) -> BotMessage {
    m.id = id.into();
    m
}
pub fn as_edit(mut m: BotMessage) -> BotMessage {
    m.is_edit = true;
    m
}

#[derive(Debug, Clone, PartialEq)]
pub struct Sent {
    pub channel_id: String,
    pub name: String,
    pub options: SlashOptions,
}

type AutoReply = Box<dyn FnMut(&str, &SlashOptions) -> Option<BotMessage>>;

pub struct Sim {
    pub core: EngineCore,
    pub now: i64,
    pub cfg: Config,
    pub sent: Vec<Sent>,
    pub effects: Vec<Effect>,
    /// What the fake Discord returns for command loads.
    pub commands: Vec<SlashCommandInfo>,
    pub fail_commands: bool,
    /// Loads are kept pending (released by `release_loads`) instead of answered at once.
    pub hold_loads: bool,
    pending_loads: Vec<String>,
    pub commands_calls: Vec<String>,
    pub active_channel: Option<String>,
    /// Answers each command right after it is sent (v1 `autoReply`).
    pub auto: Option<AutoReply>,
    next_msg: u64,
}

impl Sim {
    pub fn new(cfg: Config) -> Self {
        let mut commands = default_commands();
        // /boosts is sent at every start: tests that are not about buffs drop it so /fish stays first
        if !cfg.buffs.enabled {
            commands.retain(|c| c.name != "boosts");
        }
        Self::with_commands(cfg, commands)
    }

    pub fn with_commands(cfg: Config, commands: Vec<SlashCommandInfo>) -> Self {
        Self {
            core: EngineCore::with_rand(Box::new(|| 0.5)),
            now: T0,
            cfg,
            sent: vec![],
            effects: vec![],
            commands,
            fail_commands: false,
            hold_loads: false,
            pending_loads: vec![],
            commands_calls: vec![],
            active_channel: None,
            auto: None,
            next_msg: 1,
        }
    }

    pub fn auto_reply(&mut self, f: impl FnMut(&str, &SlashOptions) -> Option<BotMessage> + 'static) {
        self.auto = Some(Box::new(f));
    }

    pub fn input(&mut self, first: EngineInput) {
        let mut inputs = VecDeque::from([first]);
        while let Some(i) = inputs.pop_front() {
            let effects = self.core.handle(i, self.now, &self.cfg);
            for e in effects {
                match &e {
                    Effect::LoadCommands { guild_id } => {
                        self.commands_calls.push(guild_id.clone());
                        if self.hold_loads {
                            self.pending_loads.push(guild_id.clone());
                        } else {
                            inputs.push_back(self.load_result(guild_id));
                        }
                    }
                    Effect::SetActiveChannel(c) => self.active_channel = c.clone(),
                    Effect::SendSlash { id, channel_id, name, options } => {
                        self.sent.push(Sent { channel_id: channel_id.clone(), name: name.clone(), options: options.clone() });
                        inputs.push_back(EngineInput::SendResult { id: *id, ok: true });
                        let reply = self.auto.as_mut().and_then(|f| f(name, options));
                        if let Some(m) = reply.and_then(|m| self.deliver(m)) {
                            inputs.push_back(EngineInput::Bot(m));
                        }
                    }
                    _ => {}
                }
                self.effects.push(e);
            }
        }
    }

    fn load_result(&self, guild_id: &str) -> EngineInput {
        let result = if self.fail_commands { Err("Commands unavailable".into()) } else { Ok(self.commands.clone()) };
        EngineInput::CommandsLoaded { guild_id: guild_id.into(), result }
    }

    pub fn release_loads(&mut self) {
        for g in std::mem::take(&mut self.pending_loads) {
            let i = self.load_result(&g);
            self.input(i);
        }
    }

    /// Mirrors the real filter: delivered only if the message is in the active channel.
    fn deliver(&mut self, mut m: BotMessage) -> Option<BotMessage> {
        if m.id.is_empty() {
            m.id = format!("m{}", self.next_msg);
            self.next_msg += 1;
        }
        if m.channel_id.is_empty() {
            m.channel_id = self.active_channel.clone().unwrap_or_else(|| "c1".into());
        }
        if m.interaction_user_id.is_none() {
            m.interaction_user_id = Some("me".into());
        }
        (Some(&m.channel_id) == self.active_channel.as_ref()).then_some(m)
    }

    pub fn emit_bot(&mut self, m: BotMessage) {
        if let Some(m) = self.deliver(m) {
            self.input(EngineInput::Bot(m));
        }
    }

    pub fn start(&mut self, t: Target) {
        self.input(EngineInput::Start { target: t });
    }
    pub fn stop(&mut self, graceful: bool) {
        self.input(EngineInput::Stop { graceful });
    }
    pub fn manual(&mut self, name: &str) {
        self.input(EngineInput::SendManual { name: name.into(), options: SlashOptions::new() });
    }

    /// Advances the clock by `ms`, firing every wakeup on the way (v1 `vi.advanceTimersByTime`).
    pub fn advance(&mut self, ms: i64) {
        let end = self.now + ms;
        for _ in 0..10_000_000 {
            match self.core.next_wakeup().filter(|t| *t <= end) {
                Some(t) => {
                    self.now = self.now.max(t);
                    self.input(EngineInput::Tick);
                }
                None => {
                    self.now = end;
                    return;
                }
            }
        }
        panic!("simulation did not settle");
    }

    /// Advances `ms` in `step`s, answering every new command with `reply` (None = no answer).
    pub fn run_with(&mut self, ms: i64, step: i64, mut reply: impl FnMut(&str) -> Option<BotMessage>) {
        let mut answered = self.sent.len();
        let mut t = 0;
        while t < ms {
            while answered < self.sent.len() {
                let name = self.sent[answered].name.clone();
                answered += 1;
                if let Some(m) = reply(&name) {
                    self.emit_bot(m);
                }
            }
            self.advance(step);
            t += step;
        }
    }
    pub fn run(&mut self, ms: i64, reply: impl FnMut(&str) -> Option<BotMessage>) {
        self.run_with(ms, 500, reply)
    }

    // ---- observations -----------------------------------------------------------

    pub fn names(&self) -> Vec<String> {
        self.sent.iter().map(|s| s.name.clone()).collect()
    }
    pub fn count(&self, name: &str) -> usize {
        self.sent.iter().filter(|s| s.name == name).count()
    }
    pub fn state(&self) -> EngineState {
        self.core.state()
    }
    pub fn states(&self) -> Vec<(EngineState, EngineInfo)> {
        self.effects
            .iter()
            .filter_map(|e| match e {
                Effect::State { state, info } => Some((*state, info.clone())),
                _ => None,
            })
            .collect()
    }
    pub fn last_state(&self) -> (EngineState, EngineInfo) {
        self.states().pop().expect("no state emitted")
    }
    pub fn logs(&self, level: LogLevel) -> Vec<String> {
        self.effects
            .iter()
            .filter_map(|e| match e {
                Effect::Log { level: l, msg } if *l == level => Some(msg.clone()),
                _ => None,
            })
            .collect()
    }
    pub fn emitted_commands(&self) -> Vec<Vec<String>> {
        self.effects
            .iter()
            .filter_map(|e| match e {
                Effect::Commands(c) => Some(c.iter().map(|c| c.name.clone()).collect()),
                _ => None,
            })
            .collect()
    }
    pub fn session_ends(&self) -> Vec<SessionSummary> {
        self.effects
            .iter()
            .filter_map(|e| match e {
                Effect::SessionEnded(s) => Some(s.clone()),
                _ => None,
            })
            .collect()
    }
    pub fn toasts(&self) -> Vec<Toast> {
        self.effects
            .iter()
            .filter_map(|e| match e {
                Effect::Toast(t) => Some(t.clone()),
                _ => None,
            })
            .collect()
    }
    pub fn opt(&self, i: usize, key: &str) -> Option<serde_json::Value> {
        self.sent[i].options.get(key).cloned()
    }
}
