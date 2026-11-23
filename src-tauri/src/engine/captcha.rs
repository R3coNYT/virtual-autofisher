//! Captcha state (port of `captchaFlow.ts`). The engine core drives it: on a captcha the queue is
//! emptied and paused and the scheduler frozen; the only command that can leave is a `verify` pushed
//! by an explicit user action (submit/regen). Nothing ever sends /verify on its own.

use crate::model::{CaptchaPayload, EngineInfo, EngineState};
use regex::Regex;
use std::sync::OnceLock;

pub const CAPTCHA_SOLVED_TEXT: &str = "Captcha solved — resuming in a few seconds…";

/// Pre-captcha states without a session: the solve goes back to idle, never to fishing.
pub const SESSIONLESS: [EngineState; 2] = [EngineState::Idle, EngineState::Error];

/// Virtual Fisher's follow-up to any command sent while a captcha is pending.
pub fn is_reminder(text: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)solve the captcha posted above").unwrap()).is_match(text)
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CaptchaInfo {
    pub image_url: Option<String>,
    pub text: Option<String>,
    pub solved: bool,
}

impl CaptchaInfo {
    pub fn engine_info(&self) -> EngineInfo {
        EngineInfo { reason: None, captcha_image_url: self.image_url.clone(), captcha_text: self.text.clone(), captcha_solved: self.solved.then_some(true) }
    }
}

/// What is on screen and when the engine resumes after a solve.
#[derive(Debug, Default)]
pub struct CaptchaFlow {
    pub info: CaptchaInfo,
    /// Set once solved: the engine leaves the captcha at this time (5–15 s after the solve).
    pub resume_at: Option<i64>,
    /// State the engine was in when the captcha arrived.
    pub from: Option<EngineState>,
}

impl CaptchaFlow {
    /// Forget any pending resume (engine halted).
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// New challenge content. A "solve the captcha posted above" reminder (no image) keeps the actual
    /// challenge (code/image) on screen.
    pub fn show(&mut self, already_in_captcha: bool, image_url: Option<String>, text: String) {
        let reminder = already_in_captcha && image_url.is_none() && is_reminder(&text) && self.info.text.is_some();
        if !reminder {
            self.info = CaptchaInfo { image_url: image_url.or(self.info.image_url.take()), text: Some(text), solved: false };
        }
    }

    pub fn payload(info: &EngineInfo) -> CaptchaPayload {
        CaptchaPayload { image_url: info.captcha_image_url.clone(), text: info.captcha_text.clone().unwrap_or_default(), solved: info.captcha_solved }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reminder_keeps_the_challenge_but_a_new_captcha_replaces_it() {
        let mut f = CaptchaFlow::default();
        f.show(false, Some("img".into()), "Code: **uVU6**".into());
        f.show(true, None, "To continue, solve the captcha posted above with /verify".into());
        assert_eq!(f.info.text.as_deref(), Some("Code: **uVU6**"));
        f.show(true, None, "New captcha: /verify".into());
        assert_eq!(f.info.text.as_deref(), Some("New captcha: /verify"));
        assert_eq!(f.info.image_url.as_deref(), Some("img")); // kept when the update has none
    }
}
