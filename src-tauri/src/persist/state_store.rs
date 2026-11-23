//! `state.json` (port of `StateStore.ts`): account values, next daily and the Virtual Fisher detection
//! per guild, kept between sessions and app restarts. Never holds the token or anything from the
//! config. Writes are atomic (tmp + rename); a corrupt file is set aside as state.bak.json; values
//! with a wrong type are dropped one by one (v1 files load as they are).

use crate::engine::game_state::PersistedState;
use crate::logger::Logger;
use crate::model::PersistedAccount;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

/// The file's contents (v1 schema, version 1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredState {
    pub version: u32,
    pub account: PersistedAccount,
    pub next_daily_at: Option<i64>,
    pub vf_guilds: BTreeMap<String, bool>,
    pub saved_at: i64,
}

fn is_num(v: &Value) -> bool {
    v.as_u64().is_some()
}
fn num_or_null(v: &Value) -> bool {
    v.is_null() || is_num(v)
}
fn str_or_null(v: &Value) -> bool {
    v.is_null() || v.is_string()
}
fn numbers(v: &Value) -> bool {
    v.as_object().is_some_and(|o| o.values().all(is_num))
}

/// Type check of each persisted account field (a value failing it is dropped).
fn check(field: &str, v: &Value) -> bool {
    match field {
        "balance" | "fishValue" | "level" | "xpToNext" | "personalBoosters" => num_or_null(v),
        "rod" | "biome" => str_or_null(v),
        "bait" => v.is_null() || (v["name"].is_string() && is_num(&v["count"])),
        "rare" => numbers(v) && ["gold", "emerald", "lava", "diamond"].iter().all(|k| is_num(&v[*k])),
        "totals" => numbers(v),
        _ => false,
    }
}

pub struct StateStore {
    file: PathBuf,
    backup: PathBuf,
    logger: Arc<Logger>,
    now: Box<dyn Fn() -> i64 + Send>,
    vf: BTreeMap<String, bool>,
    vf_loaded: bool,
}

impl StateStore {
    pub fn new(dir: PathBuf, logger: Arc<Logger>) -> Self {
        Self::with_clock(dir, logger, Box::new(chrono_now))
    }

    pub fn with_clock(dir: PathBuf, logger: Arc<Logger>, now: Box<dyn Fn() -> i64 + Send>) -> Self {
        Self { file: dir.join("state.json"), backup: dir.join("state.bak.json"), logger, now, vf: BTreeMap::new(), vf_loaded: false }
    }

    pub fn load(&mut self) -> Option<StoredState> {
        if !self.file.exists() {
            return None;
        }
        let parsed: Value = match std::fs::read_to_string(&self.file).map_err(anyhow::Error::from).and_then(|s| Ok(serde_json::from_str(&s)?)) {
            Ok(v) => v,
            Err(e) => {
                self.logger.warn(&format!("Corrupt state.json, ignored: {e}"));
                if let Err(err) = std::fs::rename(&self.file, &self.backup) {
                    self.logger.error(&format!("Unable to back up the corrupt state.json: {err}"));
                }
                return None;
            }
        };
        let Some(raw_account) = parsed.get("account").and_then(Value::as_object).filter(|_| parsed["version"] == 1) else {
            self.logger.warn("Unsupported state.json, ignored");
            return None;
        };
        let account: Map<String, Value> = raw_account.iter().filter(|(k, v)| check(k, v)).map(|(k, v)| (k.clone(), v.clone())).collect();
        let account: PersistedAccount = serde_json::from_value(Value::Object(account)).unwrap_or_default();
        let vf_guilds: BTreeMap<String, bool> =
            parsed["vfGuilds"].as_object().map(|o| o.iter().filter_map(|(k, v)| v.as_bool().map(|b| (k.clone(), b))).collect()).unwrap_or_default();
        self.vf = vf_guilds.clone();
        self.vf_loaded = true;
        Some(StoredState { version: 1, account, next_daily_at: parsed["nextDailyAt"].as_i64(), vf_guilds, saved_at: parsed["savedAt"].as_i64().unwrap_or(0) })
    }

    pub fn save(&mut self, s: &PersistedState) -> Result<()> {
        if !self.vf_loaded {
            self.load(); // keep the persisted detection map when a game save comes first
        }
        self.write(s.account.clone(), s.next_daily_at)
    }

    pub fn vf_guilds(&mut self) -> BTreeMap<String, bool> {
        if !self.vf_loaded {
            self.load();
        }
        self.vf.clone()
    }

    /// Replaces the persisted Virtual Fisher detection map, keeping account and next daily as stored.
    pub fn set_vf_guilds(&mut self, map: BTreeMap<String, bool>) -> Result<()> {
        let cur = self.load(); // also (re)reads the file; overwritten below
        self.vf = map;
        self.vf_loaded = true;
        let (account, next) = cur.map(|c| (c.account, c.next_daily_at)).unwrap_or_default();
        self.write(account, next)
    }

    fn write(&self, account: PersistedAccount, next_daily_at: Option<i64>) -> Result<()> {
        let out = StoredState { version: 1, account, next_daily_at, vf_guilds: self.vf.clone(), saved_at: (self.now)() };
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        // atomic: a crash mid-write leaves at worst a stray state.json.tmp, never a truncated state.json
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&out)?)?;
        std::fs::rename(&tmp, &self.file)?;
        Ok(())
    }
}

fn chrono_now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Bait, PartialRare, RareCounts, Totals};
    use serde_json::json;

    fn account() -> PersistedAccount {
        PersistedAccount {
            balance: Some(136_570_161),
            fish_value: Some(32_180_326),
            level: Some(154),
            xp_to_next: Some(75_640),
            rod: Some("Superium Rod".into()),
            biome: Some("Ocean".into()),
            bait: Some(Bait { name: "Magic Bait".into(), count: 34_414 }),
            rare: RareCounts { gold: 2353, emerald: 887, lava: 43, diamond: 77 },
            totals: Totals { rare: PartialRare { gold: Some(10), ..Default::default() }, crates: Some(3), ..Default::default() },
            personal_boosters: Some(1),
        }
    }
    fn persisted(next: Option<i64>) -> PersistedState {
        PersistedState { account: account(), next_daily_at: next }
    }
    fn store(dir: &std::path::Path) -> StateStore {
        StateStore::with_clock(dir.to_path_buf(), Arc::new(Logger::new(dir.join("logs"))), Box::new(|| 1234))
    }
    fn write_raw(dir: &std::path::Path, v: &str) {
        std::fs::write(dir.join("state.json"), v).unwrap();
    }

    #[test]
    fn no_file_is_none() {
        let d = tempfile::tempdir().unwrap();
        assert!(store(d.path()).load().is_none());
    }

    #[test]
    fn round_trip_version_account_next_daily_saved_at() {
        let d = tempfile::tempdir().unwrap();
        store(d.path()).save(&persisted(Some(99))).unwrap();
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(d.path().join("state.json")).unwrap()).unwrap();
        assert_eq!((raw["version"].clone(), raw["nextDailyAt"].clone(), raw["savedAt"].clone(), raw["vfGuilds"].clone()), (json!(1), json!(99), json!(1234), json!({})));
        assert_eq!(raw["account"]["bait"], json!({ "name": "Magic Bait", "count": 34414 }));
        let back = store(d.path()).load().unwrap();
        assert_eq!(back, StoredState { version: 1, account: account(), next_daily_at: Some(99), vf_guilds: BTreeMap::new(), saved_at: 1234 });
        assert!(!d.path().join("state.json.tmp").exists());
    }

    #[test]
    fn a_v1_file_loads() {
        let d = tempfile::tempdir().unwrap();
        write_raw(
            d.path(),
            r#"{"version":1,"account":{"balance":136570161,"fishValue":32180326,"level":154,"xpToNext":75640,"rod":"Superium Rod","biome":"Ocean","bait":{"name":"Magic Bait","count":34414},"rare":{"gold":2353,"emerald":887,"lava":43,"diamond":77},"totals":{"gold":10,"crates":3},"personalBoosters":1},"nextDailyAt":99,"vfGuilds":{"10001":true},"savedAt":5}"#,
        );
        let s = store(d.path()).load().unwrap();
        assert_eq!(s.account, account());
        assert_eq!(s.vf_guilds, [("10001".to_string(), true)].into_iter().collect());
    }

    #[test]
    fn corrupt_file_is_ignored_kept_aside_and_warned() {
        let d = tempfile::tempdir().unwrap();
        write_raw(d.path(), "{not json");
        assert!(store(d.path()).load().is_none());
        assert!(d.path().join("state.bak.json").exists());
        assert!(!d.path().join("state.json").exists());
        assert!(std::fs::read_to_string(d.path().join("logs/app.log")).unwrap().contains("Corrupt state.json"));
    }

    #[test]
    fn unknown_version_or_shape_is_ignored() {
        let d = tempfile::tempdir().unwrap();
        write_raw(d.path(), &json!({ "version": 2, "account": {} }).to_string());
        assert!(store(d.path()).load().is_none());
        write_raw(d.path(), &json!({ "version": 1, "account": "x" }).to_string());
        assert!(store(d.path()).load().is_none());
    }

    #[test]
    fn wrongly_typed_values_are_dropped_the_rest_is_kept() {
        let d = tempfile::tempdir().unwrap();
        let mut acc = serde_json::to_value(account()).unwrap();
        acc["balance"] = json!("lots");
        acc["rare"] = Value::Null;
        acc["level"] = json!(154);
        write_raw(d.path(), &json!({ "version": 1, "account": acc, "nextDailyAt": "soon", "savedAt": 5 }).to_string());
        let s = store(d.path()).load().unwrap();
        assert_eq!(s.account.balance, None);
        assert_eq!(s.account.rare, RareCounts::default());
        assert_eq!(s.account.level, Some(154));
        assert_eq!(s.next_daily_at, None);
    }

    #[test]
    fn a_stray_tmp_file_does_not_matter() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("state.json.tmp"), "{half").unwrap();
        let mut s = store(d.path());
        assert!(s.load().is_none());
        s.save(&persisted(None)).unwrap();
        assert_eq!(s.load().unwrap().account, account());
    }

    #[test]
    fn vf_guilds_old_files_load_empty_and_bad_entries_are_dropped() {
        let d = tempfile::tempdir().unwrap();
        write_raw(d.path(), &json!({ "version": 1, "account": {}, "nextDailyAt": null, "savedAt": 1 }).to_string());
        assert!(store(d.path()).load().unwrap().vf_guilds.is_empty());
        write_raw(d.path(), &json!({ "version": 1, "account": {}, "nextDailyAt": null, "vfGuilds": { "a": true, "b": false, "c": "yes" }, "savedAt": 1 }).to_string());
        assert_eq!(store(d.path()).load().unwrap().vf_guilds, [("a".to_string(), true), ("b".to_string(), false)].into_iter().collect());
    }

    #[test]
    fn set_vf_guilds_persists_keeps_account_and_later_saves_keep_the_map() {
        let d = tempfile::tempdir().unwrap();
        let mut s = store(d.path());
        s.save(&persisted(Some(5))).unwrap();
        let map: BTreeMap<String, bool> = [("g1".to_string(), true), ("g2".to_string(), false)].into_iter().collect();
        s.set_vf_guilds(map.clone()).unwrap();
        let mut again = store(d.path());
        let loaded = again.load().unwrap();
        assert_eq!((loaded.account, loaded.next_daily_at, loaded.vf_guilds), (account(), Some(5), map.clone()));
        let mut changed = persisted(Some(6));
        changed.account.level = Some(1);
        again.save(&changed).unwrap(); // a game save must not wipe the map
        assert_eq!(store(d.path()).load().unwrap().vf_guilds, map);
        assert_eq!(store(d.path()).vf_guilds(), map);
    }

    #[test]
    fn set_vf_guilds_without_a_file_and_creates_the_directory() {
        let d = tempfile::tempdir().unwrap();
        let sub = d.path().join("nested").join("data");
        let mut s = StateStore::with_clock(sub.clone(), Arc::new(Logger::new(d.path().join("logs"))), Box::new(|| 1));
        s.set_vf_guilds([("g".to_string(), true)].into_iter().collect()).unwrap();
        let loaded = s.load().unwrap();
        assert_eq!(loaded.account, PersistedAccount::default());
        assert_eq!(loaded.vf_guilds.get("g"), Some(&true));
    }
}
