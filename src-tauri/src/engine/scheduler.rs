//! Scheduler (port of `Scheduler.ts`): every timer feeding the queue (fish, sell, buffs, bait, profile,
//! daily, quests, breaks). Timers are slots with a deadline and an action; `freeze()`/`thaw()` suspend
//! them with their remaining time; while frozen or resting nothing is pushed. Config is re-read at every
//! decision. Time, config, queue and game state come in through `Ctx`; the owner calls `poll` at
//! `next_wakeup()`.

use super::game_state::{GameState, Patch};
use super::humanize::{fish_delay_ms, random_between_ms};
use super::queue::{CommandQueue, Priority, QueuedCommand};
use crate::model::{Boost, Config, GameEvent, SellMode, SlashCommandInfo, SlashOptions};
use serde_json::Value;
use std::collections::BTreeMap;

const MIN: i64 = 60_000;
const POLL_MS: i64 = MIN; // re-check interval for a disabled feature (config hot reload)
const DAILY_MS: i64 = 24 * 60 * MIN;
const QUESTS_MS: i64 = 30 * MIN;
const BAIT_LOW: u64 = 3; // estimated bait left below which we buy more

/// Everything the scheduler reads or acts on, for one call.
pub struct Ctx<'a> {
    pub now: i64,
    pub cfg: &'a Config,
    pub commands: &'a [SlashCommandInfo],
    pub queue: &'a mut CommandQueue,
    pub state: &'a mut GameState,
    pub rand: &'a mut dyn FnMut() -> f64,
    pub next_id: &'a mut u64,
    /// GameState patches produced (e.g. next fish time), for the UI.
    pub patches: &'a mut Vec<Patch>,
}

impl Ctx<'_> {
    fn info(&self, name: &str) -> Option<&SlashCommandInfo> {
        self.commands.iter().find(|c| c.name == name)
    }
    fn has(&self, name: &str) -> bool {
        self.info(name).is_some()
    }
    fn between(&mut self, a: f64, b: f64) -> i64 {
        random_between_ms(a, b, self.rand)
    }
    fn grace(&mut self) -> i64 {
        self.between(5.0, 30.0)
    }
    fn cmd(&mut self, name: &str, options: SlashOptions, priority: Priority, key: Option<&str>) -> QueuedCommand {
        *self.next_id += 1;
        QueuedCommand { name: name.into(), options, priority, key: key.map(str::to_string), id: *self.next_id }
    }
}

/// SlashOptions keyed by the command's real option names, filled positionally.
pub fn positional_options(info: &SlashCommandInfo, values: &[Value]) -> SlashOptions {
    info.options.iter().zip(values).map(|(o, v)| (o.name.clone(), v.clone())).collect()
}

/// Options for `/use` activating a booster of `kind` ("personal"/"global"): the option whose choices
/// contain it (case-insensitive). None when the command or the choice is missing.
pub fn booster_use_options(cmd: Option<&SlashCommandInfo>, kind: &str) -> Option<SlashOptions> {
    for o in &cmd?.options {
        let choices = o.choices.as_deref().unwrap_or(&[]);
        let pick = choices.iter().find(|c| c.to_lowercase() == kind).or_else(|| choices.iter().find(|c| c.to_lowercase().contains(kind)));
        if let Some(c) = pick {
            return Some([(o.name.clone(), Value::String(c.clone()))].into_iter().collect());
        }
    }
    None
}

fn buff_type(name: &str) -> Option<&'static str> {
    let l = name.to_lowercase();
    if l.contains("treasure") {
        return Some("treasure");
    }
    let minutes = regex_lite_minutes(&l);
    (l.contains("fish") && (l.contains("boost") || minutes)).then_some("fish")
}

/// `\d+\s*m\b` without pulling a regex in for one check.
fn regex_lite_minutes(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_digit() {
            let mut j = i;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            while j < b.len() && b[j] == b' ' {
                j += 1;
            }
            if j < b.len() && b[j] == b'm' && (j + 1 == b.len() || !b[j + 1].is_ascii_alphanumeric()) {
                return true;
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    false
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Activity,
    Rest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Loop {
    Profile,
    Daily,
    Quests,
    Sell,
}

#[derive(Debug, Clone, PartialEq)]
enum Action {
    Fish,
    Loop(Loop),
    BuffCycleTick,
    BuyBuffs,
    BoostsExpiry,
    Redo(QueuedCommand),
    Defer(QueuedCommand),
    Work,
    StartRest,
    EndRest,
}

#[derive(Debug, Clone)]
struct Slot {
    action: Action,
    kind: Kind,
    /// Armed: fires at this time. None: suspended with `remaining` ms left.
    deadline: Option<i64>,
    remaining: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BuffPhase {
    Off,
    Checking,
    Buying,
    Waiting,
}

pub struct Scheduler {
    slots: BTreeMap<String, Slot>,
    running: bool,
    frozen: bool,
    resting: bool,
    /// Maintenance commands pushed and not yet answered (queued or in flight), by dedupe key.
    pending: BTreeMap<String, QueuedCommand>,
    buy_blocked_until_buff: i64,
    buy_blocked_until_bait: i64,
    personal_ends_at: Option<i64>,
    boosters_checked: bool,
    booster_used: bool,
    boosters_exhausted: bool,
    buff_phase: BuffPhase,
    buff_bought_at: i64,
    /// A break started (true) or ended (false) since the last `take_rest_change`.
    rest_change: Option<bool>,
}

impl Default for Scheduler {
    fn default() -> Self {
        Self {
            slots: BTreeMap::new(),
            running: false,
            frozen: false,
            resting: false,
            pending: BTreeMap::new(),
            buy_blocked_until_buff: i64::MIN,
            buy_blocked_until_bait: i64::MIN,
            personal_ends_at: None,
            boosters_checked: false,
            booster_used: false,
            boosters_exhausted: false,
            buff_phase: BuffPhase::Off,
            buff_bought_at: 0,
            rest_change: None,
        }
    }
}

impl Scheduler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_resting(&self) -> bool {
        self.resting
    }
    pub fn is_running(&self) -> bool {
        self.running
    }
    pub fn take_rest_change(&mut self) -> Option<bool> {
        self.rest_change.take()
    }

    pub fn start(&mut self, ctx: &mut Ctx) {
        self.stop(ctx);
        self.running = true;
        self.personal_ends_at = None;
        self.boosters_checked = false;
        self.booster_used = false;
        self.boosters_exhausted = false;
        // data first (/profile, /boosts, daily, quests), then the first /fish: maintenance outranks fish
        self.run_loop(Loop::Profile, ctx);
        self.buff_phase = BuffPhase::Off;
        if ctx.has("boosts") {
            self.push_boosts(ctx); // always refreshed at start (boost chips)
        }
        if ctx.cfg.buffs.enabled && ctx.has("boosts") {
            self.buff_phase = BuffPhase::Checking; // its reply decides the first cycle
        } else {
            let ms = if ctx.cfg.buffs.enabled { ctx.grace() } else { POLL_MS };
            self.set("buff-cycle", ms, Action::BuffCycleTick, Kind::Activity, ctx.now);
        }
        self.run_loop(Loop::Daily, ctx);
        self.run_loop(Loop::Quests, ctx);
        let sell_first = sell_interval_ms(ctx.cfg).unwrap_or(POLL_MS);
        self.set("sell", sell_first, Action::Loop(Loop::Sell), Kind::Activity, ctx.now);
        self.push_fish(ctx);
        self.arm_work(ctx);
    }

    pub fn stop(&mut self, ctx: &mut Ctx) {
        self.slots.clear();
        self.pending.clear();
        self.running = false;
        self.frozen = false;
        self.resting = false;
        ctx.patches.push(ctx.state.set_next_fish_at(None, ctx.now));
    }

    pub fn freeze(&mut self, now: i64) {
        self.frozen = true;
        self.sync_all(now);
    }

    pub fn thaw(&mut self, ctx: &mut Ctx) {
        self.frozen = false;
        self.sync_all(ctx.now);
        self.ensure_fish(ctx);
    }

    pub fn on_event(&mut self, e: &GameEvent, ctx: &mut Ctx) {
        if !self.running {
            return;
        }
        match e {
            GameEvent::Catch { quests_completed, .. } => {
                let d = fish_delay_ms(&ctx.cfg.fishing, ctx.rand);
                self.fish_after(d, ctx);
                let s = &ctx.cfg.sell;
                if s.enabled && s.mode == SellMode::Catches && ctx.state.catches_since_sell() as f64 >= s.every {
                    self.push_sell(ctx);
                }
                self.maybe_bait(false, ctx);
                // a quest just completed: refresh the quest list now rather than at the next 30 min tick
                if quests_completed.as_ref().is_some_and(|q| !q.is_empty()) && ctx.has("quests") {
                    let c = ctx.cmd("quests", SlashOptions::new(), Priority::Maintenance, Some("quests"));
                    self.push(c, ctx);
                }
            }
            GameEvent::Cooldown { wait_ms } => {
                let extra = ctx.between(0.2, 1.0);
                self.fish_after(wait_ms + extra, ctx);
            }
            GameEvent::Sell { .. } => self.push_profile(ctx),
            GameEvent::Inventory { .. } => self.maybe_bait(true, ctx),
            GameEvent::Boosts { active } => {
                self.on_buff_boosts(active, ctx);
                self.on_boosts(active, ctx);
            }
            GameEvent::Boosters { personal } => self.on_boosters(*personal, ctx),
            // bait bought: refresh the estimate from the inventory
            GameEvent::Purchase { item, .. } if buff_type(item).is_none() => self.push_profile(ctx),
            _ => {}
        }
    }

    /// The /fish got no usable answer: try again after a normal delay.
    pub fn retry_fish(&mut self, ctx: &mut Ctx) {
        if self.running {
            let d = fish_delay_ms(&ctx.cfg.fishing, ctx.rand);
            self.fish_after(d, ctx);
        }
    }

    /// The command got its reply, or failed: it no longer needs re-requesting after a captcha.
    pub fn on_settled(&mut self, c: &QueuedCommand) {
        if let Some(k) = &c.key {
            if self.pending.get(k).is_some_and(|p| p.id == c.id) {
                self.pending.remove(k);
            }
        }
    }

    /// Engine retry of a timed-out maintenance command: queued and tracked like any other.
    pub fn push_retry(&mut self, c: QueuedCommand, ctx: &mut Ctx) {
        if !self.running || !ctx.queue.push(c.clone()) {
            return;
        }
        if let Some(k) = &c.key {
            self.pending.insert(k.clone(), c);
        }
    }

    /// A maintenance command got no usable answer (none after its retry, or not the expected kind).
    pub fn on_command_failed(&mut self, c: &QueuedCommand, ctx: &mut Ctx) {
        if !self.running || c.key.as_deref() != Some("boosts") {
            return;
        }
        match self.buff_phase {
            BuffPhase::Checking => {
                let g = ctx.grace();
                self.set("buff-cycle", g, Action::BuffCycleTick, Kind::Activity, ctx.now);
            }
            BuffPhase::Buying => self.wait_buffs(None, ctx),
            _ => {}
        }
    }

    /// The queue was emptied (captcha): every pending maintenance command is requested again 5–30 s
    /// after the thaw (slots are frozen until then). A cut buff cycle restarts with a fresh /boosts check.
    pub fn on_queue_cleared(&mut self, ctx: &mut Ctx) {
        if matches!(self.buff_phase, BuffPhase::Checking | BuffPhase::Buying) {
            for key in ["buff-fish", "buff-treasure", "boosts"] {
                self.pending.remove(key);
            }
            self.buff_phase = BuffPhase::Off;
            let g = ctx.grace();
            self.set("buff-cycle", g, Action::BuffCycleTick, Kind::Activity, ctx.now);
        }
        let pending = std::mem::take(&mut self.pending);
        for (key, cmd) in pending {
            let g = ctx.grace();
            self.set(&format!("redo-{key}"), g, Action::Redo(cmd), Kind::Activity, ctx.now);
        }
    }

    /// A command answered by a short "wait N": pushed again after `ms`.
    pub fn defer_command(&mut self, c: QueuedCommand, ms: i64, now: i64) {
        if self.running {
            let name = format!("defer-{}", c.key.clone().unwrap_or_else(|| c.name.clone()));
            self.set(&name, ms, Action::Defer(c), Kind::Activity, now);
        }
    }

    /// A maintenance command answered by a long "wait N": its periodic slot fires next in `ms`.
    pub fn rearm(&mut self, key: Option<&str>, ms: i64, now: i64) -> bool {
        let Some(key) = key else { return false };
        let Some(slot) = self.slots.get(key).cloned() else { return false };
        if !self.running {
            return false;
        }
        self.set(key, ms, slot.action, slot.kind, now);
        true
    }

    /// /use got its reply (whatever it says): refresh the active boosts.
    pub fn after_use(&mut self, ctx: &mut Ctx) {
        if self.running {
            self.push_boosts(ctx);
        }
    }

    /// Not enough money: stop buying this kind of item ("buff" or "bait") for `ms`.
    pub fn block_purchases(&mut self, what: &str, ms: i64, now: i64) {
        if what == "bait" {
            self.buy_blocked_until_bait = now + ms;
        } else {
            self.buy_blocked_until_buff = now + ms;
        }
    }

    /// When `poll` should run next.
    pub fn next_wakeup(&self) -> Option<i64> {
        self.slots.values().filter_map(|s| s.deadline).min()
    }

    /// Fires every slot due at `ctx.now` (earliest first).
    pub fn poll(&mut self, ctx: &mut Ctx) {
        loop {
            let due = self
                .slots
                .iter()
                .filter(|(_, s)| s.deadline.is_some_and(|d| d <= ctx.now))
                .min_by_key(|(_, s)| s.deadline)
                .map(|(k, _)| k.clone());
            let Some(name) = due else { break };
            let Some(slot) = self.slots.remove(&name) else { break };
            self.fire(&name, slot.action, ctx);
        }
    }

    // ---- features -------------------------------------------------------

    fn fire(&mut self, name: &str, action: Action, ctx: &mut Ctx) {
        match action {
            Action::Fish => self.push_fish(ctx),
            Action::Loop(l) => {
                let _ = name;
                self.run_loop(l, ctx);
            }
            Action::BuffCycleTick => self.buff_cycle_tick(ctx),
            Action::BuyBuffs => self.buy_buffs(ctx),
            Action::BoostsExpiry => self.push_boosts(ctx),
            Action::Redo(cmd) => {
                let key = cmd.key.clone().unwrap_or_default();
                let blocked_until = if key == "bait" {
                    Some(self.buy_blocked_until_bait)
                } else if key.starts_with("buff-") {
                    Some(self.buy_blocked_until_buff)
                } else {
                    None
                };
                if blocked_until.is_none_or(|t| ctx.now >= t) {
                    self.push(cmd, ctx);
                }
            }
            Action::Defer(cmd) => self.push(cmd, ctx),
            Action::Work => self.arm_work(ctx),
            Action::StartRest => self.start_rest(ctx),
            Action::EndRest => self.end_rest(ctx),
        }
    }

    /// Runs the loop's tick now and re-arms it with its delay (POLL_MS when disabled).
    fn run_loop(&mut self, l: Loop, ctx: &mut Ctx) {
        let next = match l {
            Loop::Profile => self.profile_tick(ctx),
            Loop::Daily => self.daily_tick(ctx),
            Loop::Quests => self.quests_tick(ctx),
            Loop::Sell => self.sell_tick(ctx),
        }
        .unwrap_or(POLL_MS);
        let name = match l {
            Loop::Profile => "profile",
            Loop::Daily => "daily",
            Loop::Quests => "quests",
            Loop::Sell => "sell",
        };
        self.set(name, next, Action::Loop(l), Kind::Activity, ctx.now);
    }

    fn push_boosts(&mut self, ctx: &mut Ctx) {
        if ctx.has("boosts") {
            let c = ctx.cmd("boosts", SlashOptions::new(), Priority::Maintenance, Some("boosts"));
            self.push(c, ctx);
        }
    }

    /// /boosts reply: re-asks /boosts once the next boost ends, and (opt-in) starts the personal
    /// booster check when none is active.
    fn on_boosts(&mut self, active: &[Boost], ctx: &mut Ctx) {
        let live: Vec<&Boost> = active.iter().filter(|b| b.ends_at > ctx.now).collect();
        let personal = live.iter().find(|b| b.name == "Personal").map(|b| b.ends_at);
        self.personal_ends_at = personal;
        if personal.is_some() {
            self.boosters_checked = false;
            self.booster_used = false;
        }
        if let Some(next) = live.iter().map(|b| b.ends_at).min() {
            let extra = ctx.between(2.0, 10.0);
            self.set("boosts-expiry", next - ctx.now + extra, Action::BoostsExpiry, Kind::Activity, ctx.now);
        } else {
            self.slots.remove("boosts-expiry");
        }
        if personal.is_some() || self.boosters_checked || self.boosters_exhausted {
            return;
        }
        if !ctx.cfg.boosters.auto_personal || !ctx.has("boosters") {
            return;
        }
        self.boosters_checked = true;
        let c = ctx.cmd("boosters", SlashOptions::new(), Priority::Maintenance, Some("boosters"));
        self.push(c, ctx);
    }

    /// /boosters reply: activates one personal booster when allowed (at most one /use per expiry).
    fn on_boosters(&mut self, owned: u64, ctx: &mut Ctx) {
        if owned == 0 {
            self.boosters_exhausted = true;
            return;
        }
        if !ctx.cfg.boosters.auto_personal || self.booster_used {
            return;
        }
        if self.personal_ends_at.is_some_and(|t| t > ctx.now) {
            return;
        }
        let Some(options) = booster_use_options(ctx.info("use"), "personal") else { return };
        self.booster_used = true;
        let c = ctx.cmd("use", options, Priority::Maintenance, Some("use"));
        self.push(c, ctx);
    }

    fn fish_after(&mut self, ms: i64, ctx: &mut Ctx) {
        ctx.patches.push(ctx.state.set_next_fish_at(Some(ctx.now + ms), ctx.now));
        self.set("fish", ms, Action::Fish, Kind::Activity, ctx.now);
    }

    fn push_fish(&mut self, ctx: &mut Ctx) {
        let c = ctx.cmd("fish", SlashOptions::new(), Priority::Fish, Some("fish"));
        self.push(c, ctx);
    }

    fn ensure_fish(&mut self, ctx: &mut Ctx) {
        if self.running && !self.slots.contains_key("fish") {
            self.retry_fish(ctx);
        }
    }

    fn push_sell(&mut self, ctx: &mut Ctx) {
        let Some(info) = ctx.info("sell").cloned() else { return };
        let options = sell_all_options(&info);
        let c = ctx.cmd("sell", options, Priority::Maintenance, Some("sell"));
        self.push(c, ctx);
    }

    fn push_profile(&mut self, ctx: &mut Ctx) {
        for name in ["profile", "stats"] {
            if ctx.has(name) {
                let c = ctx.cmd(name, SlashOptions::new(), Priority::Maintenance, Some(name));
                self.push(c, ctx);
            }
        }
    }

    fn profile_tick(&mut self, ctx: &mut Ctx) -> Option<i64> {
        let m = ctx.cfg.profile.refresh_min;
        if m <= 0.0 {
            return None;
        }
        self.push_profile(ctx);
        Some((m * MIN as f64) as i64)
    }

    /// /daily only when it is due: nextDailyAt unknown or passed. Otherwise the slot fires again
    /// 1–5 min after nextDailyAt (if the session still runs then).
    fn daily_tick(&mut self, ctx: &mut Ctx) -> Option<i64> {
        if !ctx.cfg.daily.enabled || !ctx.has("daily") {
            return None;
        }
        if let Some(next) = ctx.state.next_daily_at().filter(|n| ctx.now < *n) {
            return Some(next - ctx.now + ctx.between(60.0, 300.0));
        }
        let c = ctx.cmd("daily", SlashOptions::new(), Priority::Maintenance, Some("daily"));
        self.push(c, ctx);
        Some(DAILY_MS + ctx.between(120.0, 600.0))
    }

    fn quests_tick(&mut self, ctx: &mut Ctx) -> Option<i64> {
        if !ctx.cfg.quests.enabled || !ctx.has("quests") {
            return None;
        }
        let c = ctx.cmd("quests", SlashOptions::new(), Priority::Maintenance, Some("quests"));
        self.push(c, ctx);
        Some(QUESTS_MS)
    }

    fn sell_tick(&mut self, ctx: &mut Ctx) -> Option<i64> {
        let every = sell_interval_ms(ctx.cfg);
        if every.is_some() && ctx.state.catches_since_sell() > 0 {
            self.push_sell(ctx);
        }
        every
    }

    fn buff_cycle_tick(&mut self, ctx: &mut Ctx) {
        if !ctx.cfg.buffs.enabled || !ctx.has("buy") {
            self.buff_phase = BuffPhase::Off;
            self.set("buff-cycle", POLL_MS, Action::BuffCycleTick, Kind::Activity, ctx.now); // picks up buffs enabled mid-session
            return;
        }
        if self.buff_phase == BuffPhase::Off && ctx.has("boosts") {
            self.buff_phase = BuffPhase::Checking; // check what is active first
            return self.push_boosts(ctx);
        }
        self.buy_buffs(ctx);
    }

    /// Fish then treasure buff, then /boosts: pushed back to back so nothing runs in between.
    fn buy_buffs(&mut self, ctx: &mut Ctx) {
        let Some(buy) = ctx.info("buy").cloned().filter(|_| ctx.cfg.buffs.enabled) else {
            self.set("buff-cycle", POLL_MS, Action::BuffCycleTick, Kind::Activity, ctx.now);
            return;
        };
        let blocked_for = self.buy_blocked_until_buff.saturating_sub(ctx.now);
        if blocked_for > 0 {
            self.set("buff-cycle", blocked_for, Action::BuffCycleTick, Kind::Activity, ctx.now);
            return;
        }
        let len = ctx.cfg.buffs.length_min;
        for kind in ["fish", "treasure"] {
            let options = positional_options(&buy, &[Value::String(format!("{kind}{len}m")), Value::from(1)]);
            let key = format!("buff-{kind}");
            let c = ctx.cmd("buy", options, Priority::Maintenance, Some(&key));
            self.push(c, ctx);
        }
        self.buff_bought_at = ctx.now;
        self.buff_phase = BuffPhase::Buying;
        if ctx.has("boosts") {
            self.push_boosts(ctx);
        } else {
            self.wait_buffs(None, ctx);
        }
    }

    fn on_buff_boosts(&mut self, active: &[Boost], ctx: &mut Ctx) {
        let last_end = active.iter().filter(|b| buff_type(&b.name).is_some()).map(|b| b.ends_at).max();
        match self.buff_phase {
            BuffPhase::Checking => match last_end {
                None => {
                    let g = ctx.grace();
                    self.set("buff-cycle", g, Action::BuffCycleTick, Kind::Activity, ctx.now);
                }
                Some(_) => self.wait_buffs(last_end, ctx),
            },
            BuffPhase::Buying => self.wait_buffs(last_end, ctx),
            BuffPhase::Waiting if last_end.is_some() => self.wait_buffs(last_end, ctx),
            _ => {}
        }
    }

    /// Waits until both buffs are over (`last_end`, or the buff length after the purchase), then buys again.
    fn wait_buffs(&mut self, last_end: Option<i64>, ctx: &mut Ctx) {
        let end = last_end.unwrap_or(self.buff_bought_at + ctx.cfg.buffs.length_min as i64 * MIN);
        self.buff_phase = BuffPhase::Waiting;
        let g = ctx.grace();
        self.set("buff-cycle", (end - ctx.now).max(0) + g, Action::BuyBuffs, Kind::Activity, ctx.now);
    }

    fn maybe_bait(&mut self, unknown_is_low: bool, ctx: &mut Ctx) {
        let low = match ctx.state.bait_estimate() {
            None => unknown_is_low,
            Some(n) => n < BAIT_LOW,
        };
        if low {
            self.push_bait(ctx);
        }
    }

    fn push_bait(&mut self, ctx: &mut Ctx) {
        let cfg = ctx.cfg;
        let Some(buy) = ctx.info("buy").cloned() else { return };
        if !cfg.bait.enabled || cfg.bait.name.is_empty() || ctx.now < self.buy_blocked_until_bait {
            return;
        }
        let amount = if cfg.bait.auto_amount {
            (((cfg.buffs.length_min as f64 * 60.0) / cfg.fishing.base_cooldown_sec - 10.0) * 0.75).ceil().max(1.0)
        } else {
            cfg.bait.amount
        };
        if amount <= 0.0 {
            return;
        }
        let options = positional_options(&buy, &[Value::String(cfg.bait.name.clone()), Value::from(amount as u64)]);
        let c = ctx.cmd("buy", options, Priority::Maintenance, Some("bait"));
        self.push(c, ctx);
    }

    fn arm_work(&mut self, ctx: &mut Ctx) {
        let b = ctx.cfg.breaks.clone();
        if !b.enabled {
            self.set("work", POLL_MS, Action::Work, Kind::Activity, ctx.now);
            return;
        }
        let ms = ctx.between((b.work_min - b.work_jitter_min) * 60.0, (b.work_min + b.work_jitter_min) * 60.0).max(MIN);
        self.set("work", ms, Action::StartRest, Kind::Activity, ctx.now);
    }

    fn start_rest(&mut self, ctx: &mut Ctx) {
        let b = ctx.cfg.breaks.clone();
        if !b.enabled {
            return self.arm_work(ctx);
        }
        self.resting = true;
        self.sync_all(ctx.now);
        self.rest_change = Some(true);
        let ms = ctx.between((b.rest_min - b.rest_jitter_min) * 60.0, (b.rest_min + b.rest_jitter_min) * 60.0).max(MIN);
        self.set("rest", ms, Action::EndRest, Kind::Rest, ctx.now);
    }

    fn end_rest(&mut self, ctx: &mut Ctx) {
        self.resting = false;
        self.sync_all(ctx.now);
        self.rest_change = Some(false);
        self.arm_work(ctx);
        self.ensure_fish(ctx);
    }

    // ---- plumbing -------------------------------------------------------

    /// Pushes only while actively fishing: never while frozen (pause/captcha) or resting.
    fn push(&mut self, c: QueuedCommand, ctx: &mut Ctx) {
        if !self.runnable(Kind::Activity) || !ctx.queue.push(c.clone()) {
            return;
        }
        if c.priority == Priority::Maintenance {
            if let Some(k) = &c.key {
                self.pending.insert(k.clone(), c);
            }
        }
    }

    fn runnable(&self, kind: Kind) -> bool {
        self.running && !self.frozen && (kind == Kind::Rest || !self.resting)
    }

    fn set(&mut self, name: &str, ms: i64, action: Action, kind: Kind, now: i64) {
        let mut slot = Slot { action, kind, deadline: None, remaining: ms.max(0) };
        if self.runnable(kind) {
            slot.deadline = Some(now + slot.remaining);
        }
        self.slots.insert(name.to_string(), slot);
    }

    /// Arms or suspends every slot according to running/frozen/resting.
    fn sync_all(&mut self, now: i64) {
        let flags = (self.running, self.frozen, self.resting);
        for s in self.slots.values_mut() {
            let want = flags.0 && !flags.1 && (s.kind == Kind::Rest || !flags.2);
            match (want, s.deadline) {
                (true, None) => s.deadline = Some(now + s.remaining),
                (false, Some(d)) => {
                    s.remaining = (d - now).max(0);
                    s.deadline = None;
                }
                _ => {}
            }
        }
    }
}

fn sell_interval_ms(cfg: &Config) -> Option<i64> {
    let s = &cfg.sell;
    (s.enabled && s.mode == SellMode::Minutes && s.every > 0.0).then_some((s.every * MIN as f64) as i64)
}

/// `/sell all`: the option whose choices include "all" (case-insensitive), else the first option.
pub fn sell_all_options(info: &SlashCommandInfo) -> SlashOptions {
    let opt = info
        .options
        .iter()
        .find(|o| o.choices.as_ref().is_some_and(|c| c.iter().any(|x| x.eq_ignore_ascii_case("all"))))
        .or_else(|| info.options.first());
    let Some(o) = opt else { return SlashOptions::new() };
    let all = o.choices.as_ref().and_then(|c| c.iter().find(|x| x.eq_ignore_ascii_case("all")).cloned()).unwrap_or_else(|| "all".into());
    [(o.name.clone(), Value::String(all))].into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::queue::QueueAction;
    use crate::model::{Bait, CatchItem, RareCounts, SlashOption};

    fn opt(name: &str, choices: Option<&[&str]>) -> SlashOption {
        SlashOption { name: name.into(), kind: 3, required: false, choices: choices.map(|c| c.iter().map(|s| s.to_string()).collect()), choice_names: None }
    }
    fn commands() -> Vec<SlashCommandInfo> {
        let c = |n: &str, options: Vec<SlashOption>| SlashCommandInfo { name: n.into(), id: n.into(), version: "1".into(), options };
        vec![
            c("fish", vec![]),
            c("sell", vec![opt("amount", None)]),
            c("buy", vec![opt("item", None), opt("amount", None)]),
            c("profile", vec![]),
            c("daily", vec![]),
            c("quests", vec![]),
            c("boosts", vec![]),
            c("boosters", vec![]),
            c("use", vec![opt("type", Some(&["Personal", "Global"]))]),
        ]
    }

    /// A tiny harness: scheduler + queue + state with a manual clock; replies are drained by hand.
    struct H {
        s: Scheduler,
        q: CommandQueue,
        g: GameState,
        cfg: Config,
        cmds: Vec<SlashCommandInfo>,
        now: i64,
        ids: u64,
        sent: Vec<QueuedCommand>,
    }

    impl H {
        fn new(patch: impl FnOnce(&mut Config)) -> Self {
            let mut cfg = Config::default();
            cfg.sell.enabled = false;
            cfg.daily.enabled = false;
            cfg.quests.enabled = false;
            cfg.profile.refresh_min = 0.0;
            patch(&mut cfg);
            Self { s: Scheduler::new(), q: CommandQueue::new(8000), g: GameState::new(), cfg, cmds: commands(), now: 0, ids: 0, sent: vec![] }
        }
        fn with<R>(&mut self, f: impl FnOnce(&mut Scheduler, &mut Ctx) -> R) -> R {
            let mut rand = || 0.5;
            let mut patches = vec![];
            let mut ctx = Ctx { now: self.now, cfg: &self.cfg, commands: &self.cmds, queue: &mut self.q, state: &mut self.g, rand: &mut rand, next_id: &mut self.ids, patches: &mut patches };
            f(&mut self.s, &mut ctx)
        }
        fn start(&mut self) {
            self.with(|s, c| s.start(c));
            self.drain();
        }
        /// Sends whatever the queue lets out now, answering each at once.
        fn drain(&mut self) {
            while let Some(QueueAction::Send(c)) = self.q.poll(self.now, 0) {
                self.q.notify_response();
                self.sent.push(c);
            }
        }
        fn advance(&mut self, ms: i64) {
            let end = self.now + ms;
            loop {
                let next = self.s.next_wakeup().filter(|t| *t <= end);
                match next {
                    Some(t) => {
                        self.now = t.max(self.now);
                        self.with(|s, c| s.poll(c));
                        self.drain();
                    }
                    None => break,
                }
            }
            self.now = end;
        }
        fn event(&mut self, e: GameEvent) {
            let now = self.now;
            self.g.apply(&e, now);
            self.with(|s, c| s.on_event(&e, c));
            self.drain();
        }
        fn names(&self) -> Vec<String> {
            self.sent.iter().map(|c| match c.options.get("item") {
                Some(Value::String(i)) if c.name == "buy" => format!("buy {i}"),
                _ => c.name.clone(),
            }).collect()
        }
    }

    fn catch(n: u64) -> GameEvent {
        GameEvent::Catch { items: vec![CatchItem { name: "Cod".into(), count: n }], xp: None, level_up: None, treasure: None, quests_completed: None, raw: String::new() }
    }

    #[test]
    fn start_order_data_first_then_fish() {
        let mut h = H::new(|c| {
            c.profile.refresh_min = 5.0;
            c.daily.enabled = true;
            c.quests.enabled = true;
        });
        h.start();
        assert_eq!(h.names(), ["profile", "boosts", "daily", "quests", "fish"]);
    }

    #[test]
    fn next_fish_after_the_catch_delay() {
        let mut h = H::new(|_| {});
        h.cmds.retain(|c| c.name != "boosts");
        h.start();
        h.event(catch(1));
        h.advance(3028);
        assert_eq!(h.names(), ["fish"]);
        h.advance(1);
        assert_eq!(h.names(), ["fish", "fish"]);
        assert_eq!(h.g.snapshot().next_fish_at, Some(3029));
    }

    #[test]
    fn sell_after_n_catches_with_all() {
        let mut h = H::new(|c| {
            c.sell.enabled = true;
            c.sell.every = 3.0;
        });
        h.cmds.retain(|c| c.name != "boosts");
        h.start();
        h.event(catch(2));
        assert!(!h.names().contains(&"sell".to_string()));
        h.event(catch(1));
        let sell = h.sent.iter().find(|c| c.name == "sell").unwrap();
        assert_eq!(sell.options.get("amount"), Some(&Value::String("all".into())));
    }

    #[test]
    fn daily_gating() {
        let mut h = H::new(|c| c.daily.enabled = true);
        h.cmds.retain(|c| c.name != "boosts");
        h.g.set_next_daily_at(Some(3 * 3_600_000), 0);
        h.start();
        assert!(!h.names().contains(&"daily".to_string()));
        h.advance(3 * 3_600_000 + 179_999); // due + 3 min (rand 0.5 → 1–5 min = 180 s)
        assert!(!h.names().contains(&"daily".to_string()));
        h.advance(1);
        assert_eq!(h.names().iter().filter(|n| *n == "daily").count(), 1);
    }

    #[test]
    fn quests_refreshed_after_quest_complete() {
        let mut h = H::new(|_| {});
        h.cmds.retain(|c| c.name != "boosts");
        h.start();
        h.event(GameEvent::Catch { items: vec![], xp: None, level_up: None, treasure: None, quests_completed: Some(vec!["Daily Fishing Tier 5".into()]), raw: String::new() });
        assert!(h.names().contains(&"quests".to_string()));
    }

    #[test]
    fn buff_cycle_buys_both_then_boosts_and_waits_for_both() {
        let mut h = H::new(|c| c.buffs.enabled = true);
        h.start();
        assert_eq!(h.names(), ["boosts", "fish"]);
        h.event(GameEvent::Boosts { active: vec![] }); // nothing active → buy after the grace (17.5 s)
        h.advance(17_499);
        assert_eq!(h.names().len(), 2);
        h.advance(1);
        assert_eq!(&h.names()[2..], ["buy fish5m", "buy treasure5m", "boosts"]);
        let now = h.now;
        h.event(GameEvent::Boosts {
            active: vec![
                Boost { name: "Fish Boost".into(), ends_at: now + 5 * MIN, by: None },
                Boost { name: "Treasure Boost".into(), ends_at: now + 8 * MIN, by: None },
            ],
        });
        let before = h.names().iter().filter(|n| n.starts_with("buy")).count();
        h.advance(7 * MIN);
        assert_eq!(h.names().iter().filter(|n| n.starts_with("buy")).count(), before);
        h.advance(2 * MIN);
        assert_eq!(h.names().iter().filter(|n| n.starts_with("buy fish")).count(), 2);
    }

    #[test]
    fn personal_booster_opt_in() {
        let mut h = H::new(|c| c.boosters.auto_personal = true);
        h.start();
        h.event(GameEvent::Boosts { active: vec![] });
        assert!(h.names().contains(&"boosters".to_string()));
        h.event(GameEvent::Boosters { personal: 1 });
        let used = h.sent.iter().find(|c| c.name == "use").unwrap();
        assert_eq!(used.options.get("type"), Some(&Value::String("Personal".into())));
        h.event(GameEvent::Boosters { personal: 1 }); // at most one /use per expiry
        assert_eq!(h.names().iter().filter(|n| *n == "use").count(), 1);
    }

    #[test]
    fn frozen_scheduler_pushes_nothing_and_keeps_remaining_time() {
        let mut h = H::new(|_| {});
        h.cmds.retain(|c| c.name != "boosts");
        h.start();
        h.event(catch(1)); // next fish at 3029
        h.advance(1000);
        let now = h.now;
        h.s.freeze(now);
        h.advance(10 * MIN);
        assert_eq!(h.names(), ["fish"]);
        h.with(|s, c| s.thaw(c));
        h.advance(2028);
        assert_eq!(h.names(), ["fish"]);
        h.advance(1);
        assert_eq!(h.names(), ["fish", "fish"]);
    }

    #[test]
    fn events_while_frozen_push_nothing() {
        let mut h = H::new(|c| c.profile.refresh_min = 5.0);
        h.cmds.retain(|c| c.name != "boosts");
        h.start();
        let sent = h.names().len();
        let now = h.now;
        h.s.freeze(now);
        h.event(GameEvent::Sell { earned: 10, xp: None }); // would push /profile
        h.event(GameEvent::Catch { items: vec![], xp: None, level_up: None, treasure: None, quests_completed: Some(vec!["Q".into()]), raw: String::new() });
        assert!(h.q.is_empty());
        assert_eq!(h.names().len(), sent);
    }

    #[test]
    fn breaks_rest_then_resume() {
        let mut h = H::new(|c| c.breaks.enabled = true);
        h.cmds.retain(|c| c.name != "boosts");
        h.start();
        h.advance(45 * MIN); // work 45 ± 10 min → 45 min with rand 0.5
        assert!(h.s.is_resting());
        assert_eq!(h.s.take_rest_change(), Some(true));
        h.event(catch(1)); // ignored scheduling while resting: fish slot suspended
        h.advance(5 * MIN);
        assert!(!h.s.is_resting());
        assert_eq!(h.s.take_rest_change(), Some(false));
    }

    #[test]
    fn redo_after_queue_cleared_unless_blocked() {
        let mut h = H::new(|c| c.daily.enabled = true);
        h.cmds.retain(|c| c.name != "boosts");
        // keep the daily queued: block sending by pausing the queue
        h.q.pause();
        h.start();
        h.q.clear();
        let now = h.now;
        h.s.freeze(now);
        h.with(|s, c| s.on_queue_cleared(c));
        h.q.resume();
        h.with(|s, c| s.thaw(c));
        h.advance(17_500);
        assert!(h.names().contains(&"daily".to_string()));
    }

    #[test]
    fn hot_reload_cooldown() {
        let mut h = H::new(|_| {});
        h.cmds.retain(|c| c.name != "boosts");
        h.start();
        h.cfg.fishing.base_cooldown_sec = 10.0;
        h.event(catch(1));
        assert_eq!(h.g.snapshot().next_fish_at, Some(10_000 - 471)); // 10 s - 1.1774 × 0.4 s
    }

    #[test]
    fn bait_bought_when_unknown_on_inventory() {
        let mut h = H::new(|c| {
            c.bait.enabled = true;
            c.bait.name = "Magic Bait".into();
        });
        h.cmds.retain(|c| c.name != "boosts");
        h.start();
        h.event(GameEvent::Inventory { balance: 1, level: 1, xp_to_next: None, rod: None, biome: None, bait: Some(Bait { name: "Magic Bait".into(), count: 1 }), rare: RareCounts::default(), fish_value: None });
        let bait = h.sent.iter().find(|c| c.key.as_deref() == Some("bait")).unwrap();
        assert_eq!(bait.options.get("amount"), Some(&Value::from(57u64))); // ceil((5 × 60 / 3.5 − 10) × 0.75)
    }

    #[test]
    fn sell_all_option_and_booster_options() {
        let info = SlashCommandInfo { name: "sell".into(), id: "1".into(), version: "1".into(), options: vec![opt("what", Some(&["fish", "ALL"]))] };
        assert_eq!(sell_all_options(&info).get("what"), Some(&Value::String("ALL".into())));
        let use_cmd = commands().into_iter().find(|c| c.name == "use").unwrap();
        assert_eq!(booster_use_options(Some(&use_cmd), "global").unwrap().get("type"), Some(&Value::String("Global".into())));
        assert!(booster_use_options(None, "personal").is_none());
        assert_eq!(buff_type("Fish Boost"), Some("fish"));
        assert_eq!(buff_type("fish5m"), Some("fish"));
        assert_eq!(buff_type("Treasure Boost"), Some("treasure"));
        assert_eq!(buff_type("Personal"), None);
    }
}
