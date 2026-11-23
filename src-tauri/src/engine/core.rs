//! Engine core (port of `Engine.ts`): the state machine driving a fishing session. Pure and
//! time-injected: every input comes in through `handle(input, now, cfg)` and every outside action
//! (send a slash command, load commands, UI updates) goes out as an `Effect`. The owner (actor or
//! simulation) calls `handle(Tick)` at `next_wakeup()`.
//!
//! Captcha safety: on a captcha the queue is emptied and paused and the scheduler frozen; the only
//! command that can leave is a `verify` pushed by an explicit user action. Nothing ever sends
//! /verify on its own, and a /verify is never retried.

use super::captcha::{CaptchaFlow, CaptchaInfo, CAPTCHA_SOLVED_TEXT, SESSIONLESS};
use super::edit_deduper::EditDeduper;
use super::game_state::{GameState, Patch, PersistedState};
use super::humanize::random_between_ms;
use super::queue::{CommandQueue, Priority, QueueAction, QueuedCommand};
use super::scheduler::{positional_options, Ctx, Scheduler};
use crate::model::{
    BotMessage, Config, EngineInfo, EngineState, EngineStatus, GameEvent, LogType, PauseReason, SessionSummary, SlashCommandInfo, SlashOptions, Target, Toast,
    ToastLevel,
};
use crate::parser::{build_text, parse_message};
use rand::{rngs::StdRng, Rng, SeedableRng};
use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::OnceLock;

const RESPONSE_TIMEOUT_MS: i64 = 8_000;
/// A deferred reply ("is thinking…", e.g. while a captcha is generated) may take longer.
const DEFERRED_REPLY_TIMEOUT_MS: i64 = 30_000;
const MAX_FAILURES: u32 = 3;
const NETWORK_GRACE_MS: i64 = 2 * 60_000;
const RATE_LIMIT_FACTOR: f64 = 1.5;
const RATE_LIMIT_WINDOW_MS: i64 = 5 * 60_000;
const NO_FUNDS_BLOCK_MS: i64 = 30 * 60_000;
const SESSION_CHECK_MS: i64 = 15_000;
/// A non-fish command answered by "wait N" is re-sent once after N when N is at most this long.
const DEFER_MAX_MS: i64 = 10 * 60_000;
/// Graceful stop: data refreshed before halting, each only if the guild exposes the command.
const GRACEFUL_COMMANDS: [&str; 2] = ["profile", "quests"];
/// Graceful stop budget (time spent in a captcha not counted).
const GRACEFUL_MAX_MS: i64 = 25_000;

pub const FETCH_COMMANDS_FAILED: &str = "Unable to fetch the Virtual Fisher commands";
pub const NO_CHANNEL: &str = "Choose a channel first";
pub const LOAD_COMMANDS_FAILED: &str = "Unable to load the Virtual Fisher commands";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EngineInput {
    Start { target: Target },
    /// User pause.
    Pause,
    Resume,
    Stop { graceful: bool },
    SendManual { name: String, options: SlashOptions },
    SubmitCaptcha(String),
    RegenCaptcha,
    UseTarget { target: Target },
    Detach,
    Bot(BotMessage),
    Disconnected,
    Reconnected,
    RateLimited(u64),
    CommandsLoaded { guild_id: String, result: Result<Vec<SlashCommandInfo>, String> },
    SendResult { id: u64, ok: bool },
    Tick,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    LoadCommands { guild_id: String },
    SetActiveChannel(Option<String>),
    SendSlash { id: u64, channel_id: String, name: String, options: SlashOptions },
    State { state: EngineState, info: EngineInfo },
    Commands(Vec<SlashCommandInfo>),
    GamePatch(Patch),
    SessionEnded(SessionSummary),
    Log { level: LogLevel, msg: String },
    Toast(Toast),
    CaptchaShow(crate::model::CaptchaPayload),
    CaptchaHide,
}

fn is_active(s: EngineState) -> bool {
    matches!(s, EngineState::Running | EngineState::Paused | EngineState::Resting)
}
/// No session: manual commands are sent straight to the target channel ("manual mode").
fn is_idle(s: EngineState) -> bool {
    matches!(s, EngineState::Idle | EngineState::Error)
}
/// States a graceful stop can start from (captcha: it starts once the captcha is solved).
fn graceful_from(s: EngineState) -> bool {
    is_active(s) || s == EngineState::Captcha
}

fn reason_str(r: PauseReason) -> &'static str {
    match r {
        PauseReason::User => "user",
        PauseReason::Network => "network",
        PauseReason::NoResponse => "noResponse",
        PauseReason::Exception => "exception",
    }
}
fn with_reason(r: &str) -> EngineInfo {
    EngineInfo { reason: Some(r.to_string()), ..EngineInfo::default() }
}

fn enough_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)enough").unwrap())
}

pub fn format_wait(ms: i64) -> String {
    let s = (ms as f64 / 1000.0).round() as i64;
    if s < 60 {
        return format!("{s}s");
    }
    let m = (s as f64 / 60.0).round() as i64;
    if m < 60 {
        format!("{m}m")
    } else {
        format!("{}h {:02}m", m / 60, m % 60)
    }
}

struct GracefulStop {
    /// Commands not answered yet (nor timed out).
    remaining: Vec<String>,
    budget_ms: i64,
    armed_at: i64,
    deadline: Option<i64>,
    /// Reason shown with the final idle state (session limit).
    reason: Option<String>,
}

enum Purpose {
    Start,
    /// Manual mode: commands to send once the list is known.
    Manual(Vec<(String, SlashOptions)>),
}

struct Loading {
    guild_id: String,
    gen: u64,
    purpose: Purpose,
}

#[derive(Clone, Copy)]
enum Due {
    Resume,
    Network,
    Graceful,
    Session,
    Scheduler,
    Queue,
}

pub struct EngineCore {
    current: EngineState,
    info: EngineInfo,
    pause_reason: Option<PauseReason>,
    commands: Vec<SlashCommandInfo>,
    /// Guild the commands were loaded for (cache key).
    commands_guild: Option<String>,
    /// Channel listened to and commanded: kept after a stop (manual mode), cleared by detach.
    target: Option<Target>,
    gen: u64,
    queue: CommandQueue,
    scheduler: Scheduler,
    game: GameState,
    captcha: CaptchaFlow,
    /// Command whose reply we are waiting for (cleared by the reply or a timeout).
    awaiting: Option<QueuedCommand>,
    /// The in-flight command answered by a Discord "is thinking…" placeholder (message id): its edit is the reply.
    deferred_reply: Option<(String, QueuedCommand)>,
    /// Copies pushed by retry_once (ids): they are not retried again.
    retries: HashSet<u64>,
    /// Copies re-sent after a "wait N" reply (ids): a second cooldown is not deferred again.
    deferred: HashSet<u64>,
    /// Last command handed to Discord (answered or not).
    last_sent: Option<QueuedCommand>,
    edits: EditDeduper,
    rand: Box<dyn FnMut() -> f64 + Send>,
    last_maintenance_key: Option<String>,
    failures: u32,
    rate_limit_until: i64,
    session_active: bool,
    session_started_at: i64,
    network_deadline: Option<i64>,
    session_check_at: Option<i64>,
    graceful: Option<GracefulStop>,
    loading: Vec<Loading>,
    next_id: u64,
    cfg: Config,
    now: i64,
    out: Vec<Effect>,
    #[cfg(test)]
    pub(crate) panic_on_route: bool,
}

impl EngineCore {
    pub fn new(rng_seed: u64) -> Self {
        let mut rng = StdRng::seed_from_u64(rng_seed);
        Self::with_rand(Box::new(move || rng.random::<f64>()))
    }

    /// With an injected uniform [0, 1) source (simulations use a constant 0.5).
    pub fn with_rand(rand: Box<dyn FnMut() -> f64 + Send>) -> Self {
        Self {
            current: EngineState::Idle,
            info: EngineInfo::default(),
            pause_reason: None,
            commands: vec![],
            commands_guild: None,
            target: None,
            gen: 0,
            queue: CommandQueue::new(RESPONSE_TIMEOUT_MS),
            scheduler: Scheduler::new(),
            game: GameState::new(),
            captcha: CaptchaFlow::default(),
            awaiting: None,
            deferred_reply: None,
            retries: HashSet::new(),
            deferred: HashSet::new(),
            last_sent: None,
            edits: EditDeduper::new(),
            rand,
            last_maintenance_key: None,
            failures: 0,
            rate_limit_until: i64::MIN,
            session_active: false,
            session_started_at: 0,
            network_deadline: None,
            session_check_at: None,
            graceful: None,
            loading: vec![],
            next_id: 0,
            cfg: Config::default(),
            now: 0,
            out: vec![],
            #[cfg(test)]
            panic_on_route: false,
        }
    }

    pub fn state(&self) -> EngineState {
        self.current
    }
    pub fn info(&self) -> &EngineInfo {
        &self.info
    }
    pub fn commands(&self) -> &[SlashCommandInfo] {
        &self.commands
    }
    pub fn game(&self) -> &GameState {
        &self.game
    }

    pub fn status(&self) -> EngineStatus {
        EngineStatus {
            state: self.current,
            info: self.info.clone(),
            captcha: (self.current == EngineState::Captcha).then(|| CaptchaFlow::payload(&self.info)),
            snapshot: self.game.snapshot(),
        }
    }

    /// Last known account values and next daily (state.json), at boot.
    pub fn hydrate(&mut self, p: &PersistedState, now: i64) -> Vec<Effect> {
        let patch = self.game.hydrate(p, now);
        self.patch(patch);
        std::mem::take(&mut self.out)
    }

    /// When `handle(Tick)` should run next.
    pub fn next_wakeup(&self) -> Option<i64> {
        self.next_due().map(|(t, _)| t)
    }

    pub fn handle(&mut self, input: EngineInput, now: i64, cfg: &Config) -> Vec<Effect> {
        self.now = now;
        self.cfg = cfg.clone();
        let res = catch_unwind(AssertUnwindSafe(|| {
            self.dispatch(input);
            self.pump();
        }));
        if res.is_err() {
            self.fail("panic");
            let _ = catch_unwind(AssertUnwindSafe(|| self.pump()));
        }
        std::mem::take(&mut self.out)
    }

    fn dispatch(&mut self, input: EngineInput) {
        match input {
            EngineInput::Start { target } => self.start(target),
            EngineInput::Pause => self.pause(PauseReason::User),
            EngineInput::Resume => self.resume(),
            EngineInput::Stop { graceful } => self.stop(graceful),
            EngineInput::SendManual { name, options } => self.send_manual(name, options),
            EngineInput::SubmitCaptcha(a) => {
                let a = a.trim().to_string();
                if !a.is_empty() {
                    self.push_verify(a);
                }
            }
            EngineInput::RegenCaptcha => self.push_verify("regen".into()),
            EngineInput::UseTarget { target } => self.use_target(target),
            EngineInput::Detach => self.detach(),
            EngineInput::Bot(m) => self.on_bot_message(m),
            EngineInput::Disconnected => self.on_disconnected(),
            EngineInput::Reconnected => self.on_reconnected(),
            EngineInput::RateLimited(ms) => {
                self.queue.hold_for(self.now, ms as i64);
                self.rate_limit_until = self.now + RATE_LIMIT_WINDOW_MS;
            }
            EngineInput::CommandsLoaded { guild_id, result } => self.on_commands_loaded(guild_id, result),
            EngineInput::SendResult { id, ok } => {
                if !ok && self.queue.in_flight().is_some_and(|c| c.id == id) {
                    if let Some(c) = self.queue.send_failed() {
                        self.on_no_answer(c, Some("send failed"));
                    }
                }
            }
            EngineInput::Tick => {}
        }
    }

    // ---- plumbing -----------------------------------------------------------

    fn log(&mut self, level: LogLevel, msg: impl Into<String>) {
        self.out.push(Effect::Log { level, msg: msg.into() });
    }
    fn toast_error(&mut self, msg: &str) {
        self.out.push(Effect::Toast(Toast { level: ToastLevel::Error, message: msg.to_string() }));
    }
    fn patch(&mut self, p: Patch) {
        if !p.is_empty() {
            self.out.push(Effect::GamePatch(p));
        }
    }
    fn new_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }
    fn between(&mut self, a: f64, b: f64) -> i64 {
        random_between_ms(a, b, &mut *self.rand)
    }
    fn has(&self, name: &str) -> bool {
        self.commands.iter().any(|c| c.name == name)
    }
    fn gap(&self) -> i64 {
        let factor = if self.now < self.rate_limit_until { RATE_LIMIT_FACTOR } else { 1.0 };
        (self.cfg.fishing.min_gap_sec * 1000.0 * factor).round() as i64
    }
    fn apply(&mut self, ev: &GameEvent) {
        let p = self.game.apply(ev, self.now);
        self.patch(p);
    }

    /// Runs `f` on the scheduler with a fresh context; forwards its patches and break changes.
    fn sched<R>(&mut self, f: impl FnOnce(&mut Scheduler, &mut Ctx) -> R) -> R {
        let mut patches = vec![];
        let r = {
            let mut ctx = Ctx {
                now: self.now,
                cfg: &self.cfg,
                commands: &self.commands,
                queue: &mut self.queue,
                state: &mut self.game,
                rand: &mut *self.rand,
                next_id: &mut self.next_id,
                patches: &mut patches,
            };
            f(&mut self.scheduler, &mut ctx)
        };
        for p in patches {
            self.patch(p);
        }
        if let Some(resting) = self.scheduler.take_rest_change() {
            self.on_rest(resting);
        }
        r
    }

    fn next_due(&self) -> Option<(i64, Due)> {
        [
            (self.captcha.resume_at, Due::Resume),
            (self.network_deadline, Due::Network),
            (self.graceful.as_ref().and_then(|g| g.deadline), Due::Graceful),
            (self.session_check_at, Due::Session),
            (self.scheduler.next_wakeup(), Due::Scheduler),
            (self.queue.next_wakeup(self.gap()), Due::Queue),
        ]
        .into_iter()
        .filter_map(|(t, d)| t.map(|t| (t, d)))
        .min_by_key(|(t, _)| *t)
    }

    /// Fires everything due at `now`, earliest first.
    fn pump(&mut self) {
        for _ in 0..100_000 {
            let Some((t, due)) = self.next_due() else { return };
            if t > self.now {
                return;
            }
            match due {
                Due::Resume => self.captcha_resume(),
                Due::Network => self.enter_error("Connection to Discord lost for more than 2 minutes"),
                Due::Graceful => self.finish_graceful_stop(),
                Due::Session => {
                    self.session_check_at = self.session_active.then_some(self.now + SESSION_CHECK_MS);
                    self.check_session_limit();
                }
                Due::Scheduler => self.sched(|s, c| s.poll(c)),
                Due::Queue => match self.queue.poll(self.now, self.gap()) {
                    Some(QueueAction::Send(c)) => self.send(c),
                    Some(QueueAction::TimedOut(c)) => self.on_no_answer(c, None),
                    None => return,
                },
            }
        }
        self.log(LogLevel::Error, "Engine pump did not settle");
    }

    fn set_state(&mut self, s: EngineState, info: EngineInfo) {
        if s == EngineState::Captcha {
            self.suspend_graceful_timer();
        }
        let prev = self.current;
        self.current = s;
        self.info = info.clone();
        if s == EngineState::Captcha {
            self.out.push(Effect::State { state: s, info: info.clone() });
            self.out.push(Effect::CaptchaShow(CaptchaFlow::payload(&info)));
        } else {
            self.out.push(Effect::State { state: s, info });
            if prev == EngineState::Captcha {
                self.out.push(Effect::CaptchaHide);
            }
        }
    }

    fn fail(&mut self, err: &str) {
        self.log(LogLevel::Error, format!("Unexpected error in the engine: {err}"));
        let _ = catch_unwind(AssertUnwindSafe(|| self.pause(PauseReason::Exception)));
    }

    // ---- commands -----------------------------------------------------------

    fn start(&mut self, target: Target) {
        if self.current == EngineState::Captcha {
            // never drop an unsolved captcha by switching channel
            return self.log(LogLevel::Warn, "Start refused: a captcha must be solved first");
        }
        if !is_idle(self.current) {
            if self.target.as_ref() == Some(&target) {
                return;
            }
            self.stop(false);
        }
        self.gen += 1;
        self.out.push(Effect::SetActiveChannel(Some(target.channel_id.clone())));
        self.out.push(Effect::LoadCommands { guild_id: target.guild_id.clone() });
        self.loading.push(Loading { guild_id: target.guild_id.clone(), gen: self.gen, purpose: Purpose::Start });
        self.target = Some(target);
        self.set_state(EngineState::Connecting, EngineInfo::default());
    }

    fn on_commands_loaded(&mut self, guild_id: String, result: Result<Vec<SlashCommandInfo>, String>) {
        let Some(i) = self.loading.iter().position(|l| l.guild_id == guild_id) else { return };
        let l = self.loading.remove(i);
        match l.purpose {
            Purpose::Start => self.finish_start(l.gen, &guild_id, result),
            Purpose::Manual(pending) => self.finish_manual_load(&guild_id, result, pending),
        }
    }

    fn finish_start(&mut self, gen: u64, guild_id: &str, result: Result<Vec<SlashCommandInfo>, String>) {
        if gen != self.gen {
            return; // stopped or restarted meanwhile
        }
        let cmds = match result {
            Ok(c) => c,
            Err(e) => {
                self.log(LogLevel::Error, format!("{FETCH_COMMANDS_FAILED}: {e}"));
                return self.enter_error(FETCH_COMMANDS_FAILED);
            }
        };
        self.set_commands(cmds, Some(guild_id.to_string()));
        if !self.has("fish") {
            return self.enter_error("Command /fish not found in this server");
        }
        self.failures = 0;
        self.awaiting = None;
        self.deferred_reply = None;
        let p = self.game.start_session(self.now);
        self.patch(p);
        self.session_active = true;
        self.session_started_at = self.now;
        self.session_check_at = Some(self.now + SESSION_CHECK_MS);

        if self.current == EngineState::Captcha {
            // a captcha arrived while connecting: keep everything frozen and empty
            self.sched(|s, c| s.start(c));
            self.queue.clear();
            self.scheduler.freeze(self.now);
            self.sched(|s, c| s.on_queue_cleared(c));
            return;
        }
        self.set_state(EngineState::Running, EngineInfo::default());
        self.queue.resume();
        self.sched(|s, c| s.start(c));
    }

    fn pause(&mut self, reason: PauseReason) {
        if self.current == EngineState::Captcha {
            // lost connection during a captcha: once solved, wait for the reconnect instead of fishing
            if reason == PauseReason::Network && self.pause_reason.is_none() {
                self.pause_reason = Some(PauseReason::Network);
            }
            return;
        }
        if self.current == EngineState::Paused {
            if reason == PauseReason::User && self.pause_reason != Some(PauseReason::User) {
                self.pause_reason = Some(PauseReason::User); // a user pause must not be lifted by a reconnect
                self.set_state(EngineState::Paused, with_reason("user"));
            }
            return;
        }
        if !matches!(self.current, EngineState::Running | EngineState::Resting) {
            return;
        }
        self.queue.pause();
        self.scheduler.freeze(self.now);
        self.pause_reason = Some(reason);
        self.set_state(EngineState::Paused, with_reason(reason_str(reason)));
    }

    fn resume(&mut self) {
        if self.current != EngineState::Paused {
            return;
        }
        self.pause_reason = None;
        self.failures = 0;
        self.sched(|s, c| s.thaw(c));
        self.activate();
    }

    /// Hard stop by default: everything halts now. Graceful: fishing and every timer stop, then
    /// /profile and /quests refresh the data (≤ 25 s, no retry) before halting. A stop while a
    /// graceful stop is under way always halts at once.
    fn stop(&mut self, graceful: bool) {
        if graceful && self.graceful.is_none() {
            return self.stop_gracefully(None);
        }
        self.halt();
        self.set_state(EngineState::Idle, EngineInfo::default());
    }

    /// Running/paused/resting: queued. Idle/error (no session): sent to the configured target while
    /// nothing else runs. Refused in captcha, connecting and stopping.
    fn send_manual(&mut self, name: String, options: SlashOptions) {
        if is_idle(self.current) {
            return self.send_idle(name, options);
        }
        if !is_active(self.current) {
            return self.log(LogLevel::Warn, format!("Command /{name} ignored (state {:?})", self.current));
        }
        if !self.has(&name) {
            return self.log(LogLevel::Warn, format!("Command /{name} not found"));
        }
        let id = self.new_id();
        self.queue.push(QueuedCommand { name, options, priority: Priority::Manual, key: None, id });
    }

    fn send_idle(&mut self, name: String, options: SlashOptions) {
        let Some(target) = self.cfg.target.clone() else {
            self.log(LogLevel::Warn, format!("Command /{name} ignored: no channel selected"));
            return self.toast_error(NO_CHANNEL);
        };
        if self.ensure_target(target, Some((name.clone(), options.clone()))) {
            self.finish_send_idle(name, options);
        }
    }

    fn finish_send_idle(&mut self, name: String, options: SlashOptions) {
        if !is_idle(self.current) {
            return self.log(LogLevel::Warn, format!("Command /{name} ignored (state {:?})", self.current));
        }
        if !self.has(&name) {
            return self.log(LogLevel::Warn, format!("Command /{name} not found"));
        }
        // the scheduler is stopped: nothing but manual commands can be in the queue
        let id = self.new_id();
        self.queue.push(QueuedCommand { name, options, priority: Priority::Manual, key: None, id });
        self.queue.resume();
    }

    /// Manual mode: listens to the target channel and loads its guild's commands (cached per guild),
    /// then emits them. No-op while a session or a captcha is under way.
    fn use_target(&mut self, target: Target) {
        if is_idle(self.current) && self.ensure_target(target, None) {
            self.emit_commands();
        }
    }

    /// Idle/error only: target channel listened to, commands of its guild loaded (cached). True when
    /// the commands are ready now; false while they load (`then` runs once loaded) or when not idle.
    fn ensure_target(&mut self, target: Target, then: Option<(String, SlashOptions)>) -> bool {
        if !is_idle(self.current) {
            return false;
        }
        self.out.push(Effect::SetActiveChannel(Some(target.channel_id.clone())));
        let guild = target.guild_id.clone();
        self.target = Some(target);
        if self.commands_guild.as_deref() == Some(guild.as_str()) && !self.commands.is_empty() {
            return true;
        }
        let pending = self.loading.iter_mut().find(|l| l.guild_id == guild && matches!(l.purpose, Purpose::Manual(_)));
        match pending {
            Some(Loading { purpose: Purpose::Manual(list), .. }) => list.extend(then),
            _ => {
                self.loading.push(Loading { guild_id: guild.clone(), gen: self.gen, purpose: Purpose::Manual(then.into_iter().collect()) });
                self.out.push(Effect::LoadCommands { guild_id: guild });
            }
        }
        false
    }

    fn finish_manual_load(&mut self, guild_id: &str, result: Result<Vec<SlashCommandInfo>, String>, pending: Vec<(String, SlashOptions)>) {
        let same_target = self.target.as_ref().is_some_and(|t| t.guild_id == guild_id);
        match result {
            Err(e) => {
                self.log(LogLevel::Error, format!("{FETCH_COMMANDS_FAILED}: {e}"));
                if is_idle(self.current) && same_target {
                    self.set_commands(vec![], None);
                }
                self.toast_error(LOAD_COMMANDS_FAILED);
            }
            Ok(cmds) => {
                // a session started, or the target moved to another guild, meanwhile: theirs wins
                if !is_idle(self.current) || !same_target {
                    return;
                }
                self.set_commands(cmds, Some(guild_id.to_string()));
                for (name, options) in pending {
                    self.finish_send_idle(name, options);
                }
            }
        }
    }

    /// Logout: halts, forgets the target and its commands, stops listening.
    fn detach(&mut self) {
        self.stop(false);
        self.target = None;
        self.out.push(Effect::SetActiveChannel(None));
        self.set_commands(vec![], None);
    }

    fn set_commands(&mut self, cmds: Vec<SlashCommandInfo>, guild: Option<String>) {
        self.commands = cmds;
        self.commands_guild = guild;
        self.emit_commands();
    }

    fn emit_commands(&mut self) {
        self.out.push(Effect::Commands(self.commands.clone()));
    }

    // ---- captcha --------------------------------------------------------------

    fn push_verify(&mut self, answer: String) {
        if self.current != EngineState::Captcha || self.captcha.info.solved {
            return;
        }
        let Some(verify) = self.commands.iter().find(|c| c.name == "verify").cloned() else {
            return self.log(LogLevel::Warn, "Command /verify not found in this server");
        };
        let id = self.new_id();
        let options = positional_options(&verify, &[Value::String(answer)]);
        self.queue.push(QueuedCommand { name: "verify".into(), options, priority: Priority::Verify, key: Some("verify".into()), id });
    }

    /// True when the event is captcha-related (it is then fully handled here).
    fn captcha_handle(&mut self, ev: &GameEvent) -> bool {
        match ev {
            GameEvent::Captcha { image_url, text } => {
                self.captcha_enter(ev, image_url.clone(), text.clone());
                true
            }
            GameEvent::CaptchaSolved => {
                self.apply(ev);
                if self.current == EngineState::Captcha {
                    if self.captcha.resume_at.is_none() {
                        let ms = self.between(5.0, 15.0);
                        self.captcha.resume_at = Some(self.now + ms);
                    }
                    self.captcha.info.text = Some(CAPTCHA_SOLVED_TEXT.into());
                    self.captcha.info.solved = true;
                    let info = self.captcha.info.engine_info();
                    self.set_state(EngineState::Captcha, info);
                }
                true
            }
            GameEvent::CaptchaFailed { text } => {
                self.apply(ev);
                if self.current == EngineState::Captcha {
                    self.captcha.resume_at = None;
                    self.captcha.info = CaptchaInfo { image_url: self.captcha.info.image_url.take(), text: Some(text.clone()), solved: false };
                    let info = self.captcha.info.engine_info();
                    self.set_state(EngineState::Captcha, info);
                }
                true
            }
            _ => false,
        }
    }

    fn captcha_enter(&mut self, ev: &GameEvent, image_url: Option<String>, text: String) {
        let st = self.current;
        // Safety first: nothing queued survives, nothing new gets in.
        self.queue.clear();
        self.queue.pause();
        self.scheduler.freeze(self.now);
        self.sched(|s, c| s.on_queue_cleared(c)); // dropped maintenance is re-requested after the thaw
        self.captcha.resume_at = None;
        if st != EngineState::Captcha {
            self.captcha.from = Some(st);
            self.apply(ev); // counts the captcha once, not on each update
        }
        self.captcha.show(st == EngineState::Captcha, image_url, text);
        let info = self.captcha.info.engine_info();
        self.set_state(EngineState::Captcha, info);
    }

    fn captcha_resume(&mut self) {
        self.captcha.resume_at = None;
        if self.current != EngineState::Captcha {
            return;
        }
        self.captcha.info = CaptchaInfo::default();
        let from = self.captcha.from.take();
        // no session to resume: queue stays paused (until the next manual command), scheduler stopped
        if from.is_some_and(|f| SESSIONLESS.contains(&f)) {
            self.pause_reason = None;
            self.network_deadline = None;
            return self.set_state(EngineState::Idle, EngineInfo::default());
        }
        // paused before (or, for the network, during) the captcha: stay paused, scheduler frozen
        if let Some(r) = self.pause_reason {
            return self.set_state(EngineState::Paused, with_reason(reason_str(r)));
        }
        self.sched(|s, c| s.thaw(c));
        self.activate();
    }

    // ---- Discord events -----------------------------------------------------------

    fn on_bot_message(&mut self, mut m: BotMessage) {
        if self.target.is_none() {
            return; // not listening (logged out, or no channel chosen yet)
        }
        // Deferred reply: the placeholder does not answer the command (nothing else may be sent
        // meanwhile, e.g. no extra /fish while a captcha is being generated); its edit does.
        if m.loading {
            if !m.is_edit {
                if let Some(a) = self.awaiting.clone() {
                    self.deferred_reply = Some((m.id.clone(), a));
                    self.queue.extend_timeout(self.now, DEFERRED_REPLY_TIMEOUT_MS);
                }
            }
            return;
        }
        if m.is_edit && self.deferred_reply.as_ref().is_some_and(|(id, _)| *id == m.id) {
            self.deferred_reply = None;
            m.is_edit = false; // the real reply to the in-flight command
        }
        let ev = parse_message(&m, self.now);
        let text = build_text(&m);
        // an edit that changes nothing, or would count a catch/sell/purchase/daily twice, is dropped
        if !self.edits.accept(&m.id, m.is_edit, &ev, &text) {
            return;
        }
        // Only non-edit messages answer the in-flight command. Known limitation: a late reply to a
        // command that already timed out can release the next command early.
        let reply_to = if m.is_edit { None } else { self.awaiting.take() };
        if !m.is_edit {
            self.failures = 0;
        }
        self.route(&ev, reply_to.as_ref());
        // Settled after routing: a captcha replying to it has already scheduled its re-request.
        if let Some(r) = &reply_to {
            self.scheduler.on_settled(r);
        }
        // Notified last: a captcha must have paused the queue before it can pump again.
        if !m.is_edit {
            self.queue.notify_response();
        }
    }

    fn route(&mut self, ev: &GameEvent, reply_to: Option<&QueuedCommand>) {
        #[cfg(test)]
        if std::mem::take(&mut self.panic_on_route) {
            panic!("boom");
        }
        if self.captcha_handle(ev) {
            return;
        }
        // the reply to /use has no known format: logged as is (system), not as an unknown message
        match ev {
            GameEvent::Unknown { title, text } if reply_to.is_some_and(|r| r.name == "use") => {
                let t = match title {
                    Some(t) => format!("/use: {t} — {text}"),
                    None => format!("/use: {text}"),
                };
                let p = self.game.note(LogType::System, &t, self.now);
                self.patch(p);
            }
            _ => self.apply(ev), // stats/log only: GameState never sends anything
        }
        if self.graceful.is_some() {
            if let Some(r) = reply_to {
                self.graceful_settled(&r.name);
            }
            return;
        }
        // In captcha (and idle/connecting/error) nothing may trigger a command.
        if !is_active(self.current) {
            // manual /daily without a session: its cooldown still tells when the next one is due
            if let GameEvent::Cooldown { wait_ms } = ev {
                if reply_to.is_some_and(|r| r.name == "daily") && is_idle(self.current) {
                    let p = self.game.set_next_daily_at(Some(self.now + wait_ms), self.now);
                    self.patch(p);
                }
            }
            return;
        }
        if let GameEvent::Error { text } = ev {
            if enough_re().is_match(text) {
                self.on_no_funds(reply_to);
            }
        }
        match ev {
            GameEvent::Cooldown { wait_ms } => self.on_cooldown(*wait_ms, reply_to),
            _ => self.sched(|s, c| s.on_event(ev, c)),
        }
        if reply_to.is_some_and(|r| r.name == "fish") && !matches!(ev, GameEvent::Catch { .. } | GameEvent::Cooldown { .. }) {
            self.sched(|s, c| s.retry_fish(c));
        }
        if reply_to.is_some_and(|r| r.name == "use") {
            self.sched(|s, c| s.after_use(c));
        }
        // /boosts answered by something else: arm the buffs without endsAt rather than never
        if let Some(r) = reply_to.filter(|r| r.key.as_deref() == Some("boosts")) {
            if !matches!(ev, GameEvent::Boosts { .. }) {
                self.sched(|s, c| s.on_command_failed(r, c));
            }
        }
    }

    /// "Wait N": a fish cooldown only when it answers a /fish (or nothing, right after a /fish).
    /// Any other command is re-sent once after N (N ≤ 10 min), else its slot is re-armed past N.
    fn on_cooldown(&mut self, wait_ms: i64, reply_to: Option<&QueuedCommand>) {
        let fish = match reply_to {
            Some(r) => r.name == "fish",
            None => self.last_sent.as_ref().is_some_and(|l| l.name == "fish"),
        };
        if fish {
            return self.sched(|s, c| s.on_event(&GameEvent::Cooldown { wait_ms }, c));
        }
        let Some(r) = reply_to.filter(|r| r.priority != Priority::Verify) else { return };
        if r.name == "daily" {
            let p = self.game.set_next_daily_at(Some(self.now + wait_ms), self.now);
            self.patch(p);
        }
        let wait = format_wait(wait_ms);
        if wait_ms <= DEFER_MAX_MS && !self.deferred.contains(&r.id) {
            let id = self.new_id();
            let again = QueuedCommand { id, ..r.clone() };
            self.deferred.insert(id);
            let ms = wait_ms + self.between(0.2, 1.0);
            let now = self.now;
            self.scheduler.defer_command(again, ms, now);
            return self.log(LogLevel::Info, format!("/{} on cooldown: sent again in {wait}", r.name));
        }
        let delay = wait_ms + self.between(60.0, 300.0);
        if self.scheduler.rearm(r.key.as_deref(), delay, self.now) {
            self.log(LogLevel::Info, format!("/{} on cooldown ({wait}): rescheduled in {}", r.name, format_wait(delay)));
        } else {
            self.log(LogLevel::Info, format!("/{} on cooldown ({wait}): not sent again", r.name));
        }
    }

    fn on_no_funds(&mut self, reply_to: Option<&QueuedCommand>) {
        let key = match reply_to {
            Some(r) if r.priority == Priority::Maintenance => r.key.clone(),
            _ => self.last_maintenance_key.clone(),
        };
        let what = match key.as_deref() {
            Some("bait") => "bait",
            Some(k) if k.starts_with("buff-") => "buff",
            _ => return,
        };
        self.log(LogLevel::Warn, format!("Not enough money: {} purchases suspended for 30 min", if what == "bait" { "bait" } else { "boost" }));
        self.scheduler.block_purchases(what, NO_FUNDS_BLOCK_MS, self.now);
    }

    /// `cause`: None for a timeout, else why the send failed.
    fn on_no_answer(&mut self, c: QueuedCommand, cause: Option<&str>) {
        if self.awaiting.as_ref().is_some_and(|a| a.id == c.id) {
            self.awaiting = None;
        }
        if self.deferred_reply.as_ref().is_some_and(|(_, d)| d.id == c.id) {
            self.deferred_reply = None;
        }
        self.scheduler.on_settled(&c); // a maintenance retry below is tracked again
        if self.graceful.is_some() {
            // stopping: no retry, move on. In a captcha it stays due and is sent again after the solve.
            if self.current != EngineState::Captcha {
                self.graceful_settled(&c.name);
            }
            return;
        }
        if !is_active(self.current) {
            return;
        }
        if let Some(cause) = cause {
            self.log(LogLevel::Warn, format!("Unable to send /{}: {cause}", c.name));
        }
        self.failures += 1;
        self.retry_once(c);
        if self.failures >= MAX_FAILURES {
            self.failures = 0;
            self.pause(PauseReason::NoResponse);
        }
    }

    /// A command without answer is tried again once (fish via its normal delay).
    fn retry_once(&mut self, c: QueuedCommand) {
        match c.priority {
            Priority::Verify => return, // a /verify is only ever sent by a user click
            Priority::Fish => return self.sched(|s, ctx| s.retry_fish(ctx)),
            _ => {}
        }
        if self.retries.contains(&c.id) {
            if c.priority == Priority::Maintenance {
                self.sched(|s, ctx| s.on_command_failed(&c, ctx));
            }
            return;
        }
        let id = self.new_id();
        let again = QueuedCommand { id, ..c };
        self.retries.insert(id);
        if again.priority == Priority::Maintenance {
            self.sched(|s, ctx| s.push_retry(again, ctx)); // tracked: survives a captcha clear
        } else {
            self.queue.push(again);
        }
    }

    fn on_disconnected(&mut self) {
        if is_idle(self.current) {
            return;
        }
        self.pause(PauseReason::Network);
        if self.network_deadline.is_none() {
            self.network_deadline = Some(self.now + NETWORK_GRACE_MS);
        }
    }

    fn on_reconnected(&mut self) {
        self.network_deadline = None;
        if self.current == EngineState::Captcha && self.pause_reason == Some(PauseReason::Network) {
            self.pause_reason = None;
        }
        if self.current == EngineState::Paused && self.pause_reason == Some(PauseReason::Network) {
            self.resume();
        }
    }

    fn on_rest(&mut self, resting: bool) {
        if resting && self.current == EngineState::Running {
            self.queue.pause();
            self.set_state(EngineState::Resting, EngineInfo::default());
        } else if !resting && self.current == EngineState::Resting {
            self.activate();
        }
    }

    // ---- internals ------------------------------------------------------------

    fn send(&mut self, c: QueuedCommand) {
        let Some(target) = self.target.clone() else {
            self.queue.send_failed();
            return self.on_no_answer(c, Some("No active channel"));
        };
        self.awaiting = Some(c.clone());
        self.last_sent = Some(c.clone());
        if c.priority == Priority::Maintenance {
            self.last_maintenance_key = c.key.clone();
        }
        let p = self.game.mark_command_sent(self.now);
        self.patch(p);
        self.out.push(Effect::SendSlash { id: c.id, channel_id: target.channel_id, name: c.name, options: c.options });
    }

    /// Back to work after a pause or a captcha: running, or resting if a break is under way.
    fn activate(&mut self) {
        if self.graceful.is_some() {
            return self.continue_graceful_stop(); // a captcha interrupted the graceful stop
        }
        if self.scheduler.is_resting() {
            self.queue.pause();
            self.set_state(EngineState::Resting, EngineInfo::default());
        } else {
            self.set_state(EngineState::Running, EngineInfo::default());
            self.queue.resume();
        }
    }

    fn check_session_limit(&mut self) {
        let h = self.cfg.session_limit_h;
        if !self.session_active || self.graceful.is_some() || h <= 0.0 || ((self.now - self.session_started_at) as f64) < h * 3_600_000.0 {
            return;
        }
        self.log(LogLevel::Info, "Session limit reached, stopping the engine");
        self.stop_gracefully(Some("Session limit reached".into()));
    }

    // ---- graceful stop ------------------------------------------------------------

    fn stop_gracefully(&mut self, reason: Option<String>) {
        if self.begin_graceful_stop(reason.clone()) {
            return;
        }
        self.halt();
        self.set_state(EngineState::Idle, reason.as_deref().map(with_reason).unwrap_or_default());
    }

    /// False when there is nothing to refresh (no target, no command, not fishing): halt instead.
    fn begin_graceful_stop(&mut self, reason: Option<String>) -> bool {
        let st = self.current;
        if !graceful_from(st) || self.target.is_none() {
            return false;
        }
        let remaining: Vec<String> = GRACEFUL_COMMANDS.iter().filter(|n| self.has(n)).map(|n| n.to_string()).collect();
        if remaining.is_empty() {
            return false;
        }
        self.sched(|s, c| s.stop(c)); // /fish and every periodic timer
        if st != EngineState::Captcha {
            self.queue.clear(); // in a captcha the queue only ever holds the user's /verify
        }
        self.pause_reason = None;
        self.graceful = Some(GracefulStop { remaining, budget_ms: GRACEFUL_MAX_MS, armed_at: 0, deadline: None, reason });
        self.log(LogLevel::Info, "Graceful stop: refreshing the profile and the quests");
        // captcha: nothing is sent until it is solved; activate() then continues the stop
        if st != EngineState::Captcha {
            self.continue_graceful_stop();
        }
        true
    }

    /// (Re)sends what is still unanswered and arms the remaining budget.
    fn continue_graceful_stop(&mut self) {
        let Some(remaining) = self.graceful.as_ref().map(|g| g.remaining.clone()) else { return };
        if remaining.is_empty() {
            return self.finish_graceful_stop();
        }
        self.set_state(EngineState::Stopping, EngineInfo::default());
        for name in remaining {
            // already in flight (e.g. a scheduled /profile): its reply or timeout settles it
            if self.awaiting.as_ref().is_none_or(|a| a.name != name) {
                let id = self.new_id();
                self.queue.push(QueuedCommand { key: Some(name.clone()), name, options: SlashOptions::new(), priority: Priority::Maintenance, id });
            }
        }
        self.queue.resume();
        let now = self.now;
        if let Some(g) = self.graceful.as_mut() {
            g.armed_at = now;
            g.deadline = Some(now + g.budget_ms.max(0));
        }
    }

    /// A graceful command got its reply or timed out.
    fn graceful_settled(&mut self, name: &str) {
        let Some(g) = self.graceful.as_mut() else { return };
        g.remaining.retain(|n| n != name);
        if g.remaining.is_empty() && self.current == EngineState::Stopping {
            self.finish_graceful_stop();
        }
    }

    /// A captcha interrupts the stop: its budget is frozen until the captcha is solved.
    fn suspend_graceful_timer(&mut self) {
        let now = self.now;
        if let Some(g) = self.graceful.as_mut() {
            if g.deadline.take().is_some() {
                g.budget_ms -= now - g.armed_at;
            }
        }
    }

    fn finish_graceful_stop(&mut self) {
        let reason = self.graceful.as_ref().and_then(|g| g.reason.clone());
        self.halt();
        self.set_state(EngineState::Idle, reason.as_deref().map(with_reason).unwrap_or_default());
    }

    /// Stops every source of commands; the caller sets the resulting state.
    fn halt(&mut self) {
        self.gen += 1;
        self.graceful = None;
        self.captcha.reset();
        self.sched(|s, c| s.stop(c));
        self.queue.clear();
        self.queue.pause();
        self.queue.notify_response(); // drop the wait on an in-flight command of the old target
        self.awaiting = None;
        self.deferred_reply = None;
        self.last_sent = None;
        self.pause_reason = None;
        self.network_deadline = None;
        self.session_check_at = None;
        if self.session_active {
            let summary = self.game.end_session(self.now);
            self.out.push(Effect::SessionEnded(summary));
        }
        self.session_active = false;
        // target and active channel are kept: manual commands still work while idle (detach drops them)
    }

    fn enter_error(&mut self, reason: &str) {
        self.halt();
        self.set_state(EngineState::Error, with_reason(reason));
    }
}

#[cfg(test)]
mod tests {
    use super::format_wait;

    #[test]
    fn format_wait_matches_v1() {
        assert_eq!(format_wait(30_000), "30s");
        assert_eq!(format_wait(5 * 60_000), "5m");
        assert_eq!(format_wait((20 * 60 + 12) * 60_000), "20h 12m");
        assert_eq!(format_wait(65 * 60_000), "1h 05m");
    }
}
