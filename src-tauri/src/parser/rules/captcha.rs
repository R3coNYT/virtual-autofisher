use crate::model::{BotMessage, GameEvent};
use crate::parser::text::{raw_text, re};
use regex::Regex;
use std::sync::OnceLock;

re!(captcha_re, r"(?i)captcha|/verify|\bverify\b");
re!(solved_re, r"(?i)you may now continue");
re!(failed_re, r"(?i)incorrect|wrong code|invalid code");

fn is_solved(t: &str) -> bool {
    solved_re().is_match(t)
}
fn is_failed(t: &str) -> bool {
    failed_re().is_match(t) && captcha_re().is_match(t)
}

/// Deliberately broad: a false positive is preferred over a missed captcha.
pub fn captcha(m: &BotMessage, text: &str) -> Option<GameEvent> {
    if is_solved(text) || is_failed(text) || !captcha_re().is_match(text) {
        return None;
    }
    let image_url = m.embeds.iter().find_map(|e| e.image_url.clone());
    Some(GameEvent::Captcha { image_url, text: raw_text(m) }) // raw markdown: shown as Discord renders it
}

pub fn captcha_solved(_m: &BotMessage, text: &str) -> Option<GameEvent> {
    is_solved(text).then_some(GameEvent::CaptchaSolved)
}

pub fn captcha_failed(m: &BotMessage, text: &str) -> Option<GameEvent> {
    is_failed(text).then(|| GameEvent::CaptchaFailed { text: raw_text(m) })
}
