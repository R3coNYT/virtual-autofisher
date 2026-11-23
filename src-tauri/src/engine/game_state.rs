//! Game state (port of `GameState.ts`): account, boosts, quests, session stats, log. Every change
//! returns a `Patch` (changed sections, replace semantics, plus new log entries) for the UI.

use crate::model::{Account, GameEvent, GameSnapshot, LogEntry, LogType, PersistedAccount, RareCounts, Session, SessionSummary, Totals};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const LOG_CAP: usize = 500;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// What GameState keeps between sessions and app restarts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PersistedState {
    pub account: PersistedAccount,
    pub next_daily_at: Option<i64>,
}

/// Changed sections (`game.patch`) and the log entries added (`log.append`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Patch {
    pub patch: Value,
    pub new_log: Vec<LogEntry>,
}

impl Patch {
    pub fn is_empty(&self) -> bool {
        self.new_log.is_empty() && self.patch.as_object().is_none_or(|m| m.is_empty())
    }
}

/// 1234 → "$1,234".
pub fn money(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    format!("${out}")
}

#[derive(Default)]
pub struct GameState {
    body: GameSnapshot, // `log` kept separately below
    log: Vec<LogEntry>,
    next_id: u64,
    since_sell: u64,
    bait: Option<u64>,
}

struct Ctx<'a> {
    added: &'a mut Vec<LogEntry>,
    next_id: &'a mut u64,
    now: i64,
}

impl Ctx<'_> {
    fn log(&mut self, kind: LogType, text: String, highlight: bool, level_up: Option<u64>) {
        *self.next_id += 1;
        self.added.push(LogEntry { id: *self.next_id, at: self.now, kind, text, highlight: highlight.then_some(true), level_up });
    }
}

impl GameState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn catches_since_sell(&self) -> u64 {
        self.since_sell
    }
    pub fn bait_estimate(&self) -> Option<u64> {
        self.bait
    }
    pub fn next_daily_at(&self) -> Option<i64> {
        self.body.next_daily_at
    }
    pub fn session(&self) -> &Session {
        &self.body.session
    }

    pub fn snapshot(&self) -> GameSnapshot {
        GameSnapshot { log: self.log.clone(), ..self.body.clone() }
    }

    pub fn apply(&mut self, e: &GameEvent, now: i64) -> Patch {
        let since_sell = &mut self.since_sell;
        let bait = &mut self.bait;
        Self::mutate(&mut self.body, &mut self.log, &mut self.next_id, now, |b, ctx| {
            let s = &mut b.session;
            match e {
                GameEvent::Catch { items, xp, level_up, quests_completed, .. } => {
                    for i in items {
                        *s.fish_by_species.entry(i.name.clone()).or_default() += i.count;
                        s.catches += i.count;
                        *since_sell += i.count;
                        let lower = i.name.to_lowercase();
                        let r = &mut s.rare_caught;
                        for (k, slot) in [("gold", &mut r.gold), ("emerald", &mut r.emerald), ("lava", &mut r.lava), ("diamond", &mut r.diamond)] {
                            if lower.contains(k) {
                                *slot += i.count;
                            }
                        }
                    }
                    if let Some(n) = bait.as_mut() {
                        *n = n.saturating_sub(1);
                    }
                    s.xp_earned += xp.unwrap_or(0);
                    let list = items.iter().map(|i| format!("{}× {}", i.count, i.name)).collect::<Vec<_>>().join(", ");
                    ctx.log(LogType::Catch, format!("Caught: {}", if list.is_empty() { "nothing".into() } else { list }), false, None);
                    if let Some(l) = level_up {
                        b.account.level = Some(*l);
                        ctx.log(LogType::System, format!("Reached level {l}!"), true, Some(*l));
                    }
                    for q in quests_completed.iter().flatten() {
                        ctx.log(LogType::System, format!("Quest completed: {q}"), true, None);
                    }
                }
                GameEvent::Sell { earned, xp } => {
                    s.money_earned += earned;
                    s.xp_earned += xp.unwrap_or(0);
                    s.sells += 1;
                    *since_sell = 0;
                    ctx.log(LogType::Trade, format!("Sold for {}", money(*earned)), false, None);
                }
                GameEvent::Inventory { balance, level, xp_to_next, rod, biome, bait: inv_bait, rare, fish_value } => {
                    let a = &mut b.account;
                    a.balance = Some(*balance);
                    a.level = Some(*level);
                    a.xp_to_next = *xp_to_next;
                    a.rod = rod.clone();
                    a.biome = biome.clone();
                    a.bait = inv_bait.clone();
                    a.fish_value = *fish_value;
                    a.rare = *rare;
                    *bait = inv_bait.as_ref().map(|b| b.count);
                    if let (Some(v), Some(_)) = (fish_value, s.started_at) {
                        let start = *s.fish_value_start.get_or_insert(*v);
                        // sells turn fish value into balance: adding them keeps the gain right across a sell
                        s.value_gained = Some(*v as i64 - start as i64 + s.money_earned as i64);
                    }
                }
                GameEvent::Stats { crates, quests, trips, daily_streak, totals } => {
                    b.account.totals = Totals { rare: totals.clone(), crates: *crates, quests: *quests, trips: *trips, daily_streak: *daily_streak };
                }
                GameEvent::Boosts { active } => b.boosts = active.clone(),
                GameEvent::Boosters { personal } => b.account.personal_boosters = Some(*personal),
                GameEvent::Purchase { item, amount, cost } => {
                    let c = cost.map(|c| format!(" ({})", money(c))).unwrap_or_default();
                    ctx.log(LogType::Trade, format!("Bought: {amount}× {item}{c}"), false, None);
                }
                GameEvent::Daily { reward, next_in_ms } => {
                    b.next_daily_at = Some(ctx.now + next_in_ms.unwrap_or(DAY_MS));
                    ctx.log(LogType::Trade, format!("Daily reward: {reward}"), false, None);
                }
                GameEvent::Quests { quests } => b.quests = quests.clone(),
                GameEvent::Captcha { .. } => {
                    s.captchas += 1;
                    ctx.log(LogType::System, "Captcha detected".into(), true, None);
                }
                GameEvent::CaptchaSolved => ctx.log(LogType::System, "Captcha solved".into(), false, None),
                GameEvent::CaptchaFailed { text } => ctx.log(LogType::System, format!("Captcha failed: {text}"), false, None),
                GameEvent::Error { text } => ctx.log(LogType::Error, text.clone(), false, None),
                GameEvent::Unknown { title, text } => {
                    let t = match title {
                        Some(t) => format!("{t} — {text}"),
                        None => text.clone(),
                    };
                    ctx.log(LogType::Unknown, t, false, None);
                }
                GameEvent::Cooldown { .. } => {}
            }
        })
    }

    /// A free log line (e.g. the unknown reply to /use).
    pub fn note(&mut self, kind: LogType, text: &str, now: i64) -> Patch {
        let text = text.to_string();
        Self::mutate(&mut self.body, &mut self.log, &mut self.next_id, now, |_, ctx| ctx.log(kind, text, false, None))
    }

    pub fn mark_command_sent(&mut self, now: i64) -> Patch {
        Self::mutate(&mut self.body, &mut self.log, &mut self.next_id, now, |b, _| b.session.commands_sent += 1)
    }

    pub fn set_next_fish_at(&mut self, ts: Option<i64>, now: i64) -> Patch {
        Self::mutate(&mut self.body, &mut self.log, &mut self.next_id, now, |b, _| b.next_fish_at = ts)
    }

    pub fn set_next_daily_at(&mut self, ts: Option<i64>, now: i64) -> Patch {
        Self::mutate(&mut self.body, &mut self.log, &mut self.next_id, now, |b, _| b.next_daily_at = ts)
    }

    /// Last known account values and next daily (state.json), shown at boot. Counts nothing in the session.
    pub fn hydrate(&mut self, p: &PersistedState, now: i64) -> Patch {
        let p = p.clone();
        Self::mutate(&mut self.body, &mut self.log, &mut self.next_id, now, move |b, _| {
            let a = p.account;
            b.account = Account {
                balance: a.balance,
                level: a.level,
                xp_to_next: a.xp_to_next,
                rod: a.rod,
                biome: a.biome,
                bait: a.bait,
                fish_value: a.fish_value,
                rare: a.rare,
                totals: a.totals,
                personal_boosters: a.personal_boosters,
            };
            if p.next_daily_at.is_some() {
                b.next_daily_at = p.next_daily_at;
            }
        })
    }

    pub fn persisted(&self) -> PersistedState {
        let a = &self.body.account;
        PersistedState {
            account: PersistedAccount {
                balance: a.balance,
                fish_value: a.fish_value,
                level: a.level,
                xp_to_next: a.xp_to_next,
                rod: a.rod.clone(),
                biome: a.biome.clone(),
                bait: a.bait.clone(),
                rare: a.rare,
                totals: a.totals.clone(),
                personal_boosters: a.personal_boosters,
            },
            next_daily_at: self.body.next_daily_at,
        }
    }

    /// Zeroes the session counters: the previous session stays visible until the next one starts.
    pub fn start_session(&mut self, now: i64) -> Patch {
        self.since_sell = 0;
        Self::mutate(&mut self.body, &mut self.log, &mut self.next_id, now, |b, ctx| {
            b.session = Session { started_at: Some(ctx.now), rare_caught: RareCounts::default(), ..Session::default() }
        })
    }

    /// Summary of the session; its counters are kept (shown after the stop) until start_session().
    pub fn end_session(&self, now: i64) -> SessionSummary {
        SessionSummary { session: self.body.session.clone(), ended_at: now }
    }

    fn mutate(body: &mut GameSnapshot, log: &mut Vec<LogEntry>, next_id: &mut u64, now: i64, f: impl FnOnce(&mut GameSnapshot, &mut Ctx)) -> Patch {
        let before = section_values(body);
        let mut added = vec![];
        {
            let mut ctx = Ctx { added: &mut added, next_id, now };
            f(body, &mut ctx);
        }
        if !added.is_empty() {
            log.extend(added.iter().cloned());
            if log.len() > LOG_CAP {
                let excess = log.len() - LOG_CAP;
                log.drain(..excess);
            }
        }
        Patch { patch: diff(&before, &section_values(body)), new_log: added }
    }
}

fn section_values(b: &GameSnapshot) -> Map<String, Value> {
    let mut v = serde_json::to_value(b).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
    v.remove("log");
    v
}

/// Shallow-by-section diff: top-level sections, then one level of fields inside object sections.
fn diff(a: &Map<String, Value>, b: &Map<String, Value>) -> Value {
    let mut out = Map::new();
    for (k, y) in b {
        let x = a.get(k).unwrap_or(&Value::Null);
        match (x, y) {
            (Value::Object(xo), Value::Object(yo)) => {
                let sub: Map<String, Value> =
                    yo.iter().filter(|(f, yv)| xo.get(*f) != Some(*yv)).map(|(f, yv)| (f.clone(), yv.clone())).collect();
                if !sub.is_empty() {
                    out.insert(k.clone(), Value::Object(sub));
                }
            }
            _ if x != y => {
                out.insert(k.clone(), y.clone());
            }
            _ => {}
        }
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Bait, Boost, CatchItem, PartialRare};
    use serde_json::json;

    fn inv(bait: u64) -> GameEvent {
        GameEvent::Inventory {
            balance: 500,
            level: 10,
            xp_to_next: Some(40),
            rod: Some("Rod".into()),
            biome: Some("River".into()),
            bait: Some(Bait { name: "Common".into(), count: bait }),
            rare: RareCounts { gold: 1, ..RareCounts::default() },
            fish_value: None,
        }
    }
    fn fish(items: &[(&str, u64)], xp: Option<u64>, level_up: Option<u64>) -> GameEvent {
        GameEvent::Catch {
            items: items.iter().map(|(n, c)| CatchItem { name: n.to_string(), count: *c }).collect(),
            xp,
            level_up,
            treasure: None,
            quests_completed: None,
            raw: String::new(),
        }
    }

    #[test]
    fn catch_adds_species_counters_and_a_log_line() {
        let mut g = GameState::new();
        g.apply(&fish(&[("Cod", 2), ("Salmon", 1)], Some(5), None), 1000);
        let s = g.snapshot();
        assert_eq!(s.session.fish_by_species, [("Cod".to_string(), 2), ("Salmon".to_string(), 1)].into_iter().collect());
        assert_eq!((s.session.catches, s.session.xp_earned, g.catches_since_sell()), (3, 5, 3));
        assert_eq!((s.log[0].kind, s.log[0].text.as_str()), (LogType::Catch, "Caught: 2× Cod, 1× Salmon"));
    }

    #[test]
    fn counts_rare_fish_and_sell_resets() {
        let mut g = GameState::new();
        g.apply(&fish(&[("Gold Fish", 1), ("Lava Eel", 2)], None, None), 0);
        assert_eq!(g.snapshot().session.rare_caught, RareCounts { gold: 1, lava: 2, ..RareCounts::default() });
        g.apply(&GameEvent::Sell { earned: 1234, xp: None }, 0);
        let s = g.snapshot();
        assert_eq!((s.session.money_earned, s.session.sells, g.catches_since_sell()), (1234, 1, 0));
        assert_eq!(s.log.last().unwrap().text, "Sold for $1,234");
    }

    #[test]
    fn inventory_recalibrates_bait_and_catch_decrements() {
        let mut g = GameState::new();
        assert_eq!(g.bait_estimate(), None);
        g.apply(&inv(100), 0);
        assert_eq!((g.snapshot().account.balance, g.snapshot().account.rod.as_deref()), (Some(500), Some("Rod")));
        g.apply(&fish(&[("Cod", 1)], None, None), 0);
        assert_eq!(g.bait_estimate(), Some(99));
        g.apply(&inv(50), 0);
        assert_eq!(g.bait_estimate(), Some(50));
    }

    #[test]
    fn log_capped_at_500_with_increasing_ids() {
        let mut g = GameState::new();
        for i in 0..520 {
            g.apply(&GameEvent::Error { text: format!("e{i}") }, 0);
        }
        let log = g.snapshot().log;
        assert_eq!(log.len(), 500);
        assert_eq!((log[0].id, log[499].id), (21, 520));
    }

    #[test]
    fn level_up_is_highlighted_with_a_structured_level() {
        let mut g = GameState::new();
        g.apply(&fish(&[("Cod", 1)], None, Some(13)), 0);
        let last = g.snapshot().log.last().cloned().unwrap();
        assert_eq!((last.text.as_str(), last.highlight, last.level_up), ("Reached level 13!", Some(true), Some(13)));
        assert_eq!(g.snapshot().account.level, Some(13));
    }

    #[test]
    fn patch_has_only_changed_fields_and_new_log() {
        let mut g = GameState::new();
        let p = g.apply(&GameEvent::Sell { earned: 10, xp: None }, 0);
        assert_eq!(p.patch["session"]["moneyEarned"], 10);
        assert!(p.patch["session"].get("catches").is_none());
        assert!(p.patch.get("account").is_none());
        assert_eq!(p.new_log.len(), 1);
        assert!(g.apply(&GameEvent::Cooldown { wait_ms: 1 }, 0).is_empty());
        assert_eq!(g.set_next_fish_at(Some(5), 0).patch, json!({ "nextFishAt": 5 }));
    }

    #[test]
    fn replace_semantics_for_nested_sections() {
        let mut g = GameState::new();
        g.apply(&fish(&[("Cod", 1)], None, None), 0);
        let p = g.start_session(10);
        assert_eq!(p.patch["session"]["fishBySpecies"], json!({}));
    }

    #[test]
    fn captcha_daily_commands_quests_boosters_boosts_note() {
        let mut g = GameState::new();
        g.apply(&GameEvent::Captcha { image_url: None, text: String::new() }, 0);
        assert_eq!(g.snapshot().session.captchas, 1);
        g.mark_command_sent(0);
        assert_eq!(g.snapshot().session.commands_sent, 1);
        g.apply(&GameEvent::Daily { reward: "$100".into(), next_in_ms: None }, 5000);
        assert_eq!(g.next_daily_at(), Some(5000 + DAY_MS));
        g.apply(&GameEvent::Daily { reward: "x".into(), next_in_ms: Some(3_600_000) }, 0);
        assert_eq!(g.next_daily_at(), Some(3_600_000));
        let q = fish(&[("Cod", 1)], None, None);
        if let GameEvent::Catch { items, .. } = q {
            g.apply(&GameEvent::Catch { items, xp: None, level_up: None, treasure: None, quests_completed: Some(vec!["Daily Fishing Tier 5".into()]), raw: String::new() }, 0);
        }
        let last = g.snapshot().log.last().cloned().unwrap();
        assert_eq!((last.text.as_str(), last.highlight), ("Quest completed: Daily Fishing Tier 5", Some(true)));
        g.apply(&GameEvent::Boosters { personal: 2 }, 0);
        assert_eq!(g.snapshot().account.personal_boosters, Some(2));
        g.apply(&GameEvent::Boosts { active: vec![Boost { name: "Global".into(), ends_at: 9, by: Some("Messor".into()) }] }, 0);
        assert_eq!(g.snapshot().boosts[0].by.as_deref(), Some("Messor"));
        g.note(LogType::System, "/use: done", 0);
        assert_eq!(g.snapshot().log.last().unwrap().text, "/use: done");
        g.apply(&GameEvent::Unknown { title: Some("Hi".into()), text: "there".into() }, 0);
        assert_eq!(g.snapshot().log.last().unwrap().text, "Hi — there");
        g.apply(&GameEvent::Purchase { item: "Bait".into(), amount: 5, cost: Some(1500) }, 0);
        assert_eq!(g.snapshot().log.last().unwrap().text, "Bought: 5× Bait ($1,500)");
        g.apply(&GameEvent::Stats { crates: Some(3), quests: None, trips: None, daily_streak: None, totals: PartialRare { gold: Some(1), ..PartialRare::default() } }, 0);
        assert_eq!(g.snapshot().account.totals.crates, Some(3));
    }

    #[test]
    fn session_gain_from_fish_value_plus_sells() {
        let mut g = GameState::new();
        let with_value = |v: u64| match inv(10) {
            GameEvent::Inventory { balance, level, xp_to_next, rod, biome, bait, rare, .. } => {
                GameEvent::Inventory { balance, level, xp_to_next, rod, biome, bait, rare, fish_value: Some(v) }
            }
            _ => unreachable!(),
        };
        g.apply(&with_value(1000), 0); // before a session: no gain
        assert_eq!(g.snapshot().session.value_gained, None);
        g.start_session(0);
        g.apply(&with_value(1000), 0);
        assert_eq!(g.snapshot().session.value_gained, Some(0));
        g.apply(&GameEvent::Sell { earned: 300, xp: None }, 0);
        g.apply(&with_value(900), 0);
        assert_eq!(g.snapshot().session.value_gained, Some(200));
        g.start_session(1);
        g.apply(&with_value(5000), 1);
        assert_eq!(g.snapshot().session.value_gained, Some(0));
    }

    #[test]
    fn session_kept_after_end_and_reset_on_start() {
        let mut g = GameState::new();
        g.start_session(100);
        g.apply(&fish(&[("Cod", 4)], None, None), 100);
        let sum = g.end_session(200);
        assert_eq!((sum.session.catches, sum.ended_at, sum.session.started_at), (4, 200, Some(100)));
        assert_eq!(g.snapshot().session.catches, 4);
        g.start_session(300);
        assert_eq!((g.snapshot().session.catches, g.catches_since_sell()), (0, 0));
    }

    #[test]
    fn hydrate_and_persisted() {
        let mut g = GameState::new();
        let p = PersistedState {
            account: PersistedAccount { balance: Some(777), level: Some(3), fish_value: Some(50), ..PersistedAccount::default() },
            next_daily_at: Some(123),
        };
        let patch = g.hydrate(&p, 0);
        assert!(!patch.is_empty());
        assert_eq!((g.snapshot().account.balance, g.next_daily_at()), (Some(777), Some(123)));
        assert_eq!(g.snapshot().session, Session::default());
        assert_eq!(g.persisted(), p);
    }

    #[test]
    fn money_formatting() {
        assert_eq!(money(0), "$0");
        assert_eq!(money(1234), "$1,234");
        assert_eq!(money(13_813_063_500), "$13,813,063,500");
    }
}
