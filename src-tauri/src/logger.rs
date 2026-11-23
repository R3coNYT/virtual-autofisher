//! Masked, rotating log file (`logs/app.log`, rotated to `app.1.log` above 5 MB). Never panics.

use regex::Regex;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const MAX_BYTES: u64 = 5 * 1024 * 1024;

fn token_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[\w-]{24,}\.[\w-]{6}\.[\w-]{27,}").expect("valid regex"))
}

/// Replaces anything shaped like a Discord token with `***TOKEN***`.
pub fn mask_secrets(s: &str) -> String {
    token_re().replace_all(s, "***TOKEN***").into_owned()
}

pub struct Logger {
    dir: PathBuf,
    lock: Mutex<()>,
}

impl Logger {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, lock: Mutex::new(()) }
    }

    pub fn info(&self, msg: &str) {
        self.write("INFO", msg)
    }
    pub fn warn(&self, msg: &str) {
        self.write("WARN", msg)
    }
    pub fn error(&self, msg: &str) {
        self.write("ERROR", msg)
    }

    fn write(&self, level: &str, msg: &str) {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let _ = fs::create_dir_all(&self.dir);
        let file = self.dir.join("app.log");
        if fs::metadata(&file).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
            let _ = fs::rename(&file, self.dir.join("app.1.log"));
        }
        let line = format!("{} {level} {}\n", timestamp(), mask_secrets(msg));
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&file) {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

/// Seconds since the Unix epoch (UTC), enough for ordering log lines.
fn timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    format!("{secs:.3}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "MTA4MTIzNDU2Nzg5MDEyMzQ1Ng.GabcdE.abcdefghijklmnopqrstuvwxyz0";

    #[test]
    fn mask_secrets_hides_token() {
        let out = mask_secrets(&format!("token {TOKEN} here"));
        assert!(!out.contains(TOKEN));
        assert!(out.contains("***TOKEN***"));
    }

    #[test]
    fn logged_lines_are_masked() {
        let tmp = tempfile::tempdir().unwrap();
        let log = Logger::new(tmp.path().to_path_buf());
        log.error(&format!("failed with {TOKEN}"));
        let text = std::fs::read_to_string(tmp.path().join("app.log")).unwrap();
        assert!(text.contains("ERROR") && !text.contains(TOKEN));
    }

    #[test]
    fn logger_rotates_at_5mb() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("app.log"), vec![b'x'; 5 * 1024 * 1024 + 1]).unwrap();
        let log = Logger::new(tmp.path().to_path_buf());
        log.info("after rotation");
        assert!(tmp.path().join("app.1.log").exists());
        let text = std::fs::read_to_string(tmp.path().join("app.log")).unwrap();
        assert!(text.contains("after rotation") && text.len() < 1000);
    }
}
