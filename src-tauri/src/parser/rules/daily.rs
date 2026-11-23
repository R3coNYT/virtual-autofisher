use crate::model::{BotMessage, GameEvent};
use crate::parser::text::{parse_duration, re, titles_of};
use regex::Regex;
use std::sync::OnceLock;

re!(quest_title_re, r"(?i)quest");
re!(on_cooldown_re, r"(?i)on cooldown");
re!(daily_re, r"(?i)daily reward|(?:claimed|collected|received).{0,20}daily|daily.{0,20}(?:claimed|collected)");
// "Next daily in 23h 59m", "come back in …", "available again in …"
re!(next_re, r"(?i)\b(?:next daily|come back|again|available)\b[^\n]*");

pub fn daily(m: &BotMessage, text: &str) -> Option<GameEvent> {
    if titles_of(m).iter().any(|t| quest_title_re().is_match(t)) || on_cooldown_re().is_match(text) || !daily_re().is_match(text) {
        return None;
    }
    let next_in_ms = next_re().find(text).and_then(|n| parse_duration(n.as_str())).filter(|ms| *ms > 0);
    Some(GameEvent::Daily { reward: text.split('\n').collect::<Vec<_>>().join(" ").trim().to_string(), next_in_ms })
}
