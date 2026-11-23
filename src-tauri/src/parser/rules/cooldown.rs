use crate::model::{BotMessage, GameEvent};
use crate::parser::text::{parse_duration, re};
use regex::Regex;
use std::sync::OnceLock;

// "wait" followed by a contiguous duration: `2.4 seconds`, `20h 12m`, `5 more seconds`,
// `1 hour, 3 minutes and 2 seconds`. Words after the duration ("before fishing") stop it.
re!(
    cooldown_re,
    r"(?i)\b(?:you must wait|please wait|wait)\s+(?:for\s+)?(\d+(?:\.\d+)?\s*(?:more\s+)?[a-z]*(?:[\s,]+(?:and\s+)?\d+(?:\.\d+)?\s*(?:more\s+)?[a-z]*)*)"
);
// "Daily reward on cooldown! (10h 20m 25s)"
re!(on_cooldown_re, r"(?i)\bon cooldown\b[^\n]*");
re!(more_re, r"(?i)\bmore\s+");
re!(leading_num_re, r"^\d+(?:\.\d+)?");

pub fn cooldown(_m: &BotMessage, text: &str) -> Option<GameEvent> {
    let Some(c) = cooldown_re().captures(text) else {
        let ms = parse_duration(on_cooldown_re().find(text)?.as_str())?;
        return Some(GameEvent::Cooldown { wait_ms: ms });
    };
    let span = more_re().replace_all(&c[1], "").to_string();
    let wait_ms = parse_duration(&span).unwrap_or_else(|| {
        let n: f64 = leading_num_re().find(&span).and_then(|m| m.as_str().parse().ok()).unwrap_or(0.0);
        (n * 1000.0).round() as i64
    });
    Some(GameEvent::Cooldown { wait_ms })
}
