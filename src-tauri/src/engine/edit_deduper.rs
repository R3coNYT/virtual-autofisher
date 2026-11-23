//! Discord edit dedupe (port of `EditDeduper.ts`): remembers, per message id, what was last parsed
//! from it, so that edits (embeds resolving, buttons removed, another player clicking our reply…)
//! are never counted twice. Bounded to the last 200 ids.

use crate::model::GameEvent;
use std::collections::{HashMap, HashSet, VecDeque};
use std::mem::{discriminant, Discriminant};

const MAX_IDS: usize = 200;

type Kind = Discriminant<GameEvent>;

/// Kinds that change counters: an edit must never count them a second time.
fn counted(e: &GameEvent) -> bool {
    matches!(e, GameEvent::Catch { .. } | GameEvent::Sell { .. } | GameEvent::Purchase { .. } | GameEvent::Daily { .. })
}
fn captcha_kind(e: &GameEvent) -> bool {
    matches!(e, GameEvent::Captcha { .. } | GameEvent::CaptchaSolved | GameEvent::CaptchaFailed { .. })
}

fn normalize(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

#[derive(Debug, Clone)]
struct Seen {
    kind: Kind,
    counted: bool,
    text: String,
}

#[derive(Default)]
pub struct EditDeduper {
    seen: HashMap<String, Seen>,
    order: VecDeque<String>,
    /// Ids that carried a captcha since it was last solved.
    captcha_ids: HashSet<String>,
    /// Ids whose captcha was solved (oldest first): an edit of them never re-enters the captcha.
    solved_ids: VecDeque<String>,
}

impl EditDeduper {
    pub fn new() -> Self {
        Self::default()
    }

    /// True when the event must be routed, false when the message must be ignored.
    pub fn accept(&mut self, id: &str, is_edit: bool, ev: &GameEvent, text: &str) -> bool {
        let norm = normalize(text);
        let prev = self.seen.get(id).cloned();
        let mut accepted = true;
        if is_edit {
            let is_captcha = matches!(ev, GameEvent::Captcha { .. });
            if prev.as_ref().is_some_and(|p| p.kind == discriminant(ev) && p.text == norm) {
                accepted = false; // unchanged
            } else if is_captcha && self.solved_ids.iter().any(|s| s == id) {
                accepted = false; // already solved
            } else if prev.as_ref().is_some_and(|p| p.counted) && !captcha_kind(ev) {
                accepted = false;
            } else if prev.is_none() && !captcha_kind(ev) && !matches!(ev, GameEvent::Cooldown { .. }) {
                // an edit of a message we never saw (sent before the session, or forgotten): typically
                // another player clicking a button of an old reply of ours. Only a captcha or a cooldown
                // may matter then.
                accepted = false;
            }
        }
        // a counted kind stays the reference: later edits of that message are never counted either
        let seen = match prev {
            Some(p) if !accepted && p.counted => Seen { kind: p.kind, counted: true, text: norm },
            _ => Seen { kind: discriminant(ev), counted: counted(ev), text: norm },
        };
        self.remember(id, seen);
        if accepted && matches!(ev, GameEvent::Captcha { .. }) {
            self.captcha_ids.insert(id.to_string());
        }
        if accepted && matches!(ev, GameEvent::CaptchaSolved) {
            let ids: Vec<String> = self.captcha_ids.drain().chain(std::iter::once(id.to_string())).collect();
            for c in ids {
                if !self.solved_ids.contains(&c) {
                    self.solved_ids.push_back(c);
                }
            }
            while self.solved_ids.len() > MAX_IDS {
                self.solved_ids.pop_front();
            }
        }
        accepted
    }

    fn remember(&mut self, id: &str, s: Seen) {
        if self.seen.insert(id.to_string(), s).is_some() {
            self.order.retain(|x| x != id); // re-insert: most recent last
        }
        self.order.push_back(id.to_string());
        while self.order.len() > MAX_IDS {
            if let Some(old) = self.order.pop_front() {
                self.seen.remove(&old);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::CatchItem;

    fn catch() -> GameEvent {
        GameEvent::Catch { items: vec![CatchItem { name: "Cod".into(), count: 1 }], xp: None, level_up: None, treasure: None, quests_completed: None, raw: String::new() }
    }
    fn captcha() -> GameEvent {
        GameEvent::Captcha { image_url: None, text: "captcha".into() }
    }
    fn unknown() -> GameEvent {
        GameEvent::Unknown { title: None, text: "x".into() }
    }

    #[test]
    fn a_counted_message_is_never_counted_again_by_an_edit() {
        let mut d = EditDeduper::new();
        assert!(d.accept("1", false, &catch(), "Caught Cod"));
        assert!(!d.accept("1", true, &catch(), "caught   cod")); // unchanged
        assert!(!d.accept("1", true, &catch(), "Caught Salmon")); // changed text, still counted
        assert!(!d.accept("1", true, &unknown(), "no fish to sell")); // another player's edit
        assert!(!d.accept("1", true, &unknown(), "something else"));
    }

    #[test]
    fn a_captcha_edit_is_accepted_even_over_a_catch() {
        let mut d = EditDeduper::new();
        d.accept("1", false, &catch(), "Caught Cod");
        assert!(d.accept("1", true, &captcha(), "captcha"));
    }

    #[test]
    fn unseen_edits_only_for_captcha_and_cooldown() {
        let mut d = EditDeduper::new();
        assert!(!d.accept("a", true, &unknown(), "x"));
        assert!(!d.accept("b", true, &catch(), "x"));
        assert!(d.accept("c", true, &GameEvent::Cooldown { wait_ms: 1000 }, "wait"));
        assert!(d.accept("d", true, &captcha(), "captcha"));
    }

    #[test]
    fn a_solved_captcha_never_comes_back_through_an_edit() {
        let mut d = EditDeduper::new();
        assert!(d.accept("cap", false, &captcha(), "captcha one"));
        assert!(d.accept("ok", false, &GameEvent::CaptchaSolved, "you may now continue"));
        assert!(!d.accept("cap", true, &captcha(), "captcha one"));
        assert!(!d.accept("cap", true, &captcha(), "captcha expired"));
        // a new captcha message is still accepted
        assert!(d.accept("cap2", false, &captcha(), "captcha two"));
    }

    #[test]
    fn bounded_to_200_ids() {
        let mut d = EditDeduper::new();
        for i in 0..250 {
            d.accept(&i.to_string(), false, &catch(), "c");
        }
        assert_eq!(d.seen.len(), 200);
        // the oldest was forgotten: its edit is now an "unseen" edit, dropped unless captcha/cooldown
        assert!(!d.seen.contains_key("0"));
        assert!(d.seen.contains_key("249"));
    }
}
