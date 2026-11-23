use crate::model::{BotMessage, CatchItem, GameEvent};
use crate::parser::text::{description_of, lines, parse_number, re, trailing_punct_re};
use regex::Regex;
use std::sync::OnceLock;

// Lines that are never a caught item (rewards, XP, chests, quest and level-up text).
re!(
    not_item_re,
    r"(?i)\bxp\b|level up|balance|boost|^#|treasure|crate|chest|you caught|\$|quest complete|\btier\s*\d|^reward\b|received|you found|you got|^\d+\s*x\s+\w+\s+crate"
);
re!(xp_any_re, r"(?i)\+?\s*([\d,.]+\s*[kmb]?)\s*xp\b");
re!(xp_line_re, r"(?i)^\+\s*([\d,.]+\s*[kmb]?)\s*xp\b");
re!(letter_re, r"(?i)[a-z]");
re!(n_x_name_re, r"(?i)^(\d[\d,]*)\s*x\s+(.+)$");
re!(name_x_n_re, r"(?i)^(.+?)\s+x\s*(\d[\d,]*)[.!]*$");
re!(n_name_re, r"^(\d[\d,]*)\s+(\D.*)$");
re!(you_caught_re, r"(?i)you caught");
re!(you_caught_prefix_re, r"(?i)^.*?you caught\s*:?");
re!(chest_fish_re, r"(?i)you got\s+(\d[\d,]*)\s+(gold|emerald|lava|diamond)\s+fish\b.*\bfrom the (?:chest|crate)");
re!(treasure_re, r"(?i)\byou found an?\b.*\b(?:chest|crate)\b|treasure");
re!(quest_complete_re, r"(?i)^quest complete");
re!(level_up_re, r"(?i)level up!?\D*(\d+)");

pub fn parse_xp(text: &str) -> Option<u64> {
    xp_any_re().captures(text).and_then(|c| parse_number(&c[1])).filter(|n| *n > 0)
}

/// XP of the catch: the "+N XP" line (not the chest's "You got N XP" line).
fn catch_xp(all: &[&str], text: &str) -> Option<u64> {
    all.iter().find_map(|l| xp_line_re().captures(l).map(|c| parse_number(&c[1]))).flatten().or_else(|| parse_xp(text))
}

fn strip(s: &str) -> String {
    trailing_punct_re().replace(s, "").trim().to_string()
}

fn parse_item(line: &str) -> Option<CatchItem> {
    if not_item_re().is_match(line) || !letter_re().is_match(line) {
        return None;
    }
    if let Some(c) = n_x_name_re().captures(line) {
        return Some(CatchItem { name: strip(&c[2]), count: parse_number(&c[1]).unwrap_or(1) });
    }
    if let Some(c) = name_x_n_re().captures(line) {
        return Some(CatchItem { name: c[1].trim().to_string(), count: parse_number(&c[2]).unwrap_or(1) });
    }
    if let Some(c) = n_name_re().captures(line) {
        // "2 Squid" (current Virtual Fisher format)
        return Some(CatchItem { name: strip(&c[2]), count: parse_number(&c[1]).unwrap_or(1) });
    }
    if line.chars().count() > 40 || line.contains(':') {
        return None;
    }
    Some(CatchItem { name: strip(line), count: 1 })
}

pub fn catch(m: &BotMessage, text: &str) -> Option<GameEvent> {
    if !you_caught_re().is_match(text) {
        return None;
    }
    let description = description_of(m);
    let all = lines(text);
    let start = all.iter().position(|l| you_caught_re().is_match(l))?;

    // the items are the consecutive item lines right after "You caught:"
    let mut items: Vec<CatchItem> = vec![];
    let rest = you_caught_prefix_re().replace(all[start], "").trim().to_string();
    let mut candidates: Vec<&str> = vec![];
    if !rest.is_empty() {
        candidates.push(rest.as_str());
    }
    candidates.extend(&all[start + 1..]);
    for line in candidates {
        match parse_item(line) {
            Some(i) => items.push(i),
            None => break,
        }
    }

    let mut treasure = vec![];
    let mut quests_completed = vec![];
    for (i, line) in all.iter().enumerate() {
        if let Some(c) = chest_fish_re().captures(line) {
            let kind = c[2].to_ascii_lowercase();
            let name = format!("{}{} Fish", kind[..1].to_ascii_uppercase(), &kind[1..]);
            items.push(CatchItem { name, count: parse_number(&c[1]).unwrap_or(1) });
        } else if treasure_re().is_match(line) {
            treasure.push(line.to_string());
        }
        if quest_complete_re().is_match(line) {
            if let Some(next) = all.get(i + 1) {
                quests_completed.push(strip(next));
            }
        }
    }

    Some(GameEvent::Catch {
        items,
        xp: catch_xp(&all, text),
        level_up: level_up_re().captures(text).and_then(|c| c[1].parse().ok()),
        treasure: (!treasure.is_empty()).then_some(treasure),
        quests_completed: (!quests_completed.is_empty()).then_some(quests_completed),
        raw: if description.is_empty() { text.to_string() } else { description },
    })
}
