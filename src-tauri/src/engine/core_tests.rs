//! Engine scenarios, ported from v1 `Engine.test.ts`, `deferredReply.test.ts` and the engine-level
//! cases of `boosters.test.ts` / `dailyPersistence.test.ts`, with the same timings and assertions.

use super::core::{EngineInput, LogLevel, NO_CHANNEL};
use super::game_state::PersistedState;
use super::sim::*;
use crate::model::{BotMessage, Config, EngineState as S, LogType, SellMode, SlashOptions};
use serde_json::json;

const MIN: i64 = 60_000;
const H: i64 = 60 * MIN;

fn a() -> crate::model::Target {
    target("g1", "A")
}
fn b() -> crate::model::Target {
    target("g1", "B")
}
fn sim() -> Sim {
    Sim::new(test_config(|_| {}))
}
fn sim_with(patch: impl FnOnce(&mut Config)) -> Sim {
    Sim::new(test_config(patch))
}
fn catch3() -> BotMessage {
    fixture("catch-basic") // 3 fish (Cod x2, Salmon x1)
}
fn captcha() -> BotMessage {
    fixture("captcha-image")
}
fn solved() -> BotMessage {
    fixture("captcha-solved")
}
fn reason(s: &Sim) -> Option<String> {
    s.last_state().1.reason
}
fn buffs(c: &mut Config) {
    c.buffs.enabled = true;
    c.buffs.length_min = 5;
}
fn buys(s: &Sim) -> Vec<String> {
    s.sent.iter().filter(|x| x.name == "buy").map(|x| x.options["item"].as_str().unwrap().to_string()).collect()
}
fn profile_reply() -> BotMessage {
    embed("Inventory of Player", "Balance: $1,000.\nLevel 3, 10/100 XP to next level.\nFish Value: $500")
}
fn quests_reply() -> BotMessage {
    embed("Quest List", "**Daily Fishing** - 1/5")
}
fn graceful_reply(cmd: &str) -> Option<BotMessage> {
    match cmd {
        "profile" => Some(profile_reply()),
        "quests" => Some(quests_reply()),
        "fish" => Some(one_fish()),
        _ => None,
    }
}
fn fish_only(cmd: &str, _: &SlashOptions) -> Option<BotMessage> {
    (cmd == "fish").then(one_fish)
}

// ---- Engine ---------------------------------------------------------------------

#[test]
fn normal_fishing_second_fish_after_the_delay_never_before_min_gap() {
    let mut s = sim();
    s.start(a());
    assert_eq!(s.state(), S::Running);
    assert_eq!(s.names(), ["fish"]);
    assert_eq!((s.sent[0].channel_id.as_str(), s.sent[0].options.is_empty()), ("A", true));
    s.advance(500);
    s.emit_bot(catch3());
    s.advance(FISH_DELAY - 10);
    assert_eq!(s.names(), ["fish"]);
    s.advance(11);
    assert_eq!(s.names(), ["fish", "fish"]);
    // a cooldown of 0 asks for a /fish 0.6 s later: minGap (2.5 s after the last send) still wins
    s.emit_bot(cooldown(0.0));
    s.advance(2498);
    assert_eq!(s.sent.len(), 2);
    s.advance(2);
    assert_eq!(s.sent.len(), 3);
}

#[test]
fn sell_after_n_catches_with_amount_all() {
    let mut s = sim_with(|c| {
        c.sell.enabled = true;
        c.sell.mode = SellMode::Catches;
        c.sell.every = 3.0;
    });
    s.start(a());
    s.emit_bot(catch3());
    s.advance(2500);
    assert_eq!(s.names(), ["fish", "sell"]);
    assert_eq!(s.opt(1, "amount"), Some(json!("all")));
}

#[test]
fn captcha_blocks_everything_nothing_sent_for_10_minutes_never_a_verify() {
    let mut s = sim_with(|c| {
        c.sell.enabled = true;
        c.sell.mode = SellMode::Catches;
        c.sell.every = 1.0;
        c.daily.enabled = true;
        c.quests.enabled = true;
        c.profile.refresh_min = 1.0;
        c.buffs.enabled = true;
        c.breaks.enabled = true;
    });
    s.start(a());
    let before = s.sent.len();
    s.emit_bot(captcha());
    assert_eq!(s.state(), S::Captcha);
    let (st, info) = s.last_state();
    assert_eq!(st, S::Captcha);
    assert_eq!(info.captcha_image_url.as_deref(), Some("https://cdn.example.test/captcha/abc123.png"));
    assert!(info.captcha_text.unwrap().to_lowercase().contains("captcha"));
    // even bot traffic that would normally trigger commands must not
    s.emit_bot(catch3());
    s.emit_bot(cooldown(1.0));
    s.advance(10 * MIN);
    assert_eq!(s.sent.len(), before);
    assert!(!s.names().contains(&"verify".to_string()));
    assert_eq!(s.state(), S::Captcha);
    // pause/resume/manual from the UI cannot escape the captcha
    s.input(EngineInput::Resume);
    s.input(EngineInput::Pause);
    s.manual("fish");
    s.advance(MIN);
    assert_eq!(s.sent.len(), before);
    assert_eq!(s.state(), S::Captcha);
}

#[test]
fn captcha_delivered_via_a_message_edit_also_blocks() {
    let mut s = sim();
    s.start(a());
    s.emit_bot(as_edit(captcha()));
    assert_eq!(s.state(), S::Captcha);
    s.advance(5 * MIN);
    assert_eq!(s.sent.len(), 1);
}

#[test]
fn captcha_resolution_verify_with_the_answer_running_only_after_5_to_15_s() {
    let mut s = sim();
    s.start(a());
    s.emit_bot(captcha()); // non-edit: also answers the in-flight /fish
    s.input(EngineInput::SubmitCaptcha("ABC123".into()));
    s.advance(2500);
    let last = s.sent.last().unwrap();
    assert_eq!((last.channel_id.as_str(), last.name.as_str()), ("A", "verify"));
    assert_eq!(last.options, [("answer".to_string(), json!("ABC123"))].into_iter().collect());

    s.emit_bot(fixture("captcha-failed"));
    assert_eq!(s.state(), S::Captcha);
    s.input(EngineInput::RegenCaptcha);
    s.advance(2500);
    assert_eq!(s.sent.last().unwrap().options["answer"], json!("regen"));

    s.emit_bot(solved());
    s.advance(4_900);
    assert_eq!(s.state(), S::Captcha);
    let n = s.sent.len();
    s.advance(10_200); // rand 0.5 → 10 s
    assert_eq!(s.state(), S::Running);
    s.advance(FISH_DELAY + 100);
    assert!(s.sent.len() > n);
    assert_eq!(s.names().last().unwrap(), "fish");
}

#[test]
fn verify_is_never_retried_and_never_sent_by_the_engine() {
    let mut s = sim();
    s.start(a());
    s.emit_bot(captcha());
    s.input(EngineInput::SubmitCaptcha("ABC".into()));
    s.advance(60 * MIN); // the verify is never answered: it times out, nothing else ever leaves
    assert_eq!(s.names(), ["fish", "verify"]);
    assert_eq!(s.state(), S::Captcha);
}

#[test]
fn a_verify_still_in_flight_after_the_solve_is_never_retried() {
    let mut s = sim();
    s.start(a());
    s.emit_bot(captcha());
    s.input(EngineInput::SubmitCaptcha("ABC".into()));
    s.advance(2_500);
    assert_eq!(s.names(), ["fish", "verify"]);
    // deferred reply to the verify (30 s), and the solve arrives as an edit of another message
    s.emit_bot(BotMessage { loading: true, ..BotMessage::default() });
    s.emit_bot(as_edit(with_id(solved(), "other")));
    s.advance(15_000);
    assert_eq!(s.state(), S::Running); // the verify is still in flight, then times out while running
    s.run(MIN, |c| (c == "fish").then(one_fish));
    assert_eq!(s.count("verify"), 1);
}

#[test]
fn captcha_failed_re_emits_the_captcha_state_with_the_bot_message() {
    let mut s = sim();
    s.start(a());
    s.emit_bot(captcha());
    s.emit_bot(fixture("captcha-failed"));
    let (st, info) = s.last_state();
    assert_eq!(st, S::Captcha);
    assert!(info.captcha_text.unwrap().to_lowercase().contains("incorrect"));
}

#[test]
fn a_new_captcha_while_in_captcha_updates_it_and_cancels_a_pending_resume() {
    let mut s = sim();
    s.start(a());
    s.emit_bot(captcha());
    s.emit_bot(solved());
    s.advance(5_000);
    let mut m = captcha();
    m.embeds = vec![crate::model::Embed { title: Some("Captcha".into()), description: Some("New code".into()), image_url: Some("https://cdn.example.test/2.png".into()), ..Default::default() }];
    s.emit_bot(m);
    assert_eq!(s.last_state().1.captcha_image_url.as_deref(), Some("https://cdn.example.test/2.png"));
    s.advance(MIN);
    assert_eq!(s.state(), S::Captcha);
    assert_eq!(s.sent.len(), 1);
    assert_eq!(s.core.game().snapshot().session.captchas, 1);
}

#[test]
fn submit_and_regen_are_noops_outside_the_captcha_state() {
    let mut s = sim();
    s.start(a());
    s.input(EngineInput::SubmitCaptcha("X".into()));
    s.input(EngineInput::RegenCaptcha);
    s.advance(30_000);
    assert!(!s.names().contains(&"verify".to_string()));
}

#[test]
fn cooldown_next_fish_at_the_earliest_wait_later() {
    let mut s = sim();
    s.start(a());
    s.advance(3000);
    s.emit_bot(cooldown(2.4));
    s.advance(2399);
    assert_eq!(s.names(), ["fish"]);
    s.advance(1000); // + 0.6 s random (rand 0.5 of 0.2–1 s)
    assert_eq!(s.names(), ["fish", "fish"]);
}

#[test]
fn disconnect_pauses_reconnect_resumes_2_min_without_reconnect_is_an_error() {
    let mut s = sim();
    s.start(a());
    s.input(EngineInput::Disconnected);
    assert_eq!(s.state(), S::Paused);
    assert_eq!(reason(&s).as_deref(), Some("network"));
    s.input(EngineInput::Reconnected);
    assert_eq!(s.state(), S::Running);

    s.input(EngineInput::Disconnected);
    s.advance(119_000);
    assert_eq!(s.state(), S::Paused);
    s.advance(1_000);
    assert_eq!(s.state(), S::Error);
    assert!(reason(&s).is_some());
    let n = s.sent.len();
    s.advance(MIN);
    assert_eq!(s.sent.len(), n);
}

#[test]
fn a_user_pause_is_not_lifted_by_a_reconnect() {
    let mut s = sim();
    s.start(a());
    s.input(EngineInput::Pause);
    s.input(EngineInput::Disconnected);
    s.input(EngineInput::Reconnected);
    assert_eq!(s.state(), S::Paused);
}

#[test]
fn three_consecutive_timeouts_pause_no_response() {
    let mut s = sim();
    s.start(a());
    s.advance(8_000);
    assert_eq!(s.state(), S::Running);
    s.advance(FISH_DELAY + 8_000);
    assert_eq!(s.state(), S::Running);
    s.advance(FISH_DELAY + 8_000);
    assert_eq!(s.state(), S::Paused);
    assert_eq!(reason(&s).as_deref(), Some("noResponse"));
    assert_eq!(s.names(), ["fish", "fish", "fish"]);
}

#[test]
fn channel_switch_queue_emptied_and_every_later_command_targets_b() {
    let mut s = sim_with(|c| {
        c.daily.enabled = true;
        c.quests.enabled = true;
    });
    s.start(a());
    assert_eq!(s.sent.iter().map(|x| x.channel_id.as_str()).collect::<Vec<_>>(), ["A"]);
    s.start(b());
    assert_eq!(s.active_channel.as_deref(), Some("B"));
    let mut t = 0;
    while t < 20_000 {
        if s.sent.len() > 1 {
            s.emit_bot(content("ok")); // answer whatever is in flight
        }
        s.advance(500);
        t += 500;
    }
    let after = &s.sent[1..];
    assert!(!after.is_empty());
    assert!(after.iter().all(|x| x.channel_id == "B"));
    assert!(after.iter().any(|x| x.name == "fish"));
}

#[test]
fn missing_fish_is_an_error() {
    let mut s = sim();
    s.commands.retain(|c| c.name != "fish");
    s.start(a());
    assert_eq!(s.state(), S::Error);
    assert_eq!(reason(&s).as_deref(), Some("Command /fish not found in this server"));
    assert!(s.sent.is_empty());
}

#[test]
fn goes_through_connecting_and_lists_available_commands() {
    let mut s = sim();
    s.start(a());
    assert_eq!(s.states().iter().map(|x| x.0).collect::<Vec<_>>(), [S::Connecting, S::Running]);
    assert!(s.core.commands().iter().any(|c| c.name == "verify"));
}

#[test]
fn a_failing_command_load_is_an_error() {
    let mut s = sim();
    s.fail_commands = true;
    s.start(a());
    assert_eq!(s.state(), S::Error);
    assert_eq!(reason(&s).as_deref(), Some("Unable to fetch the Virtual Fisher commands"));
}

#[test]
fn pause_resume_nothing_is_sent_while_paused() {
    let mut s = sim();
    s.start(a());
    s.input(EngineInput::Pause);
    assert_eq!(s.state(), S::Paused);
    s.emit_bot(catch3());
    s.manual("profile");
    s.advance(5 * MIN);
    assert_eq!(s.names(), ["fish"]);
    s.input(EngineInput::Resume);
    assert_eq!(s.state(), S::Running);
    s.advance(0);
    assert_eq!(s.names(), ["fish", "profile"]);
    s.emit_bot(content("Profile"));
    s.advance(FISH_DELAY + 100);
    assert!(s.count("fish") > 1);
}

#[test]
fn human_breaks_resting_then_running_nothing_sent_while_resting() {
    let mut s = sim_with(|c| {
        c.breaks.enabled = true;
        c.breaks.work_min = 2.0;
        c.breaks.work_jitter_min = 1.0;
        c.breaks.rest_min = 3.0;
        c.breaks.rest_jitter_min = 1.0;
    });
    s.start(a());
    let mut answered = 0;
    let answer = |s: &mut Sim, answered: &mut usize| {
        while *answered < s.sent.len() {
            *answered += 1;
            s.emit_bot(one_fish());
        }
    };
    let mut t = 0;
    while t < 119_000 {
        answer(&mut s, &mut answered);
        s.advance(1000);
        t += 1000;
    }
    assert_eq!(s.state(), S::Running);
    answer(&mut s, &mut answered);
    s.advance(1_000); // 2 min of work (rand 0.5 → exactly workMin)
    assert_eq!(s.state(), S::Resting);
    answer(&mut s, &mut answered);
    let n = s.sent.len();
    s.advance(3 * MIN - 1);
    assert_eq!(s.sent.len(), n);
    assert_eq!(s.state(), S::Resting);
    s.advance(1);
    assert_eq!(s.state(), S::Running);
    s.advance(FISH_DELAY + 10);
    assert!(s.sent.len() > n);
}

#[test]
fn session_limit_idle_after_session_limit_hours() {
    let mut s = sim_with(|c| c.session_limit_h = 1.0);
    s.start(a());
    s.advance(59 * MIN);
    assert_ne!(s.state(), S::Idle);
    s.advance(MIN + 25_000); // graceful stop: at most 25 s of /profile + /quests
    assert_eq!(s.state(), S::Idle);
    assert_eq!(s.active_channel.as_deref(), Some("A")); // still listening: manual commands work while idle
}

#[test]
fn insufficient_funds_after_a_buff_buy_no_buff_queued_for_30_min() {
    let mut s = sim_with(buffs);
    s.start(a()); // /boosts first (fish queued); buff timers armed from its reply
    assert_eq!(s.names(), ["boosts"]);
    s.emit_bot(boosts_msg("None"));
    s.advance(0);
    for _ in 0..10 {
        if !buys(&s).is_empty() {
            break;
        }
        s.advance(2500);
    }
    assert_eq!(s.sent.iter().find(|x| x.name == "buy").unwrap().options, [("item".to_string(), json!("fish5m")), ("amount".to_string(), json!(1))].into_iter().collect());
    s.emit_bot(fixture("error-funds")); // answers the fish buff buy
    let count = buys(&s).len();
    // the treasure buy was queued before the error and may still go out; nothing after it
    s.run_with(29 * MIN, 2000, |_| Some(one_fish()));
    assert_eq!(buys(&s)[count..], ["treasure5m".to_string()]);
    // after 30 min buff buys come back
    s.run_with(2 * MIN, 2000, |_| Some(one_fish()));
    assert!(buys(&s).len() > count + 1);
}

#[test]
fn buffs_wait_for_the_boosts_reply_active_fish_boost_means_no_fish_buy_before_it_ends() {
    let mut s = sim_with(buffs);
    s.start(a());
    assert_eq!(s.names().last().unwrap(), "boosts"); // sent first at start
    s.emit_bot(boosts_msg("Fish Boost: 10m"));
    s.run(10 * MIN - 1000, |c| (c != "boosts").then(one_fish));
    assert!(buys(&s).is_empty()); // a buff still active: wait until both are over
    s.run(MIN, |_| Some(one_fish()));
    assert_eq!(buys(&s), ["fish5m", "treasure5m"]);
}

#[test]
fn boosts_reply_with_no_active_boost_buys_5_to_30_s_later_not_before() {
    let mut s = sim_with(buffs);
    s.start(a());
    s.emit_bot(boosts_msg("None"));
    s.run(4_500, |_| Some(one_fish()));
    assert!(buys(&s).is_empty());
    s.run(30_000, |_| Some(one_fish()));
    let mut b = buys(&s);
    b.sort();
    assert_eq!(b, ["fish5m", "treasure5m"]);
}

#[test]
fn no_boosts_command_buffs_armed_by_the_fallback() {
    let mut s = sim_with(buffs);
    s.commands.retain(|c| c.name != "boosts");
    s.start(a());
    s.run(4_500, |_| Some(one_fish()));
    assert!(buys(&s).is_empty());
    s.run(30_000, |_| Some(one_fish()));
    assert_eq!(buys(&s).len(), 2);
}

#[test]
fn a_boosts_that_never_answers_even_retried_falls_back_to_buying() {
    let mut s = sim_with(buffs);
    s.start(a());
    s.run(MIN, |c| (c != "boosts").then(one_fish));
    let first_buy = s.sent.iter().position(|x| x.name == "buy").unwrap();
    assert_eq!(s.sent[..first_buy].iter().filter(|x| x.name == "boosts").count(), 2); // + its retry
    assert_eq!(buys(&s).len(), 2);
}

#[test]
fn boosts_answered_by_an_unknown_message_buys_5_to_30_s_later() {
    let mut s = sim_with(buffs);
    s.start(a());
    assert_eq!(s.names().last().unwrap(), "boosts");
    s.emit_bot(content("Something the parser does not know"));
    s.run(4_500, |_| Some(one_fish()));
    assert!(buys(&s).is_empty());
    s.run(30_000, |_| Some(one_fish()));
    assert_eq!(buys(&s).len(), 2);
}

fn boosts_none_or_fish(c: &str) -> Option<BotMessage> {
    Some(if c == "boosts" { boosts_msg("None") } else { one_fish() })
}

#[test]
fn captcha_replying_to_an_in_flight_boosts_re_requests_after_resume() {
    let mut s = sim_with(buffs);
    s.start(a());
    assert_eq!(s.names().last().unwrap(), "boosts");
    s.emit_bot(captcha()); // the reply to /boosts is the captcha
    let n = s.sent.len();
    s.advance(10 * MIN);
    assert_eq!(s.sent.len(), n); // safety: still nothing during the captcha
    s.emit_bot(solved());
    s.advance(10_000);
    assert_eq!(s.state(), S::Running);
    s.run(MIN, boosts_none_or_fish);
    let after = &s.sent[n..];
    let first_buy = after.iter().position(|x| x.name == "buy").unwrap();
    assert_eq!(after[..first_buy].iter().filter(|x| x.name == "boosts").count(), 1); // one fresh check
    assert_eq!(buys(&s).len(), 2);
}

#[test]
fn captcha_via_edit_while_boosts_is_in_flight_re_requests_after_resume() {
    let mut s = sim_with(buffs);
    s.start(a()); // /boosts in flight
    s.emit_bot(as_edit(captcha()));
    let n = s.sent.len();
    s.advance(5 * MIN); // the in-flight /boosts times out during the captcha
    assert_eq!(s.sent.len(), n);
    s.emit_bot(solved());
    s.advance(10_000);
    s.run(MIN, boosts_none_or_fish);
    let after = &s.sent[n..];
    let first_buy = after.iter().position(|x| x.name == "buy").unwrap();
    assert_eq!(after[..first_buy].iter().filter(|x| x.name == "boosts").count(), 1);
    assert_eq!(buys(&s).len(), 2);
}

#[test]
fn a_retry_copy_of_daily_dropped_by_a_captcha_is_sent_after_the_resume() {
    let mut s = sim_with(|c| c.daily.enabled = true);
    s.start(a());
    assert_eq!(s.names().last().unwrap(), "daily"); // data first, fish queued
    s.input(EngineInput::RateLimited(30_000)); // keeps the retry copy waiting in the queue
    s.advance(8_500); // daily times out → retry copy queued, held by the rate limit
    assert_eq!(s.count("daily"), 1);
    s.emit_bot(as_edit(captcha()));
    let n = s.sent.len();
    s.advance(10 * MIN);
    assert_eq!(s.sent.len(), n);
    s.emit_bot(solved());
    s.advance(10_000);
    s.run(40_000, |_| Some(one_fish()));
    assert_eq!(s.count("daily"), 2);
}

#[test]
fn a_timed_out_maintenance_command_is_re_sent_once_then_not_again() {
    let mut s = sim_with(|c| c.daily.enabled = true);
    s.start(a());
    s.run(MIN, |c| (c != "daily").then(one_fish));
    assert_eq!(s.count("daily"), 2);
}

#[test]
fn a_daily_answered_by_a_captcha_is_sent_again_after_the_resume() {
    let mut s = sim_with(|c| c.daily.enabled = true);
    s.start(a()); // daily in flight, fish queued
    assert_eq!(s.names(), ["daily"]);
    s.emit_bot(captcha()); // answers the daily, queue cleared (fish dropped)
    s.advance(MIN);
    assert_eq!(s.names(), ["daily"]);
    s.emit_bot(solved());
    s.advance(10_000);
    assert_eq!(s.state(), S::Running);
    s.run(40_000, |_| Some(one_fish()));
    assert_eq!(s.count("daily"), 2);
}

#[test]
fn start_b_during_a_captcha_is_refused_and_keeps_the_captcha() {
    let mut s = sim();
    s.start(a());
    s.emit_bot(captcha());
    s.start(b());
    assert_eq!(s.state(), S::Captcha);
    assert_eq!(s.active_channel.as_deref(), Some("A"));
    assert!(!s.logs(LogLevel::Warn).is_empty());
    s.advance(MIN);
    assert_eq!(s.sent.len(), 1);
}

#[test]
fn rate_limit_nothing_sent_during_retry_after_then_min_gap_x_1_5_for_5_min() {
    let mut s = sim();
    s.start(a());
    s.input(EngineInput::RateLimited(5000));
    s.emit_bot(cooldown(0.0)); // fish wanted ≈ 0.6 s later
    s.advance(4999);
    assert_eq!(s.sent.len(), 1);
    s.advance(2);
    assert_eq!(s.sent.len(), 2);
    s.emit_bot(cooldown(0.0));
    s.advance(3748); // 2.5 s × 1.5 = 3.75 s after the send at t = 5 s
    assert_eq!(s.sent.len(), 2);
    s.advance(2);
    assert_eq!(s.sent.len(), 3);
}

#[test]
fn exceptions_in_handlers_pause_the_engine_instead_of_throwing() {
    let mut s = sim();
    s.start(a());
    s.core.panic_on_route = true;
    s.emit_bot(catch3());
    assert_eq!(s.state(), S::Paused);
    assert_eq!(reason(&s).as_deref(), Some("exception"));
    assert!(!s.logs(LogLevel::Error).is_empty());
    // the answered command was released: Resume fishes again without waiting for its timeout
    let sent = s.sent.len();
    s.input(EngineInput::Resume);
    s.advance(3100);
    assert!(s.sent.len() > sent);
}

#[test]
fn session_end_delivers_the_summary_once_on_stop() {
    let mut s = sim();
    s.start(a());
    s.emit_bot(catch3());
    s.stop(false);
    s.stop(false);
    let ends = s.session_ends();
    assert_eq!(ends.len(), 1);
    assert_eq!(ends[0].session.catches, 3);
    assert!(ends[0].ended_at > 0);
    // the finished session stays visible until the next start
    assert_eq!(s.core.game().snapshot().session.catches, 3);
}

#[test]
fn stop_is_idle_and_nothing_else_is_sent() {
    let mut s = sim();
    s.start(a());
    s.stop(false);
    assert_eq!(s.state(), S::Idle);
    assert_eq!(s.active_channel.as_deref(), Some("A"));
    s.advance(MIN);
    assert_eq!(s.names(), ["fish"]);
}

#[test]
fn profile_refresh_after_a_sell() {
    let mut s = sim();
    s.start(a());
    s.emit_bot(fixture("sell"));
    s.advance(2500);
    assert_eq!(s.names(), ["fish", "profile"]);
}

// ---- cooldown replies -------------------------------------------------------------------

#[test]
fn a_daily_answered_wait_20h_leaves_fishing_alone_and_re_arms_the_daily() {
    let mut s = sim_with(|c| c.daily.enabled = true);
    s.auto_reply(|c, _| Some(if c == "daily" { content("You already claimed your daily reward, please wait 20h 12m.") } else { one_fish() }));
    s.start(a());
    s.advance(MIN);
    assert_eq!(s.count("daily"), 1);
    // fishing kept its normal pace (≈ every 3 s), it was not pushed back by the daily's cooldown
    assert!(s.count("fish") >= 15);
    assert_eq!(s.state(), S::Running);
    assert!(s.logs(LogLevel::Info).iter().any(|l| l.contains("/daily on cooldown")));

    s.cfg.fishing.base_cooldown_sec = 600.0; // fewer fish over the next 20 h
    let rearm_at = (20 * 60 + 12) * MIN + 180_000; // daily sent at 0 s; + wait + 3 min (rand 0.5 of 1–5)
    s.advance(rearm_at - MIN - 30_000);
    assert_eq!(s.count("daily"), 1);
    s.advance(MIN);
    assert_eq!(s.count("daily"), 2);
}

#[test]
fn a_short_wait_on_a_maintenance_command_re_sends_it_once_then_re_arms_its_slot() {
    let mut s = sim_with(|c| c.quests.enabled = true);
    let mut quest_replies = 0;
    s.auto_reply(move |c, _| {
        Some(if c == "quests" {
            quest_replies += 1;
            if quest_replies <= 2 {
                content("Please wait 30 more seconds")
            } else {
                content("ok")
            }
        } else {
            one_fish()
        })
    });
    s.start(a());
    s.advance(5_000);
    assert_eq!(s.count("quests"), 1);
    s.advance(25_000);
    assert_eq!(s.count("quests"), 1);
    s.advance(10_000);
    assert_eq!(s.count("quests"), 2);
    // the copy got "wait 30" again: not deferred a second time, the slot is re-armed 30 s + 3 min later
    s.advance(200_000 - 40_000);
    assert_eq!(s.count("quests"), 2);
    s.advance(MIN);
    assert_eq!(s.count("quests"), 3);
}

#[test]
fn a_fish_cooldown_with_no_reply_target_right_after_a_fish_still_reschedules() {
    let mut s = sim();
    s.start(a());
    s.emit_bot(one_fish());
    s.advance(FISH_DELAY + 10);
    assert_eq!(s.names(), ["fish", "fish"]);
    s.emit_bot(one_fish());
    s.emit_bot(as_edit(cooldown(20.0))); // …until the reply is edited into a cooldown (no reply target)
    s.advance(19_000);
    assert_eq!(s.names(), ["fish", "fish"]);
    s.advance(2_000);
    assert_eq!(s.names(), ["fish", "fish", "fish"]);
}

// ---- message edits --------------------------------------------------------------------------

#[test]
fn an_edited_catch_is_not_counted_twice() {
    let mut s = sim();
    s.start(a());
    s.emit_bot(with_id(catch3(), "x1"));
    assert_eq!(s.core.game().snapshot().session.catches, 3);
    s.emit_bot(as_edit(with_id(catch3(), "x1")));
    assert_eq!(s.core.game().snapshot().session.catches, 3);
    s.emit_bot(as_edit(with_id(one_fish(), "x1"))); // changed text, still a catch
    let snap = s.core.game().snapshot();
    assert_eq!(snap.session.catches, 3);
    assert_eq!(snap.log.iter().filter(|l| l.kind == LogType::Catch).count(), 1);
}

#[test]
fn an_edit_of_an_already_solved_captcha_does_not_re_enter_the_captcha() {
    let mut s = sim();
    s.start(a());
    s.emit_bot(with_id(captcha(), "cap1"));
    s.emit_bot(solved());
    s.advance(15_000);
    assert_eq!(s.state(), S::Running);
    s.emit_bot(as_edit(with_id(captcha(), "cap1")));
    let mut expired = as_edit(with_id(captcha(), "cap1"));
    expired.embeds = vec![crate::model::Embed { title: Some("Captcha".into()), description: Some("Use /verify (expired)".into()), ..Default::default() }];
    s.emit_bot(expired);
    assert_eq!(s.state(), S::Running);
}

#[test]
fn a_captcha_arriving_as_an_edit_of_the_fish_reply_still_enters_the_captcha() {
    let mut s = sim();
    s.start(a());
    s.emit_bot(with_id(one_fish(), "f1"));
    s.emit_bot(as_edit(with_id(captcha(), "f1")));
    assert_eq!(s.state(), S::Captcha);
    assert_eq!(s.core.game().snapshot().session.captchas, 1);
}

// ---- leaving a captcha ----------------------------------------------------------------------

#[test]
fn a_captcha_while_user_paused_goes_back_to_paused_once_solved() {
    let mut s = sim();
    s.start(a());
    s.input(EngineInput::Pause);
    s.emit_bot(captcha());
    assert_eq!(s.state(), S::Captcha);
    s.emit_bot(solved());
    s.advance(15_000);
    assert_eq!(s.state(), S::Paused);
    assert_eq!(reason(&s).as_deref(), Some("user"));
    s.advance(MIN);
    assert_eq!(s.names(), ["fish"]);
    s.input(EngineInput::Resume);
    assert_eq!(s.state(), S::Running);
    s.advance(FISH_DELAY + 100);
    assert_eq!(s.names(), ["fish", "fish"]);
}

#[test]
fn network_paused_stays_paused_after_the_captcha_a_reconnect_during_it_runs() {
    let mut s = sim();
    s.start(a());
    s.input(EngineInput::Disconnected);
    s.emit_bot(captcha());
    s.emit_bot(solved());
    s.advance(15_000);
    assert_eq!(s.state(), S::Paused);
    assert_eq!(reason(&s).as_deref(), Some("network"));
    s.input(EngineInput::Reconnected);
    assert_eq!(s.state(), S::Running);

    let mut s = sim();
    s.start(a());
    s.emit_bot(captcha());
    s.input(EngineInput::Disconnected);
    s.input(EngineInput::Reconnected);
    s.emit_bot(solved());
    s.advance(15_000);
    assert_eq!(s.state(), S::Running);
}

#[test]
fn the_solved_answer_is_reported_and_verify_is_refused_afterwards() {
    let mut s = sim();
    s.start(a());
    s.emit_bot(captcha());
    s.emit_bot(solved());
    assert_eq!(s.state(), S::Captcha);
    let info = s.last_state().1;
    assert_eq!(info.captcha_solved, Some(true));
    assert!(info.captcha_text.unwrap().contains("solved"));
    assert_eq!(s.core.info().captcha_solved, Some(true));
    s.input(EngineInput::SubmitCaptcha("again".into()));
    s.advance(3_000);
    assert!(!s.names().contains(&"verify".to_string()));
}

#[test]
fn stop_during_a_captcha_is_idle_nothing_sent() {
    let mut s = sim();
    s.start(a());
    s.emit_bot(captcha());
    s.stop(false);
    assert_eq!(s.state(), S::Idle);
    s.advance(MIN);
    assert_eq!(s.names(), ["fish"]);
}

#[test]
fn captcha_show_and_hide_effects_follow_the_state() {
    use super::core::Effect;
    let mut s = sim();
    s.start(a());
    s.emit_bot(captcha());
    assert!(s.effects.iter().any(|e| matches!(e, Effect::CaptchaShow(p) if p.image_url.as_deref() == Some("https://cdn.example.test/captcha/abc123.png"))));
    assert!(s.core.status().captcha.is_some());
    s.emit_bot(solved());
    s.advance(15_000);
    assert!(matches!(s.effects.iter().rev().find(|e| matches!(e, Effect::CaptchaShow(_) | Effect::CaptchaHide)), Some(Effect::CaptchaHide)));
    assert!(s.core.status().captcha.is_none());
}

// ---- graceful stop ----------------------------------------------------------------------------

#[test]
fn graceful_stop_sends_profile_then_quests_and_ends_idle_once_both_answered() {
    let mut s = sim();
    s.auto_reply(|c, _| graceful_reply(c));
    s.start(a());
    s.advance(10_000);
    let before = s.sent.len();
    assert!(s.names().iter().all(|n| n == "fish"));

    s.stop(true);
    assert_eq!(s.state(), S::Stopping);
    assert_eq!(s.core.game().snapshot().next_fish_at, None);
    s.advance(10_000);
    assert_eq!(s.names()[before..], ["profile", "quests"]);
    assert_eq!(s.state(), S::Idle);
    assert_eq!(s.last_state(), (S::Idle, Default::default()));
    let snap = s.core.game().snapshot();
    assert_eq!(snap.account.fish_value, Some(500));
    assert_eq!(snap.quests.len(), 1);
    assert_eq!(s.active_channel.as_deref(), Some("A"));
    s.advance(MIN);
    assert_eq!(s.names()[before..], ["profile", "quests"]);
}

#[test]
fn graceful_without_answers_no_retry_idle_within_25_s() {
    let mut s = sim();
    s.start(a()); // /fish in flight, never answered: profile at 8 s, quests at 16 s
    s.stop(true);
    s.advance(23_000);
    assert_eq!(s.state(), S::Stopping);
    s.advance(2_000);
    assert_eq!(s.state(), S::Idle);
    assert_eq!(s.names(), ["fish", "profile", "quests"]);
    s.advance(MIN);
    assert_eq!(s.sent.len(), 3);
}

#[test]
fn the_whole_graceful_stop_is_capped_at_25_s() {
    let mut s = sim();
    s.auto_reply(fish_only);
    s.start(a());
    s.advance(1_000);
    s.stop(true);
    s.input(EngineInput::RateLimited(60_000)); // nothing can leave before the cap
    s.advance(24_900);
    assert_eq!(s.state(), S::Stopping);
    s.advance(200);
    assert_eq!(s.state(), S::Idle);
    s.advance(MIN);
    assert_eq!(s.names(), ["fish"]);
}

#[test]
fn graceful_timeouts_move_on_without_retrying() {
    let mut s = sim();
    s.auto_reply(fish_only);
    s.start(a());
    s.advance(1_000);
    s.stop(true);
    s.advance(2_000 + 8_000 + 2_500);
    assert_eq!(s.names(), ["fish", "profile", "quests"]);
    s.advance(8_000);
    assert_eq!(s.state(), S::Idle);
    assert_eq!(s.names(), ["fish", "profile", "quests"]);
}

#[test]
fn a_second_stop_while_stopping_halts_immediately() {
    let mut s = sim();
    s.auto_reply(fish_only);
    s.start(a());
    s.advance(1_000);
    s.stop(true);
    assert_eq!(s.state(), S::Stopping);
    s.stop(true);
    assert_eq!(s.state(), S::Idle);
    s.advance(30_000);
    assert_eq!(s.names(), ["fish"]);
}

#[test]
fn graceful_with_no_command_to_refresh_halts_immediately() {
    let mut s = sim();
    s.commands.retain(|c| c.name != "profile" && c.name != "quests");
    s.start(a());
    s.stop(true);
    assert_eq!(s.state(), S::Idle);
}

#[test]
fn the_session_limit_stops_gracefully_with_its_reason() {
    let mut s = sim_with(|c| c.session_limit_h = 1.0);
    s.auto_reply(|c, _| graceful_reply(c));
    s.start(a());
    s.advance(60 * MIN + 15_000);
    assert!(s.states().iter().any(|x| x.0 == S::Stopping));
    assert_eq!(s.state(), S::Idle);
    assert_eq!(reason(&s).as_deref(), Some("Session limit reached"));
    assert_eq!(s.names()[s.sent.len() - 2..], ["profile", "quests"]);
}

#[test]
fn captcha_during_stopping_frozen_only_the_user_verify_then_the_stop_resumes() {
    let mut s = sim();
    s.auto_reply(fish_only);
    s.start(a());
    s.advance(1_000);
    s.stop(true);
    s.advance(2_000); // profile sent at 2.5 s
    assert_eq!(s.names(), ["fish", "profile"]);
    s.emit_bot(captcha()); // answers the profile with a captcha
    assert_eq!(s.state(), S::Captcha);
    s.advance(5 * MIN); // the 25 s budget is frozen during the captcha
    assert_eq!(s.state(), S::Captcha);
    assert_eq!(s.names(), ["fish", "profile"]);

    s.input(EngineInput::SubmitCaptcha("ABC".into()));
    s.advance(3_000);
    assert_eq!(s.names(), ["fish", "profile", "verify"]);
    s.emit_bot(solved());
    s.advance(10_100); // resume after 10 s (rand 0.5)
    assert_eq!(s.state(), S::Stopping);
    s.advance(3_000);
    assert_eq!(s.names()[3..], ["profile"]); // the unanswered /profile is sent again
    s.emit_bot(profile_reply());
    s.advance(3_000);
    assert_eq!(s.names()[3..], ["profile", "quests"]);
    s.emit_bot(quests_reply());
    assert_eq!(s.state(), S::Idle);
    assert_eq!(s.count("fish"), 1);
}

#[test]
fn stop_fishing_during_a_captcha_in_stopping_halts_at_once() {
    let mut s = sim();
    s.auto_reply(fish_only);
    s.start(a());
    s.advance(1_000);
    s.stop(true);
    s.emit_bot(captcha());
    assert_eq!(s.state(), S::Captcha);
    s.stop(false);
    assert_eq!(s.state(), S::Idle);
    s.advance(MIN);
    assert_eq!(s.names(), ["fish"]);
}

#[test]
fn hard_stop_stays_immediate() {
    let mut s = sim();
    s.auto_reply(|c, _| graceful_reply(c));
    s.start(a());
    s.advance(5_000);
    let n = s.sent.len();
    s.stop(false);
    assert_eq!(s.state(), S::Idle);
    s.advance(MIN);
    assert_eq!(s.sent.len(), n);
}

// ---- real captures ----------------------------------------------------------------------------

#[test]
fn a_catch_completing_a_quest_refreshes_quests() {
    let mut s = sim();
    s.start(a());
    s.emit_bot(real("catch-levelup-quest"));
    s.advance(2_500);
    assert_eq!(s.names(), ["fish", "quests"]);
    let snap = s.core.game().snapshot();
    assert!(snap.log.iter().any(|l| l.highlight == Some(true) && l.text == "Quest completed: Daily Level-ups Tier 3"));
    assert_eq!(snap.session.rare_caught.gold, 6);
}

#[test]
fn daily_reward_on_cooldown_sets_next_daily_at_and_leaves_fishing_alone() {
    let mut s = sim_with(|c| c.daily.enabled = true);
    s.auto_reply(|c, _| Some(if c == "daily" { real("daily-cooldown") } else { one_fish() }));
    let t0 = s.now;
    s.start(a());
    s.advance(10_000);
    assert_eq!(s.count("daily"), 1);
    let wait = ((10 * 60 + 20) * 60 + 25) * 1000;
    let next = s.core.game().next_daily_at().unwrap();
    assert!(next >= t0 + wait && next <= t0 + 10_000 + wait);
    assert_eq!(s.state(), S::Running);
    assert!(s.count("fish") >= 2);
}

#[test]
fn another_player_editing_our_catch_is_never_logged_nor_counted() {
    let mut s = sim();
    s.start(a());
    s.emit_bot(real("catch-before-edit"));
    let after = s.core.game().snapshot();
    assert_eq!(after.session.catches, 18);
    s.emit_bot(real("edit-other-player"));
    let now = s.core.game().snapshot();
    assert_eq!(now.session, after.session);
    assert_eq!(now.log, after.log);
}

#[test]
fn such_an_edit_of_a_message_we_never_saw_is_dropped_too() {
    let mut s = sim();
    s.start(a());
    let log_len = s.core.game().snapshot().log.len();
    s.emit_bot(real("edit-other-player"));
    assert_eq!(s.core.game().snapshot().log.len(), log_len);
    assert_eq!(s.state(), S::Running);
}

// ---- manual commands without a session (idle) ---------------------------------------------------

fn with_target(c: &mut Config) {
    c.target = Some(target("g1", "A"));
}

#[test]
fn idle_profile_sent_to_the_target_inventory_applied_no_fishing_ever_starts() {
    let mut s = sim_with(with_target);
    s.manual("profile");
    assert_eq!(s.active_channel.as_deref(), Some("A"));
    assert_eq!(s.names(), ["profile"]);
    assert_eq!(s.sent[0].channel_id, "A");
    assert!(s.emitted_commands().last().unwrap().contains(&"profile".to_string()));
    assert!(s.core.commands().iter().any(|c| c.name == "fish"));

    s.emit_bot(profile_reply());
    let snap = s.core.game().snapshot();
    assert_eq!(snap.account.fish_value, Some(500));
    assert_eq!(snap.session.started_at, None); // no session started
    s.advance(10 * MIN);
    assert_eq!(s.names(), ["profile"]);
    assert_eq!(s.state(), S::Idle);
    assert!(s.states().is_empty());
    assert_eq!(s.core.game().snapshot().next_fish_at, None);
}

#[test]
fn manual_commands_while_idle_go_through_the_queue_and_a_manual_fish_schedules_nothing() {
    let mut s = sim_with(with_target);
    s.manual("fish");
    s.manual("quests");
    assert_eq!(s.names(), ["fish"]); // waits for the reply / min gap
    s.emit_bot(one_fish());
    assert_eq!(s.core.game().snapshot().session.catches, 1);
    s.advance(2_499);
    assert_eq!(s.names(), ["fish"]);
    s.advance(2);
    assert_eq!(s.names(), ["fish", "quests"]);
    s.emit_bot(quests_reply());
    assert_eq!(s.core.game().snapshot().quests.len(), 1);
    s.advance(10 * MIN);
    assert_eq!(s.names(), ["fish", "quests"]);
    assert_eq!(s.state(), S::Idle);
}

#[test]
fn an_unanswered_manual_command_times_out_without_retry_or_pause() {
    let mut s = sim_with(with_target);
    s.manual("profile");
    s.manual("quests");
    s.advance(8_000);
    assert_eq!(s.names(), ["profile", "quests"]);
    s.advance(10 * MIN);
    assert_eq!(s.names(), ["profile", "quests"]);
    assert_eq!(s.state(), S::Idle);
}

#[test]
fn manual_works_after_a_stop_and_in_error_and_is_refused_without_a_target() {
    let mut s = sim_with(with_target);
    s.start(a());
    s.stop(false);
    assert_eq!(s.active_channel.as_deref(), Some("A"));
    s.manual("profile");
    s.advance(3_000);
    assert_eq!(s.names(), ["fish", "profile"]);

    let mut s = sim_with(with_target);
    s.commands.retain(|c| c.name != "fish");
    s.start(a());
    assert_eq!(s.state(), S::Error);
    s.manual("profile");
    assert_eq!(s.names(), ["profile"]);
    assert_eq!(s.sent[0].channel_id, "A");

    let mut s = sim();
    s.manual("profile");
    assert!(s.sent.is_empty());
    assert!(s.toasts().iter().any(|t| t.message == NO_CHANNEL));
}

#[test]
fn a_daily_cooldown_answering_a_manual_daily_sets_next_daily_at_nothing_re_sent() {
    let mut s = sim_with(with_target);
    let t0 = s.now;
    s.manual("daily");
    s.emit_bot(real("daily-cooldown"));
    let wait = ((10 * 60 + 20) * 60 + 25) * 1000;
    let next = s.core.game().next_daily_at().unwrap();
    assert!(next >= t0 + wait && next <= t0 + wait + 1_000);
    s.advance(15 * MIN);
    assert_eq!(s.names(), ["daily"]);
}

#[test]
fn use_target_loads_the_commands_once_per_guild_emits_them_and_listens() {
    let mut s = sim();
    s.input(EngineInput::UseTarget { target: a() });
    assert_eq!(s.active_channel.as_deref(), Some("A"));
    assert_eq!(s.emitted_commands().iter().map(Vec::len).collect::<Vec<_>>(), [s.commands.len()]);
    s.input(EngineInput::UseTarget { target: b() }); // same guild: cached
    assert_eq!(s.active_channel.as_deref(), Some("B"));
    assert_eq!(s.commands_calls, ["g1"]);
    assert_eq!(s.emitted_commands().len(), 2);
    s.input(EngineInput::UseTarget { target: target("g2", "C") });
    assert_eq!(s.commands_calls, ["g1", "g2"]);

    s.fail_commands = true;
    s.input(EngineInput::UseTarget { target: target("g3", "D") });
    assert!(s.toasts().iter().any(|t| t.message.to_lowercase().contains("commands")));
    assert_eq!(s.emitted_commands().last().unwrap().len(), 0); // buttons: "Command unavailable"
    assert!(s.core.commands().is_empty());
}

#[test]
fn detach_forgets_the_target_nulls_the_channel_and_empties_the_commands() {
    let mut s = sim();
    s.input(EngineInput::UseTarget { target: a() });
    let n = s.emitted_commands().len();
    s.input(EngineInput::Detach);
    assert_eq!(s.active_channel, None);
    assert_eq!(s.emitted_commands()[n..], [Vec::<String>::new()]);
    assert_eq!(s.state(), S::Idle);
}

#[test]
fn captcha_answering_an_idle_manual_command_only_the_user_verify_back_to_idle() {
    let mut s = sim_with(with_target);
    s.manual("profile");
    s.emit_bot(captcha());
    assert_eq!(s.state(), S::Captcha);
    assert_eq!(s.core.game().snapshot().session.captchas, 1);
    s.manual("profile"); // refused
    s.advance(5 * MIN);
    assert_eq!(s.names(), ["profile"]);

    s.input(EngineInput::SubmitCaptcha("ABC".into()));
    s.advance(3_000);
    assert_eq!(s.names(), ["profile", "verify"]);
    s.emit_bot(solved());
    assert_eq!(s.state(), S::Captcha);
    s.advance(15_100);
    assert_eq!(s.state(), S::Idle);
    assert_eq!(s.last_state(), (S::Idle, Default::default()));
    s.advance(10 * MIN);
    assert_eq!(s.names(), ["profile", "verify"]); // never fishes on its own

    s.manual("quests"); // manual mode works again afterwards
    s.advance(3_000);
    assert_eq!(s.names(), ["profile", "verify", "quests"]);
}

#[test]
fn a_captcha_from_idle_stays_idle_after_the_solve_even_if_the_connection_dropped() {
    let mut s = sim_with(with_target);
    s.manual("profile");
    s.emit_bot(captcha());
    s.input(EngineInput::Disconnected);
    s.emit_bot(solved());
    s.advance(15_100);
    assert_eq!(s.state(), S::Idle);
    s.advance(5 * MIN);
    assert_eq!(s.state(), S::Idle);
    assert_eq!(s.names(), ["profile"]);
}

#[test]
fn stop_fishing_from_a_captcha_entered_while_idle_is_idle_nothing_sent() {
    let mut s = sim_with(with_target);
    s.manual("profile");
    s.emit_bot(captcha());
    s.stop(false);
    assert_eq!(s.state(), S::Idle);
    s.advance(5 * MIN);
    assert_eq!(s.names(), ["profile"]);
}

#[test]
fn manual_commands_are_refused_while_stopping_and_connecting() {
    let mut s = sim_with(with_target);
    s.start(a());
    s.stop(true);
    assert_eq!(s.state(), S::Stopping);
    s.manual("daily");
    s.advance(30_000);
    assert!(!s.names().contains(&"daily".to_string()));

    let mut s = sim_with(with_target);
    s.hold_loads = true;
    s.start(a());
    assert_eq!(s.state(), S::Connecting);
    s.manual("daily");
    s.release_loads();
    assert_eq!(s.state(), S::Running);
    s.advance(30_000);
    assert!(!s.names().contains(&"daily".to_string()));
}

#[test]
fn a_captcha_while_connecting_keeps_everything_frozen_once_loaded() {
    let mut s = sim_with(with_target);
    s.input(EngineInput::UseTarget { target: a() }); // listening to A
    s.hold_loads = true;
    s.start(b());
    s.emit_bot(captcha());
    assert_eq!(s.state(), S::Captcha);
    s.release_loads();
    assert_eq!(s.state(), S::Captcha);
    s.advance(10 * MIN);
    assert!(s.sent.is_empty());
}

// ---- deferred replies ("Virtual Fisher is thinking…") -------------------------------------------

fn loading() -> BotMessage {
    BotMessage { id: "d1".into(), loading: true, ..BotMessage::default() }
}
fn captcha_edit() -> BotMessage {
    as_edit(with_id(embed("Player One", "### Anti-bot\n/verify <result>\nCode: **uVU6**"), "d1"))
}

#[test]
fn a_deferred_fish_blocks_other_fish_while_thinking_then_the_captcha_freezes() {
    let mut s = sim();
    s.start(a());
    assert_eq!(s.count("fish"), 1);
    s.emit_bot(loading());
    s.advance(20_000); // longer than the fish delay and the normal 8 s timeout
    assert_eq!(s.count("fish"), 1);
    s.emit_bot(captcha_edit());
    s.advance(0);
    assert_eq!(s.state(), S::Captcha);
    s.advance(5 * MIN);
    assert_eq!(s.count("fish"), 1);
}

#[test]
fn the_edit_carrying_the_catch_answers_the_fish_exactly_one_next_fish() {
    let mut s = sim();
    s.start(a());
    s.emit_bot(loading());
    s.advance(4_000);
    s.emit_bot(as_edit(with_id(one_fish(), "d1")));
    s.advance(4_000);
    assert_eq!(s.count("fish"), 2);
    s.advance(10_000); // the second /fish is unanswered: still waiting, no burst
    assert_eq!(s.count("fish"), 2);
}

#[test]
fn a_reminder_keeps_the_actual_captcha_code_on_screen() {
    let mut s = sim();
    s.start(a());
    let mut first = captcha_edit();
    first.is_edit = false;
    first.id = "c1".into();
    s.emit_bot(first);
    s.emit_bot(with_id(embed("Player One", "To continue, solve the captcha posted above with the **/verify** command."), "r1"));
    assert_eq!(s.state(), S::Captcha);
    assert!(s.last_state().1.captcha_text.unwrap().contains("uVU6"));
}

#[test]
fn a_deferred_reply_that_never_completes_times_out_after_30_s() {
    let mut s = sim();
    s.start(a());
    s.emit_bot(loading());
    s.advance(25_000);
    assert_eq!(s.count("fish"), 1);
    s.advance(10_000);
    assert_eq!(s.count("fish"), 2);
}

// ---- boosters / daily (engine-level cases) ---------------------------------------------------------

#[test]
fn boosters_captcha_nothing_but_a_user_verify_the_booster_flow_waits() {
    let mut s = sim_with(|c| c.boosters.auto_personal = true);
    s.commands = default_commands();
    s.commands.push(crate::model::SlashCommandInfo { name: "boosters".into(), id: "cmd-20".into(), version: "v20".into(), options: vec![] });
    s.commands.push(crate::model::SlashCommandInfo {
        name: "use".into(),
        id: "cmd-21".into(),
        version: "v21".into(),
        options: vec![crate::model::SlashOption { name: "type".into(), kind: 3, required: true, choices: Some(vec!["personal".into(), "global".into()]), choice_names: None }],
    });
    s.auto_reply(|c, _| (c == "boosts").then(|| embed("Captcha", "Please complete this captcha: /verify <code>")));
    s.start(a());
    s.advance(0);
    assert_eq!(s.state(), S::Captcha);
    let n = s.sent.len();
    s.advance(30 * MIN);
    assert_eq!(s.sent.len(), n);
    assert!(!s.names().contains(&"use".to_string()));
    assert!(!s.names().contains(&"verify".to_string()));
}

fn daily_sim(hydrated: Option<i64>, patch: impl FnOnce(&mut Config)) -> Sim {
    let mut s = sim_with(|c| {
        c.daily.enabled = true;
        patch(c);
    });
    if let Some(next) = hydrated {
        let now = s.now;
        s.core.hydrate(&PersistedState { next_daily_at: Some(next), ..Default::default() }, now);
    }
    s.auto_reply(|c, _| {
        Some(match c {
            "daily" => content("You claimed your daily reward: $5,000!"),
            "profile" => embed("Inventory of Player One", "Balance: $2,000\nFish Value: $500\nLevel 12 - 100/200 XP to next level"),
            _ => one_fish(),
        })
    });
    s
}

#[test]
fn unknown_next_daily_at_daily_at_start_success_next_one_24_h_later() {
    let mut s = daily_sim(None, |c| c.fishing.base_cooldown_sec = 3600.0);
    let t0 = s.now;
    s.start(a());
    assert_eq!(s.names(), ["daily"]);
    s.advance(5_000);
    assert!(s.core.game().next_daily_at().unwrap() >= t0 + 24 * H);
    s.advance(23 * H);
    assert_eq!(s.count("daily"), 1);
    s.advance(H + 15 * MIN);
    assert_eq!(s.count("daily"), 2);
}

#[test]
fn next_daily_at_in_the_past_daily_at_start() {
    let t = T0 - 1;
    let mut s = daily_sim(Some(t), |_| {});
    s.start(a());
    assert_eq!(s.names(), ["daily"]);
}

#[test]
fn next_daily_at_in_3_h_no_daily_at_start_sent_once_after_it() {
    let mut s = daily_sim(Some(T0 + 3 * H), |_| {});
    s.start(a());
    assert_eq!(s.names(), ["fish"]);
    s.advance(3 * H);
    assert_eq!(s.count("daily"), 0);
    s.advance(5 * MIN); // rand 0.5 → 3 min after nextDailyAt
    assert_eq!(s.count("daily"), 1);
}

#[test]
fn a_session_that_ends_before_next_daily_at_never_sends_daily() {
    let mut s = daily_sim(Some(T0 + 2 * H), |_| {});
    s.start(a());
    s.advance(H);
    s.stop(false);
    s.advance(3 * H);
    assert_eq!(s.count("daily"), 0);
}

// ---- settings hot reload ------------------------------------------------------------------------

#[test]
fn uses_the_new_base_cooldown_for_the_next_delay_while_running() {
    let mut s = sim();
    s.start(a());
    s.cfg.fishing.base_cooldown_sec = 10.0;
    s.cfg.fishing.jitter_sec = 0.0;
    s.emit_bot(one_fish());
    s.advance(9_999);
    assert_eq!(s.count("fish"), 1);
    s.advance(1);
    assert_eq!(s.count("fish"), 2);
}
