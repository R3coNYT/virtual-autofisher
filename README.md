# Virtual AutoFisher

A Windows desktop app (Electron + React) that automates the **Virtual Fisher** Discord bot with your own account: continuous fishing, selling, fish and treasure buffs, personal boosters, bait, `/daily` and quest tracking, with a live dashboard (balance, fish value, level, catches, boosts, rare fish, log).

## Warnings

- **Using your account token (self-bot) is against Discord's Terms of Service.** Your account can be suspended or banned.
- **Virtual Fisher forbids macros**: your progress can be reset or banned.
- The app mimics a human pace (random delays, optional breaks), which **lowers the risk without removing it**.
- You use this tool at your own risk. It is not affiliated with Discord or Virtual Fisher.
- Your token is stored **encrypted** (Windows secure storage through Electron `safeStorage`), is never displayed or written to the logs, and is only sent to Discord.

## Installation

### From the installer

1. Download `VirtualAutoFisher-Setup-x.y.z.exe` from the **Releases** tab of this repository (or build it with `npm run build:win`, it lands in `dist/`).
2. Run the installer: you can pick the install folder.
3. Windows SmartScreen may warn you because the installer is not signed: "More info", then "Run anyway".

To update, run the new installer over the installed version: your settings, token and saved values are kept.

### From source

Requirements: Node.js 20 or newer.

```bash
npm install
npm run dev
```

## Getting your Discord token

1. Open Discord in your browser (`discord.com/app`) and log in.
2. Press **F12** to open the developer tools.
3. Go to the **Network** tab.
4. Type `api` in the filter, then click any request.
5. In the request headers, copy the value of **authorization**.

Never share this token: it gives full access to your account. The same steps are shown in the app ("How do I find my token?").

## First launch

1. Read the warning, tick **I understand the risks**, paste your token and click **Log in**. Your avatar and username are shown to confirm.
2. Pick a **server** (servers with Virtual Fisher come first, with a badge; the result is remembered, **Refresh** re-checks), then a text **channel**, and confirm with **Use this channel**. You can switch at any time from the dashboard's top bar (**Back** returns without changing anything).
3. Click **Start**. The app reads the bot's slash commands on that server, refreshes your data (`/profile`, `/boosts`, `/daily` when due, `/quests`) and starts fishing.

## What it does

- **Fishing** in a loop with a randomized cooldown, at most one command at a time with a minimum gap between commands.
- **Graceful stop**: **Stop** (or the session limit) stops `/fish`, runs `/profile` then `/quests` to refresh your data, then stops (25 s max). **Force stop** stops immediately.
- **Auto buffs** (fish + treasure): buys both buffs back to back (nothing in between), runs `/boosts`, waits until **both** buffs are over, then starts again.
- **Personal boosters** (opt-in): when no personal boost is active, runs `/boosters`, then `/use Personal` if you have one, then `/boosts`.
- **Daily**: `/daily` only when it is due; the next daily time is remembered even when the app is closed.
- **Quests**: refreshed at start, every 30 min and right after a "QUEST COMPLETE".
- **Saved values**: balance, fish value, level, XP to next level, rod, biome, bait and rare fish are saved and shown on the next launch, then refreshed by `/profile`.
- **Session gain**: "+$X this session" = fish value gained since the session's first `/profile`, plus what you sold.
- **Quick commands** at the bottom of the dashboard (`/sell all`, `/daily`, `/quests`, `/boosts`, `/boosters`, `/use Personal`, `/use Global`, `/profile`, `/top` with its category, `/coinflip`, and a free command field) work with or without a fishing session.

## Captcha: manual solving only

Virtual Fisher sometimes sends a captcha (`/verify`). When that happens:

- the command queue is emptied and **no automatic command is sent anymore**;
- a clickable Windows notification appears (with a sound if enabled), the taskbar button flashes and the tray icon turns red;
- a panel that cannot be dismissed shows the captcha image (if any) and the bot's message, rendered as Discord shows it. You type the answer and click **Submit** (or press Enter): that click is what sends `/verify`. **New image** asks for another image when the bot allows it. **Stop fishing** stops the engine without sending anything (e.g. a false alarm);
- if the answer is wrong, the panel stays open with the bot's message; if it is right, fishing resumes after a random 5–15 s delay.

**Why manual?** The captcha is there to check that a human is playing. Bypassing it (OCR, third-party services) would make automation much easier to detect and goes directly against the bot's rules. The app **never sends `/verify` without your action** and never solves a captcha for you, not even a text captcha whose code is written in the message. If you don't answer, it waits.

## Settings (applied immediately)

- **Account**: change token, log out.
- **Fishing**: base delay between two `/fish` (min 2 s), random variation (0–5 s), minimum gap between two commands (min 2 s).
- **Selling**: auto sell (`/sell all`), trigger (every N catches or every N minutes).
- **Buffs and bait**: auto buffs (fish + treasure, 5 or 20 min), auto-activate a personal booster, auto buy bait (automatic or fixed amount).
- **Profile, daily and quests**: profile refresh interval, auto daily, quest tracking.
- **Humanization**: regular breaks (fishing time and break length, with variation), stop automatically after N hours.
- **Notifications**: captcha, sound, level up, rare fish.
- **Advanced**: minimize to the system tray when closing the window, capture mode, open the data folder.

An option whose command does not exist on the chosen server shows "Command unavailable" and is ignored by the automation.

Closing the window **minimizes the app to the system tray** (configurable). To really quit: right-click the tray icon, then **Quit**. The tray menu also lets you show the window and start, pause or stop.

## Capture mode and file locations

Data lives in `%APPDATA%\virtual-autofisher\`:

| Item | Location |
|---|---|
| Settings (encrypted token) | `config.json` (backup: `config.bak.json`) |
| Saved values (account, next daily, servers with Virtual Fisher) | `state.json` |
| Logs | `logs\app.log` (rotated at 5 MB) |
| Session summaries | `sessions\` |
| Captured bot messages | `captures\` (capture mode) |

**Capture mode** (Settings > Advanced) saves the bot's raw messages to `captures\`. It is used to diagnose or improve reply recognition when the bot changes its format. Captures may contain your username and other players' names: review them before sharing. **Open the data folder** opens this directory.

## npm scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Development with hot reload |
| `npm test` | Tests (Vitest) |
| `npm run typecheck` | TypeScript check (main process and UI) |
| `npm run build` | Build (`out/`) |
| `npm run build:win` | NSIS installer in `dist/` |
| `node scripts/make-icons.mjs` | Regenerates the icons (`resources/`, `build/icon.ico`) |

## Troubleshooting

- **Invalid token**: the token was refused or has expired (changing your Discord password revokes it). Get a new one (see above), then use Settings > Account > **Change token**, or log out and go through onboarding again.
- **No Virtual Fisher on the server**: the bot is not on that server (or not visible), or `/fish` cannot be found. Pick a server with the Virtual Fisher badge, or invite the bot, then click **Refresh**.
- **"Command unavailable"**: the matching command is not exposed by the bot on that server; the option is ignored. Commands are loaded when you log in or pick a channel.
- **The bot stops answering**: after 3 missing replies (8 s each) the app pauses. Check the channel, then click **Resume**.
- **A message is not recognized**: enable capture mode, reproduce the case and look at `captures\` and `logs\app.log`.

## Screenshots

<!-- TODO (owner): add screenshots: onboarding, dashboard, settings, captcha panel. -->

*Coming soon.*

## Releasing a new version

Every push to `main` runs the GitHub Action [release.yml](.github/workflows/release.yml): if the `package.json` version has no `v<version>` release yet, it runs the type check and the tests, builds the Windows installer and creates the release with the `.exe`. Otherwise it does nothing.

```bash
npm version 1.0.4
git push
```
