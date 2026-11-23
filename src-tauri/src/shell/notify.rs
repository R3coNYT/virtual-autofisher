//! Windows notifications, beep and taskbar flash (port of v1 `notify.ts`).

use crate::model::NotificationsConfig;
use tauri::{AppHandle, Manager, UserAttentionType};
use tauri_plugin_notification::NotificationExt;

/// (title, body) of each notification, or None when disabled in the settings (v1 texts).
pub fn captcha_text(cfg: &NotificationsConfig) -> Option<(String, String)> {
    cfg.captcha.then(|| ("Virtual Fisher captcha".into(), "Solve the captcha to resume fishing.".into()))
}

pub fn level_up_text(cfg: &NotificationsConfig, level: u64) -> Option<(String, String)> {
    cfg.level_up.then(|| ("Level up!".into(), format!("You reached level {level}.")))
}

pub fn rare_fish_text(cfg: &NotificationsConfig, kinds: &[String]) -> Option<(String, String)> {
    (cfg.rare_fish && !kinds.is_empty()).then(|| ("Rare fish!".into(), format!("You caught: {}.", kinds.join(", "))))
}

fn show(app: &AppHandle, (title, body): (String, String)) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        eprintln!("notification failed: {e}");
    }
}

fn beep() {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Diagnostics::Debug::MessageBeep;
        use windows::Win32::UI::WindowsAndMessaging::MB_OK;
        let _ = MessageBeep(MB_OK);
    }
}

/// Notification, optional beep, and the taskbar button blinks until the window gets the focus.
pub fn notify_captcha(app: &AppHandle, cfg: &NotificationsConfig) {
    let Some(text) = captcha_text(cfg) else { return };
    show(app, text);
    if cfg.sound {
        beep();
    }
    if let Some(w) = app.get_webview_window("main") {
        if !w.is_focused().unwrap_or(false) {
            let _ = w.request_user_attention(Some(UserAttentionType::Critical));
        }
    }
}

pub fn notify_level_up(app: &AppHandle, cfg: &NotificationsConfig, level: u64) {
    if let Some(t) = level_up_text(cfg, level) {
        show(app, t);
    }
}

pub fn notify_rare_fish(app: &AppHandle, cfg: &NotificationsConfig, kinds: &[String]) {
    if let Some(t) = rare_fish_text(cfg, kinds) {
        show(app, t);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(on: bool) -> NotificationsConfig {
        NotificationsConfig { captcha: on, sound: on, level_up: on, rare_fish: on }
    }

    #[test]
    fn texts_are_the_v1_ones() {
        assert_eq!(captcha_text(&cfg(true)).unwrap(), ("Virtual Fisher captcha".into(), "Solve the captcha to resume fishing.".into()));
        assert_eq!(level_up_text(&cfg(true), 12).unwrap(), ("Level up!".into(), "You reached level 12.".into()));
        let kinds = ["Gold Fish".to_string(), "Lava Fish".to_string()];
        assert_eq!(rare_fish_text(&cfg(true), &kinds).unwrap(), ("Rare fish!".into(), "You caught: Gold Fish, Lava Fish.".into()));
    }

    #[test]
    fn disabled_settings_or_nothing_new_send_nothing() {
        assert!(captcha_text(&cfg(false)).is_none());
        assert!(level_up_text(&cfg(false), 3).is_none());
        assert!(rare_fish_text(&cfg(false), &["Gold Fish".into()]).is_none());
        assert!(rare_fish_text(&cfg(true), &[]).is_none());
    }
}
