# First run — testing the app on your account

A short checklist to try Virtual AutoFisher on your own Discord account and report what doesn't work. Read the warnings in the [README](../README.md) first.

## 1. Launch the app

Two options:

- **Installer**: `VirtualAutoFisher-Setup-x.y.z.exe` from the repository's *Releases* tab (or `dist/` if you build it yourself). Windows SmartScreen will warn you ("unknown publisher", the exe is not signed): *More info* → *Run anyway*.
- **From source** (recommended when testing, you see the logs):
  ```bash
  npm run dev
  ```

## 2. Log in

1. Read the warning and tick **I understand the risks**.
2. Paste your token (the **How do I find my token?** help is on the screen). It is encrypted by Windows and stays on your PC.
3. Your avatar and username should appear.

## 3. Pick the server and the channel

- Servers with Virtual Fisher are listed first, with a badge.
- **Tip: use a channel where you are alone** (or almost) while testing.

## 4. Turn on capture mode

Before starting: **Settings → Advanced → Capture mode: ON**.
Every bot reply is then saved to `%APPDATA%\virtual-autofisher\captures\`, which helps fix replies the app doesn't recognize yet.

## 5. Test session (~10 min)

1. Click **▶ Start** and watch the dashboard: catches scrolling, cooldown, balance, fish value.
2. Use each quick command at least once: `/sell all`, `/profile`, `/daily`, `/quests`, `/boosts`, `/boosters`, `/top`.
3. Send a command during the cooldown (to capture the "wait" message).
4. If a **captcha** appears: fishing freezes and a Windows notification shows up. Type the code in the panel → **Submit**. If it is a false alarm: **Stop fishing**.
5. Also try: ⏸ Pause / ▶ Resume, **Stop** (graceful: `/profile` + `/quests` then stop), closing the window (it goes to the system tray, next to the clock), **Quit** from the tray icon.

## 6. What to send back

- The `%APPDATA%\virtual-autofisher\captures\` folder (zipped), **after checking it contains nothing private** (other players' names, etc.). Captures never contain your token.
- The `%APPDATA%\virtual-autofisher\logs\app.log` file (the token is masked automatically).
- Anything that looked wrong or odd in the UI, with a screenshot.

## Quick troubleshooting

| Problem | What to do |
|---|---|
| "Invalid or expired token" | Get the token again (it changes when you log out of Discord). |
| The server is greyed out | Virtual Fisher wasn't detected there: pick another one, or click **Refresh**. |
| "Command unavailable" | That Virtual Fisher command doesn't exist on this server (or was renamed): send `app.log`. |
| "Error" state | The reason is shown next to the status pill: send it. |
