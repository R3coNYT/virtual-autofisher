use crate::model::{Boost, BotMessage, GameEvent};
use crate::parser::text::{after_colon, lines, parse_duration, re, titles_of};
use regex::Regex;
use std::sync::OnceLock;

re!(boost_title_re, r"(?i)boost");
re!(active_line_re, r"(?im)^active boosts");
// Virtual Fisher's own boost lines ("Personal Boost: 9m 43s", "Global Boost Duration: 3h 24m 35s").
re!(own_boost_re, r"(?i)^(personal|global)\s+boost\b");
re!(current_booster_re, r"(?i)^current booster\s*:");
re!(name_split_re, r"(?i):|\s-\s|\bends\b|\bremaining\b|\s\d");

pub fn boosts(m: &BotMessage, text: &str, now: i64) -> Option<GameEvent> {
    if !titles_of(m).iter().any(|t| boost_title_re().is_match(t)) && !active_line_re().is_match(text) {
        return None;
    }
    let mut active: Vec<Boost> = vec![];
    let mut booster: Option<String> = None;
    for line in lines(text) {
        if current_booster_re().is_match(line) {
            booster = Some(after_colon(line)).filter(|b| !b.is_empty());
            continue;
        }
        let Some(dur) = parse_duration(line) else { continue };
        let name = match own_boost_re().captures(line) {
            Some(c) => {
                let w = c[1].to_ascii_lowercase();
                format!("{}{}", w[..1].to_ascii_uppercase(), &w[1..])
            }
            None => name_split_re().split(line).next().unwrap_or("").trim().to_string(),
        };
        if !name.is_empty() {
            active.push(Boost { name, ends_at: now + dur, by: None });
        }
    }
    if let (Some(g), Some(b)) = (active.iter_mut().find(|b| b.name == "Global"), booster) {
        g.by = Some(b);
    }
    Some(GameEvent::Boosts { active })
}
