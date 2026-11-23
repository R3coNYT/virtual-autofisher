//! Data folder: exactly `%APPDATA%\virtual-autofisher\` (the folder v1 used), never Tauri's default.

use std::io;
use std::path::PathBuf;

/// `%APPDATA%\virtual-autofisher` (falls back to the current directory if APPDATA is unknown).
pub fn data_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("virtual-autofisher")
}

#[derive(Debug, Clone)]
pub struct Paths {
    pub root: PathBuf,
    pub config: PathBuf,
    pub state: PathBuf,
    pub logs: PathBuf,
    pub sessions: PathBuf,
    pub captures: PathBuf,
}

impl Paths {
    pub fn new(root: PathBuf) -> Self {
        Self {
            config: root.join("config.json"),
            state: root.join("state.json"),
            logs: root.join("logs"),
            sessions: root.join("sessions"),
            captures: root.join("captures"),
            root,
        }
    }

    /// Creates the data folder and its sub-folders (fresh install).
    pub fn ensure(&self) -> io::Result<()> {
        for dir in [&self.root, &self.logs, &self.sessions] {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::create_dir_all(&self.captures)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_ensure_creates_missing_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("does/not/exist/virtual-autofisher");
        let p = Paths::new(root.clone());
        p.ensure().unwrap();
        assert!(root.is_dir() && p.logs.is_dir() && p.sessions.is_dir() && p.captures.is_dir());
        assert_eq!(p.config, root.join("config.json"));
        assert_eq!(p.state, root.join("state.json"));
    }

    #[test]
    fn data_dir_is_appdata_virtual_autofisher() {
        assert!(data_dir().ends_with("virtual-autofisher"));
    }
}
