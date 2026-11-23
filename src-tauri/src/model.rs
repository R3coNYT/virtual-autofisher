//! Serde mirrors of `src/shared/types.ts` and `src/shared/ipc.ts` (camelCase JSON, v1 schemas).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// ---------------------------------------------------------------- config

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_encrypted: Option<String>,
    pub target: Option<Target>,
    pub fishing: FishingConfig,
    pub sell: SellConfig,
    pub buffs: BuffsConfig,
    pub boosters: BoostersConfig,
    pub bait: BaitConfig,
    pub profile: ProfileConfig,
    pub daily: Toggle,
    pub quests: Toggle,
    pub breaks: BreaksConfig,
    pub session_limit_h: f64,
    pub notifications: NotificationsConfig,
    pub ui: UiConfig,
    pub capture: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub guild_id: String,
    pub channel_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FishingConfig {
    pub base_cooldown_sec: f64,
    pub jitter_sec: f64,
    pub min_gap_sec: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SellMode {
    Catches,
    Minutes,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SellConfig {
    pub enabled: bool,
    pub mode: SellMode,
    pub every: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BuffsConfig {
    pub enabled: bool,
    pub length_min: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BoostersConfig {
    pub auto_personal: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BaitConfig {
    pub enabled: bool,
    pub name: String,
    pub auto_amount: bool,
    pub amount: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProfileConfig {
    pub refresh_min: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Toggle {
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BreaksConfig {
    pub enabled: bool,
    pub work_min: f64,
    pub work_jitter_min: f64,
    pub rest_min: f64,
    pub rest_jitter_min: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationsConfig {
    pub captcha: bool,
    pub sound: bool,
    pub level_up: bool,
    pub rare_fish: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UiConfig {
    pub compact_log: bool,
    pub close_to_tray: bool,
}

impl Default for FishingConfig {
    fn default() -> Self {
        Self { base_cooldown_sec: 3.5, jitter_sec: 0.8, min_gap_sec: 2.5 }
    }
}
impl Default for SellConfig {
    fn default() -> Self {
        Self { enabled: true, mode: SellMode::Catches, every: 25.0 }
    }
}
impl Default for BuffsConfig {
    fn default() -> Self {
        Self { enabled: false, length_min: 5 }
    }
}
impl Default for BaitConfig {
    fn default() -> Self {
        Self { enabled: false, name: String::new(), auto_amount: true, amount: 0.0 }
    }
}
impl Default for ProfileConfig {
    fn default() -> Self {
        Self { refresh_min: 5.0 }
    }
}
impl Default for Toggle {
    fn default() -> Self {
        Self { enabled: true }
    }
}
impl Default for BreaksConfig {
    fn default() -> Self {
        Self { enabled: false, work_min: 45.0, work_jitter_min: 10.0, rest_min: 5.0, rest_jitter_min: 2.0 }
    }
}
impl Default for NotificationsConfig {
    fn default() -> Self {
        Self { captcha: true, sound: true, level_up: true, rare_fish: true }
    }
}
impl Default for UiConfig {
    fn default() -> Self {
        Self { compact_log: false, close_to_tray: true }
    }
}
impl Default for Config {
    fn default() -> Self {
        Self {
            version: 1,
            token_encrypted: None,
            target: None,
            fishing: FishingConfig::default(),
            sell: SellConfig::default(),
            buffs: BuffsConfig::default(),
            boosters: BoostersConfig::default(),
            bait: BaitConfig::default(),
            profile: ProfileConfig::default(),
            daily: Toggle::default(),
            quests: Toggle::default(),
            breaks: BreaksConfig::default(),
            session_limit_h: 0.0,
            notifications: NotificationsConfig::default(),
            ui: UiConfig::default(),
            capture: false,
        }
    }
}

// ---------------------------------------------------------------- discord

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EmbedField {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Embed {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub fields: Vec<EmbedField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub footer: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BotMessage {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub channel_id: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub embeds: Vec<Embed>,
    #[serde(default)]
    pub ephemeral: bool,
    /// Discord "is thinking…" placeholder (flag LOADING): the real reply comes as an edit of it.
    #[serde(default)]
    pub loading: bool,
    #[serde(default)]
    pub is_edit: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction_user_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfUser {
    pub id: String,
    pub username: String,
    pub avatar_url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuildInfo {
    pub id: String,
    pub name: String,
    pub icon_url: Option<String>,
    pub has_virtual_fisher: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelInfo {
    pub id: String,
    pub name: String,
    pub parent_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SlashOption {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: u8,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<String>>,
    /// `choice_names[i]` is the display label of `choices[i]` (the value sent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choice_names: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommandInfo {
    pub name: String,
    pub id: String,
    pub version: String,
    #[serde(default)]
    pub options: Vec<SlashOption>,
}

/// Options of a slash command, by option name.
pub type SlashOptions = BTreeMap<String, serde_json::Value>;

// ---------------------------------------------------------------- game

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Boost {
    pub name: String,
    pub ends_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatchItem {
    pub name: String,
    pub count: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RareCounts {
    pub gold: u64,
    pub emerald: u64,
    pub lava: u64,
    pub diamond: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PartialRare {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gold: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emerald: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lava: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diamond: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bait {
    pub name: String,
    pub count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quest {
    pub label: String,
    pub progress: String,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GameEvent {
    Catch {
        items: Vec<CatchItem>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        xp: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        level_up: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        treasure: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        quests_completed: Option<Vec<String>>,
        raw: String,
    },
    Sell {
        earned: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        xp: Option<u64>,
    },
    Inventory {
        balance: u64,
        level: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        xp_to_next: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rod: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        biome: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bait: Option<Bait>,
        rare: RareCounts,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fish_value: Option<u64>,
    },
    Stats {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        crates: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        quests: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        trips: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        daily_streak: Option<u64>,
        totals: PartialRare,
    },
    Boosts {
        active: Vec<Boost>,
    },
    Boosters {
        personal: u64,
    },
    Purchase {
        item: String,
        amount: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cost: Option<u64>,
    },
    Daily {
        reward: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        next_in_ms: Option<i64>,
    },
    Quests {
        quests: Vec<Quest>,
    },
    Cooldown {
        wait_ms: i64,
    },
    Captcha {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        image_url: Option<String>,
        text: String,
    },
    CaptchaSolved,
    CaptchaFailed {
        text: String,
    },
    Error {
        text: String,
    },
    Unknown {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        text: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LogType {
    Catch,
    Trade,
    System,
    Error,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: u64,
    pub at: i64,
    #[serde(rename = "type")]
    pub kind: LogType,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highlight: Option<bool>,
    /// Set on the "Reached level N!" entry (structured, for notifications).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level_up: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    #[serde(flatten)]
    pub rare: PartialRare,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crates: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quests: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trips: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_streak: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Account {
    pub balance: Option<u64>,
    pub level: Option<u64>,
    pub xp_to_next: Option<u64>,
    pub rod: Option<String>,
    pub biome: Option<String>,
    pub bait: Option<Bait>,
    pub fish_value: Option<u64>,
    pub rare: RareCounts,
    pub totals: Totals,
    pub personal_boosters: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    pub started_at: Option<i64>,
    pub catches: u64,
    pub fish_by_species: BTreeMap<String, u64>,
    pub money_earned: u64,
    pub xp_earned: u64,
    pub sells: u64,
    pub captchas: u64,
    pub commands_sent: u64,
    pub rare_caught: RareCounts,
    pub fish_value_start: Option<u64>,
    pub value_gained: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GameSnapshot {
    pub account: Account,
    pub boosts: Vec<Boost>,
    pub quests: Vec<Quest>,
    pub session: Session,
    pub next_fish_at: Option<i64>,
    pub next_daily_at: Option<i64>,
    pub log: Vec<LogEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    #[serde(flatten)]
    pub session: Session,
    pub ended_at: i64,
}

/// Account values kept between sessions and app restarts (state.json).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PersistedAccount {
    pub balance: Option<u64>,
    pub fish_value: Option<u64>,
    pub level: Option<u64>,
    pub xp_to_next: Option<u64>,
    pub rod: Option<String>,
    pub biome: Option<String>,
    pub bait: Option<Bait>,
    pub rare: RareCounts,
    pub totals: Totals,
    pub personal_boosters: Option<u64>,
}

// ---------------------------------------------------------------- engine / ipc

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineState {
    Idle,
    Connecting,
    Running,
    Paused,
    Resting,
    Stopping,
    Captcha,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PauseReason {
    User,
    Network,
    NoResponse,
    Exception,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub captcha_image_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub captcha_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub captcha_solved: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CaptchaPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solved: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub state: EngineState,
    pub info: EngineInfo,
    pub captcha: Option<CaptchaPayload>,
    pub snapshot: GameSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionStatus {
    Connecting,
    Connected,
    Disconnected,
    InvalidToken,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionEvent {
    pub status: ConnectionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub user: Option<SelfUser>,
    pub target: Option<Target>,
    pub has_token: bool,
    pub connection: Option<ConnectionEvent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToastLevel {
    Info,
    Success,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Toast {
    pub level: ToastLevel,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(rel: &str) -> String {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures").join(rel);
        std::fs::read_to_string(p).unwrap()
    }

    #[test]
    fn default_config_matches_v1() {
        let golden: Config = serde_json::from_str(&fixture("model/default-config.json")).unwrap();
        assert_eq!(golden, Config::default());
        let keys = |v: serde_json::Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        let golden_v: serde_json::Value = serde_json::from_str(&fixture("model/default-config.json")).unwrap();
        assert_eq!(keys(serde_json::to_value(Config::default()).unwrap()), keys(golden_v));
    }

    #[test]
    fn bot_message_camel_case_roundtrip() {
        let m: BotMessage = serde_json::from_str(&fixture("messages/catch-basic.json")).unwrap();
        assert!(!m.embeds.is_empty());
        let back = serde_json::to_value(&m).unwrap();
        assert!(back.get("channelId").is_some());
        assert!(back.get("isEdit").is_some());
    }

    #[test]
    fn game_event_tagged() {
        let e: GameEvent = serde_json::from_str(r#"{"kind":"cooldown","waitMs":2400}"#).unwrap();
        assert_eq!(e, GameEvent::Cooldown { wait_ms: 2400 });
        let s = serde_json::to_value(GameEvent::CaptchaSolved).unwrap();
        assert_eq!(s, serde_json::json!({ "kind": "captchaSolved" }));
    }

    #[test]
    fn config_tolerates_missing_and_unknown_keys() {
        let c: Config = serde_json::from_str(r#"{"fishing":{"baseCooldownSec":2.4},"somethingNew":1}"#).unwrap();
        assert_eq!(c.fishing.base_cooldown_sec, 2.4);
        assert_eq!(c.fishing.min_gap_sec, 2.5);
        assert!(c.sell.enabled);
    }
}
