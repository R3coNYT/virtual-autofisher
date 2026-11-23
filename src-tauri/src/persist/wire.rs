//! State persistence wiring (port of `wireStatePersistence.ts`): hydrates the engine's game state from
//! state.json at boot and saves it at the end of every session, whenever nextDailyAt changes, and 2 s
//! after account values change (debounced, so a kill without a clean quit loses nothing). The quit
//! path calls `flush`. Runs inside the engine actor: it observes the core's effects.

use super::state_store::StateStore;
use crate::engine::core::{Effect, EngineCore};
use crate::engine::game_state::{GameState, PersistedState};
use crate::logger::Logger;
use std::sync::{Arc, Mutex};

const ACCOUNT_SAVE_DELAY_MS: i64 = 2000;

pub struct StatePersistence {
    store: Arc<Mutex<StateStore>>,
    logger: Arc<Logger>,
    pending_at: Option<i64>,
}

impl StatePersistence {
    pub fn new(store: Arc<Mutex<StateStore>>, logger: Arc<Logger>) -> Self {
        Self { store, logger, pending_at: None }
    }

    /// Last known account values and next daily, on screen before the login completes.
    pub fn hydrate(&self, core: &mut EngineCore, now: i64) {
        let loaded = self.store.lock().unwrap_or_else(|e| e.into_inner()).load();
        if let Some(s) = loaded {
            core.hydrate(&PersistedState { account: s.account, next_daily_at: s.next_daily_at }, now);
        }
    }

    pub fn observe(&mut self, e: &Effect, now: i64, game: &GameState) {
        match e {
            Effect::SessionEnded(_) => self.flush(game),
            Effect::GamePatch(p) => {
                let has = |k: &str| p.patch.get(k).is_some();
                if has("nextDailyAt") {
                    self.flush(game);
                } else if has("account") && self.pending_at.is_none() {
                    self.pending_at = Some(now + ACCOUNT_SAVE_DELAY_MS);
                }
            }
            _ => {}
        }
    }

    pub fn next_wakeup(&self) -> Option<i64> {
        self.pending_at
    }

    pub fn poll(&mut self, now: i64, game: &GameState) {
        if self.pending_at.is_some_and(|t| t <= now) {
            self.flush(game);
        }
    }

    /// Saves now (a failure is logged, never raised).
    pub fn flush(&mut self, game: &GameState) {
        self.pending_at = None;
        let res = self.store.lock().unwrap_or_else(|e| e.into_inner()).save(&game.persisted());
        if let Err(e) = res {
            self.logger.error(&format!("Unable to save state.json: {e}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::core::{EngineInput, EngineCore};
    use crate::engine::sim::{content, target, test_config, T0};
    use crate::model::{GameEvent, RareCounts};

    fn inventory(balance: u64) -> GameEvent {
        GameEvent::Inventory {
            balance,
            level: 160,
            xp_to_next: Some(1000),
            rod: None,
            biome: None,
            bait: None,
            rare: RareCounts { gold: 1, emerald: 2, lava: 3, diamond: 4 },
            fish_value: Some(213_669_643),
        }
    }
    fn setup(dir: &std::path::Path) -> (StatePersistence, Arc<Mutex<StateStore>>) {
        let logger = Arc::new(Logger::new(dir.join("logs")));
        let store = Arc::new(Mutex::new(StateStore::new(dir.to_path_buf(), logger.clone())));
        (StatePersistence::new(store.clone(), logger), store)
    }
    fn saved_at(store: &Arc<Mutex<StateStore>>) -> Option<i64> {
        store.lock().unwrap().load().map(|s| s.saved_at)
    }
    /// Applies an event to a game state and lets persistence observe the resulting patch.
    fn apply(p: &mut StatePersistence, g: &mut GameState, e: &GameEvent, now: i64) {
        let patch = g.apply(e, now);
        p.observe(&Effect::GamePatch(patch), now, g);
    }

    #[test]
    fn saves_account_values_shortly_after_a_manual_profile() {
        let d = tempfile::tempdir().unwrap();
        let (mut p, _) = setup(d.path());
        let mut g = GameState::new();
        apply(&mut p, &mut g, &inventory(157_175_405), 0); // e.g. a manual /profile while idle
        p.poll(3000, &g);
        // the app is killed here (no clean quit): a fresh start sees the values
        let (p2, _) = setup(d.path());
        let mut core = EngineCore::with_rand(Box::new(|| 0.5));
        p2.hydrate(&mut core, 0);
        let a = core.game().snapshot().account;
        assert_eq!((a.balance, a.fish_value, a.level), (Some(157_175_405), Some(213_669_643), Some(160)));
    }

    #[test]
    fn debounces_bursts_of_account_changes_into_one_write() {
        let d = tempfile::tempdir().unwrap();
        let (mut p, store) = setup(d.path());
        let mut g = GameState::new();
        for (i, b) in [157_175_405, 1, 2].into_iter().enumerate() {
            apply(&mut p, &mut g, &inventory(b), i as i64 * 100);
        }
        p.poll(1999, &g);
        assert!(saved_at(&store).is_none());
        p.poll(2000, &g);
        assert_eq!(store.lock().unwrap().load().unwrap().account.balance, Some(2));
    }

    #[test]
    fn next_daily_at_changes_and_session_ends_save_at_once_never_the_session() {
        let d = tempfile::tempdir().unwrap();
        let (mut p, store) = setup(d.path());
        let mut core = EngineCore::with_rand(Box::new(|| 0.5));
        let cfg = test_config(|c| c.target = Some(target("10001", "20001")));
        let feed = |core: &mut EngineCore, p: &mut StatePersistence, i: EngineInput, now: i64| {
            for e in core.handle(i, now, &cfg) {
                p.observe(&e, now, core.game());
            }
        };
        feed(&mut core, &mut p, EngineInput::Start { target: target("10001", "20001") }, T0);
        feed(&mut core, &mut p, EngineInput::CommandsLoaded { guild_id: "10001".into(), result: Ok(crate::engine::sim::default_commands()) }, T0);
        let mut reply = content("You claimed your daily reward: $5,000!");
        reply.id = "m1".into();
        reply.channel_id = "20001".into();
        feed(&mut core, &mut p, EngineInput::Bot(reply), T0 + 10);
        // the reply was not to a /daily (fish in flight): a daily event still sets nextDailyAt → saved at once
        let first = store.lock().unwrap().load();
        assert!(first.is_some_and(|s| s.next_daily_at.is_some()));
        feed(&mut core, &mut p, EngineInput::Stop { graceful: false }, T0 + 20);
        let raw = std::fs::read_to_string(d.path().join("state.json")).unwrap();
        assert!(!raw.contains("catches") && !raw.contains("session") && !raw.to_lowercase().contains("token"));
    }
}
