use crate::model::{BotMessage, GameEvent, PartialRare};
use crate::parser::text::{after_colon, lines, parse_number, re, titles_of};
use regex::Regex;
use std::sync::OnceLock;

re!(title_re, r"(?i)statistics for");
re!(crates_re, r"(?i)crates");
re!(quests_re, r"(?i)quests");
re!(trips_re, r"(?i)trips");
re!(daily_re, r"(?i)daily");
re!(gold_re, r"(?i)gold(?:en)?");
re!(emerald_re, r"(?i)emerald");
re!(lava_re, r"(?i)lava");
re!(diamond_re, r"(?i)diamond");

pub fn stats(m: &BotMessage, text: &str) -> Option<GameEvent> {
    if !titles_of(m).iter().any(|t| title_re().is_match(t)) && !title_re().is_match(text) {
        return None;
    }
    let (mut crates, mut quests, mut trips, mut daily_streak) = (None, None, None, None);
    let mut totals = PartialRare::default();
    for line in lines(text) {
        let Some(n) = parse_number(&after_colon(line)).or_else(|| parse_number(line)) else { continue };
        if crates_re().is_match(line) {
            crates = Some(n)
        } else if quests_re().is_match(line) {
            quests = Some(n)
        } else if trips_re().is_match(line) {
            trips = Some(n)
        } else if daily_re().is_match(line) {
            daily_streak = Some(n)
        } else if gold_re().is_match(line) {
            totals.gold = Some(n)
        } else if emerald_re().is_match(line) {
            totals.emerald = Some(n)
        } else if lava_re().is_match(line) {
            totals.lava = Some(n)
        } else if diamond_re().is_match(line) {
            totals.diamond = Some(n)
        }
    }
    Some(GameEvent::Stats { crates, quests, trips, daily_streak, totals })
}
