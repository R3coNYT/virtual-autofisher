//! Pure parser: a bot message → a typed `GameEvent` (port of `src/main/parser`). Never panics.

pub mod rules;
pub mod text;

use crate::model::{BotMessage, GameEvent};
use rules::*;
pub use text::{build_text, clean_text, parse_duration, parse_number, raw_text};

type RuleFn<'a> = &'a dyn Fn(&BotMessage, &str) -> Option<GameEvent>;

/// Rules in a fixed order: captcha always first; boosters before boosts ("Your Boosters" matches /boost/).
pub fn parse_message(m: &BotMessage, now_ms: i64) -> GameEvent {
    let text = build_text(m);
    let ordered: [RuleFn; 14] = [
        &captcha::captcha,
        &captcha::captcha_solved,
        &captcha::captcha_failed,
        &cooldown::cooldown,
        &catch::catch,
        &sell::sell,
        &inventory::inventory,
        &stats::stats,
        &boosters::boosters,
        &|m, t| boosts::boosts(m, t, now_ms),
        &purchase::purchase,
        &daily::daily,
        &quests::quests,
        &error::error,
    ];
    for rule in ordered {
        // a rule that panics is skipped (mirrors the try/catch of v1)
        if let Ok(Some(ev)) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| rule(m, &text))) {
            return ev;
        }
    }
    GameEvent::Unknown { title: text::titles_of(m).into_iter().next(), text }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discord::model_conv::testkit::{load_capture, read_json};
    use crate::model::{Boost, CatchItem, Embed, PartialRare, Quest, RareCounts};

    const NOW: i64 = 1_700_000_000_000;

    fn load(name: &str) -> BotMessage {
        serde_json::from_value(read_json(&format!("messages/{name}.json"))).unwrap()
    }
    fn parse(name: &str) -> GameEvent {
        parse_message(&load(name), NOW)
    }
    fn real(name: &str) -> GameEvent {
        parse_message(&load_capture("real", name), NOW)
    }
    fn item(name: &str, count: u64) -> CatchItem {
        CatchItem { name: name.into(), count }
    }

    #[test]
    fn catch_basic() {
        let GameEvent::Catch { items, xp, level_up, raw, .. } = parse("catch-basic") else { panic!() };
        assert!(items.contains(&item("Cod", 2)) && items.contains(&item("Salmon", 1)));
        assert_eq!((xp, level_up), (Some(45), None));
        assert!(raw.contains("Cod x2"));
    }

    #[test]
    fn catch_levelup() {
        let GameEvent::Catch { items, xp, level_up, treasure, .. } = parse("catch-levelup") else { panic!() };
        assert_eq!((level_up, xp), (Some(13), Some(120)));
        assert_eq!(treasure.map(|t| t.len()), Some(1));
        assert_eq!(items, vec![item("Cod", 1)]);
    }

    #[test]
    fn inventory_fixture() {
        let GameEvent::Inventory { balance, level, xp_to_next, rod, biome, bait, rare, .. } = parse("inventory") else { panic!() };
        assert_eq!((balance, level, xp_to_next), (1_234_567, 12, Some(3450)));
        assert_eq!((rod.as_deref(), biome.as_deref()), (Some("Wooden Rod"), Some("Lake")));
        assert_eq!(bait.map(|b| (b.name, b.count)), Some(("Worms".to_string(), 12)));
        assert_eq!(rare, RareCounts { gold: 3, emerald: 1, lava: 0, diamond: 2 });
    }

    #[test]
    fn stats_fixture() {
        assert_eq!(
            parse("stats"),
            GameEvent::Stats {
                crates: Some(14),
                quests: Some(7),
                trips: Some(88),
                daily_streak: Some(5),
                totals: PartialRare { gold: Some(9), emerald: Some(4), lava: Some(2), diamond: Some(1) }
            }
        );
    }

    #[test]
    fn captcha_variants() {
        assert!(matches!(parse("captcha-image"), GameEvent::Captcha { image_url: Some(u), .. } if u == "https://cdn.example.test/captcha/abc123.png"));
        assert!(matches!(parse("captcha-text-only"), GameEvent::Captcha { image_url: None, .. }));
        assert_eq!(parse("captcha-solved"), GameEvent::CaptchaSolved);
        assert!(matches!(parse("captcha-failed"), GameEvent::CaptchaFailed { .. }));
        let mut m = load("catch-basic");
        m.embeds = vec![Embed { title: Some("You caught:".into()), description: Some("Cod x1".into()), footer: Some("Complete the CAPTCHA".into()), ..Embed::default() }];
        assert!(matches!(parse_message(&m, NOW), GameEvent::Captcha { .. }));
    }

    #[test]
    fn cooldowns() {
        assert_eq!(parse("cooldown"), GameEvent::Cooldown { wait_ms: 2400 });
        let cd = |content: &str| {
            let mut m = load("cooldown");
            m.content = content.into();
            m.embeds.clear();
            parse_message(&m, NOW)
        };
        assert_eq!(cd("wait 3s"), GameEvent::Cooldown { wait_ms: 3000 });
        assert_eq!(cd("You already claimed your daily, please wait 20h 12m before claiming again."), GameEvent::Cooldown { wait_ms: (20 * 60 + 12) * 60_000 });
        assert_eq!(cd("Please wait 5 more seconds"), GameEvent::Cooldown { wait_ms: 5000 });
        assert_eq!(cd("You must wait 1 hour, 3 minutes and 2 seconds"), GameEvent::Cooldown { wait_ms: 3_782_000 });
        assert_eq!(cd("wait 2 minutes 30 seconds before fishing 3 times"), GameEvent::Cooldown { wait_ms: 150_000 });
        assert_eq!(cd("Please wait 4 before fishing"), GameEvent::Cooldown { wait_ms: 4000 });
    }

    #[test]
    fn sell_purchase_daily_error_unknown() {
        assert_eq!(parse("sell"), GameEvent::Sell { earned: 1234, xp: Some(56) });
        assert_eq!(parse("purchase"), GameEvent::Purchase { item: "Worms".into(), amount: 5, cost: Some(250) });
        let GameEvent::Daily { reward, next_in_ms } = parse("daily") else { panic!() };
        assert!(reward.contains("$5,000") && next_in_ms.is_none());
        let mut d = load("daily");
        d.embeds[0].description = Some(format!("{}\nNext daily in **23h 59m**", d.embeds[0].description.clone().unwrap_or_default()));
        assert!(matches!(parse_message(&d, NOW), GameEvent::Daily { next_in_ms: Some(ms), .. } if ms == (23 * 60 + 59) * 60_000));
        assert!(matches!(parse("error-funds"), GameEvent::Error { text } if text.contains("don't have enough")));
        assert!(matches!(parse("unknown-embed"), GameEvent::Unknown { title: Some(t), .. } if t == "Fish of the day"));
    }

    #[test]
    fn boosts_and_quests_fixtures() {
        assert_eq!(
            parse("boosts"),
            GameEvent::Boosts {
                active: vec![
                    Boost { name: "Fishing Buff".into(), ends_at: NOW + 270_000, by: None },
                    Boost { name: "Lucky Charm".into(), ends_at: NOW + 3_720_000, by: None }
                ]
            }
        );
        let q = |l: &str, p: &str, d: bool| Quest { label: l.into(), progress: p.into(), done: d };
        assert_eq!(parse("quests"), GameEvent::Quests { quests: vec![q("Catch 50 fish", "12/50", false), q("Sell 20 fish", "20/20", true), q("Open 3 crates", "1/3", false)] });
    }

    #[test]
    fn robustness() {
        let m = BotMessage { embeds: vec![Embed { title: Some("X".into()), ..Embed::default() }], ..BotMessage::default() };
        assert!(matches!(parse_message(&m, NOW), GameEvent::Unknown { title: Some(t), .. } if t == "X"));
        assert!(matches!(parse_message(&BotMessage::default(), NOW), GameEvent::Unknown { .. }));
    }

    // ---- real captures (Components V2)

    #[test]
    fn real_catches() {
        let GameEvent::Catch { items, xp, level_up, treasure, .. } = real("catch-plain") else { panic!() };
        assert_eq!((items, xp, level_up, treasure), (vec![item("Turtle", 20), item("Dolphin", 3)], Some(20821), None, None));

        let GameEvent::Catch { items, xp, treasure, quests_completed, .. } = real("catch-chest-xp") else { panic!() };
        assert_eq!((items, xp, quests_completed), (vec![item("Turtle", 15)], Some(30137), None));
        assert!(treasure.unwrap()[0].starts_with("You found a rare chest"));

        let GameEvent::Catch { items, xp, treasure, .. } = real("catch-chest-lava") else { panic!() };
        assert_eq!(items, vec![item("Squid", 2), item("Turtle", 22), item("Dolphin", 1), item("Lava Fish", 5)]);
        assert_eq!((xp, treasure.map(|t| t.len())), (Some(19921), Some(1)));

        let GameEvent::Catch { items, xp, level_up, quests_completed, treasure, .. } = real("catch-levelup-quest") else { panic!() };
        assert_eq!(items, vec![item("Turtle", 14), item("Dolphin", 1), item("Gold Fish", 6)]);
        assert_eq!((xp, level_up), (Some(23962), Some(155)));
        assert_eq!(quests_completed, Some(vec!["Daily Level-ups Tier 3".to_string()]));
        assert!(treasure.unwrap()[0].starts_with("You found an uncommon chest"));

        let GameEvent::Catch { items, xp, level_up, quests_completed, treasure, .. } = real("catch-crate-gold-quest") else { panic!() };
        assert_eq!(items, vec![item("Squid", 2), item("Turtle", 8), item("Dolphin", 3), item("Gold Fish", 5)]);
        assert_eq!((xp, level_up), (Some(11912), None));
        assert_eq!(quests_completed, Some(vec!["Daily Artifact Hunter Tier 3".to_string()]));
        assert!(treasure.unwrap()[0].starts_with("You found an epic crate"));
    }

    #[test]
    fn real_inventory_quests_cooldown_edit() {
        let GameEvent::Inventory { balance, level, xp_to_next, rod, biome, bait, rare, fish_value } = real("inventory") else { panic!() };
        assert_eq!((balance, level, xp_to_next), (136_570_161, 154, Some(1_062_500 - 986_860)));
        assert_eq!((rod.as_deref(), biome.as_deref()), (Some("Superium Rod"), Some("Ocean")));
        assert_eq!(bait.map(|b| (b.name, b.count)), Some(("Magic Bait".to_string(), 34_414)));
        assert_eq!(rare, RareCounts { gold: 2353, emerald: 887, lava: 43, diamond: 77 });
        assert_eq!(fish_value, Some(32_180_326));

        let q = |l: &str, p: &str| Quest { label: l.into(), progress: p.into(), done: false };
        assert_eq!(real("quests"), GameEvent::Quests { quests: vec![q("Daily Level-ups", "2/3"), q("Daily Fishing", "3225/5000"), q("Daily Artifact Hunter", "19/25"), q("Pet Locator", "0/1")] });
        assert_eq!(real("daily-cooldown"), GameEvent::Cooldown { wait_ms: ((10 * 60 + 20) * 60 + 25) * 1000 });
        let edit = load_capture("real", "edit-other-player");
        assert!(edit.is_edit);
        assert_eq!(edit.embeds[0].title.as_deref(), Some("Other Player"));
        assert!(!matches!(parse_message(&edit, NOW), GameEvent::Catch { .. }));
    }

    #[test]
    fn v2_boosts_and_boosters() {
        let v2 = |n: &str| parse_message(&load_capture("v2", n), NOW);
        let global = |by: bool| Boost { name: "Global".into(), ends_at: NOW + ((3 * 60 + 24) * 60 + 35) * 1000, by: by.then(|| "Messor".into()) };
        assert_eq!(v2("boosts-active"), GameEvent::Boosts { active: vec![Boost { name: "Personal".into(), ends_at: NOW + (9 * 60 + 43) * 1000, by: None }, global(true)] });
        assert_eq!(v2("boosts-global-only"), GameEvent::Boosts { active: vec![global(true)] });
        assert_eq!(v2("boosts-none"), GameEvent::Boosts { active: vec![] });
        assert_eq!(v2("boosters-one"), GameEvent::Boosters { personal: 1 });
        assert_eq!(v2("boosters-none"), GameEvent::Boosters { personal: 0 });
    }

    #[test]
    fn captcha_text_is_raw_markdown() {
        let m = BotMessage {
            embeds: vec![Embed { title: Some("Player\\_One".into()), description: Some("### Anti-bot\n/verify <result>\nCode: **7CXG**".into()), ..Embed::default() }],
            ..BotMessage::default()
        };
        let GameEvent::Captcha { text, .. } = parse_message(&m, NOW) else { panic!() };
        assert_eq!(text, raw_text(&m));
        assert!(text.starts_with("**Player\\_One**") && text.contains("Code: **7CXG**"));
    }
}
