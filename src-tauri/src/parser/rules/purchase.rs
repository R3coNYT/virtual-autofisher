use crate::model::{BotMessage, GameEvent};
use crate::parser::text::{parse_number, re};
use regex::Regex;
use std::sync::OnceLock;

re!(
    purchase_re,
    r"(?im)you (?:bought|purchased)\s+(?:(\d[\d,]*)\s*x?\s*)?(.+?)(?:\s+for\s+\$?\s*([\d,.]+\s*[kmbt]?))?\s*[.!]*\s*$"
);

pub fn purchase(_m: &BotMessage, text: &str) -> Option<GameEvent> {
    let c = purchase_re().captures(text)?;
    Some(GameEvent::Purchase {
        item: c[2].trim().to_string(),
        amount: c.get(1).and_then(|n| parse_number(n.as_str())).unwrap_or(1),
        cost: c.get(3).and_then(|n| parse_number(n.as_str())),
    })
}
