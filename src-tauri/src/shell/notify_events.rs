//! What the shell reacts to (port of v1 `notifyEvents.ts` and the notification wiring of `index.ts`).
//! Pure: fed the events sent to the renderer, returns what the tray / notifications should do.

use crate::model::{EngineState, LogEntry, RareCounts};
use serde_json::Value;

const RARE: [(&str, &str); 4] = [("gold", "Gold Fish"), ("emerald", "Emerald Fish"), ("lava", "Lava Fish"), ("diamond", "Diamond Fish")];

/// Highest level announced by a level-up log entry (structured `level_up` field), or None.
pub fn level_up_from_log(new_log: &[LogEntry]) -> Option<u64> {
    new_log.iter().filter_map(|l| l.level_up).max()
}

fn rare_get(r: &RareCounts, k: &str) -> u64 {
    match k {
        "gold" => r.gold,
        "emerald" => r.emerald,
        "lava" => r.lava,
        _ => r.diamond,
    }
}

fn rare_slot<'a>(r: &'a mut RareCounts, k: &str) -> &'a mut u64 {
    match k {
        "gold" => &mut r.gold,
        "emerald" => &mut r.emerald,
        "lava" => &mut r.lava,
        _ => &mut r.diamond,
    }
}

/// English labels of the rare fish whose session count went up. `next` is a partial
/// `session.rareCaught` patch (missing keys keep their previous value).
pub fn rare_increases(prev: &RareCounts, next: &serde_json::Map<String, Value>) -> Vec<String> {
    RARE.iter()
        .filter(|(k, _)| next.get(*k).and_then(Value::as_u64).is_some_and(|n| n > rare_get(prev, k)))
        .map(|(_, label)| label.to_string())
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub enum ShellAction {
    /// Engine state changed: refresh the tray.
    Tray(EngineState),
    /// Entered the captcha.
    Captcha,
    LevelUp(u64),
    RareFish(Vec<String>),
}

/// Watches the renderer events (v1 channel names) for the tray and the notifications.
#[derive(Default)]
pub struct ShellWatcher {
    prev: Option<EngineState>,
    last_rare: RareCounts,
}

impl ShellWatcher {
    pub fn on_event(&mut self, channel: &str, payload: &Value) -> Vec<ShellAction> {
        let mut out = vec![];
        match channel {
            "engine.state" => {
                let Some(state) = payload.get("state").and_then(|s| serde_json::from_value::<EngineState>(s.clone()).ok()) else {
                    return out;
                };
                if state == EngineState::Captcha && self.prev != Some(EngineState::Captcha) {
                    out.push(ShellAction::Captcha);
                }
                if self.prev != Some(state) {
                    out.push(ShellAction::Tray(state));
                }
                self.prev = Some(state);
            }
            "log.append" => {
                let log: Vec<LogEntry> = serde_json::from_value(payload.clone()).unwrap_or_default();
                if let Some(l) = level_up_from_log(&log) {
                    out.push(ShellAction::LevelUp(l));
                }
            }
            "game.patch" => {
                if let Some(rare) = payload.pointer("/session/rareCaught").and_then(Value::as_object) {
                    let kinds = rare_increases(&self.last_rare, rare);
                    if !kinds.is_empty() {
                        out.push(ShellAction::RareFish(kinds));
                    }
                    for (k, _) in RARE {
                        if let Some(n) = rare.get(k).and_then(Value::as_u64) {
                            *rare_slot(&mut self.last_rare, k) = n;
                        }
                    }
                }
            }
            _ => {}
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LogType;
    use serde_json::json;

    fn entry(text: &str, highlight: Option<bool>, level_up: Option<u64>) -> LogEntry {
        LogEntry { id: 1, at: 0, kind: LogType::System, text: text.into(), highlight, level_up }
    }
    fn map(v: Value) -> serde_json::Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn level_up_reads_the_structured_field() {
        assert_eq!(level_up_from_log(&[entry("Caught: 1× Cod", None, None), entry("Reached level 42!", Some(true), Some(42))]), Some(42));
    }

    #[test]
    fn level_up_ignores_entries_without_the_field_whatever_their_text() {
        assert_eq!(level_up_from_log(&[entry("Reached level 42!", Some(true), None), entry("Captcha detected", Some(true), None)]), None);
    }

    #[test]
    fn rare_increases_lists_only_species_that_increased() {
        assert_eq!(rare_increases(&RareCounts::default(), &map(json!({ "gold": 1, "diamond": 2 }))), ["Gold Fish", "Diamond Fish"]);
    }

    #[test]
    fn rare_increases_is_empty_when_unchanged_or_reset() {
        let prev = RareCounts { gold: 3, ..Default::default() };
        assert!(rare_increases(&prev, &map(json!({ "gold": 3 }))).is_empty());
        assert!(rare_increases(&prev, &map(json!({ "gold": 0 }))).is_empty());
    }

    #[test]
    fn watcher_notifies_the_captcha_once_and_refreshes_the_tray_on_changes() {
        let mut w = ShellWatcher::default();
        let st = |s: &str| json!({ "state": s, "info": {} });
        assert_eq!(w.on_event("engine.state", &st("running")), [ShellAction::Tray(EngineState::Running)]);
        assert_eq!(w.on_event("engine.state", &st("captcha")), [ShellAction::Captcha, ShellAction::Tray(EngineState::Captcha)]);
        assert!(w.on_event("engine.state", &st("captcha")).is_empty());
        assert_eq!(w.on_event("engine.state", &st("running")), [ShellAction::Tray(EngineState::Running)]);
    }

    #[test]
    fn watcher_notifies_level_ups_and_rare_fish_with_merged_counts() {
        let mut w = ShellWatcher::default();
        let log = json!([{ "id": 1, "at": 0, "type": "system", "text": "Reached level 7!", "highlight": true, "levelUp": 7 }]);
        assert_eq!(w.on_event("log.append", &log), [ShellAction::LevelUp(7)]);
        let rare = |v: Value| json!({ "session": { "rareCaught": v } });
        assert_eq!(w.on_event("game.patch", &rare(json!({ "gold": 1 }))), [ShellAction::RareFish(vec!["Gold Fish".into()])]);
        assert!(w.on_event("game.patch", &rare(json!({ "lava": 0 }))).is_empty());
        assert!(w.on_event("game.patch", &rare(json!({ "gold": 1 }))).is_empty(), "gold kept from the earlier patch");
        // new session: counts reset to zero, the next catch notifies again
        assert!(w.on_event("game.patch", &rare(json!({ "gold": 0, "emerald": 0, "lava": 0, "diamond": 0 }))).is_empty());
        assert_eq!(w.on_event("game.patch", &rare(json!({ "gold": 1 }))), [ShellAction::RareFish(vec!["Gold Fish".into()])]);
        assert!(w.on_event("game.patch", &json!({ "account": { "level": 3 } })).is_empty());
    }
}
