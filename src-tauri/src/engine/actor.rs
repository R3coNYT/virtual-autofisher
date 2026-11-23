//! Engine actor: owns the `EngineCore` on a tokio task, feeds it UI inputs, Discord events, config
//! changes and wakeups, executes its Discord effects (command loads, slash sends) and forwards the
//! rest (state, game patches, logs, toasts, captcha) to `out`.

use super::core::{Effect, EngineCore, EngineInput};
use crate::discord::{DiscordClient, DiscordEvent};
use crate::model::Config;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;

#[derive(Clone)]
pub struct EngineHandle {
    tx: mpsc::UnboundedSender<EngineInput>,
}

impl EngineHandle {
    pub fn send(&self, input: EngineInput) {
        let _ = self.tx.send(input);
    }
}

/// Epoch milliseconds that advance with tokio's clock (so tests can pause time).
struct Clock {
    base_ms: i64,
    base: Instant,
}

impl Clock {
    fn new() -> Self {
        let base_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        Self { base_ms, base: Instant::now() }
    }
    fn now_ms(&self) -> i64 {
        self.base_ms + self.base.elapsed().as_millis() as i64
    }
    fn instant_at(&self, ms: i64) -> Instant {
        self.base + Duration::from_millis((ms - self.base_ms).max(0) as u64)
    }
}

pub fn spawn_engine(client: Arc<dyn DiscordClient>, cfg: watch::Receiver<Config>, out: mpsc::Sender<Effect>) -> EngineHandle {
    spawn_engine_with(EngineCore::new(rand::random()), client, cfg, out)
}

/// Same with a prepared core (e.g. hydrated from state.json).
pub fn spawn_engine_with(core: EngineCore, client: Arc<dyn DiscordClient>, cfg: watch::Receiver<Config>, out: mpsc::Sender<Effect>) -> EngineHandle {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(run(core, client, cfg, out, rx, tx.clone()));
    EngineHandle { tx }
}

async fn run(
    mut core: EngineCore,
    client: Arc<dyn DiscordClient>,
    mut cfg: watch::Receiver<Config>,
    out: mpsc::Sender<Effect>,
    mut rx: mpsc::UnboundedReceiver<EngineInput>,
    tx: mpsc::UnboundedSender<EngineInput>,
) {
    let clock = Clock::new();
    let mut events = client.subscribe();
    let (mut events_open, mut cfg_open) = (true, true);
    loop {
        let wake = core.next_wakeup();
        let input = tokio::select! {
            i = rx.recv() => match i {
                Some(i) => i,
                None => return,
            },
            ev = events.recv(), if events_open => match ev {
                Ok(DiscordEvent::BotMessage(m)) => EngineInput::Bot(m),
                Ok(DiscordEvent::Disconnected) => EngineInput::Disconnected,
                Ok(DiscordEvent::Reconnected) => EngineInput::Reconnected,
                Ok(DiscordEvent::RateLimited(ms)) => EngineInput::RateLimited(ms),
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => {
                    events_open = false;
                    continue;
                }
            },
            _ = tokio::time::sleep_until(clock.instant_at(wake.unwrap_or(0))), if wake.is_some() => EngineInput::Tick,
            r = cfg.changed(), if cfg_open => {
                cfg_open = r.is_ok();
                EngineInput::Tick // hot reload: delays and gaps are re-read now
            }
        };
        let config = cfg.borrow().clone();
        for e in core.handle(input, clock.now_ms(), &config) {
            match e {
                Effect::LoadCommands { guild_id } => {
                    let (client, tx) = (client.clone(), tx.clone());
                    tokio::spawn(async move {
                        let result = client.get_bot_commands(&guild_id).await.map_err(|e| e.to_string());
                        let _ = tx.send(EngineInput::CommandsLoaded { guild_id, result });
                    });
                }
                Effect::SetActiveChannel(c) => client.set_active_channel(c),
                Effect::SendSlash { id, channel_id, name, options } => {
                    let (client, tx) = (client.clone(), tx.clone());
                    tokio::spawn(async move {
                        let ok = client.send_slash(&channel_id, &name, options).await.is_ok();
                        let _ = tx.send(EngineInput::SendResult { id, ok });
                    });
                }
                other => {
                    let _ = out.send(other).await;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discord::LoginError;
    use crate::engine::sim::{one_fish, target, test_config};
    use crate::model::{ChannelInfo, EngineState, GuildInfo, SelfUser, SlashCommandInfo, SlashOptions};
    use anyhow::Result;
    use async_trait::async_trait;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use tokio::sync::broadcast;

    struct Fake {
        sent: Mutex<Vec<(String, String)>>,
        active: Mutex<Option<String>>,
        events: broadcast::Sender<DiscordEvent>,
    }

    #[async_trait]
    impl DiscordClient for Fake {
        async fn login(&self, _: &str) -> std::result::Result<SelfUser, LoginError> {
            Ok(SelfUser { id: "me".into(), username: "t".into(), avatar_url: String::new() })
        }
        async fn logout(&self) {}
        async fn list_guilds(&self, _: bool) -> Result<Vec<GuildInfo>> {
            Ok(vec![])
        }
        async fn list_channels(&self, _: &str) -> Result<Vec<ChannelInfo>> {
            Ok(vec![])
        }
        async fn get_bot_commands(&self, _: &str) -> Result<Vec<SlashCommandInfo>> {
            Ok(vec![SlashCommandInfo { name: "fish".into(), id: "1".into(), version: "1".into(), options: vec![] }])
        }
        async fn send_slash(&self, channel_id: &str, command: &str, _: SlashOptions) -> Result<()> {
            self.sent.lock().unwrap().push((channel_id.into(), command.into()));
            Ok(())
        }
        fn set_active_channel(&self, c: Option<String>) {
            *self.active.lock().unwrap() = c;
        }
        fn subscribe(&self) -> broadcast::Receiver<DiscordEvent> {
            self.events.subscribe()
        }
        fn seed_vf_cache(&self, _: HashMap<String, bool>) {}
        fn vf_cache(&self) -> HashMap<String, bool> {
            HashMap::new()
        }
        fn set_capture_dir(&self, _: Option<PathBuf>) {}
    }

    #[tokio::test(start_paused = true)]
    async fn start_sends_fish_and_a_catch_brings_the_next_fish_after_the_delay() {
        let (events, _) = broadcast::channel(16);
        let fake = Arc::new(Fake { sent: Mutex::new(vec![]), active: Mutex::new(None), events });
        let (_cfg_tx, cfg_rx) = watch::channel(test_config(|_| {}));
        let (out_tx, mut out_rx) = mpsc::channel(256);
        let engine = spawn_engine(fake.clone(), cfg_rx, out_tx);
        let fish = || fake.sent.lock().unwrap().iter().filter(|(_, n)| n == "fish").count();

        engine.send(EngineInput::Start { target: target("g1", "A") });
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(fish(), 1);
        assert_eq!(fake.sent.lock().unwrap()[0].0, "A");
        assert_eq!(fake.active.lock().unwrap().as_deref(), Some("A"));

        let mut catch = one_fish();
        catch.id = "m1".into();
        catch.channel_id = "A".into();
        fake.events.send(DiscordEvent::BotMessage(catch)).unwrap();
        tokio::time::sleep(Duration::from_millis(2_600)).await; // fish delay ≥ 2.7 s
        assert_eq!(fish(), 1);
        tokio::time::sleep(Duration::from_millis(2_000)).await; // ≤ 4.3 s
        assert_eq!(fish(), 2);

        let mut states = vec![];
        while let Ok(e) = out_rx.try_recv() {
            assert!(!matches!(e, Effect::SendSlash { .. } | Effect::LoadCommands { .. }), "Discord effects stay in the actor");
            if let Effect::State { state, .. } = e {
                states.push(state);
            }
        }
        assert_eq!(states, [EngineState::Connecting, EngineState::Running]);
    }
}
