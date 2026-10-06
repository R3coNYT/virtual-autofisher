import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { ConfigStore } from './config/ConfigStore'
import { safeStorageCipher } from './config/safeStorageCipher'
import { SelfbotClient } from './discord/SelfbotClient'
import { Engine } from './engine/Engine'
import { GameState } from './engine/GameState'
import { registerHandlers } from './ipc/handlers'
import { notifyCaptcha, notifyLevelUp, notifyRareFish } from './notify'
import { levelUpFromLog, rareIncreases } from './notifyEvents'
import { createTray, resourcePath } from './tray'
import { createLogger } from './util/logger'
import type { EngineState, RareCounts } from '../shared/types'

const logger = createLogger(join(app.getPath('userData'), 'logs'))
process.on('uncaughtException', (e) => logger.error('uncaughtException', e))
process.on('unhandledRejection', (e) => logger.error('unhandledRejection', e))

let current: BrowserWindow | null = null
let quitting = false

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
  const client = new SelfbotClient({ logger })
  const state = new GameState()
  const engine = new Engine({ client, config, state, logger })

  let win = createWindow()
  const send = (channel: string, payload: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
  const { autoLogin, dispose } = registerHandlers({
    ipc: ipcMain,
    config,
    client,
    engine,
    state,
    send,
    sessionsDir: join(userData, 'sessions'),
    dataDir: userData,
    openPath: (p) => shell.openPath(p),
    setCaptureDir: (dir) => client.setCaptureDir(dir),
    captureDir: join(userData, 'captures'),
    logger
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
  const tray = createTray(win, engine, { getTarget: () => config.get().target, quit: () => app.quit() })

  // notifications (captcha, level up, rare fish)
  let prevState: EngineState = engine.state
  engine.onState((s) => {
    if (s === 'captcha' && prevState !== 'captcha' && !win.isDestroyed()) notifyCaptcha(win, config.get().notifications)
    prevState = s
  })
  let lastRare: RareCounts = { gold: 0, emerald: 0, lava: 0, diamond: 0 }
  state.onPatch((patch, newLog) => {
    if (win.isDestroyed()) return
    const level = levelUpFromLog(newLog)
    if (level !== null) notifyLevelUp(win, config.get().notifications, level)
    const rare = patch.session?.rareCaught
    if (rare) {
      notifyRareFish(win, config.get().notifications, rareIncreases(lastRare, rare))
      lastRare = { ...lastRare, ...rare }
    }
  })

  // writes the session summary (synchronously) before the process goes away
  app.on('before-quit', () => {
    quitting = true
    tray.destroy()
    dispose()
    try {
      engine.stop()
    } catch (e) {
      logger.error('engine.stop on quit failed', e)
    }
    void client.logout().catch(() => {})
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow()
    else if (current && !current.isDestroyed()) current.show()
  })
}

app.whenReady().then(boot).catch((e) => logger.error('boot failed', e))

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
