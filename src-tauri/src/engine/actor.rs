//! Engine actor: owns the `EngineCore` on a tokio task, feeds it UI inputs, Discord events, config
//! changes and wakeups, executes its Discord effects (command loads, slash sends), saves state.json
//! (when given a `StatePersistence`) and forwards the rest (state, game patches, logs, toasts,
//! captcha) to `out`.

use super::core::{Effect, EngineCore, EngineInput};
use crate::discord::{DiscordClient, DiscordEvent};
use crate::model::{Config, EngineStatus, SlashCommandInfo};
use crate::persist::wire::StatePersistence;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;

pub enum ActorMsg {
    Input(EngineInput),
    Status(oneshot::Sender<EngineStatus>),
    Commands(oneshot::Sender<Vec<SlashCommandInfo>>),
    /// Saves state.json now (quit path).
    Flush(oneshot::Sender<()>),
}

#[derive(Clone)]
pub struct EngineHandle {
    tx: mpsc::UnboundedSender<ActorMsg>,
}

impl EngineHandle {
    pub fn send(&self, input: EngineInput) {
        let _ = self.tx.send(ActorMsg::Input(input));
    }

    /// None when the actor is gone.
    pub async fn status(&self) -> Option<EngineStatus> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(ActorMsg::Status(tx)).ok()?;
        rx.await.ok()
    }

    pub async fn commands(&self) -> Vec<SlashCommandInfo> {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(ActorMsg::Commands(tx)).is_err() {
            return vec![];
        }
        rx.await.unwrap_or_default()
    }

    pub async fn flush(&self) {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(ActorMsg::Flush(tx)).is_ok() {
            let _ = rx.await;
        }
    }
}

/// Epoch milliseconds that advance with tokio's clock (so tests can pause time).
pub struct Clock {
    base_ms: i64,
    base: Instant,
}

impl Default for Clock {
    fn default() -> Self {
        let base_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        Self { base_ms, base: Instant::now() }
    }
}

impl Clock {
    pub fn now_ms(&self) -> i64 {
        self.base_ms + self.base.elapsed().as_millis() as i64
    }
    fn instant_at(&self, ms: i64) -> Instant {
        self.base + Duration::from_millis((ms - self.base_ms).max(0) as u64)
    }
}

pub fn spawn_engine(client: Arc<dyn DiscordClient>, cfg: watch::Receiver<Config>, out: mpsc::Sender<Effect>) -> EngineHandle {
    spawn_engine_with(EngineCore::new(rand::random()), client, cfg, out, None)
}

/// Same with a prepared core and optional state.json persistence (hydrated here).
pub fn spawn_engine_with(
    mut core: EngineCore,
    client: Arc<dyn DiscordClient>,
    cfg: watch::Receiver<Config>,
    out: mpsc::Sender<Effect>,
    persist: Option<StatePersistence>,
) -> EngineHandle {
    let clock = Clock::default();
    if let Some(p) = &persist {
        p.hydrate(&mut core, clock.now_ms());
    }
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(run(Actor { core, client, persist, out, tx: tx.clone(), clock }, cfg, rx));
    EngineHandle { tx }
}

struct Actor {
    core: EngineCore,
    client: Arc<dyn DiscordClient>,
    persist: Option<StatePersistence>,
    out: mpsc::Sender<Effect>,
    tx: mpsc::UnboundedSender<ActorMsg>,
    clock: Clock,
}

impl Actor {
    fn next_wakeup(&self) -> Option<i64> {
        let p = self.persist.as_ref().and_then(|p| p.next_wakeup());
        match (self.core.next_wakeup(), p) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    async fn handle(&mut self, input: EngineInput, cfg: &Config) {
        let now = self.clock.now_ms();
        let effects = self.core.handle(input, now, cfg);
        if let Some(p) = self.persist.as_mut() {
            for e in &effects {
                p.observe(e, now, self.core.game());
            }
            p.poll(now, self.core.game());
        }
        for e in effects {
            match e {
                Effect::LoadCommands { guild_id } => {
                    let (client, tx) = (self.client.clone(), self.tx.clone());
                    tokio::spawn(async move {
                        let result = client.get_bot_commands(&guild_id).await.map_err(|e| e.to_string());
                        let _ = tx.send(ActorMsg::Input(EngineInput::CommandsLoaded { guild_id, result }));
                    });
                }
                Effect::SetActiveChannel(c) => self.client.set_active_channel(c),
                Effect::SendSlash { id, channel_id, name, options } => {
                    let (client, tx) = (self.client.clone(), self.tx.clone());
                    tokio::spawn(async move {
                        let ok = client.send_slash(&channel_id, &name, options).await.is_ok();
                        let _ = tx.send(ActorMsg::Input(EngineInput::SendResult { id, ok }));
                    });
                }
                other => {
                    let _ = self.out.send(other).await;
                }
            }
        }
    }
}

async fn run(mut a: Actor, mut cfg: watch::Receiver<Config>, mut rx: mpsc::UnboundedReceiver<ActorMsg>) {
    let mut events = a.client.subscribe();
    let (mut events_open, mut cfg_open) = (true, true);
    loop {
        let wake = a.next_wakeup();
        let input = tokio::select! {
            m = rx.recv() => match m {
                None => return,
                Some(ActorMsg::Input(i)) => i,
                Some(ActorMsg::Status(reply)) => {
                    let _ = reply.send(a.core.status());
                    continue;
                }
                Some(ActorMsg::Commands(reply)) => {
                    let _ = reply.send(a.core.commands().to_vec());
                    continue;
                }
                Some(ActorMsg::Flush(reply)) => {
                    if let Some(p) = a.persist.as_mut() {
                        p.flush(a.core.game());
                    }
                    let _ = reply.send(());
                    continue;
                }
            },
            ev = events.recv(), if events_open => match ev {
                Ok(DiscordEvent::BotMessage(m)) => EngineInput::Bot(m),
                Ok(DiscordEvent::Disconnected | DiscordEvent::InvalidToken) => EngineInput::Disconnected, // AppCore stops it
                Ok(DiscordEvent::Reconnected) => EngineInput::Reconnected,
                Ok(DiscordEvent::RateLimited(ms)) => EngineInput::RateLimited(ms),
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => {
                    events_open = false;
                    continue;
                }
            },
            _ = tokio::time::sleep_until(a.clock.instant_at(wake.unwrap_or(0))), if wake.is_some() => EngineInput::Tick,
            r = cfg.changed(), if cfg_open => {
                cfg_open = r.is_ok();
                EngineInput::Tick // hot reload: delays and gaps are re-read now
            }
        };
        let config = cfg.borrow().clone();
        a.handle(input, &config).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discord::fake::FakeClient;
    use crate::engine::sim::{one_fish, target, test_config};
    use crate::model::{EngineState, SlashCommandInfo};

    #[tokio::test(start_paused = true)]
    async fn start_sends_fish_and_a_catch_brings_the_next_fish_after_the_delay() {
        let fake = FakeClient::new();
        *fake.commands.lock().unwrap() = vec![SlashCommandInfo { name: "fish".into(), id: "1".into(), version: "1".into(), options: vec![] }];
        let (_cfg_tx, cfg_rx) = watch::channel(test_config(|_| {}));
        let (out_tx, mut out_rx) = mpsc::channel(256);
        let engine = spawn_engine(fake.clone(), cfg_rx, out_tx);
        let fish = || fake.names().iter().filter(|n| *n == "fish").count();

        engine.send(EngineInput::Start { target: target("g1", "A") });
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(fish(), 1);
        assert_eq!(fake.sent.lock().unwrap()[0].0, "A");
        assert_eq!(fake.active().as_deref(), Some("A"));
        assert_eq!(engine.status().await.unwrap().state, EngineState::Running);
        assert_eq!(engine.commands().await.len(), 1);

        fake.emit_bot(one_fish());
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
