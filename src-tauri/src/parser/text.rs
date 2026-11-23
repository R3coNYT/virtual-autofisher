//! Text helpers shared by the parser rules (port of `src/main/parser/text.ts`).

use crate::model::{BotMessage, GameEvent};
use regex::Regex;
use std::sync::OnceLock;

/// A parser rule: returns a GameEvent when it recognises the message.
pub type Rule = fn(&BotMessage, &str) -> Option<GameEvent>;

macro_rules! re {
    ($name:ident, $pat:expr) => {
        pub(crate) fn $name() -> &'static Regex {
            static RE: OnceLock<Regex> = OnceLock::new();
            RE.get_or_init(|| Regex::new($pat).expect("valid regex"))
        }
    };
}
pub(crate) use re;

re!(emoji_re, r"<a?:\w+:\d+>");
re!(shortcode_re, r":\w+:");
re!(markdown_re, r"[*_~`]");
re!(spaces_re, "[ \t\u{a0}]+");
re!(number_re, r"(\d[\d,]*(?:\.\d+)?)\s*([kmbtKMBT])?");
re!(duration_re, r"(?i)(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b");
re!(trailing_punct_re, r"[.!]+$");

/// Strips custom emoji (<:n:id>, <a:n:id>), :shortcodes:, markdown (*_~`), collapses horizontal
/// whitespace. Newlines are kept so rules can work line by line.
pub fn clean_text(s: &str) -> String {
    let s = emoji_re().replace_all(s, "");
    let s = shortcode_re().replace_all(&s, "");
    let s = markdown_re().replace_all(&s, "");
    s.split('\n').map(|l| spaces_re().replace_all(l, " ").trim().to_string()).collect::<Vec<_>>().join("\n").trim().to_string()
}

/// First number of a string: `1,234`, `$1,234`, `1.2M`, `12.5k`. A suffix letter followed by
/// another letter (`5 minutes`) is not a suffix.
pub fn parse_number(s: &str) -> Option<u64> {
    let m = number_re().captures(s)?;
    let n: f64 = m[1].replace(',', "").parse().ok()?;
    let mult = match m.get(2) {
        Some(suf) if !s[suf.end()..].chars().next().is_some_and(|c| c.is_ascii_alphabetic()) => {
            match suf.as_str().to_ascii_lowercase().as_str() {
                "k" => 1e3,
                "m" => 1e6,
                "b" => 1e9,
                _ => 1e12,
            }
        }
        _ => 1.0,
    };
    Some((n * mult).round() as u64)
}

/// Durations like `5m 30s`, `1h 2m`, `12 seconds`, `2.4 seconds`, in milliseconds.
pub fn parse_duration(s: &str) -> Option<i64> {
    let mut total = 0.0;
    let mut found = false;
    for m in duration_re().captures_iter(s) {
        let unit = m[2].to_ascii_lowercase();
        let ms = match unit.chars().next() {
            Some('h') => 3_600_000.0,
            Some('m') => 60_000.0,
            _ => 1000.0,
        };
        total += m[1].parse::<f64>().unwrap_or(0.0) * ms;
        found = true;
    }
    found.then(|| total.round() as i64)
}

/// Non-empty trimmed lines.
pub fn lines(text: &str) -> Vec<&str> {
    text.split('\n').map(str::trim).filter(|l| !l.is_empty()).collect()
}

/// Value after the first ':' (or the whole line), without trailing punctuation.
pub fn after_colon(line: &str) -> String {
    let v = line.split_once(':').map_or(line, |(_, r)| r).trim();
    trailing_punct_re().replace(v, "").trim().to_string()
}

pub fn titles_of(m: &BotMessage) -> Vec<String> {
    m.embeds.iter().map(|e| clean_text(e.title.as_deref().unwrap_or(""))).filter(|t| !t.is_empty()).collect()
}

pub fn description_of(m: &BotMessage) -> String {
    clean_text(m.embeds.iter().find_map(|e| e.description.as_deref().filter(|d| !d.is_empty())).unwrap_or(""))
}

/// Content, titles, descriptions, fields and footers, cleaned, one per line.
pub fn build_text(m: &BotMessage) -> String {
    let mut parts: Vec<String> = vec![m.content.clone()];
    for e in &m.embeds {
        parts.push(e.title.clone().unwrap_or_default());
        parts.push(e.description.clone().unwrap_or_default());
        for f in &e.fields {
            let name = f.name.trim_end().trim_end_matches(':').trim_end();
            parts.push(format!("{name}: {}", f.value));
        }
        parts.push(e.footer.clone().unwrap_or_default());
    }
    parts.iter().map(|p| clean_text(p)).filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n")
}

/// The message as Discord markdown (not cleaned), for display: titles in bold, footers as subtext.
pub fn raw_text(m: &BotMessage) -> String {
    let mut parts: Vec<String> = vec![m.content.clone()];
    for e in &m.embeds {
        if let Some(t) = e.title.as_deref().filter(|t| !t.is_empty()) {
            parts.push(format!("**{t}**"));
        }
        parts.push(e.description.clone().unwrap_or_default());
        for f in &e.fields {
            parts.push(format!("**{}**\n{}", f.name, f.value));
        }
        parts.push(e.footer.as_ref().map(|f| format!("-# {f}")).unwrap_or_default());
    }
    parts.into_iter().filter(|p| !p.trim().is_empty()).collect::<Vec<_>>().join("\n").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_number_plain_comma_currency_suffixes() {
        assert_eq!(parse_number("1,234,567"), Some(1_234_567));
        assert_eq!(parse_number("$1,234"), Some(1234));
        assert_eq!(parse_number("1.2M"), Some(1_200_000));
        assert_eq!(parse_number("12.5k"), Some(12_500));
        assert_eq!(parse_number("abc"), None);
        assert_eq!(parse_number(""), None);
        assert_eq!(parse_number("5 minutes"), Some(5));
    }

    #[test]
    fn parse_duration_units() {
        assert_eq!(parse_duration("5m 30s"), Some(330_000));
        assert_eq!(parse_duration("1h 2m"), Some(3_720_000));
        assert_eq!(parse_duration("12 seconds"), Some(12_000));
        assert_eq!(parse_duration("2.4 seconds"), Some(2400));
        assert_eq!(parse_duration("soon"), None);
    }

    #[test]
    fn clean_text_strips_emoji_markdown_shortcodes() {
        assert_eq!(clean_text("<:fish:123> **Cod** x2"), "Cod x2");
        assert_eq!(clean_text("<a:spin:456> _x_ ~~y~~ `z`"), "x y z");
        assert_eq!(clean_text(":fish:   Cod    x2"), "Cod x2");
    }
}
