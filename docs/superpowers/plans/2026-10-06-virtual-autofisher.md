# Virtual AutoFisher — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Windows Electron app that automates Virtual Fisher (fish, sell, buffs, bait, profile, daily, quests) through the user's Discord account, with a real-time dashboard and a manually solved captcha.

**Architecture:** The main process contains `ConfigStore`, the `DiscordClient` adapter (discord.js-selfbot-v13), a pure `Parser` (message → `GameEvent`) and an `Engine` (state machine + `CommandQueue` + `Scheduler` + `GameState`). The sandboxed React interface only receives states and diffs through a typed IPC.

**Tech Stack:** Electron, electron-vite, strict TypeScript, React 18, Tailwind CSS 3, Zustand, lucide-react, discord.js-selfbot-v13, Vitest, electron-builder (NSIS).

**Spec:** `docs/superpowers/specs/2026-10-06-virtual-autofisher-design.md`

## Global Constraints

- Virtual Fisher bot ID: `574652751745777665`.
- **No `/verify` sent without a user click.** No automatic captcha solving (no OCR, no external service).
- Global minimum delay between two commands: `minGapSec` (default **2.5**). Fish cooldown: `baseCooldownSec` (default **3.5**, min **2**) ± `jitterSec` (default **0.8**).
- Bot response timeout: **8 s**; 3 consecutive timeouts → `paused`.
- Resume after a solved captcha: random delay of **5–15 s**.
- The token is never in plain text on disk, never sent to the renderer, never logged (masking by `maskSecrets`).
- Windows: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- Minimum window size 1000×680, dark "ocean" theme (background `#0a1628`, cyan accent `#22d3ee`, turquoise `#2dd4bf`).
- Log: 500 entries max; `app.log` rotated at 5 MB.
- The interface text is in **French**.
- Slash command names and options are read at runtime (command index), never assumed without verification.

## Review Focus

1. **Message from another player in the channel** → must neither count as a catch nor trigger a captcha for us (`interactionUserId` / mention filter). Test in Task 8.
2. **Captcha arriving via `MESSAGE_UPDATE`** (the bot edits its `/fish` response into a captcha) → must switch to `captcha`. Test in Task 7.
3. **Channel change during a `running`** → stop, queue emptied, no command sent to the old channel. Test in Task 7.
4. **Formatted numbers** (`1,234,567`, `1.2M`, `12.5k`, `$1,234`) → correct numeric value. Test in Task 3.
5. **Empty message or embed without a description** → `unknown`, without an exception. Test in Task 3.

---

## File structure

```
package.json, electron.vite.config.ts, tsconfig*.json, tailwind.config.js, postcss.config.js,
vitest.config.ts, electron-builder.yml
src/shared/types.ts           # all shared types (Config, GameEvent, EngineState, IPC DTOs)
src/shared/ipc.ts             # IPC channel names + window.api signature
src/main/index.ts             # window, tray, wiring
src/main/config/ConfigStore.ts
src/main/util/maskSecrets.ts
src/main/util/logger.ts
src/main/discord/DiscordClient.ts   # interface
src/main/discord/SelfbotClient.ts   # implementation
src/main/discord/toBotMessage.ts    # Message (lib) → BotMessage
src/main/parser/text.ts
src/main/parser/index.ts            # parseMessage
src/main/parser/rules/*.ts          # one file per event type
src/main/engine/humanize.ts
src/main/engine/CommandQueue.ts
src/main/engine/GameState.ts
src/main/engine/Scheduler.ts
src/main/engine/Engine.ts
src/main/ipc/handlers.ts
src/main/notify.ts
src/main/tray.ts
src/preload/index.ts
src/renderer/index.html, main.tsx, App.tsx, store.ts, styles.css
src/renderer/screens/{Onboarding,ServerPicker,Dashboard,Settings}.tsx
src/renderer/components/{TopBar,StatCard,CooldownRing,BoostChips,RareFishGrid,CatchLog,SidePanel,CommandBar,CaptchaPanel,StatusPill}.tsx
tests/fixtures/messages/*.json
tests/helpers/FakeDiscordClient.ts
tests/{parser,engine,config}/*.test.ts
```

---

### Task 1: Project skeleton and shared types

**Files:**
- Create: all the configuration at the root, `src/shared/types.ts`, `src/shared/ipc.ts`, `src/main/index.ts` (empty window), `src/preload/index.ts`, `src/renderer/{index.html,main.tsx,App.tsx,styles.css}`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Produces (`src/shared/types.ts`): the types `Config`, `GameEvent` (exact union from spec §5.3), `CatchItem = { name: string; count: number }`, `RareCounts = { gold: number; emerald: number; lava: number; diamond: number }`, `EngineState = 'idle'|'connecting'|'running'|'paused'|'resting'|'captcha'|'error'`, `PauseReason = 'user'|'network'|'noResponse'|'exception'`, `BotMessage`, `GuildInfo`, `ChannelInfo`, `SlashCommandInfo = { name: string; id: string; version: string; options: { name: string; type: number; required: boolean; choices?: string[] }[] }`, `SelfUser = { id: string; username: string; avatarUrl: string }`, `LogEntry = { id: number; at: number; type: 'catch'|'trade'|'system'|'error'|'unknown'; text: string; highlight?: boolean }`, `GameSnapshot` (§5.4 GameState: `account`, `boosts`, `quests`, `session`, `log`), `DEFAULT_CONFIG: Config` (exact values of the JSON in spec §5.5, without `tokenEncrypted`).
- Produces (`src/shared/ipc.ts`): `type Api` = the list of channels from spec §5.6 as methods (`auth.setToken(token): Promise<SelfUser>`, `guilds.list(): Promise<GuildInfo[]>`, `channels.list(guildId)`, `target.set(guildId, channelId)`, `engine.start|pause|resume|stop(): Promise<void>`, `command.send(name, options?)`, `captcha.submit(answer)`, `captcha.regen()`, `config.get()`, `config.update(patch: DeepPartial<Config>)`, `on(channel, cb): () => void` for the main → renderer events).

- [ ] **Step 1:** Create the project with electron-vite's `react-ts` template, add `tailwindcss@3 postcss autoprefixer zustand lucide-react discord.js-selfbot-v13`, then `vitest electron-builder` in devDependencies. Scripts: `dev`, `build`, `test` (`vitest run`), `typecheck`, `build:win` (`electron-vite build && electron-builder --win`).
- [ ] **Step 2:** Write `tests/smoke.test.ts`: `expect(DEFAULT_CONFIG.fishing).toEqual({ baseCooldownSec: 3.5, jitterSec: 0.8, minGapSec: 2.5 })` and `expect(DEFAULT_CONFIG.sell).toEqual({ enabled: true, mode: 'catches', every: 25 })`.
- [ ] **Step 3:** Write `src/shared/types.ts` and `src/shared/ipc.ts`. Create the main window with the security flags and the minimum size. The renderer displays a `#0a1628` background with "Virtual AutoFisher".
- [ ] **Step 4:** Run `npm test` (PASS), `npm run typecheck` (no errors) and `npm run dev` (the window opens).
- [ ] **Step 5:** Commit `chore: scaffold electron-vite app with shared types`.

---

### Task 2: ConfigStore, secret masking, logger

**Files:**
- Create: `src/main/config/ConfigStore.ts`, `src/main/util/maskSecrets.ts`, `src/main/util/logger.ts`
- Test: `tests/config/ConfigStore.test.ts`, `tests/config/maskSecrets.test.ts`

**Interfaces:**
- Produces: `interface Cipher { encrypt(s: string): string; decrypt(b64: string): string; available(): boolean }`; `class ConfigStore { constructor(dir: string, cipher: Cipher); load(): Config; get(): Config; update(patch: DeepPartial<Config>): Config; setToken(token: string): void; getToken(): string | null; clearToken(): void; onChange(cb: (c: Config) => void): () => void }`; `safeStorageCipher: Cipher` (Electron `safeStorage` wrapper); `maskSecrets(s: string): string`; `logger.info|warn|error(msg: string, extra?: unknown)` which writes to `userData/logs/app.log`, with rotation at 5 MB and `maskSecrets` applied.

- [ ] **Step 1: tests.**
  - `load()` without a file → `DEFAULT_CONFIG`.
  - `update({ sell: { every: 10 } })` keeps the other `sell` fields and persists to disk.
  - `setToken('abc')` → the JSON file does not contain `abc`, and `getToken()` returns `'abc'` (with a fake `Cipher` that does reversed base64).
  - Corrupted JSON → `DEFAULT_CONFIG`, and the file is backed up as `config.bak.json`.
  - `maskSecrets('token MTA4.abc.def-ghi here')` → no longer contains the token string. Discord token regex: `[\w-]{24,}\.[\w-]{6}\.[\w-]{27,}`, replaced by `***TOKEN***`.
- [ ] **Step 2:** `npx vitest run tests/config` → FAIL.
- [ ] **Step 3:** Implement. The deep merge is done in `ConfigStore`. If `cipher.available()` is false, `setToken` throws `Error('Encryption unavailable')`: we never store in plain text.
- [ ] **Step 4:** `npx vitest run tests/config` → PASS.
- [ ] **Step 5:** Commit `feat: config store with encrypted token and secret masking`.

---

### Task 3: Text utilities and Parser

**Files:**
- Create: `src/main/parser/text.ts`, `src/main/parser/index.ts`, `src/main/parser/rules/{captcha,catch,sell,inventory,stats,boosts,purchase,daily,quests,cooldown,error}.ts`
- Create: `tests/fixtures/messages/*.json` (**synthetic** fixtures in the `BotMessage` format, built from the reference bot's texts. They will be replaced by real captures in Task 13.)
- Test: `tests/parser/text.test.ts`, `tests/parser/parseMessage.test.ts`

**Interfaces:**
- Consumes: `BotMessage`, `GameEvent` (Task 1).
- Produces: `cleanText(s: string): string` (removes `<a?:\w+:\d+>`, `:\w+:`, `*_~\``, and collapses whitespace); `parseNumber(s: string): number | null`; `parseDuration(s: string): number | null` (ms, from `5m 30s`, `1h 2m`, `12 seconds`); `parseMessage(m: BotMessage): GameEvent`.
- Each rule: `(m: BotMessage, text: string) => GameEvent | null`. `parseMessage` tries them in this fixed order: **captcha** (always first), captchaSolved/captchaFailed, cooldown, catch, sell, inventory, stats, boosts, purchase, daily, quests, error, then `unknown`.

- [ ] **Step 1: `text` tests.** `parseNumber('1,234,567') === 1234567`, `('$1,234') === 1234`, `('1.2M') === 1200000`, `('12.5k') === 12500`, `('abc') === null`; `parseDuration('5m 30s') === 330000`, `('12 seconds') === 12000`; `cleanText('<:fish:123> **Cod** x2') === 'Cod x2'`.
- [ ] **Step 2: `parseMessage` tests** (one `it` per fixture):
  - `catch-basic` → `kind:'catch'`, `items` contains `{ name:'Cod', count:2 }`;
  - `catch-levelup` → `levelUp` = the new level;
  - `inventory` → `balance`, `level`, `rare.gold`;
  - `stats` → `dailyStreak`;
  - `captcha-image` → `kind:'captcha'` + `imageUrl`;
  - `captcha-text-only` (text "use /verify", no image) → `captcha`;
  - `captcha-solved` (`You may now continue.`) → `captchaSolved`;
  - `cooldown` ("You must wait 2.4 seconds") → `waitMs: 2400`;
  - `sell` → `earned`;
  - Review Focus 5: `{ content:'', embeds:[{ title:'X' }] }` and `{ content:'', embeds:[] }` → `unknown`, without an exception.
- [ ] **Step 3:** `npx vitest run tests/parser` → FAIL.
- [ ] **Step 4:** Implement the rules (keywords from spec §5.3). `parseMessage` wraps each rule in a try/catch: if a rule throws an exception, we move on to the next one.
- [ ] **Step 5:** `npx vitest run tests/parser` → PASS.
- [ ] **Step 6:** Commit `feat: message parser with synthetic fixtures`.

---

### Task 4: Humanization and CommandQueue

**Files:**
- Create: `src/main/engine/humanize.ts`, `src/main/engine/CommandQueue.ts`
- Test: `tests/engine/humanize.test.ts`, `tests/engine/CommandQueue.test.ts`

**Interfaces:**
- Produces: `fishDelayMs(cfg: Config['fishing'], rand?: () => number): number` (truncated normal centered on `base`, standard deviation `jitter/2`, bounded to `[max(2, base-jitter), base+jitter]` × 1000); `randomBetweenMs(minS: number, maxS: number, rand?): number`.
- Produces: `type Priority = 'manual'|'verify'|'maintenance'|'fish'`; `type QueuedCommand = { name: string; options?: Record<string, string|number>; priority: Priority; key?: string }`; `class CommandQueue { constructor(send: (c: QueuedCommand) => Promise<void>, opts: { minGapMs: () => number; responseTimeoutMs: number /* 8000 */ }); push(c): boolean /* false if key already queued */; clear(): void; pause(): void; resume(): void; notifyResponse(): void; onTimeout(cb: (c: QueuedCommand) => void): void; get size(): number }`.

- [ ] **Step 1: tests** (with `vi.useFakeTimers()`).
  - `fishDelayMs` over 1000 draws stays within the bounds, and never goes below 2000 even with `base=2, jitter=1`.
  - The `manual` priority goes out before a `fish` pushed earlier.
  - Two sends are separated by at least `minGapMs` **and** wait for `notifyResponse()`.
  - Without a response: `onTimeout` is called after 8000 ms and the queue continues.
  - `push` of two `{ key:'sell' }` → the second returns `false`.
  - `pause()` → nothing goes out; `resume()` → sending resumes.
  - `clear()` empties the queue.
- [ ] **Step 2:** `npx vitest run tests/engine/humanize.test.ts tests/engine/CommandQueue.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Queue sorted by priority then arrival order; only one send in flight.
- [ ] **Step 4:** Run again → PASS.
- [ ] **Step 5:** Commit `feat: command queue with priorities, min gap and response timeout`.

---

### Task 5: GameState

**Files:**
- Create: `src/main/engine/GameState.ts`
- Test: `tests/engine/GameState.test.ts`

**Interfaces:**
- Consumes: `GameEvent`, `GameSnapshot`, `LogEntry`.
- Produces: `class GameState { constructor(now?: () => number); apply(e: GameEvent): void; markCommandSent(name: string): void; markCaptcha(): void; startSession(): void; endSession(): SessionSummary; snapshot(): GameSnapshot; onPatch(cb: (patch: DeepPartial<GameSnapshot>, newLog: LogEntry[]) => void): () => void; get catchesSinceSell(): number; get baitEstimate(): number | null }`.

- [ ] **Step 1: tests.**
  - A `catch` adds its `items` to `session.fishBySpecies`, increments `session.catches` and `catchesSinceSell`, and adds a `catch` line to the log.
  - A `sell` adds `earned` to `session.moneyEarned` and resets `catchesSinceSell` to 0.
  - An `inventory` updates `account` and recalibrates `baitEstimate`.
  - A `catch` decrements `baitEstimate`.
  - The log is capped at 500.
  - `levelUp` → entry with `highlight: true`.
  - `onPatch` receives only the modified fields.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS (`npx vitest run tests/engine/GameState.test.ts`).
- [ ] **Step 5:** Commit `feat: game state with session stats and capped log`.

---

### Task 6: DiscordClient interface and FakeDiscordClient

**Files:**
- Create: `src/main/discord/DiscordClient.ts`, `tests/helpers/FakeDiscordClient.ts`
- Test: `tests/engine/FakeDiscordClient.test.ts`

**Interfaces:**
- Produces: `interface DiscordClient` exactly as in spec §5.2, plus `setActiveChannel(channelId: string | null): void` (the `botMessage` filter only lets this channel through) and `on('rateLimited', cb: (retryAfterMs: number) => void)`.
- Produces: `class FakeDiscordClient implements DiscordClient` with `sent: { channelId; command; options }[]`, `emitBot(m: Partial<BotMessage>)`, `emitDisconnect()`, `emitReconnect()`, configurable `commands: SlashCommandInfo[]`, `failLogin?: boolean`.

- [ ] **Step 1:** Test: `sendSlash` does record the command in `sent`, and `emitBot` triggers the `botMessage` callback.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: discord client interface and fake for tests`.

---

### Task 7: Scheduler and Engine

**Files:**
- Create: `src/main/engine/Scheduler.ts`, `src/main/engine/Engine.ts`
- Test: `tests/engine/Engine.test.ts`

**Interfaces:**
- Consumes: `DiscordClient`, `CommandQueue`, `GameState`, `parseMessage`, `fishDelayMs`, `randomBetweenMs`, `ConfigStore.get()`.
- Produces: `class Scheduler { constructor(queue: CommandQueue, getConfig: () => Config, state: GameState); start(): void; stop(): void; freeze(): void; thaw(): void; onEvent(e: GameEvent): void }`. It manages the timers `fish`, `sell` (mode `catches` or `minutes`), `buff`, `bait`, `profile`, `daily` (24 h + 2–10 min), `quests` (30 min) and `breaks`.
- Produces: `class Engine { constructor(deps: { client: DiscordClient; config: ConfigStore; state: GameState; rand?: () => number }); start(target: { guildId: string; channelId: string }): Promise<void>; pause(reason?: PauseReason): void; resume(): void; stop(): void; sendManual(name: string, options?: Record<string, string|number>): void; submitCaptcha(answer: string): void; regenCaptcha(): void; get state(): EngineState; get availableCommands(): SlashCommandInfo[]; onState(cb: (s: EngineState, info?: { reason?: string; captchaImageUrl?: string; captchaText?: string }) => void): () => void }`.
- `start()` fetches `getBotCommands`. If `fish` is missing → `error` ("/fish command not found in this server"). Features whose command is missing are disabled and listed in `availableCommands`.

- [ ] **Step 1: tests** (FakeDiscordClient + fake timers + deterministic `rand`).
  - **Normal fishing**: `start` → `/fish` sent → `emitBot(catch)` → a 2nd `/fish` goes out after the delay, never before `minGap`.
  - **Sale at N catches**: with `every: 3`, after 3 catches the queue contains `sell` (options taken from `SlashCommandInfo`, amount `all`).
  - **Blocking captcha** (critical test): `emitBot(captcha)` → state `captcha`; advance 10 min → `sent` contains no new command, and no `verify`.
  - **Captcha via edit** (Review Focus 2): `emitBot({ ...captcha, isEdit: true })` → `captcha`.
  - **Solving**: `submitCaptcha('ABC123')` → `verify` sent with the answer; `emitBot(captchaSolved)` → `running` only after 5–15 s.
  - **Cooldown**: `emitBot(cooldown 2400ms)` → the next `/fish` goes out at the earliest 2400 ms later.
  - **Disconnection**: `emitDisconnect()` → `paused` (reason `network`); `emitReconnect()` → `running`; without reconnection for 2 min → `error`.
  - **3 consecutive timeouts** → `paused` (reason `noResponse`).
  - **Channel change** (Review Focus 3): `start(A)`, then `start(B)` → the queue is emptied, and all commands after the change target `B`.
  - **Missing `/fish`** → `error`.
  - **Pause / resume**: nothing is sent during the pause.
  - **Human breaks**: with `breaks.enabled`, after `workMin` (± jitter) → `resting`, then back to `running` after `restMin` (± jitter), with nothing sent during the rest.
  - **Session limit**: with `sessionLimitH: 1`, after 1 h → `idle`.
  - **Insufficient funds**: an `error` containing "enough" after a buff `buy` → no more buffs queued for 30 min.
  - **Rate limit**: `rateLimited(5000)` → nothing sent for 5 s, then `minGap` × 1.5 for 5 min.
- [ ] **Step 2:** `npx vitest run tests/engine/Engine.test.ts` → FAIL.
- [ ] **Step 3:** Implement Scheduler then Engine. In `captcha`, the Engine calls `queue.clear()`, then `queue.pause()` and `scheduler.freeze()`. Only `submitCaptcha` and `regenCaptcha` push a command (priority `verify`) and the queue lets it through even when paused. Any exception in a handler → `pause('exception')` + `logger.error`.
- [ ] **Step 4:** Run again → PASS. `npm test` → all PASS.
- [ ] **Step 5:** Commit `feat: engine state machine and scheduler`.

---

### Task 8: SelfbotClient (real adapter) and capture mode

**Files:**
- Create: `src/main/discord/SelfbotClient.ts`, `src/main/discord/toBotMessage.ts`
- Test: `tests/discord/toBotMessage.test.ts`

**Interfaces:**
- Consumes: `DiscordClient`, `BotMessage`, `logger`, `maskSecrets`.
- Produces: `class SelfbotClient implements DiscordClient` (constructor `(opts: { captureDir?: string })`). `toBotMessage(msg: LibMessageLike, selfId: string): BotMessage | null`, where `LibMessageLike` is the structural subset of the fields read (`id, channelId, content, author.id, embeds[], flags, interaction?.user.id, interactionMetadata?.user.id, mentions.users`), which makes it testable without the library.

- [ ] **Step 1: `toBotMessage` tests.**
  - Author ≠ `574652751745777665` → `null`.
  - Reply to another player's interaction, without mentioning us → `null` (Review Focus 1).
  - Reply to our interaction → `BotMessage` with `interactionUserId = selfId`.
  - Flag 64 → `ephemeral: true`.
  - Embed with an image → `imageUrl` filled in.
- [ ] **Step 2:** FAIL → **Step 3:** implement `toBotMessage` → **Step 4:** PASS.
- [ ] **Step 5:** Implement `SelfbotClient` with `discord.js-selfbot-v13`.
  - `login` → `client.login(token)`, then wait for `ready` (timeout 20 s, error "Invalid or expired token").
  - `listGuilds` → `client.guilds.cache`, with `hasVirtualFisher` = `guild.members.fetch('574652751745777665')` succeeded (with cache).
  - `listChannels` → text channels where `permissionsFor(me)` contains `SEND_MESSAGES` and `USE_APPLICATION_COMMANDS`.
  - `getBotCommands` → the server's application command index, filtered on the VF application. **Check the method exposed by the installed version** (read `node_modules/discord.js-selfbot-v13/typings/index.d.ts`: interaction search / `sendSlash`) and note it in a comment.
  - `sendSlash` → `channel.sendSlash('574652751745777665', name, ...optionsOrdered)`, with the options ordered according to `SlashCommandInfo.options`.
  - `messageCreate` / `messageUpdate` → `toBotMessage`. If `captureDir` is set, write the `BotMessage` to `captureDir/<timestamp>-<id>.json`.
  - `shardDisconnect` / `shardResume` → `disconnected` / `reconnected`; rate limit → `rateLimited`.
- [ ] **Step 6:** `npm run typecheck` → no errors.
- [ ] **Step 7:** Commit `feat: selfbot discord adapter with capture mode`.

---

### Task 9: IPC, preload and main wiring

**Files:**
- Create: `src/main/ipc/handlers.ts`
- Modify: `src/main/index.ts`, `src/preload/index.ts`
- Test: `tests/ipc/handlers.test.ts`

**Interfaces:**
- Consumes: `Api` (Task 1), `Engine`, `ConfigStore`, `SelfbotClient`, `GameState`.
- Produces: `registerHandlers(deps: { ipc: IpcMainLike; config: ConfigStore; client: DiscordClient; engine: Engine; state: GameState; send: (channel: string, payload: unknown) => void }): void`. The preload exposes `window.api: Api` via `contextBridge`.

- [ ] **Step 1: tests** (fake `IpcMainLike`).
  - `auth.setToken` with an OK FakeClient → returns `SelfUser` and calls `config.setToken`.
  - `auth.setToken` failing → rejects, and the token is **not** stored.
  - No payload sent to the renderer contains the token: we spy on `send` over a whole scenario and check the string is absent.
  - `target.set` persists in `config.target` and restarts the Engine if it was `running`.
  - `config.get` does not return `tokenEncrypted`.
  - `engine.stop` writes the session summary (`state.endSession()`) to `userData/sessions/<startedAt>.json`.
- [ ] **Step 2:** FAIL → **Step 3:** implement. When main starts, if there is a stored token → automatic `client.login`. The events `engine.state`, `game.patch`, `log.append`, `captcha.show|hide` and `connection.status` are relayed to the renderer.
- [ ] **Step 4:** PASS + `npm run typecheck`.
- [ ] **Step 5:** Commit `feat: typed ipc bridge and main wiring`.

---

### Task 10: Renderer — store, Onboarding, ServerPicker

**Files:**
- Create: `src/renderer/store.ts`, `src/renderer/screens/Onboarding.tsx`, `src/renderer/screens/ServerPicker.tsx`
- Modify: `src/renderer/App.tsx`, `src/renderer/styles.css`, `tailwind.config.js` (`ocean` colors)

**Interfaces:**
- Consumes: `window.api`.
- Produces: `useStore` (Zustand) with `{ user, screen: 'onboarding'|'picker'|'dashboard'|'settings', engineState, game: GameSnapshot, log: LogEntry[], captcha: { imageUrl?: string; text?: string } | null, config }` and the actions `goto(screen)`, `applyPatch`, `appendLog`. A `useApiEvents()` subscribes the store to the main events.

- [ ] **Step 1:** Onboarding: warning card (Discord ToS / VF rules) with a mandatory checkbox, masked token field (eye), collapsible help "How do I find my token?", "Log in" button (spinner, then error or avatar + username).
- [ ] **Step 2:** ServerPicker: icon grid, those that have VF first with a "Virtual Fisher" badge, the others greyed out and not clickable. Then a list of channels (`#name`) with a search field, and a "Use this channel" button → `api.target.set` → dashboard.
- [ ] **Step 3:** `App.tsx` routes according to `screen`. At launch: if there is a user and a target → dashboard; a user without a target → picker; otherwise → onboarding.
- [ ] **Step 4:** Check with `npm run dev`: the complete flow with a real token leads to the picker and lists the servers. `npm run typecheck` OK.
- [ ] **Step 5:** Commit `feat: onboarding and server/channel picker`.

---

### Task 11: Renderer — Dashboard

**Files:**
- Create: `src/renderer/screens/Dashboard.tsx`, `src/renderer/components/{TopBar,StatusPill,StatCard,CooldownRing,BoostChips,RareFishGrid,CatchLog,SidePanel,CommandBar}.tsx`

**Interfaces:**
- Consumes: `useStore`, `window.api.engine.*`, `window.api.command.send`.

- [ ] **Step 1:** `TopBar`: server and channel (click → picker), `StatusPill` (colors: running = turquoise, paused = amber, resting = blue, captcha = flashing red, error = red, idle = grey), Start/Pause/Stop buttons depending on the state, session timer.
- [ ] **Step 2:** Row of 4 `StatCard`s: Balance (+ session gain), Level (XP bar), Catches (+ `/h`), Next `/fish` (`CooldownRing` animated in CSS). Then `BoostChips` with countdown, and `RareFishGrid` (session / total).
- [ ] **Step 3:** `CatchLog`: simple virtualized list (500 max), filters All / Catches / Buys-sells / System, auto-scroll disabled if the user scrolls up. `SidePanel`: rod, biome, bait + stock, quests with progress bars, next daily.
- [ ] **Step 4:** `CommandBar`: buttons `/sell all`, `/daily`, `/quests`, `/boosts`, `/profile`, `/top`, a `/coinflip` with side and amount, and a free-form field with autocomplete on `availableCommands`. An unavailable command is disabled with a tooltip.
- [ ] **Step 5:** Check with `npm run dev`, on a real channel, for 5 min: the catches scroll by, the balance and the cooldown move. Take a screenshot for the README.
- [ ] **Step 6:** Commit `feat: live dashboard`.

---

### Task 12: Settings, captcha panel, notifications, tray, packaging

**Files:**
- Create: `src/renderer/screens/Settings.tsx`, `src/renderer/components/CaptchaPanel.tsx`, `src/main/notify.ts`, `src/main/tray.ts`, `electron-builder.yml`, `build/icon.ico`
- Modify: `src/main/index.ts`, `README.md`
- Test: `tests/engine/settingsHotReload.test.ts`

**Interfaces:**
- Consumes: `api.config.get|update`, `Engine.onState`, `captcha.show|hide`.
- Produces: `notifyCaptcha(win: BrowserWindow, cfg: Config['notifications']): void` (clickable Windows notification that does `win.show(); win.focus()`, sound if enabled, `win.flashFrame(true)`); `createTray(win, engine): Tray`.

- [ ] **Step 1: hot-reload test.** Changing `fishing.baseCooldownSec` during `running` → the next delay uses the new value. Disabling `sell.enabled` → no more `sell` queued.
- [ ] **Step 2:** FAIL → implement (the Scheduler reads `getConfig()` on every scheduling) → PASS.
- [ ] **Step 3:** `Settings.tsx`: the sections of spec §6.1-4, with bounded controls (cooldown ≥ 2, gap ≥ 2, buff duration ∈ {5, 20}), immediate application, Account section (change the token, log out), Advanced section (capture mode, open the data folder). A missing VF command is flagged next to the relevant option.
- [ ] **Step 4:** `CaptchaPanel.tsx`: non-closable modal, large image, automatically focused field (Enter = Submit), Submit and New image buttons (hidden if `verify` has no regen option), last message from the bot, sending state.
- [ ] **Step 5:** `notify.ts` + `tray.ts`: Show / Start-Pause / Quit menu, red icon on captcha, closing = minimize to the tray.
- [ ] **Step 6:** `electron-builder.yml` (NSIS, appId `com.r3con.virtualautofisher`, productName `Virtual AutoFisher`), then `npm run build:win` → the installer is in `dist/`, installs and launches.
- [ ] **Step 7:** README (EN): installation, retrieving the token, warnings, how the captcha works, screenshots, npm scripts.
- [ ] **Step 8:** `npm test` + `npm run typecheck` → everything passes.
- [ ] **Step 9:** Commit `feat: settings, manual captcha panel, notifications, tray and packaging`.

---

### Task 13: Calibrating the Parser with real messages

**Files:**
- Modify: `tests/fixtures/messages/*.json`, `src/main/parser/rules/*.ts`
- Test: `tests/parser/parseMessage.test.ts`

- [ ] **Step 1:** Enable capture mode and run a real 10-minute session: fish, sell, profile, stats, boosts, daily, quests, a command during the cooldown, and a captcha if possible.
- [ ] **Step 2:** Copy at least 2 captures per type into the fixtures, replacing the IDs and usernames with fake values. Replace the corresponding synthetic fixtures.
- [ ] **Step 3:** `npx vitest run tests/parser` → note the FAILs.
- [ ] **Step 4:** Adjust the rules until everything passes, **without weakening the captcha detection**.
- [ ] **Step 5:** Run again → PASS.
- [ ] **Step 6:** Commit `test: calibrate parser on captured Virtual Fisher messages`.
