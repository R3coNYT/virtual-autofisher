use crate::model::{BotMessage, GameEvent};
use crate::parser::text::re;
use regex::Regex;
use std::sync::OnceLock;

re!(
    error_re,
    r"(?i)don'?t have enough|not enough|insufficient|unknown (?:item|command|bait|rod)|invalid (?:item|amount|command)|doesn'?t exist|you (?:can'?t|cannot)"
);

pub fn error(_m: &BotMessage, text: &str) -> Option<GameEvent> {
    error_re().is_match(text).then(|| GameEvent::Error { text: text.to_string() })
}
