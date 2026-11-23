use crate::model::{BotMessage, GameEvent};
use crate::parser::rules::catch::parse_xp;
use crate::parser::text::{parse_number, re};
use regex::Regex;
use std::sync::OnceLock;

re!(sold_re, r"(?i)you sold|\bsold\b.*\bfor\b");
re!(dollar_re, r"(?i)\$\s*([\d,.]+\s*[kmbt]?)");
re!(for_re, r"(?i)\bfor\s+([\d,.]+\s*[kmbt]?)");

pub fn sell(_m: &BotMessage, text: &str) -> Option<GameEvent> {
    if !sold_re().is_match(text) {
        return None;
    }
    let amount = dollar_re().captures(text).or_else(|| for_re().captures(text)).map(|c| c[1].to_string()).unwrap_or_default();
    let earned = parse_number(&amount)?;
    Some(GameEvent::Sell { earned, xp: parse_xp(text) })
}
