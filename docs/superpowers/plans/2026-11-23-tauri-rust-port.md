# Virtual AutoFisher 2.0 (Tauri + Rust) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Electron main process with a Rust/Tauri backend that has full behaviour parity with v1.0.4, keeping the React UI.

**Architecture:** A Tauri 2 app (`src-tauri/`). The engine is a **pure, time-injected core** (`EngineCore::handle(input, now) -> Vec<Effect>`) driven by one tokio actor task; the queue and scheduler are pure state machines polled with `now`, so every TS fake-timer test ports to a deterministic Rust simulation. A hand-written Discord user-account client (Gateway WS + REST) sits behind a `DiscordClient` trait. The React renderer is kept; `window.api` is re-implemented over Tauri `invoke`/`listen` with the same contract.

**Tech Stack:** Rust stable 1.99, Tauri 2 (+ plugins notification, single-instance, opener), tokio, tokio-tungstenite (rustls), reqwest (rustls, json), serde/serde_json, windows (DPAPI), thiserror, async-trait, rand; React 18 + Vite + Vitest (frontend unchanged).

**Spec:** `docs/superpowers/specs/2026-11-23-tauri-rust-port-design.md` — parity reference: the TypeScript sources and tests on `main` @ a232f02 (v1.0.4). Each task names the TS module/tests it ports; read them, they are the detailed behaviour spec.

## Global Constraints

- Branch `tauri-rust`. Windows x64 only. Identifier/appId `com.r3con.virtualautofisher`, product name `Virtual AutoFisher`.
- Data folder exactly `%APPDATA%\virtual-autofisher\` (`dirs::config_dir()/virtual-autofisher`), never Tauri's default app-data dir.
- `config.json` / `state.json` keep the v1 JSON schemas (camelCase keys); token stored as `tokenEncrypted: "dpapi:<base64>"`; any other format is ignored (user re-enters the token).
- The token never appears in Tauri events, command results, logs, `state.json`, captures or committed files. Logger masks `[\w-]{24,}\.[\w-]{6}\.[\w-]{27,}` → `***TOKEN***`.
- Captcha safety: while `captcha`, nothing but a user-clicked `/verify` is sent; `/verify` never retried or auto-sent.
- Discord identity: Gateway v9 Identify `properties`, `capabilities: 0`, `compress: false`, `client_state: { guild_versions: {} }` and REST headers copied from `node_modules/discord.js-selfbot-v13/src/util/Options.js` (lines 192–219) and `src/rest/APIRequest.js` (lines 55–76), kept in one module `discord/identity.rs`. Command index cached per guild (not re-fetched per command).
- Timing constants (from v1.0.4): response timeout 8 s, deferred (LOADING) reply 30 s, min gap `minGapSec` (×1.5 for 5 min after 429), max 3 consecutive no-answers → pause, network grace 2 min, graceful stop cap 25 s, captcha resume 5–15 s, no-funds block 30 min, log cap 500, state save debounce 2 s, auto-login retry 30 s / 60 s / every 120 s.
- All UI text English. Frontend files outside `src/renderer/api.ts` / `src/renderer/main.tsx` change only if a task says so.
- Every Rust module ships with its ported tests; `cargo clippy --all-targets -- -D warnings` and `cargo test` pass at each commit; `npm test` (renderer helpers) keeps passing.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Gateway connection drops mid-session (WS close / op 7 Reconnect) → client resumes with session_id + last seq; the engine sees `Disconnected` then `Reconnected` and resumes fishing. → test in Task 4.
2. op 9 Invalid Session (non-resumable) → fresh Identify, not a crash or a silent dead client. → test in Task 4.
3. First launch on a PC without `%APPDATA%\virtual-autofisher\` (fresh install) → folder created, defaults used, no panic. → test in Task 2.
4. A message in another channel, or from another user's interaction, while fishing → never counted, never captcha. → test in Task 3.
5. App closed during a session with the token-less renderer reloading (Ctrl+R disabled in prod, but `engine.status` must rebuild state) → `engine_status` returns state, captcha, snapshot, no token. → test in Task 10.

---

## File Structure

```
src-tauri/
  Cargo.toml, build.rs, tauri.conf.json, capabilities/default.json, icons/ (from build/, resources/)
  windows/hooks.nsh                 NSIS hook: uninstall Electron 1.x
  src/main.rs                       thin: calls lib::run()
  src/lib.rs                        Tauri builder, plugins, state, setup
  src/model.rs                      serde mirrors of src/shared/types.ts + ipc payloads
  src/paths.rs                      data dir + sub-paths
  src/logger.rs                     masked, rotating log
  src/config.rs                     ConfigStore + public_config + clamp-free deep merge
  src/dpapi.rs                      Cipher trait + DPAPI impl
  src/discord/{mod,identity,model_conv,components,slash,rest,gateway,permissions,client}.rs
  src/parser/{mod,text,rules/*.rs}.rs
  src/engine/{queue,humanize,game_state,edit_deduper,captcha,scheduler,core,actor,sim}.rs
  src/persist/{state_store,wire}.rs
  src/ipc/{commands,events}.rs
  src/shell/{tray,notify,notify_events}.rs
  examples/discord_probe.rs         owner live checkpoint 1
src/renderer/api.ts                 window.api over @tauri-apps/api
vite.config.ts                      renderer-only Vite config (replaces electron.vite.config.ts)
tests/fixtures/                     kept; read by Rust tests via CARGO_MANIFEST_DIR/../tests/fixtures
```

Removed in Task 10: `src/main/`, `src/preload/`, `electron.vite.config.ts`, `electron-builder.yml`, TS tests of main-process code (`tests/{config,discord,engine,ipc,parser,persist,shared}`, `tests/helpers`, `tests/smoke.test.ts`), Electron deps.

---

### Task 1: Tauri skeleton, shared model, paths, logger

**Files:** Create `src-tauri/**` (Cargo.toml, build.rs, tauri.conf.json, capabilities, icons, `src/{main,lib,model,paths,logger}.rs`), `vite.config.ts`; Modify `package.json` (scripts `dev: tauri dev`, `build: tauri build`, `vite:dev`, `vite:build`; deps `@tauri-apps/api@2`, devDeps `@tauri-apps/cli@2`); Create `tests/fixtures/model/default-config.json` (generated from TS `DEFAULT_CONFIG` via `node -e` before Electron code is removed).
Test: `src-tauri/src/model.rs` (unit), `src-tauri/src/logger.rs` (unit), `src-tauri/src/paths.rs` (unit).

**Interfaces — Produces:**
- `model.rs`: `Config` (+ `impl Default` = v1 `DEFAULT_CONFIG`), `BotMessage { id, channel_id, content, embeds: Vec<Embed>, ephemeral, loading: bool, is_edit, interaction_user_id: Option<String> }`, `Embed`, `GameEvent` (`#[serde(tag="kind", rename_all="camelCase")]`, all v1 kinds), `GameSnapshot`, `LogEntry`, `Boost`, `RareCounts`, `SessionSummary`, `PersistedAccount`, `EngineState` (8 states, lowercase), `PauseReason`, `EngineInfo`, `SelfUser`, `GuildInfo`, `ChannelInfo`, `SlashCommandInfo`/`SlashOption`, `CaptchaPayload`, `EngineStatus`, `AuthStatus`, `ConnectionStatus`, `Toast`. All `#[serde(rename_all = "camelCase")]`, optional fields `skip_serializing_if = "Option::is_none"`.
- `paths.rs`: `fn data_dir() -> PathBuf`; `struct Paths { root, config, state, logs, sessions, captures }` with `Paths::new(root: PathBuf)` and `Paths::ensure(&self) -> io::Result<()>` (mkdir -p).
- `logger.rs`: `fn mask_secrets(s: &str) -> String`; `struct Logger` with `Logger::new(dir: PathBuf)`, `info/warn/error(&self, msg: &str)`; rotation `app.log` → `app.1.log` above 5 * 1024 * 1024 bytes; never panics.
- tauri.conf.json: identifier `com.r3con.virtualautofisher`, version `../package.json`, window title `Virtual AutoFisher`, min 1000×680, `devUrl` Vite, `frontendDist ../out/renderer`, bundle target `nsis`, icon `icons/icon.ico`.

- [ ] **Step 1:** Generate the golden default config: `node -e "…import DEFAULT_CONFIG…"` (via `npx tsx`) → `tests/fixtures/model/default-config.json`.
- [ ] **Step 2: failing tests** — `default_config_matches_v1` (serde_json::to_value(Config::default()) == golden file); `bot_message_camel_case_roundtrip` (parses `tests/fixtures/messages/catch-basic.json`); `game_event_tagged` (`{"kind":"cooldown","waitMs":2400}` → `GameEvent::Cooldown{wait_ms:2400}`); `mask_secrets_hides_token` (input `token MTA4MTIzNDU2Nzg5MDEyMzQ1Ng.GabcdE.abcdefghijklmnopqrstuvwxyz0 here` → no token substring, contains `***TOKEN***`); `logger_rotates_at_5mb`; `paths_ensure_creates_missing_dirs` (Review Focus 3: temp root that doesn't exist → all sub-dirs exist after `ensure`).
- [ ] **Step 3:** `cargo test` in `src-tauri` → FAIL (types missing).
- [ ] **Step 4:** Implement; scaffold Tauri with an empty window loading the existing renderer via Vite (`vite.config.ts`: root `src/renderer`, outDir `out/renderer`, react plugin). Window shows the app's splash/onboarding (the `window.api` bridge comes in Task 10 — until then `main.tsx` may log a missing-api warning).
- [ ] **Step 5:** `cargo test` PASS; `cargo clippy --all-targets -- -D warnings` clean; `npm run dev` opens the Tauri window.
- [ ] **Step 6:** Commit `feat(tauri): skeleton, shared model, paths and logger`.

---

### Task 2: Config store and DPAPI token storage

**Files:** Create `src-tauri/src/{config,dpapi}.rs`. Ports `src/main/config/ConfigStore.ts`, `tests/config/ConfigStore.test.ts`.

**Interfaces — Produces:**
- `trait Cipher: Send + Sync { fn encrypt(&self, s: &str) -> Result<String>; fn decrypt(&self, s: &str) -> Result<String>; fn available(&self) -> bool }`; `struct DpapiCipher` (CryptProtectData/CryptUnprotectData, current user, output `dpapi:<base64>`; decrypt rejects other prefixes).
- `struct ConfigStore { … }`: `new(paths: &Paths, cipher: Arc<dyn Cipher>, logger: Arc<Logger>) -> Self`, `load(&mut self) -> Config`, `get(&self) -> Config`, `update(&mut self, patch: serde_json::Value) -> Config` (deep merge; `target` replaced wholesale; `tokenEncrypted` key in patch ignored), `set_token(&mut self, token: &str) -> Result<()>` (error `"Encryption unavailable"` if `!available()`), `token(&self) -> Option<String>` (None on missing/undecryptable, warns), `clear_token`, `subscribe(&self) -> tokio::sync::watch::Receiver<Config>`; atomic write `config.json.tmp` → rename; corrupt JSON → defaults + `config.bak.json`.
- `fn public_config(c: &Config) -> Config` (token field stripped).

- [ ] **Step 1: failing tests** (port each TS case): defaults when no file; deep merge keeps siblings; target replaced; patch can't set `tokenEncrypted`; token not in file plaintext (fake reversible cipher); corrupt → bak; leftover `.tmp` ignored; old Electron-format token (`"djEw…"` without `dpapi:`) → `token()` is None; fresh missing dir (Review Focus 3) works; `dpapi_roundtrip` (real DPAPI, `#[cfg(windows)]`).
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS + clippy.
- [ ] **Step 5:** Commit `feat(config): config store with DPAPI token`.

---

### Task 3: Discord message model, Components V2, slash payloads

**Files:** Create `src-tauri/src/discord/{mod,identity,model_conv,components,slash}.rs`. Ports `toBotMessage.ts`, `orderSlashArgs.ts`, the V2 conversion and their tests (`tests/discord/{toBotMessage,componentsV2,orderSlashArgs}.test.ts`, `tests/parser/realMessages.test.ts` loaders).

**Interfaces — Produces:**
- `pub const VIRTUAL_FISHER_ID: &str = "574652751745777665"`.
- `fn to_bot_message(raw: &serde_json::Value, self_id: &str, is_edit: bool) -> Option<BotMessage>` — input is the **Gateway** message JSON (`author.id`, `interaction_metadata.user.id` / `interaction.user.id`, `mentions[]`, `flags` (64 ephemeral, 128 loading), `embeds[]` (`image.url`, `footer.text`), `components[]` numeric types 17/10/9/12/11/1, `attachments[]`). Same accept rule as v1 (safety-critical).
- `fn components_to_embeds(components: &[Value]) -> Vec<Embed>` (heading/bold-only first line → title).
- `fn order_slash_args(info: &SlashCommandInfo, options: &SlashOptions) -> Result<Vec<Option<Value>>>` (`"Option inconnue"` → English `"Unknown option: {name}"`).
- `fn interaction_payload(cmd: &SlashCommandInfo, app_id: &str, guild_id: &str, channel_id: &str, session_id: &str, nonce: &str, options: &SlashOptions) -> Value` (type 2; `data: {version, id, name, type: 1, options: [{type, name, value}]}`, gaps omitted).
- `identity.rs`: `fn super_properties() -> Value`, `fn super_properties_b64() -> String`, `fn rest_headers(token: &str) -> HeaderMap`, `fn identify_payload(token: &str) -> Value` (values copied from the library, see Global Constraints).
- `type SlashOptions = BTreeMap<String, Value>`.

- [ ] **Step 1: failing tests** — every v1 case ported with gateway-shaped JSON; the 10 real fixtures in `tests/fixtures/messages/real/` (their `rawComponents` become `components`) convert to the same embeds as v1; `foreign_interaction_and_other_channel_ignored` (Review Focus 4: other user's `interaction_metadata` → None; channel filtering stays in the client, test in Task 4); `loading_flag_128`; `payload_matches_library_shape` (snapshot of `interaction_payload` for `/sell amount:all`); `identify_has_library_properties` (keys `os`,`browser`,`client_build_number`,`capabilities`=0,`compress`=false).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + clippy.
- [ ] **Step 5:** Commit `feat(discord): message conversion, components V2, slash payloads`.

---

### Task 4: Discord Gateway + REST client, and the live probe

**Files:** Create `src-tauri/src/discord/{rest,gateway,permissions,client}.rs`, `src-tauri/examples/discord_probe.rs`. Ports `SelfbotClient.ts`, `detectVirtualFisher.ts`, `classifyLoginError.ts` and their tests.

**Interfaces — Produces:**
- `enum DiscordEvent { BotMessage(BotMessage), Disconnected, Reconnected, RateLimited(u64) }`.
- `enum LoginError { InvalidToken, Network }` with messages `"Invalid or expired token"` / `"Unable to connect to Discord"`.
- `#[async_trait] trait DiscordClient: Send + Sync { async fn login(&self, token: &str) -> Result<SelfUser, LoginError>; async fn logout(&self); async fn list_guilds(&self, refresh: bool) -> Result<Vec<GuildInfo>>; async fn list_channels(&self, guild_id: &str) -> Result<Vec<ChannelInfo>>; async fn get_bot_commands(&self, guild_id: &str) -> Result<Vec<SlashCommandInfo>>; async fn send_slash(&self, channel_id: &str, command: &str, options: SlashOptions) -> Result<()>; fn set_active_channel(&self, channel_id: Option<String>); fn subscribe(&self) -> broadcast::Receiver<DiscordEvent>; fn seed_vf_cache(&self, m: HashMap<String,bool>); fn vf_cache(&self) -> HashMap<String,bool>; }`
- `struct LiveClient` implementing it; `struct GatewayConfig { url: String, api_base: String }` (overridable for tests).
- `permissions.rs`: `fn can_use_commands(guild: &GuildState, channel: &ChannelState, member: &MemberState) -> bool` (VIEW_CHANNEL + SEND_MESSAGES + USE_APPLICATION_COMMANDS; @everyone, roles, overwrites, admin, owner).
- Behaviour: login validates by completing Identify→READY (20 s timeout), swaps clients only on success; heartbeat with jitter; op 7 / close → Resume(session_id, seq) with backoff, emitting `Disconnected` once then `Reconnected`; op 9 non-resumable → new Identify; MESSAGE_CREATE/UPDATE → `to_bot_message` + active-channel filter → `BotMessage`; capture mode writes `{…BotMessage, rawComponents}` to `captures/<ms>-<id>.json`; 429 → `RateLimited(retry_after ms)` + retry; VF detection via command index (true/false cached, errors not cached).

- [ ] **Step 1: failing tests** with a local mock Gateway (tokio-tungstenite server) and mock REST (axum or `wiremock`): handshake Hello→Identify(properties checked)→READY → `login` returns user; heartbeat sent; `resume_after_close` (Review Focus 1: server closes → client sends op 6 with last seq → `Disconnected`,`Reconnected` emitted once each); `invalid_session_reidentifies` (Review Focus 2); `other_channel_message_dropped` (Review Focus 4); `send_slash_posts_interaction` (body = `interaction_payload`, headers include `x-super-properties`, `Authorization` raw token); `vf_detection_caching`; `invalid_token_vs_network` (close 4004 → InvalidToken; connection refused → Network); `permissions_*` (owner, admin, overwrite deny, role allow).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + clippy.
- [ ] **Step 5:** `examples/discord_probe.rs`: reads token from env `VAF_TOKEN` (never printed), logs in, prints user, guilds with VF, channels of a guild given as arg; with `--send <channelId> profile` sends `/profile` and prints the converted reply text. Builds with `cargo build --example discord_probe`.
- [ ] **Step 6:** Commit `feat(discord): gateway and REST user client`.
- [ ] **Step 7: OWNER CHECKPOINT 1** — stop and ask the owner to run (their terminal; token stays on their machine):
  ```powershell
  $env:VAF_TOKEN="<token>"; cargo run --example discord_probe -- <guildId>
  cargo run --example discord_probe -- --send <channelId> profile
  ```
  Expected: their username, the VF servers, the channel list, and the `/profile` reply text. Fix what fails before Task 5.

---

### Task 5: Parser

**Files:** Create `src-tauri/src/parser/{mod,text}.rs`, `src-tauri/src/parser/rules/{captcha,catch,sell,inventory,stats,boosts,boosters,purchase,daily,quests,cooldown,error}.rs`. Ports `src/main/parser/**`, `tests/parser/*.test.ts`, `tests/shared/boosters.test.ts`.

**Interfaces — Produces:** `fn parse_message(m: &BotMessage, now_ms: i64) -> GameEvent`; `text.rs`: `clean_text`, `parse_number`, `parse_duration`, `build_text`, `raw_text`, `titles_of`, `description_of`, `lines`, `after_colon`; rule order identical to v1 `parser/index.ts`.

- [ ] **Step 1: failing tests** — port every case of `text.test.ts`, `parseMessage.test.ts`, `realMessages.test.ts` (same fixtures, same expected values), `discordMarkdown` captcha case (captcha `text` = `raw_text`).
- [ ] **Step 2:** FAIL. **Step 3:** implement (regex crate; same patterns as v1). **Step 4:** PASS + clippy.
- [ ] **Step 5:** Commit `feat(parser): port the message parser`.

---

### Task 6: Command queue and humanization (pure, time-injected)

**Files:** Create `src-tauri/src/engine/{mod,queue,humanize}.rs`. Ports `CommandQueue.ts`, `humanize.ts`, their tests.

**Interfaces — Produces:**
- `enum Priority { Manual, Verify, Maintenance, Fish }`; `struct QueuedCommand { name: String, options: SlashOptions, priority: Priority, key: Option<String>, id: u64 }` (`id` identifies copies for retry tracking).
- `struct CommandQueue` with `new(response_timeout_ms: u64)`, `push(&mut self, c) -> bool` (dedupe by key), `clear`, `pause`, `resume`, `hold_for(now, ms)`, `notify_response(&mut self)`, `extend_timeout(now, ms)`, `send_failed(&mut self, now)`, `poll(&mut self, now: i64, min_gap_ms: u64) -> Option<QueueAction>`, `next_wakeup(&self, min_gap_ms: u64) -> Option<i64>`, `in_flight(&self) -> Option<&QueuedCommand>`.
- `enum QueueAction { Send(QueuedCommand), TimedOut(QueuedCommand) }`.
- `humanize.rs`: `fn fish_delay_ms(cfg: &FishingConfig, rng: &mut impl Rng) -> u64`, `fn random_between_ms(min_s: f64, max_s: f64, rng: &mut impl Rng) -> u64` (same distributions/bounds as v1).

- [ ] **Step 1: failing tests** — every `CommandQueue.test.ts` / `humanize.test.ts` case, rewritten as explicit `now` steps (e.g. push fish, poll(0) → Send; poll(7999) → None; poll(8000) → TimedOut).
- [ ] **Step 2–4:** FAIL → implement → PASS + clippy.
- [ ] **Step 5:** Commit `feat(engine): command queue and humanize`.

---

### Task 7: Game state

**Files:** Create `src-tauri/src/engine/game_state.rs`. Ports `GameState.ts`, `tests/engine/GameState.test.ts`, `notifyEvents` detection inputs.

**Interfaces — Produces:** `struct GameState` with `apply(&mut self, e: &GameEvent, now: i64) -> Patch`, `note`, `mark_captcha`, `start_session(now)`, `end_session(now) -> SessionSummary`, `set_next_fish_at`, `set_next_daily_at`, `hydrate(PersistedState)`, `persisted() -> PersistedState`, `snapshot() -> GameSnapshot`, `catches_since_sell()`, `bait_estimate()`; `struct Patch { patch: serde_json::Value /* section-level, replace semantics */, new_log: Vec<LogEntry> }` (empty when nothing changed).

- [ ] **Step 1: failing tests** — port all GameState cases (session counters, log cap 500, level-up highlight flag, quest completed line, fish value gain + sells, last session kept after `end_session`, hydrate doesn't touch session).
- [ ] **Step 2–4:** FAIL → implement → PASS + clippy.
- [ ] **Step 5:** Commit `feat(engine): game state`.

---

### Task 8: Scheduler

**Files:** Create `src-tauri/src/engine/scheduler.rs`. Ports `Scheduler.ts` (slots, freeze/thaw with remaining time, rest, buff cycle, boosters, daily gating, quests refresh, redo after captcha, defer/rearm).

**Interfaces — Produces:** `struct Scheduler` with `start(&mut self, now, cfg: &Config, commands: &[SlashCommandInfo], state: &GameState)`, `stop`, `freeze(now)`, `thaw(now)`, `on_event(&mut self, e: &GameEvent, now, cfg, state)`, `retry_fish(now, cfg)`, `on_settled(&QueuedCommand)`, `on_command_failed(&QueuedCommand, now)`, `on_queue_cleared(now)`, `defer_command(QueuedCommand, ms, now)`, `rearm(key, ms, now) -> bool`, `after_use(now)`, `block_purchases(what, ms, now)`, `is_resting()`, `poll(&mut self, now, cfg, state, commands) -> Vec<SchedAction>`, `next_wakeup() -> Option<i64>`; `enum SchedAction { Push(QueuedCommand), Rest(bool) }`.

- [ ] **Step 1: failing tests** — Scheduler-level cases from `Engine.test.ts` (buffs, daily, sell, breaks), `buffCycle.test.ts`, `boosters.test.ts`, `dailyPersistence.test.ts` (gating parts), `settingsHotReload.test.ts`, driven directly through `Scheduler` with explicit `now`.
- [ ] **Step 2–4:** FAIL → implement → PASS + clippy.
- [ ] **Step 5:** Commit `feat(engine): scheduler`.

---

### Task 9: Engine core, captcha flow, edit dedupe, simulation harness

**Files:** Create `src-tauri/src/engine/{edit_deduper,captcha,core,sim,actor}.rs`. Ports `Engine.ts`, `captchaFlow.ts`, `EditDeduper.ts`, tests `Engine.test.ts`, `deferredReply.test.ts`, `FakeDiscordClient.test.ts` (as sim tests).

**Interfaces — Produces:**
- `enum EngineInput { Start{target}, Pause, Resume, Stop{graceful: bool}, SendManual{name, options}, SubmitCaptcha(String), RegenCaptcha, UseTarget{target}, Detach, Bot(BotMessage), Disconnected, Reconnected, RateLimited(u64), CommandsLoaded{guild_id, Result<Vec<SlashCommandInfo>>}, SendResult{id, ok: bool}, Tick }`.
- `enum Effect { LoadCommands{guild_id}, SetActiveChannel(Option<String>), SendSlash{id, channel_id, name, options}, State{state, info}, Commands(Vec<SlashCommandInfo>), GamePatch(Patch), SessionEnded(SessionSummary), Log{level, msg}, Toast(Toast), CaptchaShow(CaptchaPayload), CaptchaHide }`.
- `struct EngineCore` with `new(rng_seed: u64)`, `handle(&mut self, input: EngineInput, now: i64, cfg: &Config) -> Vec<Effect>`, `next_wakeup(&self) -> Option<i64>`, `state()`, `status() -> EngineStatus`, `commands()`.
- `sim.rs` (test-only helper): `Sim { core, now, cfg, sent: Vec<(String, SlashOptions)>, effects }` with `start(target)`, `advance(ms)` (Tick at every wakeup ≤ target, auto-acks `SendResult`), `emit_bot(Partial)`, `names()`; deterministic `rand = 0.5` equivalent.
- `actor.rs`: `fn spawn_engine(client: Arc<dyn DiscordClient>, cfg: watch::Receiver<Config>, out: mpsc::Sender<Effect>) -> EngineHandle` (`EngineHandle::send(EngineInput)`); loop: `select!` over input channel, client events, `sleep_until(core.next_wakeup())`; executes `LoadCommands`/`SendSlash` on the client and feeds results back.

- [ ] **Step 1: failing tests** — port every case in `Engine.test.ts`, `deferredReply.test.ts`, the captcha/stop/idle/manual cases from `boosters.test.ts`/`dailyPersistence.test.ts`, as `Sim` scenarios with the same timings and assertions (strict captcha test: 10 min advance, zero sends, no verify).
- [ ] **Step 2–4:** FAIL → implement → PASS + clippy.
- [ ] **Step 5:** `actor` smoke test with a fake `DiscordClient`: start → `SendSlash fish` reaches the client; bot catch → second fish after the delay (tokio paused time).
- [ ] **Step 6:** Commit `feat(engine): engine core, captcha flow, simulation`.

---

### Task 10: Persistence, IPC, renderer bridge, Electron removal

**Files:** Create `src-tauri/src/persist/{state_store,wire}.rs`, `src-tauri/src/ipc/{commands,events}.rs`, `src/renderer/api.ts`; Modify `src-tauri/src/lib.rs`, `src/renderer/main.tsx` (install `window.api` before render), `src/renderer/env.d.ts`; Delete Electron code and TS main tests (see File Structure). Ports `StateStore.ts`, `wireStatePersistence.ts`, `handlers.ts` and tests.

**Interfaces — Produces:**
- `StateStore` (`load`, `save`, `vf_guilds`, `set_vf_guilds`; atomic write; old files load), `wire_state_persistence` (hydrate at boot, save on session end / nextDailyAt change / 2 s after account change / quit).
- Tauri commands (snake_case Rust, invoked from `api.ts` with these exact names): `auth_set_token(token) -> SelfUser`, `auth_logout`, `auth_status -> AuthStatus`, `guilds_list(refresh: bool)`, `channels_list(guild_id)`, `target_set(guild_id, channel_id)`, `engine_start`, `engine_pause`, `engine_resume`, `engine_stop(graceful: bool)`, `engine_commands`, `engine_status -> EngineStatus`, `command_send(name, options)`, `captcha_submit(answer)`, `captcha_regen`, `config_get -> Config` (public), `config_update(patch) -> Config` (public; target stripped), `app_open_data_dir`. Ids validated `^\d{5,25}$`. Errors returned as masked strings.
- Events emitted with the v1 `EventMap` names and payloads: `engine.state`, `engine.commands`, `game.patch`, `log.append`, `captcha.show`, `captcha.hide`, `connection.status`, `toast`.
- Auto-login with backoff, LoginError routing, toasts for noResponse/exception/error/session-limit (same strings as v1 handlers).
- `src/renderer/api.ts`: `export function installTauriApi(): void` setting `window.api: Api` (from `src/shared/ipc.ts`) — each method → `invoke('<command>', {…})`; `on(channel, cb)` → `listen(channel, e => cb(e.payload))` returning a synchronous unsubscribe.

- [ ] **Step 1: failing tests** — port `StateStore.test.ts`, `wireStatePersistence.test.ts`, `dailyPersistence.test.ts` (persistence parts), `handlers.test.ts` scenarios against a testable `AppCore` (commands' logic without Tauri types: `AppCore::auth_status()`, …), including `no_token_in_any_payload` (serialize every effect/result of a full scenario, assert the token and its `dpapi:` value never appear) and `engine_status_rebuilds_after_reload` (Review Focus 5).
- [ ] **Step 2–4:** FAIL → implement → PASS + clippy. Frontend: `npm test` (renderer tests) and `npx tsc -p tsconfig.web.json` pass.
- [ ] **Step 5:** Remove Electron code/tests/deps; `npm run dev` → full app works with the mock-free live client (owner's token in the UI).
- [ ] **Step 6:** Commit `feat(ipc): Tauri commands, persistence and renderer bridge; remove Electron`.
- [ ] **Step 7: OWNER CHECKPOINT 2** — owner runs `npm run dev`, pastes the token, picks the channel, presses Start: dashboard fills (`/profile`, `/boosts`, `/quests`), `/fish` loop runs, deferred replies don't cause extra `/fish`, Stop does the graceful stop. Fix before Task 11.

---

### Task 11: App shell (tray, notifications, single instance, window)

**Files:** Create `src-tauri/src/shell/{tray,notify,notify_events}.rs`; Modify `src-tauri/src/lib.rs`, `tauri.conf.json`, `capabilities/default.json`. Ports `tray.ts`, `notify.ts`, `notifyEvents.ts` and `tests/engine/notifyEvents.test.ts`.

**Interfaces — Produces:** tray menu items `Show`, `Start`/`Pause`/`Resume`, `Stop`/`Force stop`, `Quit`, red icon (`icons/icon-alert.png`) in captcha; `fn notify_captcha(app, cfg)`, `notify_level_up`, `notify_rare_fish` (titles/bodies as v1); `notify_events::{level_up_from_log, rare_increases}`; single-instance plugin focuses the existing window; close → hide when `ui.closeToTray`; quit path: dispose retries → graceful-free halt (`Stop{graceful:false}`) → save state → logout; taskbar flash on captcha until focus; no menu bar in production.

- [ ] **Step 1: failing tests** — port `notifyEvents.test.ts`; unit test of the tray state → label mapping (`fn tray_labels(state) -> TrayLabels`).
- [ ] **Step 2–4:** FAIL → implement → PASS + clippy.
- [ ] **Step 5:** Manual: second launch focuses the window; close hides to tray; Quit writes a session file in `sessions/`.
- [ ] **Step 6:** Commit `feat(shell): tray, notifications, single instance`.
- [ ] **OWNER CHECKPOINT 3** (whenever a captcha appears during their use): panel shows the Discord-style message, Submit sends `/verify`, nothing else is sent meanwhile, fishing resumes after solving.

---

### Task 12: Packaging, release workflow, docs, 2.0.0

**Files:** Create `src-tauri/windows/hooks.nsh`; Modify `tauri.conf.json` (nsis `installerHooks`, `artifactName`-equivalent via `bundle > windows > nsis` + workflow rename to `VirtualAutoFisher-Setup-<version>.exe`, WebView2 `downloadBootstrapper`), `.github/workflows/release.yml`, `README.md`, `docs/first-run.md`, `package.json` (version `2.0.0`).

- [ ] **Step 1:** `hooks.nsh` `NSIS_HOOK_PREINSTALL`: read `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\*` for DisplayName `Virtual AutoFisher` with an Electron uninstaller (`Uninstall Virtual AutoFisher.exe`), run it with `/S`, wait.
- [ ] **Step 2:** Workflow: keep the `check` job; `release` job on `windows-latest`: setup-node@v7 (npm cache), `dtolnay/rust-toolchain@stable`, `Swatinem/rust-cache@v2` (workspace `src-tauri`), `npm ci`, `npm test`, `npx tsc -p tsconfig.web.json --noEmit`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run build`, copy `src-tauri/target/release/bundle/nsis/*-setup.exe` to `VirtualAutoFisher-Setup-$VERSION.exe`, `gh release create` as today.
- [ ] **Step 3:** README/first-run updated (Tauri, WebView2, re-enter token once on 2.0, `npm run dev`/`build`, cargo commands); version `2.0.0`.
- [ ] **Step 4:** Local `npm run build` → installer exists, size noted (target ≈10 MB); install over a machine with 1.0.4 installed → 1.x uninstalled, 2.0 runs, data folder reused.
- [ ] **Step 5:** Commit `chore: Tauri packaging, release workflow, 2.0.0`.
- [ ] **Step 6:** Ask the owner before merging `tauri-rust` into `main` and pushing (that publishes v2.0.0).
