# Virtual AutoFisher — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** Une app Electron Windows qui automatise Virtual Fisher (fish, sell, buffs, appât, profil, daily, quêtes) via le compte Discord de l'utilisateur, avec dashboard temps réel et captcha résolu manuellement.

**Architecture :** Le processus principal contient `ConfigStore`, l'adaptateur `DiscordClient` (discord.js-selfbot-v13), un `Parser` pur (message → `GameEvent`) et un `Engine` (machine d'états + `CommandQueue` + `Scheduler` + `GameState`). L'interface React, sandboxée, ne reçoit que des états et des diffs via un IPC typé.

**Tech Stack :** Electron, electron-vite, TypeScript strict, React 18, Tailwind CSS 3, Zustand, lucide-react, discord.js-selfbot-v13, Vitest, electron-builder (NSIS).

**Spec :** `docs/superpowers/specs/2026-10-06-virtual-autofisher-design.md`

## Global Constraints

- ID du bot Virtual Fisher : `574652751745777665`.
- **Aucun `/verify` envoyé sans clic utilisateur.** Aucune résolution automatique de captcha (pas d'OCR, pas de service externe).
- Délai minimal global entre deux commandes : `minGapSec` (défaut **2.5**). Cooldown fish : `baseCooldownSec` (défaut **3.5**, min **2**) ± `jitterSec` (défaut **0.8**).
- Timeout de réponse du bot : **8 s** ; 3 timeouts consécutifs → `paused`.
- Reprise après captcha résolu : délai aléatoire **5–15 s**.
- Le token n'est jamais en clair sur disque, jamais envoyé au renderer, jamais loggé (masquage par `maskSecrets`).
- Fenêtres : `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- Taille minimale de la fenêtre 1000×680, thème sombre « océan » (fond `#0a1628`, accent cyan `#22d3ee`, turquoise `#2dd4bf`).
- Journal : 500 entrées max ; `app.log` en rotation à 5 Mo.
- Le texte de l'interface est en **français**.
- Les noms et options des commandes slash sont lus à l'exécution (index des commandes), jamais supposés sans vérification.

## Review Focus

1. **Message d'un autre joueur dans le salon** → ne doit ni compter comme prise ni déclencher de captcha pour nous (filtre `interactionUserId` / mention). Test dans la Task 8.
2. **Captcha arrivant via `MESSAGE_UPDATE`** (le bot édite sa réponse `/fish` en captcha) → doit passer en `captcha`. Test dans la Task 7.
3. **Changement de salon pendant un `running`** → stop, file vidée, aucune commande envoyée vers l'ancien salon. Test dans la Task 7.
4. **Nombres formatés** (`1,234,567`, `1.2M`, `12.5k`, `$1,234`) → valeur numérique correcte. Test dans la Task 3.
5. **Message vide ou embed sans description** → `unknown`, sans exception. Test dans la Task 3.

---

## Structure des fichiers

```
package.json, electron.vite.config.ts, tsconfig*.json, tailwind.config.js, postcss.config.js,
vitest.config.ts, electron-builder.yml
src/shared/types.ts           # tous les types partagés (Config, GameEvent, EngineState, DTO IPC)
src/shared/ipc.ts             # noms des canaux IPC + signature de window.api
src/main/index.ts             # fenêtre, tray, wiring
src/main/config/ConfigStore.ts
src/main/util/maskSecrets.ts
src/main/util/logger.ts
src/main/discord/DiscordClient.ts   # interface
src/main/discord/SelfbotClient.ts   # implémentation
src/main/discord/toBotMessage.ts    # Message (lib) → BotMessage
src/main/parser/text.ts
src/main/parser/index.ts            # parseMessage
src/main/parser/rules/*.ts          # un fichier par type d'événement
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

### Task 1 : Squelette du projet et types partagés

**Files :**
- Create : toute la configuration à la racine, `src/shared/types.ts`, `src/shared/ipc.ts`, `src/main/index.ts` (fenêtre vide), `src/preload/index.ts`, `src/renderer/{index.html,main.tsx,App.tsx,styles.css}`
- Test : `tests/smoke.test.ts`

**Interfaces :**
- Produces (`src/shared/types.ts`) : les types `Config`, `GameEvent` (union exacte de la spec §5.3), `CatchItem = { name: string; count: number }`, `RareCounts = { gold: number; emerald: number; lava: number; diamond: number }`, `EngineState = 'idle'|'connecting'|'running'|'paused'|'resting'|'captcha'|'error'`, `PauseReason = 'user'|'network'|'noResponse'|'exception'`, `BotMessage`, `GuildInfo`, `ChannelInfo`, `SlashCommandInfo = { name: string; id: string; version: string; options: { name: string; type: number; required: boolean; choices?: string[] }[] }`, `SelfUser = { id: string; username: string; avatarUrl: string }`, `LogEntry = { id: number; at: number; type: 'catch'|'trade'|'system'|'error'|'unknown'; text: string; highlight?: boolean }`, `GameSnapshot` (§5.4 GameState : `account`, `boosts`, `quests`, `session`, `log`), `DEFAULT_CONFIG: Config` (valeurs exactes du JSON de la spec §5.5, sans `tokenEncrypted`).
- Produces (`src/shared/ipc.ts`) : `type Api` = la liste des canaux de la spec §5.6 sous forme de méthodes (`auth.setToken(token): Promise<SelfUser>`, `guilds.list(): Promise<GuildInfo[]>`, `channels.list(guildId)`, `target.set(guildId, channelId)`, `engine.start|pause|resume|stop(): Promise<void>`, `command.send(name, options?)`, `captcha.submit(answer)`, `captcha.regen()`, `config.get()`, `config.update(patch: DeepPartial<Config>)`, `on(channel, cb): () => void` pour les events main → renderer).

- [ ] **Step 1 :** Créer le projet avec le template `react-ts` d'electron-vite, ajouter `tailwindcss@3 postcss autoprefixer zustand lucide-react discord.js-selfbot-v13`, puis `vitest electron-builder` en devDependencies. Scripts : `dev`, `build`, `test` (`vitest run`), `typecheck`, `build:win` (`electron-vite build && electron-builder --win`).
- [ ] **Step 2 :** Écrire `tests/smoke.test.ts` : `expect(DEFAULT_CONFIG.fishing).toEqual({ baseCooldownSec: 3.5, jitterSec: 0.8, minGapSec: 2.5 })` et `expect(DEFAULT_CONFIG.sell).toEqual({ enabled: true, mode: 'catches', every: 25 })`.
- [ ] **Step 3 :** Écrire `src/shared/types.ts` et `src/shared/ipc.ts`. Créer la fenêtre principale avec les flags de sécurité et la taille minimale. Le renderer affiche un fond `#0a1628` avec « Virtual AutoFisher ».
- [ ] **Step 4 :** Lancer `npm test` (PASS), `npm run typecheck` (aucune erreur) et `npm run dev` (la fenêtre s'ouvre).
- [ ] **Step 5 :** Commit `chore: scaffold electron-vite app with shared types`.

---

### Task 2 : ConfigStore, masquage des secrets, logger

**Files :**
- Create : `src/main/config/ConfigStore.ts`, `src/main/util/maskSecrets.ts`, `src/main/util/logger.ts`
- Test : `tests/config/ConfigStore.test.ts`, `tests/config/maskSecrets.test.ts`

**Interfaces :**
- Produces : `interface Cipher { encrypt(s: string): string; decrypt(b64: string): string; available(): boolean }` ; `class ConfigStore { constructor(dir: string, cipher: Cipher); load(): Config; get(): Config; update(patch: DeepPartial<Config>): Config; setToken(token: string): void; getToken(): string | null; clearToken(): void; onChange(cb: (c: Config) => void): () => void }` ; `safeStorageCipher: Cipher` (wrapper d'Electron `safeStorage`) ; `maskSecrets(s: string): string` ; `logger.info|warn|error(msg: string, extra?: unknown)` qui écrit dans `userData/logs/app.log`, avec rotation à 5 Mo et `maskSecrets` appliqué.

- [ ] **Step 1 : tests.**
  - `load()` sans fichier → `DEFAULT_CONFIG`.
  - `update({ sell: { every: 10 } })` conserve les autres champs de `sell` et persiste sur disque.
  - `setToken('abc')` → le fichier JSON ne contient pas `abc`, et `getToken()` retourne `'abc'` (avec un faux `Cipher` qui fait base64 inversé).
  - JSON corrompu → `DEFAULT_CONFIG`, et le fichier est sauvegardé en `config.bak.json`.
  - `maskSecrets('token MTA4.abc.def-ghi here')` → ne contient plus la chaîne du token. Regex token Discord : `[\w-]{24,}\.[\w-]{6}\.[\w-]{27,}`, remplacée par `***TOKEN***`.
- [ ] **Step 2 :** `npx vitest run tests/config` → FAIL.
- [ ] **Step 3 :** Implémenter. Le fusionnement profond se fait dans `ConfigStore`. Si `cipher.available()` est faux, `setToken` lève `Error('Chiffrement indisponible')` : on ne stocke jamais en clair.
- [ ] **Step 4 :** `npx vitest run tests/config` → PASS.
- [ ] **Step 5 :** Commit `feat: config store with encrypted token and secret masking`.

---

### Task 3 : Utilitaires texte et Parser

**Files :**
- Create : `src/main/parser/text.ts`, `src/main/parser/index.ts`, `src/main/parser/rules/{captcha,catch,sell,inventory,stats,boosts,purchase,daily,quests,cooldown,error}.ts`
- Create : `tests/fixtures/messages/*.json` (fixtures **synthétiques** au format `BotMessage`, construites à partir des textes du bot de référence. Elles seront remplacées par des captures réelles à la Task 13.)
- Test : `tests/parser/text.test.ts`, `tests/parser/parseMessage.test.ts`

**Interfaces :**
- Consumes : `BotMessage`, `GameEvent` (Task 1).
- Produces : `cleanText(s: string): string` (supprime `<a?:\w+:\d+>`, `:\w+:`, `*_~\``, et compacte les espaces) ; `parseNumber(s: string): number | null` ; `parseDuration(s: string): number | null` (ms, depuis `5m 30s`, `1h 2m`, `12 seconds`) ; `parseMessage(m: BotMessage): GameEvent`.
- Chaque règle : `(m: BotMessage, text: string) => GameEvent | null`. `parseMessage` les essaie dans cet ordre fixe : **captcha** (toujours en premier), captchaSolved/captchaFailed, cooldown, catch, sell, inventory, stats, boosts, purchase, daily, quests, error, puis `unknown`.

- [ ] **Step 1 : tests de `text`.** `parseNumber('1,234,567') === 1234567`, `('$1,234') === 1234`, `('1.2M') === 1200000`, `('12.5k') === 12500`, `('abc') === null` ; `parseDuration('5m 30s') === 330000`, `('12 seconds') === 12000` ; `cleanText('<:fish:123> **Cod** x2') === 'Cod x2'`.
- [ ] **Step 2 : tests de `parseMessage`** (un `it` par fixture) :
  - `catch-basic` → `kind:'catch'`, `items` contient `{ name:'Cod', count:2 }` ;
  - `catch-levelup` → `levelUp` = le nouveau niveau ;
  - `inventory` → `balance`, `level`, `rare.gold` ;
  - `stats` → `dailyStreak` ;
  - `captcha-image` → `kind:'captcha'` + `imageUrl` ;
  - `captcha-text-only` (texte « use /verify », sans image) → `captcha` ;
  - `captcha-solved` (`You may now continue.`) → `captchaSolved` ;
  - `cooldown` (« You must wait 2.4 seconds ») → `waitMs: 2400` ;
  - `sell` → `earned` ;
  - Review Focus 5 : `{ content:'', embeds:[{ title:'X' }] }` et `{ content:'', embeds:[] }` → `unknown`, sans exception.
- [ ] **Step 3 :** `npx vitest run tests/parser` → FAIL.
- [ ] **Step 4 :** Implémenter les règles (mots-clés de la spec §5.3). `parseMessage` entoure chaque règle d'un try/catch : si une règle lève une exception, on passe à la suivante.
- [ ] **Step 5 :** `npx vitest run tests/parser` → PASS.
- [ ] **Step 6 :** Commit `feat: message parser with synthetic fixtures`.

---

### Task 4 : Humanisation et CommandQueue

**Files :**
- Create : `src/main/engine/humanize.ts`, `src/main/engine/CommandQueue.ts`
- Test : `tests/engine/humanize.test.ts`, `tests/engine/CommandQueue.test.ts`

**Interfaces :**
- Produces : `fishDelayMs(cfg: Config['fishing'], rand?: () => number): number` (normale tronquée centrée sur `base`, écart-type `jitter/2`, bornée à `[max(2, base-jitter), base+jitter]` × 1000) ; `randomBetweenMs(minS: number, maxS: number, rand?): number`.
- Produces : `type Priority = 'manual'|'verify'|'maintenance'|'fish'` ; `type QueuedCommand = { name: string; options?: Record<string, string|number>; priority: Priority; key?: string }` ; `class CommandQueue { constructor(send: (c: QueuedCommand) => Promise<void>, opts: { minGapMs: () => number; responseTimeoutMs: number /* 8000 */ }); push(c): boolean /* false si key déjà en file */; clear(): void; pause(): void; resume(): void; notifyResponse(): void; onTimeout(cb: (c: QueuedCommand) => void): void; get size(): number }`.

- [ ] **Step 1 : tests** (avec `vi.useFakeTimers()`).
  - `fishDelayMs` avec 1000 tirages reste dans les bornes, et jamais sous 2000 même avec `base=2, jitter=1`.
  - La priorité `manual` part avant `fish` poussé plus tôt.
  - Deux envois sont séparés d'au moins `minGapMs` **et** attendent `notifyResponse()`.
  - Sans réponse : `onTimeout` est appelé après 8000 ms et la file continue.
  - `push` de deux `{ key:'sell' }` → le second retourne `false`.
  - `pause()` → rien ne part ; `resume()` → l'envoi reprend.
  - `clear()` vide la file.
- [ ] **Step 2 :** `npx vitest run tests/engine/humanize.test.ts tests/engine/CommandQueue.test.ts` → FAIL.
- [ ] **Step 3 :** Implémenter. File triée par priorité puis ordre d'arrivée ; un seul envoi en vol.
- [ ] **Step 4 :** Relancer → PASS.
- [ ] **Step 5 :** Commit `feat: command queue with priorities, min gap and response timeout`.

---

### Task 5 : GameState

**Files :**
- Create : `src/main/engine/GameState.ts`
- Test : `tests/engine/GameState.test.ts`

**Interfaces :**
- Consumes : `GameEvent`, `GameSnapshot`, `LogEntry`.
- Produces : `class GameState { constructor(now?: () => number); apply(e: GameEvent): void; markCommandSent(name: string): void; markCaptcha(): void; startSession(): void; endSession(): SessionSummary; snapshot(): GameSnapshot; onPatch(cb: (patch: DeepPartial<GameSnapshot>, newLog: LogEntry[]) => void): () => void; get catchesSinceSell(): number; get baitEstimate(): number | null }`.

- [ ] **Step 1 : tests.**
  - Un `catch` ajoute ses `items` à `session.fishBySpecies`, incrémente `session.catches` et `catchesSinceSell`, et ajoute une ligne `catch` au log.
  - Un `sell` ajoute `earned` à `session.moneyEarned` et remet `catchesSinceSell` à 0.
  - Un `inventory` met à jour `account` et recale `baitEstimate`.
  - Un `catch` décrémente `baitEstimate`.
  - Le log est plafonné à 500.
  - `levelUp` → entrée avec `highlight: true`.
  - `onPatch` reçoit seulement les champs modifiés.
- [ ] **Step 2 :** FAIL → **Step 3 :** implémenter → **Step 4 :** PASS (`npx vitest run tests/engine/GameState.test.ts`).
- [ ] **Step 5 :** Commit `feat: game state with session stats and capped log`.

---

### Task 6 : Interface DiscordClient et FakeDiscordClient

**Files :**
- Create : `src/main/discord/DiscordClient.ts`, `tests/helpers/FakeDiscordClient.ts`
- Test : `tests/engine/FakeDiscordClient.test.ts`

**Interfaces :**
- Produces : `interface DiscordClient` exactement comme dans la spec §5.2, plus `setActiveChannel(channelId: string | null): void` (le filtre `botMessage` ne laisse passer que ce salon) et `on('rateLimited', cb: (retryAfterMs: number) => void)`.
- Produces : `class FakeDiscordClient implements DiscordClient` avec `sent: { channelId; command; options }[]`, `emitBot(m: Partial<BotMessage>)`, `emitDisconnect()`, `emitReconnect()`, `commands: SlashCommandInfo[]` configurable, `failLogin?: boolean`.

- [ ] **Step 1 :** Test : `sendSlash` enregistre bien la commande dans `sent`, et `emitBot` déclenche le callback `botMessage`.
- [ ] **Step 2 :** FAIL → **Step 3 :** implémenter → **Step 4 :** PASS.
- [ ] **Step 5 :** Commit `feat: discord client interface and fake for tests`.

---

### Task 7 : Scheduler et Engine

**Files :**
- Create : `src/main/engine/Scheduler.ts`, `src/main/engine/Engine.ts`
- Test : `tests/engine/Engine.test.ts`

**Interfaces :**
- Consumes : `DiscordClient`, `CommandQueue`, `GameState`, `parseMessage`, `fishDelayMs`, `randomBetweenMs`, `ConfigStore.get()`.
- Produces : `class Scheduler { constructor(queue: CommandQueue, getConfig: () => Config, state: GameState); start(): void; stop(): void; freeze(): void; thaw(): void; onEvent(e: GameEvent): void }`. Il gère les timers `fish`, `sell` (mode `catches` ou `minutes`), `buff`, `bait`, `profile`, `daily` (24 h + 2–10 min), `quests` (30 min) et `breaks`.
- Produces : `class Engine { constructor(deps: { client: DiscordClient; config: ConfigStore; state: GameState; rand?: () => number }); start(target: { guildId: string; channelId: string }): Promise<void>; pause(reason?: PauseReason): void; resume(): void; stop(): void; sendManual(name: string, options?: Record<string, string|number>): void; submitCaptcha(answer: string): void; regenCaptcha(): void; get state(): EngineState; get availableCommands(): SlashCommandInfo[]; onState(cb: (s: EngineState, info?: { reason?: string; captchaImageUrl?: string; captchaText?: string }) => void): () => void }`.
- `start()` récupère `getBotCommands`. Si `fish` manque → `error` (« Commande /fish introuvable dans ce serveur »). Les fonctions dont la commande manque sont désactivées et listées dans `availableCommands`.

- [ ] **Step 1 : tests** (FakeDiscordClient + fake timers + `rand` déterministe).
  - **Pêche normale** : `start` → `/fish` envoyé → `emitBot(catch)` → un 2e `/fish` part après le délai, jamais avant `minGap`.
  - **Vente à N prises** : avec `every: 3`, après 3 prises la file contient `sell` (options issues de `SlashCommandInfo`, montant `all`).
  - **Captcha bloquant** (test critique) : `emitBot(captcha)` → état `captcha` ; avancer de 10 min → `sent` ne contient aucune nouvelle commande, et aucun `verify`.
  - **Captcha via édition** (Review Focus 2) : `emitBot({ ...captcha, isEdit: true })` → `captcha`.
  - **Résolution** : `submitCaptcha('ABC123')` → `verify` envoyé avec la réponse ; `emitBot(captchaSolved)` → `running` seulement après 5–15 s.
  - **Cooldown** : `emitBot(cooldown 2400ms)` → le prochain `/fish` part au plus tôt 2400 ms plus tard.
  - **Déconnexion** : `emitDisconnect()` → `paused` (raison `network`) ; `emitReconnect()` → `running` ; sans reconnexion pendant 2 min → `error`.
  - **3 timeouts** consécutifs → `paused` (raison `noResponse`).
  - **Changement de salon** (Review Focus 3) : `start(A)`, puis `start(B)` → la file est vidée, et toutes les commandes après le changement visent `B`.
  - **`/fish` manquant** → `error`.
  - **Pause / resume** : rien n'est envoyé pendant la pause.
  - **Pauses humaines** : avec `breaks.enabled`, après `workMin` (± jitter) → `resting`, puis retour à `running` après `restMin` (± jitter), sans aucun envoi pendant le repos.
  - **Limite de session** : avec `sessionLimitH: 1`, après 1 h → `idle`.
  - **Fonds insuffisants** : un `error` qui contient « enough » après un `buy` de buff → plus aucun buff mis en file pendant 30 min.
  - **Rate limit** : `rateLimited(5000)` → aucun envoi pendant 5 s, puis `minGap` × 1,5 pendant 5 min.
- [ ] **Step 2 :** `npx vitest run tests/engine/Engine.test.ts` → FAIL.
- [ ] **Step 3 :** Implémenter Scheduler puis Engine. En `captcha`, l'Engine appelle `queue.clear()`, puis `queue.pause()` et `scheduler.freeze()`. Seuls `submitCaptcha` et `regenCaptcha` poussent une commande (priorité `verify`) et la file la laisse passer même en pause. Toute exception dans un handler → `pause('exception')` + `logger.error`.
- [ ] **Step 4 :** Relancer → PASS. `npm test` → tout PASS.
- [ ] **Step 5 :** Commit `feat: engine state machine and scheduler`.

---

### Task 8 : SelfbotClient (adaptateur réel) et mode capture

**Files :**
- Create : `src/main/discord/SelfbotClient.ts`, `src/main/discord/toBotMessage.ts`
- Test : `tests/discord/toBotMessage.test.ts`

**Interfaces :**
- Consumes : `DiscordClient`, `BotMessage`, `logger`, `maskSecrets`.
- Produces : `class SelfbotClient implements DiscordClient` (constructeur `(opts: { captureDir?: string })`). `toBotMessage(msg: LibMessageLike, selfId: string): BotMessage | null`, où `LibMessageLike` est le sous-ensemble structurel des champs lus (`id, channelId, content, author.id, embeds[], flags, interaction?.user.id, interactionMetadata?.user.id, mentions.users`), ce qui le rend testable sans la librairie.

- [ ] **Step 1 : tests de `toBotMessage`.**
  - Auteur ≠ `574652751745777665` → `null`.
  - Réponse à l'interaction d'un autre joueur, sans nous mentionner → `null` (Review Focus 1).
  - Réponse à notre interaction → `BotMessage` avec `interactionUserId = selfId`.
  - Flag 64 → `ephemeral: true`.
  - Embed avec image → `imageUrl` rempli.
- [ ] **Step 2 :** FAIL → **Step 3 :** implémenter `toBotMessage` → **Step 4 :** PASS.
- [ ] **Step 5 :** Implémenter `SelfbotClient` avec `discord.js-selfbot-v13`.
  - `login` → `client.login(token)`, puis attente de `ready` (timeout 20 s, erreur « Token invalide ou expiré »).
  - `listGuilds` → `client.guilds.cache`, avec `hasVirtualFisher` = `guild.members.fetch('574652751745777665')` réussi (avec cache).
  - `listChannels` → salons texte où `permissionsFor(me)` contient `SEND_MESSAGES` et `USE_APPLICATION_COMMANDS`.
  - `getBotCommands` → index des commandes applicatives du serveur, filtré sur l'application VF. **Vérifier la méthode exposée par la version installée** (lire `node_modules/discord.js-selfbot-v13/typings/index.d.ts` : recherche d'interactions / `sendSlash`) et l'indiquer en commentaire.
  - `sendSlash` → `channel.sendSlash('574652751745777665', name, ...optionsOrdered)`, avec les options ordonnées selon `SlashCommandInfo.options`.
  - `messageCreate` / `messageUpdate` → `toBotMessage`. Si `captureDir` est défini, écriture du `BotMessage` dans `captureDir/<timestamp>-<id>.json`.
  - `shardDisconnect` / `shardResume` → `disconnected` / `reconnected` ; rate limit → `rateLimited`.
- [ ] **Step 6 :** `npm run typecheck` → aucune erreur.
- [ ] **Step 7 :** Commit `feat: selfbot discord adapter with capture mode`.

---

### Task 9 : IPC, preload et wiring du main

**Files :**
- Create : `src/main/ipc/handlers.ts`
- Modify : `src/main/index.ts`, `src/preload/index.ts`
- Test : `tests/ipc/handlers.test.ts`

**Interfaces :**
- Consumes : `Api` (Task 1), `Engine`, `ConfigStore`, `SelfbotClient`, `GameState`.
- Produces : `registerHandlers(deps: { ipc: IpcMainLike; config: ConfigStore; client: DiscordClient; engine: Engine; state: GameState; send: (channel: string, payload: unknown) => void }): void`. Le preload expose `window.api: Api` via `contextBridge`.

- [ ] **Step 1 : tests** (faux `IpcMainLike`).
  - `auth.setToken` avec un FakeClient OK → retourne `SelfUser` et appelle `config.setToken`.
  - `auth.setToken` en échec → rejette, et le token n'est **pas** stocké.
  - Aucun payload envoyé au renderer ne contient le token : on espionne `send` sur tout un scénario et on vérifie l'absence de la chaîne.
  - `target.set` persiste dans `config.target` et redémarre l'Engine s'il était `running`.
  - `config.get` ne renvoie pas `tokenEncrypted`.
  - `engine.stop` écrit le résumé de session (`state.endSession()`) dans `userData/sessions/<startedAt>.json`.
- [ ] **Step 2 :** FAIL → **Step 3 :** implémenter. Au démarrage du main, s'il y a un token stocké → `client.login` automatique. Les events `engine.state`, `game.patch`, `log.append`, `captcha.show|hide` et `connection.status` sont relayés au renderer.
- [ ] **Step 4 :** PASS + `npm run typecheck`.
- [ ] **Step 5 :** Commit `feat: typed ipc bridge and main wiring`.

---

### Task 10 : Renderer — store, Onboarding, ServerPicker

**Files :**
- Create : `src/renderer/store.ts`, `src/renderer/screens/Onboarding.tsx`, `src/renderer/screens/ServerPicker.tsx`
- Modify : `src/renderer/App.tsx`, `src/renderer/styles.css`, `tailwind.config.js` (couleurs `ocean`)

**Interfaces :**
- Consumes : `window.api`.
- Produces : `useStore` (Zustand) avec `{ user, screen: 'onboarding'|'picker'|'dashboard'|'settings', engineState, game: GameSnapshot, log: LogEntry[], captcha: { imageUrl?: string; text?: string } | null, config }` et les actions `goto(screen)`, `applyPatch`, `appendLog`. Un `useApiEvents()` abonne le store aux events du main.

- [ ] **Step 1 :** Onboarding : carte d'avertissement (CGU Discord / règles VF) avec case obligatoire, champ token masqué (œil), aide repliable « Comment trouver mon token ? », bouton « Connexion » (spinner, puis erreur ou avatar + pseudo).
- [ ] **Step 2 :** ServerPicker : grille d'icônes, ceux qui ont VF en premier avec un badge « Virtual Fisher », les autres grisés et non cliquables. Puis liste des salons (`#nom`) avec champ de recherche, et bouton « Utiliser ce salon » → `api.target.set` → dashboard.
- [ ] **Step 3 :** `App.tsx` route selon `screen`. Au lancement : s'il y a un utilisateur et une cible → dashboard ; un utilisateur sans cible → picker ; sinon → onboarding.
- [ ] **Step 4 :** Vérifier avec `npm run dev` : le flux complet avec un vrai token mène au sélecteur et liste les serveurs. `npm run typecheck` OK.
- [ ] **Step 5 :** Commit `feat: onboarding and server/channel picker`.

---

### Task 11 : Renderer — Dashboard

**Files :**
- Create : `src/renderer/screens/Dashboard.tsx`, `src/renderer/components/{TopBar,StatusPill,StatCard,CooldownRing,BoostChips,RareFishGrid,CatchLog,SidePanel,CommandBar}.tsx`

**Interfaces :**
- Consumes : `useStore`, `window.api.engine.*`, `window.api.command.send`.

- [ ] **Step 1 :** `TopBar` : serveur et salon (clic → picker), `StatusPill` (couleurs : running = turquoise, paused = ambre, resting = bleu, captcha = rouge clignotant, error = rouge, idle = gris), boutons Start/Pause/Stop selon l'état, chrono de session.
- [ ] **Step 2 :** Rangée de 4 `StatCard` : Solde (+ gain de session), Niveau (barre d'XP), Prises (+ `/h`), Prochain `/fish` (`CooldownRing` animé en CSS). Puis `BoostChips` avec compte à rebours, et `RareFishGrid` (session / total).
- [ ] **Step 3 :** `CatchLog` : liste virtualisée simple (500 max), filtres Tout / Prises / Achats-ventes / Système, défilement auto désactivé si l'utilisateur remonte. `SidePanel` : canne, biome, appât + stock, quêtes avec barres de progression, prochain daily.
- [ ] **Step 4 :** `CommandBar` : boutons `/sell all`, `/daily`, `/quests`, `/boosts`, `/profile`, `/top`, un `/coinflip` avec côté et montant, et un champ libre avec autocomplétion sur `availableCommands`. Une commande indisponible est désactivée avec une infobulle.
- [ ] **Step 5 :** Vérifier avec `npm run dev`, sur un vrai salon, pendant 5 min : les prises défilent, le solde et le cooldown bougent. Prendre une capture d'écran pour le README.
- [ ] **Step 6 :** Commit `feat: live dashboard`.

---

### Task 12 : Réglages, panneau captcha, notifications, tray, packaging

**Files :**
- Create : `src/renderer/screens/Settings.tsx`, `src/renderer/components/CaptchaPanel.tsx`, `src/main/notify.ts`, `src/main/tray.ts`, `electron-builder.yml`, `build/icon.ico`
- Modify : `src/main/index.ts`, `README.md`
- Test : `tests/engine/settingsHotReload.test.ts`

**Interfaces :**
- Consumes : `api.config.get|update`, `Engine.onState`, `captcha.show|hide`.
- Produces : `notifyCaptcha(win: BrowserWindow, cfg: Config['notifications']): void` (notification Windows cliquable qui fait `win.show(); win.focus()`, son si activé, `win.flashFrame(true)`) ; `createTray(win, engine): Tray`.

- [ ] **Step 1 : test** de rechargement à chaud. Changer `fishing.baseCooldownSec` pendant `running` → le prochain délai utilise la nouvelle valeur. Désactiver `sell.enabled` → plus aucun `sell` mis en file.
- [ ] **Step 2 :** FAIL → implémenter (le Scheduler lit `getConfig()` à chaque planification) → PASS.
- [ ] **Step 3 :** `Settings.tsx` : les sections de la spec §6.1-4, avec des contrôles bornés (cooldown ≥ 2, gap ≥ 2, durée de buff ∈ {5, 20}), application immédiate, section Compte (changer le token, déconnexion), section Avancé (mode capture, ouvrir le dossier de données). Une commande VF absente est signalée à côté de l'option concernée.
- [ ] **Step 4 :** `CaptchaPanel.tsx` : modal non fermable, image en grand, champ en focus automatique (Entrée = Valider), boutons Valider et Nouvelle image (masqué si `verify` n'a pas d'option regen), dernier message du bot, état d'envoi.
- [ ] **Step 5 :** `notify.ts` + `tray.ts` : menu Afficher / Start-Pause / Quitter, icône rouge en captcha, fermeture = réduction dans la barre.
- [ ] **Step 6 :** `electron-builder.yml` (NSIS, appId `com.r3con.virtualautofisher`, productName `Virtual AutoFisher`), puis `npm run build:win` → l'installeur est dans `dist/`, s'installe et se lance.
- [ ] **Step 7 :** README (FR) : installation, récupération du token, avertissements, fonctionnement du captcha, captures d'écran, scripts npm.
- [ ] **Step 8 :** `npm test` + `npm run typecheck` → tout passe.
- [ ] **Step 9 :** Commit `feat: settings, manual captcha panel, notifications, tray and packaging`.

---

### Task 13 : Calibrage du Parser avec de vrais messages

**Files :**
- Modify : `tests/fixtures/messages/*.json`, `src/main/parser/rules/*.ts`
- Test : `tests/parser/parseMessage.test.ts`

- [ ] **Step 1 :** Activer le mode capture et faire une session réelle de 10 min : fish, sell, profile, stats, boosts, daily, quests, une commande pendant le cooldown, et un captcha si possible.
- [ ] **Step 2 :** Copier au moins 2 captures par type dans les fixtures, en remplaçant les IDs et pseudos par des valeurs factices. Remplacer les fixtures synthétiques correspondantes.
- [ ] **Step 3 :** `npx vitest run tests/parser` → noter les FAIL.
- [ ] **Step 4 :** Ajuster les règles jusqu'à ce que tout passe, **sans affaiblir la détection du captcha**.
- [ ] **Step 5 :** Relancer → PASS.
- [ ] **Step 6 :** Commit `test: calibrate parser on captured Virtual Fisher messages`.
