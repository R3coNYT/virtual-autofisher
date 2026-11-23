use crate::model::{Bait, BotMessage, GameEvent, RareCounts};
use crate::parser::text::{after_colon, lines, parse_number, re, titles_of, trailing_punct_re};
use regex::Regex;
use std::sync::OnceLock;

re!(inventory_re, r"(?i)inventory of");
re!(fish_value_re, r"(?i)fish value:");
re!(balance_re, r"(?i)balance:");
re!(xp_next_re, r"(?i)xp to next level");
re!(level_re, r"(?i)level\s*(\d+)");
re!(frac_re, r"(?i)(\d[\d,]*)\s*/\s*(\d[\d,]*)\s*xp to next");
re!(xp_re, r"(?i)([\d,.]+\s*[kmb]?)\s*xp to next");
re!(using_re, r"(?i)^.*currently using");
re!(biome_re, r"(?i)current biome:");
re!(gold_re, r"(?i)gold(?:en)? fish");
re!(emerald_re, r"(?i)emerald fish");
re!(lava_re, r"(?i)lava fish");
re!(diamond_re, r"(?i)diamond fish");
re!(bait_re, r"(?i)\bbait\b");
re!(bait_count_re, r"(?i)x\s*(\d[\d,]*)|\((\d[\d,]*)\)|(\d[\d,]*)\s*x?$");
re!(rod_re, r"(?i)\brod\b");

pub fn inventory(m: &BotMessage, text: &str) -> Option<GameEvent> {
    if !titles_of(m).iter().any(|t| inventory_re().is_match(t)) && !inventory_re().is_match(text) {
        return None;
    }
    let mut rare = RareCounts::default();
    let (mut balance, mut level, mut xp_to_next, mut rod, mut biome, mut bait, mut fish_value) =
        (None, None, None, None, None, None, None);
    for line in lines(text) {
        if fish_value_re().is_match(line) {
            fish_value = parse_number(&after_colon(line));
        } else if balance_re().is_match(line) {
            balance = parse_number(&after_colon(line));
        } else if xp_next_re().is_match(line) {
            if let Some(c) = level_re().captures(line) {
                level = c[1].parse().ok();
            }
            if let Some(c) = frac_re().captures(line) {
                xp_to_next = Some(parse_number(&c[2]).unwrap_or(0).saturating_sub(parse_number(&c[1]).unwrap_or(0)));
            } else if let Some(c) = xp_re().captures(line) {
                xp_to_next = parse_number(&c[1]);
            }
        } else if using_re().is_match(line) {
            let r = using_re().replace(line, "");
            rod = Some(trailing_punct_re().replace(&r, "").trim().to_string());
        } else if biome_re().is_match(line) {
            biome = Some(after_colon(line));
        } else if gold_re().is_match(line) {
            rare.gold = parse_number(&after_colon(line)).unwrap_or(0);
        } else if emerald_re().is_match(line) {
            rare.emerald = parse_number(&after_colon(line)).unwrap_or(0);
        } else if lava_re().is_match(line) {
            rare.lava = parse_number(&after_colon(line)).unwrap_or(0);
        } else if diamond_re().is_match(line) {
            rare.diamond = parse_number(&after_colon(line)).unwrap_or(0);
        } else if bait_re().is_match(line) {
            let v = after_colon(line);
            let c = bait_count_re().captures(&v);
            let count = c
                .as_ref()
                .and_then(|c| c.get(1).or_else(|| c.get(2)).or_else(|| c.get(3)))
                .and_then(|g| parse_number(g.as_str()))
                .unwrap_or(0);
            let whole = c.as_ref().and_then(|c| c.get(0)).map_or("", |g| g.as_str());
            bait = Some(Bait { name: v.replacen(whole, "", 1).trim().to_string(), count });
        } else if rod_re().is_match(line) {
            rod = Some(after_colon(line));
        }
    }
    Some(GameEvent::Inventory { balance: balance?, level: level?, xp_to_next, rod, biome, bait, rare, fish_value })
}
