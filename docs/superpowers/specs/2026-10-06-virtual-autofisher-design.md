# Virtual AutoFisher — Design Specification

- **Date:** 2026-10-06
- **Status:** draft, awaiting approval
- **Reference:** [yudhistiraindyka/virtualfisher-bot-experimental](https://github.com/yudhistiraindyka/virtualfisher-bot-experimental) (Python, CLI, `%`-prefixed commands)
- **Target bot:** Virtual Fisher (ID `574652751745777665`), [guide](https://virtualfisher.com/guide), [commands](https://virtualfisher.com/commands)

---

## 1. Goal

A nice, simple Windows desktop app that automates fishing on Virtual Fisher using the user's Discord account. It displays everything useful live: catches, money, level, cooldown, boosts, stats.

### Success criteria

1. The user pastes their token once. The app finds on its own the servers where Virtual Fisher is present, and their channels.
2. The user picks a server and a channel and clicks **Start**: fishing runs without intervention.
3. The dashboard reflects the real state of the account (balance, level, boosts, catches) within a few seconds.
4. When a captcha appears, everything stops immediately. The user is notified, solves it in the app, and fishing resumes.
5. The user can switch server or channel without restarting the app (only one active at a time).

### Out of scope

- **Automatic captcha solving** (OCR or anything else): deliberately excluded. It would circumvent Virtual Fisher's anti-bot protection. The captcha is always solved by a human.
- Multiple accounts or multiple servers at the same time.
- Automated coinflip or gambling (available only as a manual command).
- macOS / Linux: not targeted, even though nothing is Windows-specific except the packaging.

### Risks accepted by the user

- Using a user token (selfbot) violates Discord's Terms of Service: the account may be banned.
- Virtual Fisher forbids macros: risk of a reset or a ban in the bot.
- The app limits the exposure (human-like pacing, pause on captcha, token encrypted locally) but does not eliminate it. A warning is shown on first launch.

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Shell | Electron (latest stable version) |
| Build | electron-vite |
| Language | TypeScript (strict) everywhere |
| UI | React 18 + Tailwind CSS + lucide-react (icons) |
| UI state | Zustand |
| Discord | `discord.js-selfbot-v13` wrapped in an adapter |
| Persistence | JSON in `app.getPath('userData')` + `safeStorage` for the token |
| Tests | Vitest (parser, scheduler, engine with a fake client) |
| Packaging | electron-builder → NSIS `.exe` installer |

---

## 3. How Discord works (technical reminder)

The reference bot sent text messages (`POST /channels/{id}/messages` with `%fish`). Virtual Fisher now works with **slash commands**, which are sent as **interactions**:

1. **Gateway connection** (WebSocket) with the token. The `READY` event provides the `session_id`, the user and the list of servers.
2. **Command discovery:** fetch the server's application command index to get, for Virtual Fisher, the `id`, the `version` and the options of each command (`fish`, `sell`, `buy`, `verify`…).
3. **Sending:** `POST /interactions` (type 2) with `application_id`, `guild_id`, `channel_id`, `session_id`, `data` (id, version, name, options) and a `nonce`.
4. **Responses:** the bot replies with a message (`MESSAGE_CREATE`), sometimes edited afterwards (`MESSAGE_UPDATE`), sometimes ephemeral (flag 64, visible only to us but received through the Gateway).

The `discord.js-selfbot-v13` library handles steps 1 to 3 (`channel.sendSlash(botId, 'command', ...options)`). The `DiscordClient` adapter (§5.2) isolates the rest of the app from this library.

**The exact command names and options are read at runtime** from the command index, never hardcoded without verification. If an expected command is missing, the app reports it in the settings and disables the corresponding feature.

---

## 4. Features

### 4.1 Automations

| Feature | Command | Trigger | Settings |
|---|---|---|---|
| Auto-fish | `/fish` | In a loop, after the cooldown | Base cooldown (s, default 3.5, min 2), random (± s, default 0.8) |
| Auto-sell | `/sell` (amount `all`) | Every N catches **or** N minutes | Mode, N (default: 25 catches) |
| Auto-buff | `/buy` fish boost + treasure boost | When each boost expires | On/off, duration (5 or 20 min) |
| Auto-bait | `/buy` bait | When the estimated stock falls below a threshold, or together with the buffs | Bait, quantity (auto calculation: `(duration*60 / cooldown − 10) × 0.75`, as in the reference) |
| Profile | `/profile` (inventory) + stats | At startup, then every N minutes (default 5) and after each sale | Interval |
| Daily | `/daily` | At startup then every 24 h (+ a few minutes) | On/off |
| Quests | `/quests` | At startup then every 30 min | On/off (read-only: display) |

### 4.2 Manual commands

A quick-command bar in the dashboard, each command going through the same queue: `/sell all`, `/daily`, `/quests`, `/boosts`, `/coinflip` (side + amount), `/top`, `/profile`, plus a free-form field to type a slash command and its options.

### 4.3 Humanization

- Random delay on every cooldown (truncated normal distribution, never below the minimum).
- Global minimum delay of **2.5 s** between two commands, all sources combined.
- **Optional breaks**: after X minutes of fishing (default 45 ± 10), a break of Y minutes (default 5 ± 2). Disabled by default, can be enabled in the settings.
- Optional session limit: automatic stop after H hours.

### 4.4 Captcha (manual solving)

1. The parser detects a verification message: text or embed containing `captcha`, `/verify` or `verify`, with or without an image.
2. The Engine switches to the `captcha` state: **the queue is emptied and no more automatic commands are sent.**
3. The app sends a Windows notification (clickable: brings the window to the foreground), plays a sound if enabled, and flashes the taskbar icon.
4. The captcha panel shows the image large, an input field and two buttons: **Submit** (`/verify` + answer) and **New image** (`/verify regen`, if the option exists).
5. If the bot replies that the verification succeeded (`You may now continue.` or equivalent), the Engine resumes **after a random delay of 5 to 15 s**.
6. If the answer is wrong, the panel stays open with the bot's message.
7. **No automatic sending of `/verify`.** Only the user's click sends one.

---

## 5. Architecture

```
┌──────────────── Main process (Node) ───────────────────────┐
│                                                            │
│  ConfigStore ── config.json + encrypted token (safeStorage)│
│       │                                                    │
│  DiscordClient (discord.js-selfbot-v13 adapter)            │
│       │                                                    │
│  Parser (pure functions): message → GameEvent              │
│       │                                                    │
│  Engine                                                    │
│   ├─ StateMachine (idle/connecting/running/paused/…)       │
│   ├─ CommandQueue (single queue + minimum delay)           │
│   ├─ Scheduler (fish/sell/buff/bait/profile/daily timers)  │
│   └─ GameState (profile, boosts, session stats, log)       │
│       │                                                    │
│  IPC (ipcMain / preload contextBridge, typed)              │
└───────────────────────┬────────────────────────────────────┘
                        │
┌──────────── Interface (React, sandboxed) ────────────────────┐
│  Onboarding → Server/channel selection → Dashboard           │
│  Log • Settings • Captcha panel                              │
└──────────────────────────────────────────────────────────────┘
```

### 5.1 File tree

```
src/
  main/
    index.ts                 # window creation, tray, wiring
    config/ConfigStore.ts
    discord/DiscordClient.ts # interface
    discord/SelfbotClient.ts # discord.js-selfbot-v13 implementation
    parser/index.ts          # parseMessage(msg) → GameEvent
    parser/catch.ts | inventory.ts | stats.ts | boosts.ts | captcha.ts | misc.ts
    parser/text.ts           # cleanup of emojis, markdown, numbers
    engine/Engine.ts
    engine/CommandQueue.ts
    engine/Scheduler.ts
    engine/GameState.ts
    engine/humanize.ts       # random delays
    ipc/channels.ts          # shared names + types
    ipc/handlers.ts
    notify.ts                # Windows notifications, sound, flash
  preload/index.ts           # exposes window.api (typed)
  renderer/
    App.tsx
    store.ts                 # Zustand, fed by IPC events
    screens/Onboarding.tsx | ServerPicker.tsx | Dashboard.tsx | Settings.tsx
    components/StatCard.tsx | CatchLog.tsx | BoostTimer.tsx | CaptchaPanel.tsx
               | CommandBar.tsx | StatusPill.tsx | RareFishGrid.tsx
  shared/types.ts            # GameEvent, Config, EngineState, IPC DTOs
tests/
  fixtures/messages/*.json   # real bot messages (anonymized)
  parser/*.test.ts
  engine/*.test.ts
```

### 5.2 `DiscordClient` (interface)

```ts
interface DiscordClient {
  login(token: string): Promise<SelfUser>;       // rejects if the token is invalid
  logout(): Promise<void>;
  listGuilds(): Promise<GuildInfo[]>;            // { id, name, iconUrl, hasVirtualFisher }
  listChannels(guildId: string): Promise<ChannelInfo[]>; // text channels where we can write + use slash commands
  getBotCommands(guildId: string): Promise<SlashCommandInfo[]>; // available VF commands
  sendSlash(channelId: string, command: string, options?: SlashOptions): Promise<void>;
  on(event: 'botMessage', cb: (m: BotMessage) => void): void; // create + update, filtered on the VF author and the active channel
  on(event: 'disconnected' | 'reconnected', cb: () => void): void;
}
```

`BotMessage` is a neutral representation: `{ id, channelId, content, embeds[{title, description, fields, imageUrl, footer}], ephemeral, isEdit, interactionUserId }`. Only messages that reply to **our** interactions (`interactionUserId === me`) or that mention us are forwarded. This avoids counting the catches of the other players in the channel.

### 5.3 Parser

`parseMessage(msg: BotMessage): GameEvent` is a pure function, tested with fixtures.

```ts
type GameEvent =
  | { kind: 'catch'; items: CatchItem[]; xp?: number; levelUp?: number; treasure?: string[]; raw: string }
  | { kind: 'sell'; earned: number; xp?: number }
  | { kind: 'inventory'; balance: number; level: number; xpToNext?: number; rod?: string; biome?: string;
      bait?: { name: string; count: number }; rare: { gold: number; emerald: number; lava: number; diamond: number } }
  | { kind: 'stats'; crates?: number; quests?: number; trips?: number; dailyStreak?: number; totals: Partial<RareCounts> }
  | { kind: 'boosts'; active: { name: string; endsAt: number }[] }
  | { kind: 'purchase'; item: string; amount: number; cost?: number }
  | { kind: 'daily'; reward: string }
  | { kind: 'quests'; quests: { label: string; progress: string; done: boolean }[] }
  | { kind: 'cooldown'; waitMs: number }        // "You must wait X seconds"
  | { kind: 'captcha'; imageUrl?: string; text: string }
  | { kind: 'captchaSolved' }
  | { kind: 'captchaFailed'; text: string }
  | { kind: 'error'; text: string }             // insufficient funds, unknown command…
  | { kind: 'unknown'; title?: string; text: string };
```

Rules:
- The type is identified by the **embed title**, then by keywords: `You caught`, `Inventory of`, `Statistics for`, `Active boosts`, `You sold`, `You must wait`, `captcha`, `You may now continue`…
- Cleanup before analysis: we remove custom emojis `<:name:id>` and `<a:name:id>`, `:emoji:`, the markdown `*_~\``, and we normalize numbers (`1,234,567` and `1.2M`).
- **Captcha detection takes priority** over everything else, and is deliberately broad: better a false alarm than an ignored captcha.
- An unrecognized message produces `unknown`, shown in the log, without ever crashing the engine.

> The exact texts of the embeds in the slash version are not publicly documented. **The first implementation step** is to capture real messages ("capture" mode that records the raw `BotMessage`s in `userData/captures/`) to build the fixtures. The keywords above come from the reference bot and will be adjusted.

### 5.4 Engine

**States:**

```
idle ──start──▶ connecting ──ok──▶ running ◀──resume── paused
  ▲                 │                │ ▲                  ▲
  │               error              │ └─captchaSolved─┐  │
  └────stop─────────┴────────────────┤                 │  │
                                     ├──pause──────────┼──┘
                                     ├──captcha──▶ captcha
                                     └──break (humanization)──▶ resting ──timer──▶ running
```

- `running`: the Scheduler feeds the queue.
- `paused` / `resting` / `captcha`: the timers are frozen and the queue is blocked. The captcha also empties the queue.
- `error`: prolonged disconnection, invalid token, inaccessible channel. A clear message is shown and a button allows retrying.

**`CommandQueue`:**
- FIFO queue with priorities: `manual` > `verify` > `maintenance` (sell, buy, profile, daily) > `fish`.
- One send at a time. After a send, we wait for the bot's response (timeout 8 s) **and** the global minimum delay, before the next command.
- If the bot replies `cooldown`, we wait `waitMs` + a bit of randomness, then resend once.
- Maintenance duplicates are ignored (no two `/sell` in the queue).

**`Scheduler`:**
- `fish`: on each `catch` response, we reschedule after `cooldown()`.
- `sell`: catch counter or timer, depending on the chosen mode.
- `buff`: based on `boosts.endsAt`, known thanks to `/boosts` or at purchase time. We rebuy 5 to 30 s after expiry.
- `bait`: decrements an estimated counter on each catch, and corrects it with the inventory.
- `profile`, `daily`, `quests`: simple timers.

**`GameState`** is the single source of truth, pushed to the interface as a diff on every change:
- `account`: balance, level, XP, rod, biome, bait, rare fish;
- `boosts`;
- `quests`;
- `session`: start, catches, fish per species, money earned, XP earned, sales, captchas, commands sent;
- `log`: last 500 entries.

### 5.5 Persistence

`userData/config.json`:

```json
{
  "version": 1,
  "tokenEncrypted": "<base64 safeStorage>",
  "target": { "guildId": "…", "channelId": "…" },
  "fishing": { "baseCooldownSec": 3.5, "jitterSec": 0.8, "minGapSec": 2.5 },
  "sell": { "enabled": true, "mode": "catches", "every": 25 },
  "buffs": { "enabled": false, "lengthMin": 5 },
  "bait": { "enabled": false, "name": "", "autoAmount": true, "amount": 0 },
  "profile": { "refreshMin": 5 },
  "daily": { "enabled": true },
  "quests": { "enabled": true },
  "breaks": { "enabled": false, "workMin": 45, "workJitterMin": 10, "restMin": 5, "restJitterMin": 2 },
  "sessionLimitH": 0,
  "notifications": { "captcha": true, "sound": true, "levelUp": true, "rareFish": true },
  "ui": { "compactLog": false },
  "capture": false
}
```

- The token is **never** stored in plain text, never sent to the interface, never written to the logs. Error messages mask anything that looks like a token.
- `userData/sessions/*.json` contains a summary of each finished session, for the history.

### 5.6 IPC

The channels are typed in `shared/types.ts`, and `window.api` is exposed by the preload with `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false`.

- **Interface → main:** `auth.setToken`, `auth.logout`, `guilds.list`, `channels.list`, `target.set`, `engine.start|pause|resume|stop`, `command.send`, `captcha.submit`, `captcha.regen`, `config.get|update`.
- **Main → interface:** `engine.state`, `game.patch`, `log.append`, `captcha.show|hide`, `connection.status`, `toast`.

---

## 6. Interface

Dark "ocean" theme: midnight-blue background, cyan and turquoise accents, semi-transparent cards, Inter font with tabular numerals. The app is usable from 1000×680, with a collapsible sidebar.

### 6.1 Screens

1. **Onboarding** (first launch)
   - Warning about the risks (Discord ToS, VF rules), with an "I understand the risks" checkbox.
   - Token field (masked, show button), "How do I find my token?" link to built-in help.
   - "Log in" button, which then shows the avatar and username for confirmation.
2. **Server and channel selection**
   - Grid of servers with icon and name. Those that have Virtual Fisher come first with a badge, the others are greyed out.
   - Then a list of the allowed text channels, with search.
   - "Use this channel" remembers the choice. The user can come back at any time via the selector at the top of the dashboard.
3. **Dashboard**
   - **Top bar:** active server and channel (clickable to change), status pill (Running / Paused / Captcha / Resting / Error), ▶ Start, ⏸ Pause, ⏹ Stop buttons, session timer.
   - **Row of cards:** Balance (with session gain), Level (XP bar), Session catches (with hourly rate), Next `/fish` (animated cooldown ring).
   - **Active boosts:** chips with countdown (fish, treasure, others).
   - **Rare fish:** gold, emerald, lava, diamond, with session counter and total.
   - **Catch log** (main column): live list, one line per catch (time, fish with quantities, XP, treasures, level-up highlighted). Filters: all, catches, buys/sells, system.
   - **Side panel:** rod, biome, bait and stock, today's quests with progress, next daily.
   - **Quick-command bar** at the bottom (§4.2).
4. **Settings**
   - Sections: Fishing, Selling, Buffs and bait, Profile/Daily/Quests, Humanization, Notifications, Account (change token, log out), Advanced (capture mode, open the data folder).
   - Every change is applied live.
5. **Captcha panel** (modal that cannot be closed while the captcha is active)
   - Image, answer field (automatic focus), Submit, New image, last message from the bot.

### 6.2 System tray

- Taskbar icon with menu: Show, Start/Pause, Quit.
- Closing the window minimizes the app to the tray (configurable).
- The icon changes on a captcha.

---

## 7. Error handling

| Situation | Behavior |
|---|---|
| Invalid token | Back to onboarding with the message "Invalid or expired token". |
| Gateway disconnection | The library reconnects; the Engine goes to `paused` (cause: network) and resumes on its own on reconnection. After 2 min without reconnection: `error`. |
| Channel deleted or no longer accessible | `error`, with a return to the picker. |
| VF command not found | Feature disabled + warning in the settings. If it is `/fish`: `error`. |
| No response from the bot (timeout 8 s) | Retry once. After 3 timeouts in a row: `paused` + toast "Virtual Fisher is not responding". |
| "You must wait" | Wait for the indicated delay + randomness. |
| Insufficient funds for a purchase | Log + temporary disabling of the affected purchase (30 min). |
| Unrecognized message | `unknown` line in the log; never a stop. |
| Discord rate limit (429) | Respect `retry_after` + temporary increase of the minimum delay. |
| Unexpected exception in the Engine | Caught, logged, Engine goes to `paused`, error toast. No app crash. |

Technical logs are written to `userData/logs/app.log` (rotation at 5 MB), with the token masked.

---

## 8. Tests

- **Parser**: each event type has at least 2 real fixtures. Unknown messages must produce `unknown` without an exception. All captcha variants must produce `captcha`.
- **CommandQueue / Scheduler**: with simulated timers (`vi.useFakeTimers`), we check the priority order, the minimum delay, the deduplication, the freeze on pause and the emptying on captcha.
- **Engine**: with a `FakeDiscordClient` that replays scenarios (normal fishing, sale triggered at N catches, captcha → solving → resume, disconnection → resume, cooldown).
- **Critical test**: in the `captcha` state, **no** command is sent without a user action.
- **Manual**: a real 10-minute session on a test server, with a captcha triggered naturally if possible.

---

## 9. Packaging and delivery

- `npm run dev`: development with hot reload.
- `npm run test`: Vitest.
- `npm run build:win`: NSIS installer in `dist/`.
- `README.md`: installation, retrieving the token, warnings, screenshots.

---

## 10. Implementation steps (overview)

1. electron-vite + React + Tailwind + typed IPC skeleton.
2. `ConfigStore`, then `SelfbotClient` (login, servers, channels, commands, slash sending, receiving) with a **capture mode**.
3. Capture of real messages, then fixtures and Parser with tests.
4. CommandQueue, Scheduler, GameState, Engine, with tests.
5. Interface: onboarding, picker, dashboard, settings, captcha panel.
6. Notifications, system tray, error handling, packaging.

The detailed plan will be written separately after this spec is approved.
