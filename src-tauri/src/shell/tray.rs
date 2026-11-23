//! Tray icon and menu (port of v1 `tray.ts`). `tray_labels` is the pure state → menu mapping.

use crate::model::EngineState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    Start,
    Pause,
    Resume,
    /// Graceful stop.
    Stop,
    /// Immediate halt (while already stopping).
    ForceStop,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayItem {
    pub label: &'static str,
    pub enabled: bool,
    pub action: TrayAction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayLabels {
    pub toggle: TrayItem,
    pub stop: TrayItem,
    /// Red icon (captcha to solve).
    pub alert: bool,
    pub tooltip: &'static str,
}

const fn item(label: &'static str, enabled: bool, action: TrayAction) -> TrayItem {
    TrayItem { label, enabled, action }
}

pub fn tray_labels(state: EngineState) -> TrayLabels {
    use EngineState::*;
    let toggle = match state {
        Running | Resting => item("Pause", true, TrayAction::Pause),
        Paused => item("Resume", true, TrayAction::Resume),
        Stopping => item("Pause", false, TrayAction::None), // nothing to toggle while the stop completes
        Idle | Error => item("Start", true, TrayAction::Start),
        Connecting | Captcha => item("Start", false, TrayAction::None),
    };
    let stop = match state {
        Running | Resting | Paused => item("Stop", true, TrayAction::Stop),
        Stopping => item("Force stop", true, TrayAction::ForceStop),
        _ => item("Stop", false, TrayAction::None), // the captcha panel has its own stop
    };
    let tooltip = match state {
        Captcha => "Virtual AutoFisher — captcha to solve",
        Stopping => "Virtual AutoFisher — stopping",
        _ => "Virtual AutoFisher",
    };
    TrayLabels { toggle, stop, alert: state == Captcha, tooltip }
}

#[cfg(test)]
mod tests {
    use super::*;
    use EngineState::*;

    fn t(s: EngineState) -> (&'static str, bool, &'static str, bool) {
        let l = tray_labels(s);
        (l.toggle.label, l.toggle.enabled, l.stop.label, l.stop.enabled)
    }

    #[test]
    fn labels_follow_the_engine_state_as_in_v1() {
        assert_eq!(t(Idle), ("Start", true, "Stop", false));
        assert_eq!(t(Error), ("Start", true, "Stop", false));
        assert_eq!(t(Connecting), ("Start", false, "Stop", false));
        assert_eq!(t(Running), ("Pause", true, "Stop", true));
        assert_eq!(t(Resting), ("Pause", true, "Stop", true));
        assert_eq!(t(Paused), ("Resume", true, "Stop", true));
        assert_eq!(t(Stopping), ("Pause", false, "Force stop", true));
        assert_eq!(t(Captcha), ("Start", false, "Stop", false));
    }

    #[test]
    fn actions_match_the_labels() {
        assert_eq!(tray_labels(Running).toggle.action, TrayAction::Pause);
        assert_eq!(tray_labels(Paused).toggle.action, TrayAction::Resume);
        assert_eq!(tray_labels(Idle).toggle.action, TrayAction::Start);
        assert_eq!(tray_labels(Paused).stop.action, TrayAction::Stop);
        assert_eq!(tray_labels(Stopping).stop.action, TrayAction::ForceStop);
        assert_eq!(tray_labels(Captcha).stop.action, TrayAction::None);
    }

    #[test]
    fn captcha_shows_the_alert_icon_and_tooltip() {
        let c = tray_labels(Captcha);
        assert!(c.alert);
        assert_eq!(c.tooltip, "Virtual AutoFisher — captcha to solve");
        assert_eq!(tray_labels(Stopping).tooltip, "Virtual AutoFisher — stopping");
        assert!(!tray_labels(Running).alert);
        assert_eq!(tray_labels(Running).tooltip, "Virtual AutoFisher");
    }
}
