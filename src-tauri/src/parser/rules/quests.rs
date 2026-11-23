use crate::model::{BotMessage, GameEvent, Quest};
use crate::parser::text::{lines, re, titles_of};
use regex::Regex;
use std::sync::OnceLock;

re!(quest_title_re, r"(?i)\bquests?\b");
re!(progress_re, r"(\d[\d,]*)\s*/\s*(\d[\d,]*)");
re!(marks_re, "[\u{2705}\u{2714}\u{2611}\u{274C}\u{2716}]");
re!(edges_re, r"^[\s:\-\u{2013}]+|[\s:\-\u{2013}]+$");
re!(done_re, "(?i)\u{2705}|\u{2714}|\u{2611}|complete");

pub fn quests(m: &BotMessage, text: &str) -> Option<GameEvent> {
    if !titles_of(m).iter().any(|t| quest_title_re().is_match(t)) {
        return None;
    }
    let mut out = vec![];
    for line in lines(text) {
        let Some(p) = progress_re().captures(line) else { continue };
        let num = |s: &str| s.replace(',', "").parse::<u64>().unwrap_or(0);
        let (a, b) = (num(&p[1]), num(&p[2]));
        let whole = p.get(0).map_or("", |g| g.as_str());
        let label = line.replacen(whole, "", 1);
        let label = marks_re().replace_all(&label, "");
        let label = edges_re().replace_all(&label, "").to_string();
        out.push(Quest {
            label,
            progress: whole.chars().filter(|c| !c.is_whitespace()).collect(),
            done: done_re().is_match(line) || (b > 0 && a >= b),
        });
    }
    Some(GameEvent::Quests { quests: out })
}
