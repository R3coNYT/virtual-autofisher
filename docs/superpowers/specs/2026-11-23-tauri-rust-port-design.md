# Virtual AutoFisher 2.0 — Tauri + Rust port

- **Date:** 2026-11-23
- **Status:** written, awaiting approval
- **Branch:** `tauri-rust` (Electron 1.x stays on `main` until this reaches parity)
- **Baseline (fixed reference):** Electron app v1.0.4 (`main` @ a232f02): ~3,700 lines of main-process TypeScript, ~3,200 lines of React UI, 356 tests. The owner will not use or update 1.x anymore: no fixes need carrying over during the port.

## 1. Intent

The owner wants Virtual AutoFisher rewritten in Rust using Tauri: same app, same behaviour, but the whole background engine (Discord connection, parsing, automation, persistence) in Rust, with the existing React UI kept as the window's frontend.

**Why** (assumed, the owner chose the approach without stating the reason): a native, lighter app. The Electron installer is ~118 MB and ships a full Chromium + Node; a Tauri app uses the system WebView2 and should land around 10 MB with far less memory.

### Goals

1. **Behaviour parity** with v1.0.4: every feature and safety rule listed in §5 works the same way.
2. **Same UI**: the React screens look and behave as today; only their bridge to the backend changes.
3. **Same data folder**: `%APPDATA%\virtual-autofisher\` is reused (settings, saved values, logs, captures, sessions).
4. **Automatic releases**: every new version on `main` still produces a GitHub release with a Windows installer.

### Non-goals

- New features (they come after parity).
- macOS / Linux builds.
- Several accounts or servers at once.
- Migrating the encrypted token from the Electron format (see §7).

### Anti-goals (failure even if it "works")

- **Any regression of captcha safety**: nothing but a user-clicked `/verify` may ever be sent while a captcha is pending; captchas are never solved automatically, not even text captchas.
- **The token leaking** to the UI, the logs, `state.json`, captures or any committed file.
- **A more detectable client**: the Rust Discord client must identify and send requests like the library used today (same client properties and headers), not like a bot or an unknown client.
- Sending more commands than the Electron engine would (bursts, retries during deferred replies, etc.).

## 2. Constraints

- Windows 10/11 x64, WebView2 runtime (bundled bootstrapper in the installer).
- Tauri 2, Rust stable (1.99 installed), tokio async runtime.
- The React/TypeScript frontend (`src/renderer`, `src/shared` types) is kept; Vite stays the frontend build tool.
- No Node runtime shipped with the app.
- Repo: same repository; the Electron code is removed only on this branch.

## 3. Approaches considered

| | Approach | Trade-offs |
|---|---|---|
| **A (chosen)** | Rust engine with our own Discord client (Gateway WebSocket + REST), React UI kept | Real Rust app, ~10 MB installer, low memory. The Discord user-account client must be written and validated live: the main risk. |
| B | Tauri shell + a Node sidecar keeping `discord.js-selfbot-v13` | Discord layer keeps working unchanged, but ships Node (~40 MB) and keeps a large part in JavaScript — against the point of moving to Rust. |
| C | An existing Rust Discord library | None is reliable for user accounts (serenity/twilight target bots). Rejected. |

The owner picked **A**.

## 4. Architecture

```
Tauri window (WebView2) ── React UI (unchanged screens)
        │  src/renderer/api.ts: implements the existing `Api` (window.api) with
        │  @tauri-apps/api invoke() + listen(), same method and event names
        ▼
src-tauri (Rust)
  ipc/        Tauri commands + event emitter (token never crosses this boundary)
  config/     config.json (+ DPAPI-encrypted token), deep-merge, atomic writes
  persist/    state.json (account values, nextDailyAt, vfGuilds), debounced saves
  discord/    gateway (WS, identify, heartbeat, resume), rest (reqwest + headers),
              interactions (slash commands), model (BotMessage), components V2,
              permissions (channel list), capture mode
  parser/     text helpers + one module per rule (catch, inventory, boosts, …)
  engine/     queue, scheduler, game_state, captcha_flow, edit_deduper, engine
  tray, notify, logger (secret masking, 5 MB rotation)
```

- **Concurrency model**: the engine runs as one tokio task (actor) owning all state, fed by a channel of inputs (bot messages, UI commands, timer fires, gateway status). Timers use `tokio::time`, so engine tests can run with paused/advanced time exactly like today's fake timers.
- The module split mirrors the TypeScript one so each Rust module can be checked against its TS counterpart and tests.
- **Renderer bridge**: `src/preload` and Electron-specific code go away; `window.api` is provided by a small module using Tauri's `invoke`/`listen`, keeping the `Api`/`EventMap` contract from `src/shared/ipc.ts` (names and payloads unchanged, so `store.ts` and the screens don't change).

## 5. Behaviour to keep (parity checklist)

Each line is existing behaviour, already covered by tests in `tests/` that must be ported:

- **Discord**: login with a user token (invalid vs network errors distinguished; network → keep token, retry 30 s, 60 s, then every 2 min); guild list with "has Virtual Fisher" (command-index check, cached and persisted, Refresh); text channels where the user can send messages and use slash commands; slash commands read from the guild's application-command index (options ordered positionally with gaps; choice values + labels); replies filtered to our interactions / mentions / ephemerals in the active channel; Components V2 converted to embed-like text; raw markdown kept for the captcha panel; Discord "LOADING" deferred replies wait for their edit (30 s timeout); MESSAGE_UPDATE edits; rate-limit (429) holds.
- **Queue**: one command in flight, priorities manual > verify > maintenance > fish, dedupe keys, min gap (×1.5 for 5 min after a rate limit), 8 s response timeout, one retry for maintenance/manual, verify never retried, verify allowed through while paused.
- **Engine states**: idle, connecting, running, paused, resting, stopping, captcha, error; breaks; session limit; graceful stop (`/profile` then `/quests`, 25 s cap; Force stop); manual commands while idle (no session started, no automation); target switch refused during captcha.
- **Scheduler**: start order `/profile`, `/boosts`, `/daily` (only when due), `/quests`, then `/fish`; fish delay (truncated normal, min 2 s); sell by catches/minutes; buff cycle (fish + treasure back to back, then `/boosts`, wait until both are over); personal boosters opt-in (`/boosters` → `/use Personal` → `/boosts`, one `/use` per expiry); bait; quests refresh after QUEST COMPLETE; cooldown routing ("wait N" only reschedules `/fish` when it answers `/fish`); insufficient funds blocks buys 30 min; captcha clears/freezes and re-requests dropped maintenance after the solve.
- **Captcha**: freeze everything, notification + taskbar flash + red tray icon, panel never auto-submits, "Stop fishing" sends nothing, solved → resume after 5–15 s in the pre-captcha state (user pause kept), reminders ("posted above") don't replace the challenge, edits of an already solved captcha ignored.
- **Parser**: all current rules and the real fixtures in `tests/fixtures/messages/real/` and `v2/`.
- **GameState**: session stats, session gain (fish value delta + sells), log (500 entries), patches with replace semantics, last session kept visible after stop.
- **Persistence**: `config.json` (same schema), `state.json` (same schema; account values saved 2 s after changes, at session end, on quit), next daily gating across restarts, session summaries in `sessions/`, capture files (BotMessage + raw components).
- **App shell**: single instance (second launch focuses the window), close to tray (configurable), tray menu (Show, Start/Pause/Resume, Stop/Force stop, Quit), Windows notifications with the app's identity, menu bar hidden, app icon (existing `build/icon.ico`, `resources/*.png`).

## 6. Discord client (the risky part)

Mirror what `discord.js-selfbot-v13` 3.7.1 does today:

- **Gateway** `wss://gateway.discord.gg/?v=9&encoding=json`: Hello → heartbeat at the given interval with jitter; Identify with the same `properties` object as the library (`os: Windows`, `browser: Discord Client`, `release_channel: stable`, `client_version`, `client_build_number`, `native_build_number`, `browser_user_agent`, `system_locale`, launch ids…), `capabilities: 0`, `compress: false`, `client_state: { guild_versions: {} }`, presence online/afk; Resume on reconnect (session_id, seq), Invalid Session handling, reconnect backoff. Events used: READY (user, session_id, guilds with roles/channels, own member), GUILD_CREATE, MESSAGE_CREATE, MESSAGE_UPDATE, INTERACTION_SUCCESS/FAILURE (optional).
- **REST** `https://discord.com/api/v9` with the library's headers: `Authorization` (raw token), browser `User-Agent`, `x-super-properties` (base64 of the same properties), `x-discord-locale`, `x-discord-timezone`, `origin`, `referer`, sec-ch/sec-fetch headers. Endpoints: `GET /guilds/{id}/application-command-index`, `POST /interactions`.
- **Slash command** (`POST /interactions`): `type: 2`, `application_id`, `guild_id`, `channel_id`, `session_id`, `nonce` (snowflake), `data: { version, id, name, type: 1, options: [{type, name, value}] }`.
- The client properties (build numbers, versions, user agent) live in one constants module so they can be refreshed when Discord updates.
- **How far "like the library" goes** (builder's call, recorded): same Identify payload and REST headers. Not copied: the library's redundant traffic (it re-fetches the command index before every slash command; 2.0 caches it per guild like the real client) and the low-level TLS/HTTP fingerprint (plain `reqwest`/`tokio-tungstenite` stack).
- **Validation**: unit tests on message conversion and payload building. The builder cannot use the owner's token, so the Discord client is built **first** and the owner runs short live checkpoints on their account as it progresses: (1) login, guild list, channel list; (2) `/profile` and a `/fish` loop, deferred replies; (3) captcha. Problems surface before the rest is built on top.

## 7. Data and token

- Data folder: `%APPDATA%\virtual-autofisher\` exactly (override Tauri's default app-data path, which would otherwise derive from the identifier).
- `config.json` schema unchanged. The token is re-encrypted with Windows **DPAPI** (current user) and stored as `tokenEncrypted: "dpapi:<base64>"`. A value in the old Electron `safeStorage` format can't be read: it is ignored, and the user pastes the token once on first launch of 2.0 (onboarding shows a one-line explanation).
- `state.json`, `logs/`, `sessions/`, `captures/`: same formats; 2.0 reads what 1.x wrote.

## 8. Testing

- Rust unit/integration tests for parser, components V2, queue, scheduler, engine, captcha flow, edit deduper, persistence, config, secret masking, slash payloads — ported from the existing TS tests, reusing the JSON fixtures as-is. Engine tests use paused tokio time and a fake Discord client (same scenarios as `FakeDiscordClient`).
- Frontend tests (vitest) for the pure renderer helpers stay.
- CI runs `cargo test`, `cargo clippy -D warnings`, the frontend tests and type check.
- Live acceptance: the owner runs the checklist of §6 on their account before `tauri-rust` is merged into `main`.

## 9. Build and release

- Tauri bundler, NSIS installer, x64, with the WebView2 bootstrapper; artifact name `VirtualAutoFisher-Setup-<version>.exe`; same `appId`/identifier `com.r3con.virtualautofisher`.
- **1.x already installed** (builder's call, recorded): the Tauri installer would install next to the Electron one, and both could run on the same account and data folder. The 2.0 installer therefore detects an installed 1.x and runs its uninstaller silently (NSIS hook) before installing. Going back to 1.x after 2.0 is not supported (its token format can't read `dpapi:`).
- Version source stays `package.json` (Tauri config reads it).
- The GitHub Action keeps its logic (release only when `v<version>` doesn't exist) but builds with the Rust toolchain + Tauri (cached), on `windows-latest`.
- Released as **2.0.0** once merged into `main`.

## 10. Left to the builder

- Exact crates (e.g. `tokio-tungstenite`, `reqwest` with rustls, `serde_json`, `windows` for DPAPI, Tauri plugins for notifications / single instance) and module boundaries inside each folder.
- Channel permission computation details (roles + overwrites from READY / GUILD_CREATE).
- How the fake Discord client and paused-time helpers are structured in Rust tests.
- Order of the port, with the Discord client first (for the owner's live checkpoints), e.g. Tauri skeleton + Discord client → parser → queue/scheduler/engine with tests → IPC/UI bridge → shell → release workflow.
