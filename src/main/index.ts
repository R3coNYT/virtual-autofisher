import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron'
import { join } from 'path'
import { ConfigStore } from './config/ConfigStore'
import { safeStorageCipher } from './config/safeStorageCipher'
import { SelfbotClient } from './discord/SelfbotClient'
import { Engine } from './engine/Engine'
import { GameState } from './engine/GameState'
import { registerHandlers } from './ipc/handlers'
import { notifyCaptcha, notifyLevelUp, notifyRareFish } from './notify'
import { StateStore } from './persist/StateStore'
import { wireStatePersistence } from './persist/wireStatePersistence'
import { levelUpFromLog, rareIncreases } from './notifyEvents'
import { createTray, resourcePath } from './tray'
import { createLogger } from './util/logger'
import type { EngineState, RareCounts } from '../shared/types'

const logger = createLogger(join(app.getPath('userData'), 'logs'))
let client: SelfbotClient | null = null
process.on('uncaughtException', (e) => logger.error('uncaughtException', e))
process.on('unhandledRejection', (e) => {
  // the library posts interactions without awaiting them: name the slash command that was just sent
  const last = client?.lastSlash
  const ctx = last && Date.now() - last.at < 30_000 ? ` (after /${last.command})` : ''
  logger.error(`unhandledRejection${ctx}`, e)
})

let current: BrowserWindow | null = null
let quitting = false

/** Brings the existing window to the front (tray, second launch). */
function showCurrent(): void {
  if (!current || current.isDestroyed()) return
  if (current.isMinimized()) current.restore()
  current.show()
  current.focus()
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    backgroundColor: '#0a1628',
    title: 'Virtual AutoFisher',
    icon: resourcePath('icon.png'),
    autoHideMenuBar: !!process.env['ELECTRON_RENDERER_URL'], // dev: menu hidden, Alt shows it
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => (current = null))

  if (process.env['ELECTRON_RENDERER_URL']) {
    // dev only: surface renderer warnings/errors (e.g. CSP violations) in app.log
    win.webContents.on('console-message', (event) => {
      // Electron >= 35 passes a details object; level: 'info' | 'warning' | 'error' | 'debug'
      if (event.level === 'warning' || event.level === 'error') {
        logger.warn(`renderer ${event.level}: ${event.message} (${event.sourceId}:${event.lineNumber})`)
      }
    })
  }

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  current = win
  return win
}

function boot(): void {
  const userData = app.getPath('userData')
  const config = new ConfigStore(userData, safeStorageCipher, logger)
  config.load()
  if (!process.env['ELECTRON_RENDERER_URL']) Menu.setApplicationMenu(null) // keep the default (devtools) menu in dev
  const discord = new SelfbotClient({ logger })
  client = discord
  const state = new GameState()
  const engine = new Engine({ client: discord, config, state, logger })
  // last known account values and next daily (state.json): on screen before the login completes
  const stateStore = new StateStore(userData, logger)
  const persisted = wireStatePersistence({ state, engine, store: stateStore, logger })

  let win = createWindow()
  const send = (channel: string, payload: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
  const { autoLogin, dispose, startEngine } = registerHandlers({
    ipc: ipcMain,
    config,
    client: discord,
    engine,
    state,
    send,
    sessionsDir: join(userData, 'sessions'),
    dataDir: userData,
    openPath: (p) => shell.openPath(p),
    setCaptureDir: (dir) => discord.setCaptureDir(dir),
    captureDir: join(userData, 'captures'),
    logger,
    vfStore: stateStore
  })
  // log in once the renderer is listening, so it receives connection.status
  win.webContents.once('did-finish-load', () => void autoLogin())

  // close = hide to the tray (unless disabled); a real quit goes through app.quit() / the tray menu
  const attachClose = (w: BrowserWindow): void => {
    w.on('close', (e) => {
      if (quitting || !config.get().ui.closeToTray) return
      e.preventDefault()
      w.hide()
    })
  }
  attachClose(win)
  const tray = createTray(win, engine, { start: startEngine,
    onError: (e) => {
      const msg = e instanceof Error ? e.message : String(e)
      logger.warn(`tray start failed: ${msg}`)
      send('toast', { level: 'error', message: msg })
    },
    quit: () => app.quit() })

  // notifications (captcha, level up, rare fish)
  let prevState: EngineState = engine.state
  engine.onState((s) => {
    if (s === 'captcha' && prevState !== 'captcha' && !win.isDestroyed()) notifyCaptcha(win, config.get().notifications)
    prevState = s
  })
  let lastRare: RareCounts = { gold: 0, emerald: 0, lava: 0, diamond: 0 }
  state.onPatch((patch, newLog) => {
    try {
      if (win.isDestroyed()) return
      const level = levelUpFromLog(newLog)
      if (level !== null) notifyLevelUp(win, config.get().notifications, level)
      const rare = patch.session?.rareCaught
      if (rare) {
        notifyRareFish(win, config.get().notifications, rareIncreases(lastRare, rare))
        lastRare = { ...lastRare, ...rare }
      }
    } catch (e) {
      logger.error('Notification failed', e) // must never reach (and pause) the engine
    }
  })

  // writes the session summary (synchronously) before the process goes away
  app.on('before-quit', () => {
    quitting = true
    dispose()
    try {
      engine.stop()
    } catch (e) {
      logger.error('engine.stop on quit failed', e)
    }
    persisted.save() // also saved by the session end above; covers quitting while idle
    tray.destroy() // after engine.stop(): its state change still refreshes a live tray
    void discord.logout().catch(() => {})
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow()
    else if (current && !current.isDestroyed()) current.show()
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit() // another instance runs (it is brought to the front by 'second-instance')
} else {
  app.on('second-instance', showCurrent)
  app.whenReady().then(boot).catch((e) => logger.error('boot failed', e))
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
