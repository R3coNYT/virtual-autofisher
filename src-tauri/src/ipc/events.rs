//! Backend → renderer events (port of the relays in v1 `handlers.ts`). Channel names and payloads are
//! the v1 `EventMap` ones (`engine.state`, `game.patch`, …); the Tauri emitter maps the dot to `:`
//! because Tauri event names cannot contain dots.

use crate::engine::core::{Effect, LogLevel};
use crate::logger::Logger;
use crate::model::{EngineInfo, EngineState, Toast, ToastLevel};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

pub trait Emitter: Send + Sync {
    fn emit(&self, channel: &str, payload: Value);
}

/// Tauri event name for a v1 channel (`engine.state` → `engine:state`).
pub fn tauri_event_name(channel: &str) -> String {
    channel.replace('.', ":")
}

/// The user is told when the engine stops or pauses on its own (v1 strings).
pub fn state_toast(s: EngineState, prev: EngineState, info: &EngineInfo) -> Option<Toast> {
    let reason = info.reason.as_deref();
    let t = |level, message: String| Some(Toast { level, message });
    match (s, reason) {
        (EngineState::Paused, Some("noResponse")) if prev != EngineState::Paused => t(ToastLevel::Error, "Virtual Fisher is not responding — fishing paused".into()),
        (EngineState::Paused, Some("exception")) if prev != EngineState::Paused => t(ToastLevel::Error, "Unexpected error — fishing paused".into()),
        (EngineState::Error, r) => t(ToastLevel::Error, r.map_or("Engine error".into(), |r| format!("Error: {r}"))),
        (EngineState::Idle, Some(r)) => t(ToastLevel::Info, format!("{r} — fishing stopped")),
        _ => None,
    }
}

/// Turns engine effects into renderer events, toasts, log lines and session files.
pub struct Relay {
    emitter: Arc<dyn Emitter>,
    logger: Arc<Logger>,
    sessions_dir: PathBuf,
    prev: EngineState,
}

impl Relay {
    pub fn new(emitter: Arc<dyn Emitter>, logger: Arc<Logger>, sessions_dir: PathBuf) -> Self {
        Self { emitter, logger, sessions_dir, prev: EngineState::Idle }
    }

    pub fn toast(&self, t: &Toast) {
        self.emitter.emit("toast", serde_json::to_value(t).unwrap_or(Value::Null));
    }

    pub fn on_effect(&mut self, e: Effect) {
        let emit = |c: &str, v: Value| self.emitter.emit(c, v);
        match e {
            Effect::State { state, info } => {
                emit("engine.state", json!({ "state": state, "info": info }));
                if let Some(t) = state_toast(state, self.prev, &info) {
                    self.toast(&t);
                }
                self.prev = state;
            }
            Effect::Commands(c) => emit("engine.commands", serde_json::to_value(c).unwrap_or(Value::Null)),
            Effect::GamePatch(p) => {
                if p.patch.as_object().is_some_and(|m| !m.is_empty()) {
                    emit("game.patch", p.patch);
                }
                if !p.new_log.is_empty() {
                    emit("log.append", serde_json::to_value(p.new_log).unwrap_or(Value::Null));
                }
            }
            Effect::CaptchaShow(p) => emit("captcha.show", serde_json::to_value(p).unwrap_or(Value::Null)),
            Effect::CaptchaHide => emit("captcha.hide", Value::Null),
            Effect::Toast(t) => self.toast(&t),
            Effect::Log { level, msg } => match level {
                LogLevel::Info => self.logger.info(&msg),
                LogLevel::Warn => self.logger.warn(&msg),
                LogLevel::Error => self.logger.error(&msg),
            },
            Effect::SessionEnded(s) => {
                let name = format!("{}.json", s.session.started_at.unwrap_or(s.ended_at));
                let res = std::fs::create_dir_all(&self.sessions_dir)
                    .map_err(anyhow::Error::from)
                    .and_then(|_| Ok(std::fs::write(self.sessions_dir.join(name), serde_json::to_string_pretty(&s)?)?));
                if let Err(e) = res {
                    self.logger.error(&format!("Unable to write the session summary: {e}"));
                }
            }
            Effect::LoadCommands { .. } | Effect::SetActiveChannel(_) | Effect::SendSlash { .. } => {} // handled by the actor
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(r: Option<&str>) -> EngineInfo {
        EngineInfo { reason: r.map(String::from), ..Default::default() }
    }

    #[test]
    fn toasts_match_v1() {
        use EngineState::*;
        let msg = |s, p, r| state_toast(s, p, &info(r)).map(|t| t.message);
        assert_eq!(msg(Paused, Running, Some("noResponse")).as_deref(), Some("Virtual Fisher is not responding — fishing paused"));
        assert_eq!(msg(Paused, Running, Some("exception")).as_deref(), Some("Unexpected error — fishing paused"));
        assert_eq!(msg(Paused, Paused, Some("noResponse")), None);
        assert_eq!(msg(Paused, Running, Some("user")), None);
        assert_eq!(msg(Error, Running, Some("Connection to Discord lost for more than 2 minutes")).as_deref(), Some("Error: Connection to Discord lost for more than 2 minutes"));
        assert_eq!(msg(Idle, Stopping, Some("Session limit reached")).as_deref(), Some("Session limit reached — fishing stopped"));
        assert_eq!(msg(Idle, Running, None), None);
        assert_eq!(tauri_event_name("engine.state"), "engine:state");
    }
}
