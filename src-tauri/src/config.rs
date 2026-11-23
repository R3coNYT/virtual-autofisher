//! `config.json` (v1 schema): deep-merged updates, encrypted token, atomic writes.

use crate::dpapi::Cipher;
use crate::logger::Logger;
use crate::model::Config;
use crate::paths::Paths;
use anyhow::{bail, Result};
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::watch;

pub struct ConfigStore {
    file: PathBuf,
    backup: PathBuf,
    cipher: Arc<dyn Cipher>,
    logger: Arc<Logger>,
    config: Config,
    tx: watch::Sender<Config>,
}

/// The config as the UI may see it: never the token.
pub fn public_config(c: &Config) -> Config {
    Config { token_encrypted: None, ..c.clone() }
}

fn merge(base: &mut Value, patch: &Value) {
    match (base, patch) {
        (Value::Object(b), Value::Object(p)) => {
            for (k, v) in p {
                match b.get_mut(k) {
                    Some(slot) if slot.is_object() && v.is_object() => merge(slot, v),
                    _ => {
                        b.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        (b, p) => *b = p.clone(),
    }
}

impl ConfigStore {
    pub fn new(paths: &Paths, cipher: Arc<dyn Cipher>, logger: Arc<Logger>) -> Self {
        let (tx, _) = watch::channel(Config::default());
        Self {
            file: paths.config.clone(),
            backup: paths.root.join("config.bak.json"),
            cipher,
            logger,
            config: Config::default(),
            tx,
        }
    }

    pub fn load(&mut self) -> Config {
        self.config = Config::default();
        if self.file.exists() {
            let parsed = std::fs::read_to_string(&self.file)
                .map_err(anyhow::Error::from)
                .and_then(|s| serde_json::from_str::<Value>(&s).map_err(Into::into))
                .and_then(|v| {
                    if !v.is_object() {
                        bail!("invalid config");
                    }
                    let mut base = serde_json::to_value(Config::default())?;
                    merge(&mut base, &v);
                    Ok(serde_json::from_value::<Config>(base)?)
                });
            match parsed {
                Ok(c) => self.config = c,
                Err(e) => {
                    self.logger.warn(&format!("Corrupt configuration, back to the defaults: {e}"));
                    if let Err(err) = std::fs::rename(&self.file, &self.backup) {
                        self.logger.error(&format!("Unable to back up the corrupt configuration: {err}"));
                    }
                }
            }
        }
        self.tx.send_replace(self.config.clone());
        self.get()
    }

    pub fn get(&self) -> Config {
        self.config.clone()
    }

    /// Deep-merges `patch` (camelCase JSON). `target` is replaced wholesale; `tokenEncrypted` is ignored.
    pub fn update(&mut self, patch: Value) -> Config {
        let mut patch = match patch {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        patch.remove("tokenEncrypted");
        let target = patch.remove("target");
        let mut base = serde_json::to_value(&self.config).unwrap_or(Value::Null);
        merge(&mut base, &Value::Object(patch));
        if let (Some(t), Value::Object(b)) = (target, &mut base) {
            b.insert("target".into(), t);
        }
        match serde_json::from_value::<Config>(base) {
            Ok(c) => self.config = c,
            Err(e) => self.logger.warn(&format!("Invalid configuration update ignored: {e}")),
        }
        self.commit()
    }

    pub fn set_token(&mut self, token: &str) -> Result<()> {
        if !self.cipher.available() {
            bail!("Encryption unavailable");
        }
        self.config.token_encrypted = Some(self.cipher.encrypt(token)?);
        self.commit();
        Ok(())
    }

    /// None when no token is stored or it can't be decrypted (e.g. the Electron 1.x format).
    pub fn token(&self) -> Option<String> {
        let enc = self.config.token_encrypted.as_deref()?;
        match self.cipher.decrypt(enc) {
            Ok(t) => Some(t),
            Err(e) => {
                self.logger.warn(&format!("Unable to decrypt the token: {e}"));
                None
            }
        }
    }

    pub fn clear_token(&mut self) {
        self.config.token_encrypted = None;
        self.commit();
    }

    pub fn subscribe(&self) -> watch::Receiver<Config> {
        self.tx.subscribe()
    }

    fn commit(&mut self) -> Config {
        if let Err(e) = self.write() {
            self.logger.error(&format!("Unable to save the configuration: {e}"));
        }
        self.tx.send_replace(self.config.clone());
        self.get()
    }

    /// Atomic: a crash mid-write leaves at worst a stray config.json.tmp, never a truncated config.json.
    fn write(&self) -> Result<()> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&self.config)?)?;
        std::fs::rename(&tmp, &self.file)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    /// Reversible fake cipher (base64 of the reversed string), always available.
    struct FakeCipher(bool);
    impl Cipher for FakeCipher {
        fn encrypt(&self, s: &str) -> anyhow::Result<String> {
            Ok(format!("fake:{}", s.chars().rev().collect::<String>()))
        }
        fn decrypt(&self, s: &str) -> anyhow::Result<String> {
            let body = s.strip_prefix("fake:").ok_or_else(|| anyhow::anyhow!("unknown format"))?;
            Ok(body.chars().rev().collect())
        }
        fn available(&self) -> bool {
            self.0
        }
    }

    fn store(root: &std::path::Path, available: bool) -> ConfigStore {
        let paths = Paths::new(root.to_path_buf());
        let logger = Arc::new(Logger::new(paths.logs.clone()));
        ConfigStore::new(&paths, Arc::new(FakeCipher(available)), logger)
    }

    #[test]
    fn defaults_when_no_file() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = store(tmp.path(), true);
        assert_eq!(s.load(), Config::default());
    }

    #[test]
    fn fresh_missing_dir_works() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("not/created/yet");
        let mut s = store(&root, true);
        s.load();
        s.update(json!({ "capture": true }));
        assert!(root.join("config.json").exists());
    }

    #[test]
    fn deep_merge_keeps_siblings_and_persists() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = store(tmp.path(), true);
        s.load();
        let c = s.update(json!({ "sell": { "every": 10 } }));
        assert_eq!(c.sell.every, 10.0);
        assert!(c.sell.enabled);
        let mut again = store(tmp.path(), true);
        assert_eq!(again.load().sell.every, 10.0);
    }

    #[test]
    fn target_replaced_wholesale() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = store(tmp.path(), true);
        s.load();
        s.update(json!({ "target": { "guildId": "11111", "channelId": "22222" } }));
        let c = s.update(json!({ "target": null }));
        assert_eq!(c.target, None);
    }

    #[test]
    fn patch_cannot_set_token() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = store(tmp.path(), true);
        s.load();
        let c = s.update(json!({ "tokenEncrypted": "fake:xyz" }));
        assert_eq!(c.token_encrypted, None);
        assert_eq!(s.token(), None);
    }

    #[test]
    fn token_is_not_stored_in_plain_text() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = store(tmp.path(), true);
        s.load();
        s.set_token("secret-token-abc").unwrap();
        let file = std::fs::read_to_string(tmp.path().join("config.json")).unwrap();
        assert!(!file.contains("secret-token-abc"));
        assert_eq!(s.token().as_deref(), Some("secret-token-abc"));
        s.clear_token();
        assert_eq!(s.token(), None);
    }

    #[test]
    fn set_token_refuses_when_encryption_unavailable() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = store(tmp.path(), false);
        s.load();
        let err = s.set_token("x").unwrap_err();
        assert_eq!(err.to_string(), "Encryption unavailable");
    }

    #[test]
    fn electron_format_token_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("config.json"), r#"{"tokenEncrypted":"djEwAAAA..."}"#).unwrap();
        let mut s = store(tmp.path(), true);
        s.load();
        assert_eq!(s.token(), None);
    }

    #[test]
    fn corrupt_file_falls_back_and_is_backed_up() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("config.json"), "{not json").unwrap();
        let mut s = store(tmp.path(), true);
        assert_eq!(s.load(), Config::default());
        assert!(tmp.path().join("config.bak.json").exists());
    }

    #[test]
    fn leftover_tmp_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("config.json.tmp"), "{garbage").unwrap();
        let mut s = store(tmp.path(), true);
        assert_eq!(s.load(), Config::default());
        s.update(json!({ "capture": true }));
        let mut again = store(tmp.path(), true);
        assert!(again.load().capture);
    }

    #[test]
    fn public_config_strips_the_token() {
        let c = Config { token_encrypted: Some("dpapi:abc".into()), ..Config::default() };
        let v = serde_json::to_value(public_config(&c)).unwrap();
        assert!(v.get("tokenEncrypted").is_none());
    }

    #[test]
    fn subscribers_see_updates() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = store(tmp.path(), true);
        s.load();
        let rx = s.subscribe();
        s.update(json!({ "capture": true }));
        assert!(rx.borrow().capture);
    }
}
