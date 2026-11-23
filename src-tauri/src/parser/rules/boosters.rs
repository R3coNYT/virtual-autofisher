use crate::model::{BotMessage, GameEvent};
use crate::parser::text::{parse_number, re, titles_of};
use regex::Regex;
use std::sync::OnceLock;

re!(none_re, r"(?i)you have no boosters");
re!(line_re, r"(?i)personal boosters?\s*:\s*([^\n]*)");
re!(title_re, r"(?i)your boosters");

/// /boosters: "Personal Boosters: 1." or "You have no boosters! Get some by donating, or voting."
pub fn boosters(m: &BotMessage, text: &str) -> Option<GameEvent> {
    if none_re().is_match(text) {
        return Some(GameEvent::Boosters { personal: 0 });
    }
    if let Some(c) = line_re().captures(text) {
        return Some(GameEvent::Boosters { personal: parse_number(&c[1]).unwrap_or(0) });
    }
    titles_of(m).iter().any(|t| title_re().is_match(t)).then_some(GameEvent::Boosters { personal: 0 })
}
